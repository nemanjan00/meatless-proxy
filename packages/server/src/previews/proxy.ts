import {
  Agent,
  STATUS_CODES,
  createServer,
  request,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { ContainerRuntime, PreviewTarget } from '@mp/containers'
import { errorMessage, isMpError, type Logger } from '@mp/core'
import type { ContactData, Directory } from '@mp/directory'
import type { StoredRecord } from '@mp/store'
import { accessOf, atLeast } from '../auth/access.ts'
import { parsePreviewHost, previewLabel, type PreviewMode } from './origins.ts'
import type { PreviewGrant, PreviewScope, PreviewSigner } from './tokens.ts'

/** The preview cookie: httpOnly, scoped to the preview origin, signed (see tokens.ts). */
export const PREVIEW_COOKIE = 'mp_preview'
/** The path the preview origin exchanges a token at. Everything else under the prefix is 404. */
export const PREVIEW_AUTH_PATH = '/__mp_preview/auth'
const RESERVED_PREFIX = '/__mp_preview/'
/** Cookies of the harness (and our own): never passed to a preview, never set by one. */
const HARNESS_COOKIE_RE = /^mp_/i
/** How long a viewer's access is trusted before it is looked up again. */
const ACCESS_CACHE_MS = 30_000

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
/** Request headers a preview never sees: credentials for the harness, and the harness's own CSRF header. */
const STRIPPED_REQUEST = new Set(['authorization', 'cookie', 'host', 'x-mp-csrf', 'forwarded'])

export interface PreviewProxyDeps {
  mode: PreviewMode
  signer: PreviewSigner
  containers: ContainerRuntime
  directory: Pick<Directory, 'contacts'>
  logger: Logger
  now: () => number
  /** The harness UI's origin, the only one that may frame a preview. Null: nobody may. */
  harnessOrigin: (previewHost: string) => string | null
  /** `Secure` on the preview cookie (https). */
  secure: (req: IncomingMessage) => boolean
  /** Trust `x-forwarded-*` from a reverse proxy. */
  trustProxy: boolean
}

type Resolved =
  | { ok: true; grant: PreviewGrant; target: PreviewTarget; refresh: boolean }
  | { ok: false; status: number; message: string }

/** Parses a `cookie` header into name/value pairs, keeping the raw pairs for rebuilding. */
export function parseCookies(header: string | undefined): { name: string; value: string; raw: string }[] {
  if (!header) return []
  return header
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((raw) => {
      const i = raw.indexOf('=')
      const name = (i < 0 ? raw : raw.slice(0, i)).trim()
      const value = i < 0 ? '' : raw.slice(i + 1).trim()
      return { name, value, raw }
    })
}

/** The `cookie` header a preview gets: everything but the harness's cookies (`mp_*`). */
export function previewRequestCookies(header: string | undefined): string | undefined {
  const kept = parseCookies(header).filter((c) => !HARNESS_COOKIE_RE.test(c.name))
  return kept.length ? kept.map((c) => c.raw).join('; ') : undefined
}

/**
 * Whether a preview's `Set-Cookie` may reach the browser: only host-only cookies for the preview
 * origin itself (no `Domain`, which would reach other hosts such as the harness), and never one
 * named like the harness's cookies.
 */
export function allowedSetCookie(line: string): boolean {
  const [pair, ...attrs] = line.split(';')
  const name = (pair ?? '').split('=')[0]!.trim()
  if (!name || HARNESS_COOKIE_RE.test(name) || /^__(host|secure)-mp_/i.test(name)) return false
  return !attrs.some((a) => /^\s*domain\s*=/i.test(a))
}

/** `Content-Security-Policy` of every preview response: only the harness UI may frame it. */
export const frameAncestors = (harnessOrigin: string | null) => `frame-ancestors ${harnessOrigin ?? "'none'"}`

/**
 * The preview listener: a plain Node HTTP server that serves nothing but the proxied app.
 *
 * - `GET /__mp_preview/auth?token=` exchanges a preview token for the preview cookie and redirects
 *   to `/`.
 * - Everything else (HTTP and WebSocket upgrades) is proxied to the environment's port, found from
 *   the cookie (and, in domain mode, checked against the host), with the harness's cookies and any
 *   `Authorization` stripped, `Host` rewritten, and `frame-ancestors <harness>` added to responses.
 */
export function createPreviewProxy(deps: PreviewProxyDeps): { server: Server; close(): void } {
  const agent = new Agent({ keepAlive: true, maxSockets: 64 })
  const accessCache = new Map<string, { at: number; ok: boolean }>()
  /** Upgraded connections: the HTTP server doesn't close those itself. */
  const tunnels = new Set<Duplex>()
  const log = deps.logger

  const viewerMayPreview = async (contactId: string) => {
    const hit = accessCache.get(contactId)
    if (hit && deps.now() - hit.at < ACCESS_CACHE_MS) return hit.ok
    const contact = (await deps.directory.contacts.get(contactId)) as StoredRecord<ContactData> | null
    const access = accessOf(contact)
    const ok = !!access && atLeast(access, 'member')
    accessCache.set(contactId, { at: deps.now(), ok })
    return ok
  }

  const hostOf = (req: IncomingMessage) => {
    const fwd = deps.trustProxy
      ? String(req.headers['x-forwarded-host'] ?? '')
          .split(',')[0]
          ?.trim()
      : ''
    return fwd || req.headers.host || ''
  }

  /** In domain mode the host names the preview; the grant must be for that very one. */
  const hostMatches = (req: IncomingMessage, scope: PreviewScope) => {
    if (deps.mode.kind !== 'domain') return true
    const parsed = parsePreviewHost(hostOf(req), deps.mode.domain)
    return !!parsed && parsed.label === previewLabel(scope.envId, scope.port)
  }

  const target = async (scope: PreviewScope): Promise<PreviewTarget | { status: number; message: string }> => {
    try {
      return await deps.containers.previewTarget!(scope.envId, scope.port)
    } catch (e) {
      if (isMpError(e, 'not_found')) return { status: 404, message: 'this preview has ended: its environment is gone' }
      log.warn('preview target unavailable', { envId: scope.envId, port: scope.port, err: errorMessage(e) })
      return { status: 502, message: 'the preview is not reachable right now' }
    }
  }

  /** The grant behind the request's preview cookie, and where it points. */
  const resolve = async (req: IncomingMessage): Promise<Resolved> => {
    const cookie = parseCookies(req.headers.cookie).find((c) => c.name === PREVIEW_COOKIE)
    if (!cookie) return { ok: false, status: 401, message: 'open this preview from the harness UI' }
    const r = deps.signer.checkCookie(decodeURIComponent(cookie.value))
    if (!r.ok) return { ok: false, status: 401, message: 'this preview link has expired: open it again from the harness UI' }
    if (!hostMatches(req, r.grant)) return { ok: false, status: 403, message: 'this preview cookie is for another preview' }
    if (!(await viewerMayPreview(r.grant.contactId))) return { ok: false, status: 403, message: 'you may not open previews' }
    const t = await target(r.grant)
    if ('status' in t) return { ok: false, ...t }
    return { ok: true, grant: r.grant, target: t, refresh: deps.signer.dueForRefresh(r.grant) }
  }

  const cookieHeader = (req: IncomingMessage, scope: PreviewScope) => {
    const secure = deps.secure(req)
    const maxAge = Math.floor(deps.signer.cookieTtlMs / 1000)
    return [
      `${PREVIEW_COOKIE}=${encodeURIComponent(deps.signer.cookie(scope))}`,
      'Path=/',
      'HttpOnly',
      `Max-Age=${maxAge}`,
      // SameSite=None lets the harness UI's frame send it; browsers only accept that with Secure.
      secure ? 'SameSite=None; Secure' : 'SameSite=Lax',
    ].join('; ')
  }

  const baseHeaders = (req: IncomingMessage): OutgoingHttpHeaders => ({
    'content-security-policy': frameAncestors(deps.harnessOrigin(hostOf(req))),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })

  const page = (req: IncomingMessage, res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { ...baseHeaders(req), 'content-type': 'text/plain; charset=utf-8' })
    res.end(`${message}\n`)
  }

  async function exchange(req: IncomingMessage, res: ServerResponse, url: URL) {
    const token = url.searchParams.get('token') ?? ''
    const r = deps.signer.checkToken(token)
    if (!r.ok) {
      const why = r.reason === 'expired' ? 'has expired' : r.reason === 'used' ? 'was already used' : 'is not valid'
      return page(req, res, 401, `this preview link ${why}: open the preview again from the harness UI`)
    }
    if (!hostMatches(req, r.grant)) return page(req, res, 403, 'this preview link is for another preview')
    if (!(await viewerMayPreview(r.grant.contactId))) return page(req, res, 403, 'you may not open previews')
    const t = await target(r.grant)
    if ('status' in t) return page(req, res, t.status, t.message)
    if (!deps.signer.redeemToken(token).ok) return page(req, res, 401, 'this preview link was already used')
    res.writeHead(302, { ...baseHeaders(req), location: '/', 'set-cookie': cookieHeader(req, r.grant) })
    res.end()
  }

  /** Headers for the upstream request: harness credentials out, `Host` and same-origin headers rewritten. */
  function upstreamHeaders(req: IncomingMessage, port: number, upgrade: boolean): OutgoingHttpHeaders {
    const connectionListed = String(req.headers.connection ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
    const out: OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue
      if (STRIPPED_REQUEST.has(k) || HOP_BY_HOP.has(k) || connectionListed.includes(k) || k.startsWith('x-forwarded-')) continue
      out[k] = v
    }
    // The exposed port: what the app listens on in its container, whatever address reaches it.
    const inner = `localhost:${port}`
    out.host = inner
    const cookies = previewRequestCookies(req.headers.cookie)
    if (cookies) out.cookie = cookies
    const host = hostOf(req)
    const proto = deps.secure(req) ? 'https' : 'http'
    const self = `${proto}://${host}`
    // To the app it looks like it is served at localhost:<port>, as dev servers expect.
    if (typeof out.origin === 'string' && out.origin === self) out.origin = `http://${inner}`
    if (typeof out.referer === 'string' && out.referer.startsWith(`${self}/`))
      out.referer = `http://${inner}${out.referer.slice(self.length)}`
    out['x-forwarded-host'] = host
    out['x-forwarded-proto'] = proto
    if (upgrade) {
      out.connection = 'Upgrade'
      out.upgrade = String(req.headers.upgrade ?? 'websocket')
    }
    return out
  }

  /** A redirect to the app's own inner address becomes a path on the preview origin. */
  function rewriteLocation(loc: string, port: number, t: PreviewTarget): string {
    try {
      const u = new URL(loc)
      const inner = new Set([port, t.port].flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`, `${t.host}:${p}`, `0.0.0.0:${p}`]))
      if ((u.protocol === 'http:' || u.protocol === 'https:') && inner.has(u.host)) return `${u.pathname}${u.search}${u.hash}`
    } catch {
      // relative: fine as is
    }
    return loc
  }

  function responseHeaders(req: IncomingMessage, up: IncomingMessage, port: number, t: PreviewTarget, refresh: string | null) {
    const connectionListed = String(up.headers.connection ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
    const out: OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(up.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || connectionListed.includes(k)) continue
      if (k === 'set-cookie') {
        const kept = (Array.isArray(v) ? v : [v]).filter(allowedSetCookie)
        if (kept.length) out[k] = kept
        continue
      }
      out[k] = k === 'location' && typeof v === 'string' ? rewriteLocation(v, port, t) : v
    }
    if (refresh) out['set-cookie'] = [...((out['set-cookie'] as string[] | undefined) ?? []), refresh]
    // A policy of its own (comma-separated policies all apply): the app's CSP, if any, still holds.
    const own = up.headers['content-security-policy']
    const ours = frameAncestors(deps.harnessOrigin(hostOf(req)))
    out['content-security-policy'] = own ? `${own}, ${ours}` : ours
    return out
  }

  async function proxy(req: IncomingMessage, res: ServerResponse) {
    const r = await resolve(req)
    if (!r.ok) return page(req, res, r.status, r.message)
    const refresh = r.refresh ? cookieHeader(req, r.grant) : null
    const up = request({
      host: r.target.host,
      port: r.target.port,
      method: req.method,
      path: req.url ?? '/',
      headers: upstreamHeaders(req, r.grant.port, false),
      agent,
    })
    up.on('response', (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.statusMessage, responseHeaders(req, ur, r.grant.port, r.target, refresh))
      ur.pipe(res)
      ur.on('error', () => res.destroy())
    })
    up.on('error', (e) => {
      log.debug('preview upstream error', { envId: r.grant.envId, port: r.grant.port, err: errorMessage(e) })
      if (!res.headersSent) page(req, res, 502, 'the preview did not answer: is the app listening on 0.0.0.0?')
      else res.destroy()
    })
    res.on('close', () => {
      if (!res.writableFinished) up.destroy()
    })
    req.pipe(up)
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://preview.invalid')
    if (url.pathname === PREVIEW_AUTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return page(req, res, 405, 'method not allowed')
      return exchange(req, res, url)
    }
    if (url.pathname.startsWith(RESERVED_PREFIX)) return page(req, res, 404, 'not found')
    return proxy(req, res)
  }

  const refuseUpgrade = (socket: Duplex, status: number) => {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  /** WebSocket (and other) upgrades, e.g. a dev server's hot reload. */
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => socket.destroy())
    tunnels.add(socket)
    socket.on('close', () => tunnels.delete(socket))
    const url = new URL(req.url ?? '/', 'http://preview.invalid')
    if (url.pathname.startsWith(RESERVED_PREFIX)) return refuseUpgrade(socket, 404)
    // Only the preview's own pages may open its sockets (the cookie is SameSite=None).
    const origin = req.headers.origin
    if (origin) {
      let o: string
      try {
        o = new URL(origin).host
      } catch {
        return refuseUpgrade(socket, 403)
      }
      if (o !== hostOf(req).toLowerCase()) return refuseUpgrade(socket, 403)
    }
    const r = await resolve(req)
    if (!r.ok) return refuseUpgrade(socket, r.status)
    const upstream: Socket = connect({ host: r.target.host, port: r.target.port })
    tunnels.add(upstream)
    upstream.on('close', () => tunnels.delete(upstream))
    const fail = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', () => {
      if (!socket.destroyed) refuseUpgrade(socket, 502)
      upstream.destroy()
    })
    socket.on('close', () => upstream.destroy())
    upstream.on('connect', () => {
      const headers = upstreamHeaders(req, r.grant.port, true)
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
      for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      // The answer's head goes through the same Set-Cookie filter as normal responses.
      let buf = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) {
          if (buf.length > 64 * 1024) fail()
          return
        }
        upstream.off('data', onData)
        const [status, ...rest] = buf.subarray(0, end).toString('latin1').split('\r\n')
        const kept = rest.filter((l) => {
          const i = l.indexOf(':')
          const name = l.slice(0, i).trim().toLowerCase()
          return name !== 'set-cookie' || allowedSetCookie(l.slice(i + 1).trim())
        })
        socket.write(`${[status, ...kept].join('\r\n')}\r\n\r\n`)
        const tail = buf.subarray(end + 4)
        if (tail.length) socket.write(tail)
        upstream.pipe(socket)
        socket.pipe(upstream)
      }
      upstream.on('data', onData)
    })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error('preview request failed', { err: errorMessage(e) })
      if (!res.headersSent) page(req, res, 500, 'internal error')
      else res.destroy()
    })
  })
  server.on('upgrade', (req, socket, head) => {
    upgrade(req, socket, head).catch((e) => {
      log.error('preview upgrade failed', { err: errorMessage(e) })
      socket.destroy()
    })
  })
  return {
    server,
    close() {
      agent.destroy()
      for (const t of tunnels) t.destroy()
      tunnels.clear()
    },
  }
}
