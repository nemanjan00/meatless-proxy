import {
  type Clock,
  ConflictError,
  type Logger,
  NotFoundError,
  silentLogger,
  systemClock,
  UnavailableError,
  ValidationError,
} from '@mp/core'
import type {
  ManagedMcpHub,
  McpCallResult,
  McpNotification,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
  SecretResolver,
} from '@mp/mcp'
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

/** A server config with its variables resolved, secrets included. Never log `env`. */
export interface ResolvedMcpServer {
  config: McpServerConfig
  /** `config.env` plus resolved secrets: env vars for stdio, headers for http. */
  env: Record<string, string>
  /** The OAuth provider for an http server that uses OAuth (see `authProviderFor`). */
  authProvider?: OAuthClientProvider
}

/** Builds the transport for a server. The default handles `stdio` and `http`. */
export type TransportFactory = (server: ResolvedMcpServer) => Transport | Promise<Transport>

export interface CreateMcpHubOptions {
  /** Servers to start with. More can be added with `addServer`. Default none. */
  servers?: McpServerConfig[]
  /** Required when any server has `secrets`. */
  resolveSecrets?: SecretResolver
  /**
   * The OAuth client provider of an http server, or undefined when it doesn't use OAuth. The
   * streamable HTTP transport sends its access token, refreshes it on a 401, and reports a server
   * that needs a new sign-in as `needs_auth`.
   */
  authProviderFor?: (config: McpServerConfig) => OAuthClientProvider | undefined
  logger?: Logger
  clock?: Clock
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

export interface SdkMcpHub extends ManagedMcpHub {
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
  authProvider?: OAuthClientProvider
}

interface ServerState {
  config: McpServerConfig
  conn?: Conn
  connecting?: Promise<Conn>
  removed: boolean
  status: McpServerStatus
}

/** The error a server that needs (new) authorization fails with. `details.needsAuth` is true. */
export function needsAuthError(server: string, message = 'needs authorization'): UnavailableError {
  return new UnavailableError(`MCP server ${server} ${message}`, { server, needsAuth: true })
}

/**
 * An McpHub over the official MCP SDK, whose servers can be added, removed
 * and reconnected at runtime. Each server gets one `Client`, connected lazily
 * (or all at once with `start()`). A failed connect is retried once, except
 * when the server wants authorization (`needs_auth`). A dropped connection is
 * re-established on next use; tool listing is retried once after
 * reconnecting, tool calls are not (their effect is uncertain) and fail with
 * UnavailableError.
 */
export function createMcpHub(opts: CreateMcpHubOptions = {}): SdkMcpHub {
  const log = (opts.logger ?? silentLogger).child({ component: 'mcp-sdk' })
  const clock = opts.clock ?? systemClock
  const clientInfo = opts.clientInfo ?? { name: 'meatless-proxy', version: '0.0.0' }
  const factory = opts.transportFactory ?? defaultTransport(log)
  const timeout = opts.requestTimeoutMs ?? 60_000
  const handlers = new Set<(n: McpNotification) => void>()
  const statusHandlers = new Set<(server: string, status: McpServerStatus) => void>()
  const states = new Map<string, ServerState>()
  let closed = false

  const check = (config: McpServerConfig) => {
    validate(config)
    if (config.secrets && Object.keys(config.secrets).length && !opts.resolveSecrets) {
      throw new ValidationError(`MCP server ${config.name} has secrets but no resolveSecrets was given`)
    }
  }
  for (const config of opts.servers ?? []) {
    check(config)
    if (states.has(config.name)) throw new ValidationError(`duplicate MCP server name: ${config.name}`)
    states.set(config.name, { config, removed: false, status: { state: 'idle' } })
  }

  const state = (name: string) => {
    const s = states.get(name)
    if (!s) throw new NotFoundError('MCP server', name)
    return s
  }
  const ensureOpen = () => {
    if (closed) throw new UnavailableError('MCP hub is closed')
  }

  function setStatus(s: ServerState, patch: Partial<McpServerStatus> & Pick<McpServerStatus, 'state'>) {
    if (s.removed || closed) return
    const prev = s.status
    const next: McpServerStatus = { ...prev, ...patch }
    if (patch.state === 'connected' || patch.state === 'connecting' || patch.state === 'idle') delete next.error
    if (patch.error) {
      next.lastError = patch.error
      next.lastErrorAt = clock.iso()
    }
    if (patch.state !== 'connected' && patch.toolCount === undefined) delete next.toolCount
    s.status = next
    if (prev.state === next.state && prev.error === next.error && prev.toolCount === next.toolCount) return
    for (const h of [...statusHandlers]) {
      try {
        h(s.config.name, { ...next })
      } catch (e) {
        log.error('MCP status handler failed', { server: s.config.name, error: e })
      }
    }
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
    const resolved = names.length ? await opts.resolveSecrets!(names, config) : {}
    const env: Record<string, string> = { ...config.env }
    const missing: string[] = []
    for (const [variable, secret] of Object.entries(config.secrets ?? {})) {
      const value = resolved[secret]
      if (value === undefined || value === '') missing.push(secret)
      else env[variable] = `${config.secretPrefix?.[variable] ?? ''}${value}`
    }
    if (missing.length) throw new ValidationError(`missing secrets for MCP server ${config.name}`, missing)

    const secretValues = Object.values(config.secrets ?? {})
      .map((secret) => resolved[secret]!)
      .filter((v) => v.length >= 4)
    const authProvider = config.transport === 'http' ? opts.authProviderFor?.(config) : undefined
    const client = new Client(clientInfo, { capabilities: {} })
    const conn: Conn = { client, closed: false, secretValues, ...(authProvider ? { authProvider } : {}) }
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/tools/list_changed') conn.tools = undefined
      emit({ server: config.name, method: n.method, params: (n.params ?? {}) as Record<string, unknown> })
    }
    client.onclose = () => {
      const unexpected = !conn.closed
      conn.closed = true
      if (!closed && unexpected && s.conn === conn) {
        log.warn('MCP server disconnected', { server: config.name })
        s.conn = undefined
        setStatus(s, { state: 'idle' })
      }
    }
    client.onerror = (e) => log.debug('MCP transport error', { server: config.name, error: redact(errorText(e), secretValues) })
    try {
      await client.connect(await factory({ config, env, ...(authProvider ? { authProvider } : {}) }), { timeout })
    } catch (e) {
      conn.closed = true
      await client.close().catch(() => {})
      if (isUnauthorized(e)) throw needsAuthError(config.name)
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
      if (e instanceof ValidationError || isNeedsAuth(e) || closed || s.removed) throw e
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
      setStatus(s, { state: 'connecting' })
      s.connecting = connect(s)
        .then(async (conn) => {
          if (closed || s.removed) {
            conn.closed = true
            await conn.client.close().catch(() => {})
            throw new UnavailableError(closed ? 'MCP hub is closed' : `MCP server ${name} was removed`, { server: name })
          }
          s.conn = conn
          setStatus(s, { state: 'connected', connectedAt: clock.iso() })
          return conn
        })
        .catch((e) => {
          if (!closed && !s.removed) setStatus(s, { state: isNeedsAuth(e) ? 'needs_auth' : 'error', error: errorText(e) })
          throw e
        })
        .finally(() => {
          s.connecting = undefined
        })
    }
    return s.connecting
  }

