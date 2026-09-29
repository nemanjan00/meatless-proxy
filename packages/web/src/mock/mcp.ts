import {
  type ApiClient,
  ApiRequestError,
  type McpServerAuthInfo,
  type McpServerAuthInput,
  type McpServerCreate,
  type McpServerInfo,
  type McpServerTool,
} from '@mp/api'
import { EMP, type MockDb, mockId } from './data.ts'

type McpApi = Pick<
  ApiClient,
  | 'mcpServers'
  | 'createMcpServer'
  | 'updateMcpServer'
  | 'deleteMcpServer'
  | 'reconnectMcpServer'
  | 'mcpServerTools'
  | 'startMcpOAuth'
  | 'disconnectMcpOAuth'
>

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const secretName = (name: string, suffix: string) => `MCP_${name.toUpperCase().replace(/-/g, '_')}_${suffix}`

const TOOLS: Record<string, McpServerTool[]> = {
  docs: [
    { name: 'search', description: 'Search the wiki', effect: 'read' },
    { name: 'get_page', description: 'Read a page', effect: 'read' },
    { name: 'create_page', description: 'Create a page', effect: 'non_idempotent' },
  ].map((t) => ({ ...t, toolName: `mcp.docs.${t.name}`, inputSchema: { type: 'object', properties: {} } }) as McpServerTool),
  tasks: [
    { name: 'list_tasks', description: 'List tasks', effect: 'read' },
    { name: 'update_task', description: 'Update a task', effect: 'idempotent' },
  ].map((t) => ({ ...t, toolName: `mcp.tasks.${t.name}`, inputSchema: { type: 'object', properties: {} } }) as McpServerTool),
}

const tools = (name: string): McpServerTool[] =>
  TOOLS[name] ?? [
    {
      name: 'echo',
      toolName: `mcp.${name}.echo`,
      description: 'Echo text',
      inputSchema: { type: 'object', properties: {} },
      effect: 'non_idempotent',
    },
  ]

/**
 * MCP servers in the mock: a global token server (connected), a config server (read-only),
 * and an employee's OAuth server that needs a sign-in. Connect "signs in" at once and sends
 * the browser back with `mcp_oauth=connected`.
 */
