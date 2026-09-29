import { type Logger, NotFoundError, silentLogger, UnavailableError, ValidationError } from '@mp/core'
import type { McpCallResult, McpHub, McpNotification, McpServerConfig, McpToolInfo, SecretResolver } from '@mp/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

/** A server config with its variables resolved, secrets included. Never log `env`. */
export interface ResolvedMcpServer {
  config: McpServerConfig
  /** `config.env` plus resolved secrets: env vars for stdio, headers for http. */
  env: Record<string, string>
}

/** Builds the transport for a server. The default handles `stdio` and `http`. */
export type TransportFactory = (server: ResolvedMcpServer) => Transport | Promise<Transport>

export interface CreateMcpHubOptions {
  servers: McpServerConfig[]
  /** Required when any server has `secrets`. */
  resolveSecrets?: SecretResolver
  logger?: Logger
  clientInfo?: { name: string; version: string }
  /** Replaces the default stdio / streamable HTTP transports (tests, custom transports). */
  transportFactory?: TransportFactory
  /** Timeout for each MCP request. Default 60 000 ms (the SDK default). */
  requestTimeoutMs?: number
}

export interface ConnectResult {
  server: string
  ok: boolean
  error?: string
}

export interface SdkMcpHub extends McpHub {
  /**
   * Connects every server now. Servers otherwise connect lazily on first use;
   * notifications only arrive from connected servers, so call this at startup
   * when you rely on them. Never throws: failures are reported per server.
   */
  start(): Promise<ConnectResult[]>
  /** Whether the server currently has a live connection. */
  connected(server: string): boolean
}

interface Conn {
  client: Client
  closed: boolean
  tools?: McpToolInfo[]
  secretValues: string[]
}

interface ServerState {
  config: McpServerConfig
  conn?: Conn
  connecting?: Promise<Conn>
}

/**
 * An McpHub over the official MCP SDK. Each server gets one `Client`,
 * connected lazily (or all at once with `start()`). A failed connect is
 * retried once. A dropped connection is re-established on next use; tool
 * listing is retried once after reconnecting, tool calls are not (their
 * effect is uncertain) and fail with UnavailableError.
 */
