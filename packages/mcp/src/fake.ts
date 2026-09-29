import { MpError, NotFoundError, UnavailableError } from '@mp/core'
import type { McpCallResult, McpHub, McpNotification, McpToolInfo } from './types.ts'

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

export interface FakeMcpHub extends McpHub {
  /** Every tool call, in order (also ones that failed). */
  readonly calls: FakeMcpCall[]
  /** Delivers a notification to subscribers, as if the server had sent it. */
  notify(server: string, method: string, params?: Record<string, unknown>): void
  /** Replaces a server's tool list (or adds a server). */
  setServer(name: string, def: FakeServerDef): void
  readonly closed: boolean
}

/** An in-memory McpHub for tests. */
export function fakeMcpHub(opts: { servers: Record<string, FakeServerDef> }): FakeMcpHub {
  const servers = new Map(Object.entries(opts.servers))
  const handlers = new Set<(n: McpNotification) => void>()
  const calls: FakeMcpCall[] = []
  let closed = false

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
    async close() {
      closed = true
      handlers.clear()
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