export function createMockMcpApi(h: { db: MockDb; iso(): string; delay<T>(v: T): Promise<T> }): McpApi {
  const at = h.iso()
  const servers: McpServerInfo[] = [
    {
      id: 'config:tasks',
      name: 'tasks',
      source: 'config',
      transport: 'stdio',
      employeeId: null,
      enabled: true,
      effect: 'read',
      auth: { type: 'none' },
      status: { state: 'connected', toolCount: 2, connectedAt: at },
    },
    {
      id: mockId('mcs', 1),
      name: 'docs',
      source: 'record',
      transport: 'http',
      url: 'https://docs.example.com/mcp',
      employeeId: null,
      enabled: true,
      auth: { type: 'token', header: 'Authorization', prefix: 'Bearer ', secret: 'MCP_DOCS_TOKEN', hasToken: true },
      status: { state: 'connected', toolCount: 3, connectedAt: at },
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: mockId('mcs', 2),
      name: 'crm',
      source: 'record',
      transport: 'http',
      url: 'https://crm.example.com/mcp',
      employeeId: EMP.billing,
      enabled: true,
      auth: { type: 'oauth', scopes: ['read'], hasTokens: false },
      status: {
        state: 'needs_auth',
        error: 'needs authorization',
        toolCount: 0,
        lastError: 'needs authorization',
        lastErrorAt: at,
      },
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
  ]
  let seq = 3

  const find = (id: string) => {
    const s = servers.find((x) => x.id === id)
    if (!s) throw new ApiRequestError(404, 'not_found', `MCP server ${id} not found`)
    return s
  }
  const writable = (id: string) => {
    const s = find(id)
    if (s.source === 'config')
      throw new ApiRequestError(403, 'denied', 'servers from MCP_SERVERS are read-only: change the config')
    return s
  }
  const invalid = (issues: string[]) => new ApiRequestError(422, 'validation', 'invalid MCP server', { issues })
  const checkUrl = (url: string | undefined, issues: string[]) => {
    try {
      const u = new URL(url ?? '')
      if (u.protocol !== 'http:' && u.protocol !== 'https:') issues.push('url: must be an http(s) URL')
    } catch {
      issues.push('url: must be an http(s) URL')
    }
  }
  const authInfo = (name: string, input: McpServerAuthInput | undefined, prev?: McpServerAuthInfo): McpServerAuthInfo => {
    if (!input || input.type === 'none') return { type: 'none' }
    if (input.type === 'token') {
      const prevToken = prev?.type === 'token' ? prev : undefined
      return {
        type: 'token',
        header: input.header || 'Authorization',
        prefix: input.prefix ?? 'Bearer ',
        secret: input.secret || prevToken?.secret || secretName(name, 'TOKEN'),
        hasToken: !!input.token || !!input.secret || !!prevToken?.hasToken,
      }
    }
    return {
      type: 'oauth',
      ...(input.scopes?.length ? { scopes: input.scopes } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.clientSecret ? { clientSecretSecret: secretName(name, 'OAUTH_CLIENT_SECRET') } : {}),
      ...(input.clientSecretSecret ? { clientSecretSecret: input.clientSecretSecret } : {}),
      ...(input.authorizationServer ? { authorizationServer: input.authorizationServer } : {}),
      hasTokens: prev?.type === 'oauth' ? prev.hasTokens : false,
    }
  }
  const statusFor = (s: McpServerInfo): McpServerInfo['status'] => {
    if (!s.enabled) return { state: 'disabled', toolCount: 0 }
    if (s.auth.type === 'oauth' && !s.auth.hasTokens) return { state: 'needs_auth', error: 'needs authorization', toolCount: 0 }
    if (s.auth.type === 'token' && !s.auth.hasToken) return { state: 'needs_auth', error: 'the token was refused', toolCount: 0 }
    return { state: 'connected', toolCount: tools(s.name).length, connectedAt: h.iso() }
  }

  return {
    mcpServers: (q = {}) => {
      const e = q.employeeId
      const list =
        e === undefined
          ? servers
          : e === '' || e === 'global'
            ? servers.filter((s) => s.employeeId === null)
            : servers.filter((s) => s.employeeId === e && s.source === 'record')
      return h.delay(list)
    },
    createMcpServer: (body: McpServerCreate) => {
      const issues: string[] = []
      if (!SLUG.test(body.name ?? '')) issues.push('name: lowercase letters, digits and - (a slug)')
      checkUrl(body.url, issues)
      if (body.auth?.type === 'token' && !body.auth.token && !body.auth.secret) issues.push('auth.token: give the token')
      if (issues.length) return Promise.reject(invalid(issues))
      const employeeId = body.employeeId ?? null
      if (servers.some((s) => s.name === body.name && (s.employeeId === employeeId || s.employeeId === null || !employeeId)))
        return Promise.reject(new ApiRequestError(409, 'conflict', `an MCP server named ${body.name} already exists`))
      const s: McpServerInfo = {
        id: mockId('mcs', seq++),
        name: body.name,
        source: 'record',
        transport: 'http',
        url: body.url,
        ...(body.headers && Object.keys(body.headers).length ? { headers: body.headers } : {}),
        employeeId,
        enabled: body.enabled ?? true,
        ...(body.effect ? { effect: body.effect } : {}),
        auth: authInfo(body.name, body.auth),
        status: { state: 'connecting', toolCount: 0 },
        version: 1,
        createdAt: h.iso(),
        updatedAt: h.iso(),
      }
      s.status = statusFor(s)
      servers.push(s)
      return h.delay(s)
    },
    updateMcpServer: (id, patch) => {
      let s: McpServerInfo
      try {
        s = writable(id)
      } catch (e) {
        return Promise.reject(e)
      }
      const issues: string[] = []
      if (patch.url !== undefined) checkUrl(patch.url, issues)
      if (issues.length) return Promise.reject(invalid(issues))
      if (patch.url !== undefined) s.url = patch.url
      if (patch.headers !== undefined) {
        if (Object.keys(patch.headers).length) s.headers = patch.headers
        else delete s.headers
      }
      if (patch.enabled !== undefined) s.enabled = patch.enabled
      if (patch.effect === null) delete s.effect
      else if (patch.effect) s.effect = patch.effect
      if (patch.auth) s.auth = authInfo(s.name, patch.auth, s.auth)
      s.version = (s.version ?? 0) + 1
      s.updatedAt = h.iso()
      s.status = statusFor(s)
      return h.delay(s)
    },
    deleteMcpServer: (id) => {
      try {
        writable(id)
      } catch (e) {
        return Promise.reject(e)
      }
      servers.splice(
        servers.findIndex((s) => s.id === id),
        1,
      )
      return h.delay(undefined)
    },
    reconnectMcpServer: (id) => {
      try {
        const s = writable(id)
        s.status = statusFor(s)
        return h.delay(s)
      } catch (e) {
        return Promise.reject(e)
      }
    },
    mcpServerTools: (id) => {
      try {
        const s = find(id)
        return h.delay(s.status.state === 'connected' ? tools(s.name) : [])
      } catch (e) {
        return Promise.reject(e)
      }
    },
    startMcpOAuth: (id, body = {}) => {
      let s: McpServerInfo
      try {
        s = writable(id)
      } catch (e) {
        return Promise.reject(e)
      }
      if (s.auth.type !== 'oauth')
        return Promise.reject(new ApiRequestError(422, 'validation', `MCP server ${s.name} doesn't use OAuth`))
      // The mock has no authorization server: consent is instant and the "callback" lands right back.
      s.auth.hasTokens = true
      s.status = statusFor(s)
      const back = new URL(body.returnTo ?? '/settings/mcp', 'http://mock.invalid')
      back.searchParams.set('mcp_oauth', 'connected')
      back.searchParams.set('mcp_server', s.name)
      return h.delay({
        authorizationUrl: `${back.pathname}${back.search}`,
        expiresAt: new Date(h.db.now() + 10 * 60_000).toISOString(),
      })
    },
    disconnectMcpOAuth: (id) => {
      try {
        const s = writable(id)
        if (s.auth.type === 'oauth') s.auth.hasTokens = false
        s.status = statusFor(s)
        return h.delay(s)
      } catch (e) {
        return Promise.reject(e)
      }
    },
  }
}