export function createMcpHub(opts: CreateMcpHubOptions): SdkMcpHub {
  const log = (opts.logger ?? silentLogger).child({ component: 'mcp-sdk' })
  const clientInfo = opts.clientInfo ?? { name: 'meatless-proxy', version: '0.0.0' }
  const factory = opts.transportFactory ?? defaultTransport(log)
  const timeout = opts.requestTimeoutMs ?? 60_000
  const handlers = new Set<(n: McpNotification) => void>()
  const states = new Map<string, ServerState>()
  let closed = false

  for (const config of opts.servers) {
    validate(config)
    if (states.has(config.name)) throw new ValidationError(`duplicate MCP server name: ${config.name}`)
    if (config.secrets && Object.keys(config.secrets).length && !opts.resolveSecrets) {
      throw new ValidationError(`MCP server ${config.name} has secrets but no resolveSecrets was given`)
    }
    states.set(config.name, { config })
  }

  const state = (name: string) => {
    const s = states.get(name)
    if (!s) throw new NotFoundError('MCP server', name)
    return s
  }
  const ensureOpen = () => {
    if (closed) throw new UnavailableError('MCP hub is closed')
  }

  function emit(n: McpNotification) {
    for (const h of [...handlers]) {
      try {
        h(n)
      } catch (e) {
        log.error('MCP notification handler failed', { server: n.server, method: n.method, error: e })
      }
    }
  }

  async function connectOnce(s: ServerState): Promise<Conn> {
    const { config } = s
    const names = Object.values(config.secrets ?? {})
    const resolved = names.length ? await opts.resolveSecrets!(names) : {}
    const env: Record<string, string> = { ...config.env }
    const missing: string[] = []
    for (const [variable, secret] of Object.entries(config.secrets ?? {})) {
      const value = resolved[secret]
      if (value === undefined) missing.push(secret)
      else env[variable] = value
    }
    if (missing.length) throw new ValidationError(`missing secrets for MCP server ${config.name}`, missing)

    const secretValues = Object.keys(config.secrets ?? {})
      .map((k) => env[k]!)
      .filter((v) => v.length >= 4)
    const client = new Client(clientInfo, { capabilities: {} })
    const conn: Conn = { client, closed: false, secretValues }
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/tools/list_changed') conn.tools = undefined
      emit({ server: config.name, method: n.method, params: (n.params ?? {}) as Record<string, unknown> })
    }
    client.onclose = () => {
      conn.closed = true
      if (!closed) log.warn('MCP server disconnected', { server: config.name })
    }
    client.onerror = (e) => log.debug('MCP transport error', { server: config.name, error: redact(errorText(e), secretValues) })
    try {
      await client.connect(await factory({ config, env }), { timeout })
    } catch (e) {
      conn.closed = true
      await client.close().catch(() => {})
      throw new UnavailableError(`cannot connect to MCP server ${config.name}: ${redact(errorText(e), secretValues)}`, {
        server: config.name,
      })
    }
    log.info('MCP server connected', { server: config.name, transport: config.transport })
    return conn
  }

  async function connect(s: ServerState): Promise<Conn> {
    try {
      return await connectOnce(s)
    } catch (e) {
      if (e instanceof ValidationError || closed) throw e
      log.warn('MCP connect failed, retrying once', { server: s.config.name, error: errorText(e) })
      return await connectOnce(s)
    }
  }

  async function getConn(name: string): Promise<Conn> {
    ensureOpen()
    const s = state(name)
    if (s.conn && !s.conn.closed) return s.conn
    if (!s.connecting) {
      s.conn = undefined
      s.connecting = connect(s)
        .then(async (conn) => {
          if (closed) {
            await conn.client.close().catch(() => {})
            throw new UnavailableError('MCP hub is closed')
          }
          s.conn = conn
          return conn
        })
        .finally(() => {
          s.connecting = undefined
        })
    }
    return s.connecting
  }

  async function drop(name: string, conn: Conn) {
    conn.closed = true
    const s = states.get(name)
    if (s?.conn === conn) s.conn = undefined
    await conn.client.close().catch(() => {})
  }

  async function listServerTools(name: string, retry = true): Promise<McpToolInfo[]> {
    const conn = await getConn(name)
    if (conn.tools) return conn.tools
    try {
      const tools: McpToolInfo[] = []
      let cursor: string | undefined
      do {
        const page = await conn.client.listTools(cursor ? { cursor } : {}, { timeout })
        for (const t of page.tools) {
          tools.push({
            server: name,
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema as Record<string, unknown>,
          })
        }
        cursor = page.nextCursor
      } while (cursor)
      if (!conn.closed) conn.tools = tools
      return tools
    } catch (e) {
      if (!retry || closed || !isConnectionError(e, conn)) throw wrap(e, name, conn)
      log.warn('MCP listTools failed, reconnecting', { server: name, error: redact(errorText(e), conn.secretValues) })
      await drop(name, conn)
      return listServerTools(name, false)
    }
  }

  return {
    servers: () => [...states.keys()],

    async listTools(server) {
      ensureOpen()
      if (server !== undefined) return listServerTools(state(server).config.name)
      const lists = await Promise.all([...states.keys()].map((n) => listServerTools(n)))
      return lists.flat()
    },

    async callTool(server, tool, args, callOpts) {
      state(server)
      const conn = await getConn(server)
      callOpts?.signal?.throwIfAborted()
      try {
        const result = await conn.client.callTool({ name: tool, arguments: args }, undefined, {
          timeout,
          ...(callOpts?.signal ? { signal: callOpts.signal } : {}),
        })
        return mapResult(result)
      } catch (e) {
        if (callOpts?.signal?.aborted) throw callOpts.signal.reason ?? e
        if (e instanceof McpError && e.code !== ErrorCode.RequestTimeout && !isConnectionError(e, conn)) {
          // A protocol-level error (unknown tool, invalid params, server error): report it to the caller as a tool error.
          return { content: [{ type: 'text', text: redact(e.message, conn.secretValues) }], isError: true }
        }
        if (isConnectionError(e, conn)) await drop(server, conn)
        throw wrap(e, server, conn)
      }
    },

    onNotification(handler) {
      handlers.add(handler)
      return () => void handlers.delete(handler)
    },

    async start() {
      return Promise.all(
        [...states.keys()].map(async (server): Promise<ConnectResult> => {
          try {
            await getConn(server)
            return { server, ok: true }
          } catch (e) {
            log.error('MCP server failed to connect', { server, error: errorText(e) })
            return { server, ok: false, error: errorText(e) }
          }
        }),
      )
    },

    connected: (server) => {
      const c = states.get(server)?.conn
      return !!c && !c.closed
    },

    async close() {
      if (closed) return
      closed = true
      handlers.clear()
      await Promise.all(
        [...states.values()].map(async (s) => {
          const conn = s.conn ?? (await s.connecting?.catch(() => undefined))
          s.conn = undefined
          if (conn) {
            conn.closed = true
            await conn.client.close().catch(() => {})
          }
        }),
      )
    },
  }
}