  async function drop(s: ServerState, conn: Conn) {
    conn.closed = true
    if (s.conn === conn) s.conn = undefined
    await conn.client.close().catch(() => {})
  }

  /** A failure on a live connection: needs_auth when the server refused our authorization, else idle. */
  async function failed(s: ServerState, conn: Conn, e: unknown) {
    await drop(s, conn)
    if (isUnauthorized(e)) setStatus(s, { state: 'needs_auth', error: 'needs authorization' })
    else setStatus(s, { state: 'idle' })
  }

  async function listServerTools(name: string, retry = true): Promise<McpToolInfo[]> {
    const conn = await getConn(name)
    const s = state(name)
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
      if (!conn.closed) {
        conn.tools = tools
        setStatus(s, { state: 'connected', toolCount: tools.length })
      }
      return tools
    } catch (e) {
      if (isUnauthorized(e)) {
        await failed(s, conn, e)
        throw needsAuthError(name)
      }
      if (!retry || closed || !isConnectionError(e, conn)) throw wrap(e, name, conn)
      log.warn('MCP listTools failed, reconnecting', { server: name, error: redact(errorText(e), conn.secretValues) })
      await failed(s, conn, e)
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
      const s = state(server)
      const conn = await getConn(server)
      callOpts?.signal?.throwIfAborted()
      try {
        const result = await conn.client.callTool({ name: tool, arguments: args }, undefined, {
          timeout,
          ...(callOpts?.signal ? { signal: callOpts.signal } : {}),
        })
        return redactResult(mapResult(result), await secretsOf(conn))
      } catch (e) {
        if (callOpts?.signal?.aborted) throw callOpts.signal.reason ?? e
        if (isUnauthorized(e)) {
          await failed(s, conn, e)
          throw needsAuthError(server)
        }
        if (e instanceof McpError && e.code !== ErrorCode.RequestTimeout && !isConnectionError(e, conn)) {
          // A protocol-level error (unknown tool, invalid params, server error): report it to the caller as a tool error.
          return { content: [{ type: 'text', text: redact(e.message, await secretsOf(conn)) }], isError: true }
        }
        if (isConnectionError(e, conn)) await failed(s, conn, e)
        throw wrap(e, server, conn)
      }
    },

