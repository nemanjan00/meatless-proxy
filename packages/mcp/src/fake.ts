import { ConflictError, MpError, NotFoundError, UnavailableError } from '@mp/core'
import type { ManagedMcpHub, McpCallResult, McpNotification, McpServerConfig, McpServerStatus, McpToolInfo } from './types.ts'

/** A tool on a fake server. */
export interface FakeToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** What a fake tool handler may return: a full result, plain text, or any JSON value (sent as text). */
export type FakeCallReturn = McpCallResult | string | { [key: string]: unknown }

export interface FakeServerDef {
  tools: FakeToolDef[]
  /**
   * Handles calls to this server's tools. Throwing makes `callTool` reject.
   * Default: a text result echoing `{ tool, args }` as JSON.
   */
  call?: (tool: string, args: Record<string, unknown>, ctx: { signal?: AbortSignal }) => FakeCallReturn | Promise<FakeCallReturn>
}

export interface FakeMcpCall {
  server: string
  tool: string
  args: Record<string, unknown>
}

export interface FakeMcpHub extends ManagedMcpHub {
  /** Every tool call, in order (also ones that failed). */
  readonly calls: FakeMcpCall[]
  /** Delivers a notification to subscribers, as if the server had sent it. */
  notify(server: string, method: string, params?: Record<string, unknown>): void
  /** Replaces a server's tool list (or adds a server). */
  setServer(name: string, def: FakeServerDef): void
  /** Sets a server's status, as if its connection had changed (status handlers are called). */
  setStatus(name: string, status: McpServerStatus): void
  /** The configs given to `addServer`, by name. */
  readonly configs: Map<string, McpServerConfig>
  readonly closed: boolean
}

export interface FakeMcpHubOptions {
  servers: Record<string, FakeServerDef>
  /** Tools of servers added later with `addServer`, by server name. Default: no tools. */
  definitions?: Record<string, FakeServerDef>
}

/** An in-memory McpHub for tests. Every server is `connected` unless `setStatus` says otherwise. */
export function fakeMcpHub(opts: FakeMcpHubOptions): FakeMcpHub {
  const servers = new Map(Object.entries(opts.servers))
  const statuses = new Map<string, McpServerStatus>()
  const configs = new Map<string, McpServerConfig>()
  const handlers = new Set<(n: McpNotification) => void>()
  const statusHandlers = new Set<(server: string, status: McpServerStatus) => void>()
  const calls: FakeMcpCall[] = []
  let closed = false
  const setStatus = (name: string, status: McpServerStatus) => {
    statuses.set(name, status)
    for (const h of [...statusHandlers]) h(name, status)
  }

  const open = () => {
    if (closed) throw new UnavailableError('MCP hub is closed')
  }
  const get = (name: string) => {
    const def = servers.get(name)
    if (!def) throw new NotFoundError('MCP server', name)
    return def
  }

  return {
    calls,
    get closed() {
      return closed
    },
    servers: () => [...servers.keys()],
    async listTools(server) {
      open()
      const names = server === undefined ? [...servers.keys()] : [server]
      return names.flatMap((s) =>
        get(s).tools.map(
          (t): McpToolInfo => ({
            server: s,
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
          }),
        ),
      )
    },
    async callTool(server, tool, args, callOpts) {
      open()
      calls.push({ server, tool, args: structuredClone(args) })
      const def = get(server)
      if (!def.tools.some((t) => t.name === tool)) throw new NotFoundError('MCP tool', `${server}.${tool}`)
      throwIfAborted(callOpts?.signal)
      const out = def.call ? await def.call(tool, args, callOpts?.signal ? { signal: callOpts.signal } : {}) : { tool, args }
      throwIfAborted(callOpts?.signal)
      return toResult(out)
    },
    onNotification(handler) {
      handlers.add(handler)
      return () => void handlers.delete(handler)
    },
    notify(server, method, params = {}) {
      if (closed) return
      get(server)
      const n: McpNotification = { server, method, params }
      for (const h of [...handlers]) h(n)
    },
    setServer(name, def) {
      servers.set(name, def)
    },
    setStatus(name, status) {
      get(name)
      setStatus(name, status)
    },
    configs,
    addServer(config) {
      open()
      if (servers.has(config.name)) throw new ConflictError(`MCP server ${config.name} already exists`)
      servers.set(config.name, opts.definitions?.[config.name] ?? { tools: [] })
      configs.set(config.name, config)
    },
    async removeServer(name) {
      statuses.delete(name)
      configs.delete(name)
      return servers.delete(name)
    },
    async reconnect(name) {
      get(name)
      const status: McpServerStatus = { state: 'connected', toolCount: get(name).tools.length }
      setStatus(name, status)
      return status
    },
    status(name) {
      return statuses.get(name) ?? { state: 'connected', toolCount: get(name).tools.length }
    },
    onStatus(handler) {
      statusHandlers.add(handler)
      return () => void statusHandlers.delete(handler)
    },
    async close() {
      closed = true
      handlers.clear()
      statusHandlers.clear()
    },
  }
}

function toResult(out: FakeCallReturn): McpCallResult {
  if (typeof out === 'string') return { content: [{ type: 'text', text: out }], isError: false }
  if (out && Array.isArray((out as McpCallResult).content)) {
    const r = out as McpCallResult
    return {
      content: r.content,
      isError: !!r.isError,
      ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false }
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new MpError('aborted', 'MCP call aborted')
}
