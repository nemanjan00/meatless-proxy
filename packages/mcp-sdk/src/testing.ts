/**
 * A fake OAuth-protected MCP server for tests: an authorization server
 * (metadata, dynamic client registration, authorize with PKCE, token with
 * refresh) and an MCP server (the SDK's `McpServer` over
 * `StreamableHTTPServerTransport`) that checks bearer tokens, on one local
 * HTTP port. Import it from `@mp/mcp-sdk/testing`; never in production code.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export interface FakeOAuthMcpOptions {
  /** Seconds until an access token expires. Default 3600. */
  expiresIn?: number
  /** Also accept this static bearer token (for token-auth tests); OAuth still works alongside. */
  staticToken?: string
  /** Accept no bearer at all (a server without auth). */
  open?: boolean
  /** Port to listen on. Default: a free one. */
  port?: number
  /** Leave out the protected-resource metadata, so clients must be told the authorization server. */
  noResourceMetadata?: boolean
}

interface Client {
  client_id: string
  client_secret?: string
  redirect_uris: string[]
}

interface Code {
  clientId: string
  redirectUri: string
  challenge: string
  scope?: string
  expiresAt: number
  used: boolean
}

interface Token {
  clientId: string
  expiresAt: number
  scope?: string
}

export interface FakeOAuthMcp {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string
  /** The MCP endpoint: `<origin>/mcp`. */
  readonly url: string
  readonly stats: {
    registrations: number
    authorizations: number
    codeExchanges: number
    refreshes: number
    mcpRequests: number
    rejected: number
  }
  /** The `Authorization` header values the MCP endpoint received, in order. */
  readonly authHeaders: string[]
  /** Makes every access token issued so far expire now. */
  expireAccessTokens(): void
  /** Revokes every refresh token issued so far (the next refresh fails with invalid_grant). */
  revokeRefreshTokens(): void
  /** Follows an authorization URL like a browser that consents: returns the redirect (callback) URL. */
  approve(authorizationUrl: string | URL): Promise<URL>
  close(): Promise<void>
}

const sha256b64url = (s: string) => createHash('sha256').update(s).digest('base64url')
const token = () => randomBytes(24).toString('base64url')

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(value))
}

function mcpServer(tokenInfo: () => { clientId?: string; scope?: string }) {
  const s = new McpServer({ name: 'fake-oauth-mcp', version: '0.0.0' })
  s.registerTool('echo', { description: 'Echo text', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }))
  s.registerTool('whoami', { description: 'The OAuth client and scope of the caller' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(tokenInfo()) }],
  }))
  return s
}