    onNotification(handler) {
      handlers.add(handler)
      return () => void handlers.delete(handler)
    },

    onStatus(handler) {
      statusHandlers.add(handler)
      return () => void statusHandlers.delete(handler)
    },

    addServer(config) {
      ensureOpen()
      check(config)
      if (states.has(config.name)) throw new ConflictError(`MCP server ${config.name} already exists`)
      states.set(config.name, { config: { ...config }, removed: false, status: { state: 'idle' } })
      log.info('MCP server added', { server: config.name, transport: config.transport })
    },

    async removeServer(name) {
      const s = states.get(name)
      if (!s) return false
      states.delete(name)
      s.removed = true
      const conn = s.conn ?? (await s.connecting?.catch(() => undefined))
      s.conn = undefined
      if (conn) {
        conn.closed = true
        await conn.client.close().catch(() => {})
      }
      log.info('MCP server removed', { server: name })
      return true
    },

    async reconnect(name) {
      ensureOpen()
      const s = state(name)
      await s.connecting?.catch(() => undefined)
      if (s.conn) await drop(s, s.conn)
      try {
        await listServerTools(name)
      } catch (e) {
        log.warn('MCP reconnect failed', { server: name, error: errorText(e) })
      }
      return { ...s.status }
    },

    status(name) {
      return { ...state(name).status }
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
      statusHandlers.clear()
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

/** The default transports: spawn for stdio (env = safe defaults + resolved env), streamable HTTP with headers (and OAuth). */
export function defaultTransport(log: Logger = silentLogger): TransportFactory {
  return ({ config, env, authProvider }) => {
    if (config.transport === 'http') {
      return new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: { headers: env },
        ...(authProvider ? { authProvider } : {}),
      })
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

/** The secret values a connection uses: resolved secrets and the current OAuth tokens. */
async function secretsOf(conn: Conn): Promise<string[]> {
  if (!conn.authProvider) return conn.secretValues
  const tokens = await Promise.resolve(conn.authProvider.tokens()).catch(() => undefined)
  return [...conn.secretValues, ...[tokens?.access_token, tokens?.refresh_token].filter((v): v is string => !!v && v.length >= 4)]
}

/** Masks secret values anywhere in a result, in case a server echoes one back. */
export function redactResult(result: McpCallResult, secrets: string[]): McpCallResult {
  const values = [...new Set(secrets.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length)
  if (!values.length) return result
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v, values)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(result) as McpCallResult
}

/** Whether an error means the server refused our authorization (and refreshing didn't help). */
export function isUnauthorized(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof UnauthorizedError) return true
    if (cur instanceof StreamableHTTPError && cur.code === 401) return true
    if (isNeedsAuth(cur)) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

function isNeedsAuth(e: unknown): boolean {
  return e instanceof UnavailableError && (e.details as { needsAuth?: unknown } | undefined)?.needsAuth === true
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
