import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { errorMessage } from '@mp/core'
import { z } from 'zod'
import { GUARD_RULES, compileRules, matchRule } from './auth/guard.ts'
import { accessOf } from './auth/access.ts'
import type { Services } from './services.ts'
import { contactForToken } from './tokens.ts'

/** A response body longer than this (characters) is cut, with a note. */
export const ADMIN_MCP_MAX_TEXT = 200_000
/** A binary response (an export, a file) bigger than this (bytes) isn't returned. */
export const ADMIN_MCP_MAX_BINARY = 8 * 1024 * 1024

/** A route of the HTTP API, and the access it needs. */
export interface AdminRoute {
  method: string
  path: string
  need: string
}

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true })

const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
  Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status, ...(headers ? { headers } : {}) })

const INSTRUCTIONS = [
  "The admin side of vegan: everything the web UI's admin pages do (employees, integrations, triggers, secrets' names,",
  'MCP servers, projects, procedures, schedules, limits, knowledge, people, sessions and runs, the kill switch), over its HTTP API.',
  'api_routes lists the routes and the access each needs; api_request calls one as you, the admin whose token this is.',
  'Bodies are JSON. A request with a wrong body answers 400 with what is wrong: read it and fix the call.',
  'Every write is attributed to you, as in the web UI. Secret values can be set but are never returned.',
  'Changes are live at once for every employee: read before you change, and prefer the narrowest route.',
].join(' ')

/**
 * The harness's admin MCP server (docs/spec.md#the-admin-mcp-server): streamable HTTP at
 * `/mcp/admin`, for admins' tokens only. It is the admin UI over MCP: its tools call the HTTP API
 * in-process with the caller's own token, so the guard, validation and attribution are the API's,
 * and a route added to the API is there without a change here. Stateless: no sessions, no pushes.
 */
export class AdminMcpServer {
  private rules = compileRules(GUARD_RULES)

  /**
   * @param fetch the HTTP app (`app.fetch`), which the tools call
   * @param routes the app's routes (`app.routes`), read on each listing
   */
  constructor(
    private s: Services,
    private fetch: (req: Request) => Response | Promise<Response>,
    private routes: () => { method: string; path: string }[],
  ) {}