/** Starts the fake on 127.0.0.1. */
export async function startFakeOAuthMcp(opts: FakeOAuthMcpOptions = {}): Promise<FakeOAuthMcp> {
  const clients = new Map<string, Client>()
  const codes = new Map<string, Code>()
  const access = new Map<string, Token>()
  const refresh = new Map<string, Token & { revoked: boolean }>()
  const stats = { registrations: 0, authorizations: 0, codeExchanges: 0, refreshes: 0, mcpRequests: 0, rejected: 0 }
  const authHeaders: string[] = []
  const expiresIn = opts.expiresIn ?? 3600
  let origin = ''

  const issue = (clientId: string, scope: string | undefined) => {
    const a = token()
    const r = token()
    access.set(a, { clientId, expiresAt: Date.now() + expiresIn * 1000, ...(scope ? { scope } : {}) })
    refresh.set(r, { clientId, expiresAt: Number.MAX_SAFE_INTEGER, revoked: false, ...(scope ? { scope } : {}) })
    return { access_token: a, token_type: 'Bearer', expires_in: expiresIn, refresh_token: r, ...(scope ? { scope } : {}) }
  }

  const clientAuth = (req: IncomingMessage, form: URLSearchParams): Client | null => {
    let id = form.get('client_id') ?? undefined
    let secret = form.get('client_secret') ?? undefined
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '')
    if (basic) {
      const [u, p] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':')
      id = decodeURIComponent(u ?? '')
      secret = decodeURIComponent(p ?? '')
    }
    const c = id ? clients.get(id) : undefined
    if (!c) return null
    if (c.client_secret && c.client_secret !== secret) return null
    return c
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', origin)
    const path = url.pathname

    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      if (opts.noResourceMetadata) return json(res, 404, { error: 'not_found' })
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read', 'write'] })
    }
    if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      })
    }
    if (path === '/register' && req.method === 'POST') {
      const meta = JSON.parse((await body(req)) || '{}') as { redirect_uris?: string[]; token_endpoint_auth_method?: string }
      if (!Array.isArray(meta.redirect_uris) || !meta.redirect_uris.length)
        return json(res, 400, { error: 'invalid_redirect_uri' })
      stats.registrations++
      const c: Client = {
        client_id: `client-${token().slice(0, 8)}`,
        redirect_uris: meta.redirect_uris,
        ...(meta.token_endpoint_auth_method && meta.token_endpoint_auth_method !== 'none' ? { client_secret: token() } : {}),
      }
      clients.set(c.client_id, c)
      return json(res, 201, { ...meta, ...c, client_id_issued_at: Math.floor(Date.now() / 1000) })
    }
    if (path === '/authorize' && req.method === 'GET') {
      const q = url.searchParams
      const c = clients.get(q.get('client_id') ?? '')
      const redirectUri = q.get('redirect_uri') ?? ''
      if (!c?.redirect_uris.includes(redirectUri)) return json(res, 400, { error: 'invalid_client' })
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge'))
        return json(res, 400, { error: 'invalid_request' })
      stats.authorizations++
      const code = token()
      const scope = q.get('scope') ?? undefined
      codes.set(code, {
        clientId: c.client_id,
        redirectUri,
        challenge: q.get('code_challenge')!,
        ...(scope ? { scope } : {}),
        expiresAt: Date.now() + 60_000,
        used: false,
      })
      const back = new URL(redirectUri)
      back.searchParams.set('code', code)
      const state = q.get('state')
      if (state) back.searchParams.set('state', state)
      res.writeHead(302, { location: back.toString() })
      return res.end()
    }
    if (path === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await body(req))
      const c = clientAuth(req, form)
      if (!c) return json(res, 401, { error: 'invalid_client' })
      if (form.get('grant_type') === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        if (
          !code ||
          code.used ||
          code.expiresAt < Date.now() ||
          code.clientId !== c.client_id ||
          code.redirectUri !== form.get('redirect_uri') ||
          sha256b64url(verifier) !== code.challenge
        )
          return json(res, 400, { error: 'invalid_grant', error_description: 'bad authorization code' })
        code.used = true
        stats.codeExchanges++
        return json(res, 200, issue(c.client_id, code.scope))
      }
      if (form.get('grant_type') === 'refresh_token') {
        const r = refresh.get(form.get('refresh_token') ?? '')
        if (!r || r.revoked || r.clientId !== c.client_id)
          return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' })
        r.revoked = true // rotation: a refresh token is good once
        stats.refreshes++
        return json(res, 200, issue(c.client_id, r.scope))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (path === '/mcp') {
      const header = req.headers.authorization ?? ''
      if (header) authHeaders.push(header)
      const bearer = /^Bearer (.+)$/.exec(header)?.[1]
      const t = bearer ? access.get(bearer) : undefined
      const staticOk = !!opts.staticToken && bearer === opts.staticToken
      if (!opts.open && !staticOk && (!t || t.expiresAt <= Date.now())) {
        stats.rejected++
        return json(
          res,
          401,
          { error: 'invalid_token' },
          {
            'www-authenticate': `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        )
      }
      stats.mcpRequests++
      const server = mcpServer(() =>
        t ? { clientId: t.clientId, ...(t.scope ? { scope: t.scope } : {}) } : { clientId: 'static' },
      )
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      const raw = req.method === 'POST' ? await body(req) : ''
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined)
      return
    }
    json(res, 404, { error: 'not_found' })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: 'server_error', error_description: String(e) })
      else res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    origin,
    url: `${origin}/mcp`,
    stats,
    authHeaders,
    expireAccessTokens() {
      for (const t of access.values()) t.expiresAt = 0
    },
    revokeRefreshTokens() {
      for (const r of refresh.values()) r.revoked = true
    },
    async approve(authorizationUrl) {
      const res = await fetch(authorizationUrl, { redirect: 'manual' })
      const location = res.headers.get('location')
      if (res.status !== 302 || !location) throw new Error(`authorization failed: ${res.status} ${await res.text()}`)
      return new URL(location)
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