function validate(c: McpServerConfig) {
  if (!c.name || !/^[A-Za-z0-9_-]+$/.test(c.name)) {
    throw new ValidationError(`invalid MCP server name: ${JSON.stringify(c.name)} (letters, digits, _ and - only)`)
  }
  if (c.transport === 'stdio' && !c.command) throw new ValidationError(`MCP server ${c.name}: stdio needs a command`)
  if (c.transport === 'http' && !c.url) throw new ValidationError(`MCP server ${c.name}: http needs a url`)
  if (c.transport !== 'stdio' && c.transport !== 'http') {
    throw new ValidationError(`MCP server ${c.name}: unknown transport ${JSON.stringify(c.transport)}`)
  }
}

/** The default transports: spawn for stdio (env = safe defaults + resolved env), streamable HTTP with headers. */
export function defaultTransport(log: Logger = silentLogger): TransportFactory {
  return ({ config, env }) => {
    if (config.transport === 'http') {
      return new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: env } })
    }
    const transport = new StdioClientTransport({
      command: config.command!,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...env },
      stderr: 'pipe',
    })
    const secrets = Object.keys(config.secrets ?? {})
      .map((k) => env[k]!)
      .filter((v) => v && v.length >= 4)
    let buf = ''
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd()
        buf = buf.slice(nl + 1)
        if (line) log.debug('MCP server stderr', { server: config.name, line: redact(line, secrets) })
      }
    })
    return transport
  }
}

function mapResult(r: Record<string, unknown>): McpCallResult {
  const content = Array.isArray(r.content)
    ? (r.content as unknown[])
    : 'toolResult' in r
      ? [{ type: 'text', text: typeof r.toolResult === 'string' ? r.toolResult : JSON.stringify(r.toolResult) }]
      : []
  return {
    content,
    isError: r.isError === true,
    ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
  }
}

function isConnectionError(e: unknown, conn: Conn): boolean {
  if (conn.closed) return true
  if (e instanceof McpError) return e.code === ErrorCode.ConnectionClosed
  return true
}

function wrap(e: unknown, server: string, conn: Conn): Error {
  if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
    return new UnavailableError(`MCP server ${server} timed out`, { server })
  }
  if (e instanceof McpError && !isConnectionError(e, conn))
    return new UnavailableError(`MCP server ${server}: ${redact(e.message, conn.secretValues)}`, { server, code: e.code })
  if (e instanceof UnavailableError || e instanceof ValidationError || e instanceof NotFoundError) return e
  return new UnavailableError(`MCP server ${server} unavailable: ${redact(errorText(e), conn.secretValues)}`, { server })
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]')
  return out
}