  async handle(req: Request): Promise<Response> {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
    const token = m?.[1]?.trim()
    const contactId = token ? await contactForToken(this.s.records, token) : null
    const access = contactId ? accessOf(await this.s.directory.contacts.get(contactId)) : null
    if (!token || !contactId || !access)
      return rpcError(401, -32001, 'unauthorized: send Authorization: Bearer <token>', { 'www-authenticate': 'Bearer' })
    if (access !== 'admin') return rpcError(403, -32001, `admins only: you are signed in as a ${access}`)
    if (req.method !== 'POST') return rpcError(405, -32000, 'stateless server: POST JSON-RPC requests only')
    const server = this.buildServer(req, token)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(req)
    } finally {
      void server.close().catch(() => {})
    }
  }

  /** The API's routes, each once, with the access it needs. */
  listRoutes(filter?: string): AdminRoute[] {
    const seen = new Set<string>()
    const out: AdminRoute[] = []
    const needle = filter?.toLowerCase()
    for (const r of this.routes()) {
      if (!r.path.startsWith('/api/') || r.method === 'ALL' || r.path.endsWith('*')) continue
      const key = `${r.method} ${r.path}`
      if (seen.has(key)) continue
      seen.add(key)
      if (needle && !key.toLowerCase().includes(needle)) continue
      const hit = matchRule(this.rules, r.method, r.path)
      const need = hit ? (typeof hit.rule.need === 'function' ? 'member or admin, by kind' : hit.rule.need) : 'viewer'
      out.push({ method: r.method, path: r.path, need })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  }

  private buildServer(incoming: Request, token: string): McpServer {
    const server = new McpServer({ name: 'vegan-admin', version: '0.0.0' }, { instructions: INSTRUCTIONS })

    server.registerTool(
      'api_routes',
      {
        description:
          'Lists the routes of the HTTP API (method, path with :params, and the access each needs). ' +
          'filter narrows it to routes whose "METHOD /path" contains the text, e.g. "employees" or "POST /api/secrets".',
        inputSchema: { filter: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ filter }) => {
        const routes = this.listRoutes(filter)
        return text({ routes, total: routes.length })
      },
    )

    server.registerTool(
      'api_request',
      {
        description:
          'Calls a route of the HTTP API as you (the admin whose token this is) and returns its status and body. ' +
          'path is the route with its :params filled in, e.g. /api/employees/emp_123; query is added to it; body is sent as JSON. ' +
          'Only /api/ paths. A JSON answer comes back parsed, text as text, and a file (an export) as a resource.',
        inputSchema: {
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
          path: z.string().min(1),
          query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
          body: z.unknown().optional(),
        },
      },
      async ({ method, path, query, body }) => {
        try {
          return await this.call(incoming, token, { method, path, ...(query ? { query } : {}), body })
        } catch (e) {
          return fail(errorMessage(e))
        }
      },
    )
    return server
  }

  private async call(
    incoming: Request,
    token: string,
    r: { method: string; path: string; query?: Record<string, string | number | boolean>; body?: unknown },
  ) {
    const url = new URL(r.path, incoming.url)
    // The URL resolves `..` and the like: what counts is where it lands.
    if (url.origin !== new URL(incoming.url).origin || !url.pathname.startsWith('/api/'))
      return fail(`only /api/ paths: ${r.path}`)
    for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, String(v))
    const headers = new Headers({ authorization: `Bearer ${token}`, accept: 'application/json' })
    for (const h of ['host', 'x-forwarded-for', 'x-forwarded-proto', 'user-agent']) {
      const v = incoming.headers.get(h)
      if (v) headers.set(h, v)
    }
    const withBody = r.body !== undefined && r.method !== 'GET'
    if (withBody) headers.set('content-type', 'application/json')
    const res = await this.fetch(
      new Request(url, { method: r.method, headers, ...(withBody ? { body: JSON.stringify(r.body) } : {}) }),
    )
    const type = res.headers.get('content-type') ?? ''
    const status = res.status
    this.s.logger.info('admin mcp request', { method: r.method, path: url.pathname, status })
    if (/json/.test(type)) {
      const raw = await res.text()
      let parsed: unknown = raw
      try {
        parsed = raw ? JSON.parse(raw) : null
      } catch {}
      const out = JSON.stringify({ status, body: parsed }, null, 2)
      return status >= 400 ? fail(clip(out)) : text(clip(out))
    }
    if (!type || /^text\/|xml|javascript|yaml/.test(type)) {
      const out = `HTTP ${status}\n\n${clip(await res.text())}`
      return status >= 400 ? fail(out) : text(out)
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > ADMIN_MCP_MAX_BINARY)
      return fail(
        `HTTP ${status}: a ${type} of ${bytes.byteLength} bytes, over the ${ADMIN_MCP_MAX_BINARY} the admin MCP returns`,
      )
    const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'response'
    return {
      content: [
        { type: 'text' as const, text: `HTTP ${status}: ${name}, ${type}, ${bytes.byteLength} bytes` },
        {
          type: 'resource' as const,
          resource: { uri: `${url.origin}${url.pathname}`, mimeType: type, blob: Buffer.from(bytes).toString('base64') },
        },
      ],
      ...(status >= 400 ? { isError: true } : {}),
    }
  }
}

function clip(s: string): string {
  return s.length > ADMIN_MCP_MAX_TEXT ? `${s.slice(0, ADMIN_MCP_MAX_TEXT)}\n… cut at ${ADMIN_MCP_MAX_TEXT} characters` : s
}
