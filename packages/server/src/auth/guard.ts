import { timingSafeEqual } from 'node:crypto'
import { DeniedError, LimitError, MpError } from '@mp/core'
import type { ContactData } from '@mp/directory'
import type { StoredRecord } from '@mp/store'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Services } from '../services.ts'
import { contactForToken } from '../tokens.ts'
import { type Access, accessOf, atLeast } from './access.ts'
import { RateLimiter } from './rate-limit.ts'
import { resolveAuthSession } from './sessions.ts'

/** The session cookie: httpOnly, SameSite=Lax, Path=/, Secure over https. */
export const SESSION_COOKIE = 'mp_session'
/** The double-submit CSRF cookie (readable by the page, which echoes it in `x-mp-csrf`). */
export const CSRF_COOKIE = 'mp_csrf'
export const CSRF_HEADER = 'x-mp-csrf'

/** Who is making a request: always a signed-in person, never a caller's word. */
export interface Principal {
  contactId: string
  name: string
  email?: string
  access: Access
  /** A session cookie (web UI) or a bearer token (scripts, agents, MCP). */
  via: 'session' | 'token'
}

export class UnauthorizedError extends MpError {
  constructor(message = 'sign in first') {
    super('unauthorized', message)
  }
}

const PRINCIPAL = 'mp.principal'

/** The signed-in principal of a request. Throws 401 when there is none (only on public routes). */
export function principalOf(c: Context): Principal {
  const p = c.get(PRINCIPAL as never) as Principal | undefined
  if (!p) throw new UnauthorizedError()
  return p
}

/** The principal, or undefined on public routes without credentials. */
export const maybePrincipal = (c: Context): Principal | undefined => c.get(PRINCIPAL as never) as Principal | undefined

// ── The guard table ─────────────────────────────────────────────────────────

/** What a route needs: nothing (`public`, it checks credentials itself if any), or at least this access. */
export type Need = 'public' | Access

export interface GuardContext {
  c: Context
  principal: Principal
  params: Record<string, string>
  s: Services
}

export interface GuardRule {
  method: string
  /** `:name` matches one segment, a trailing `*` anything. */
  path: string
  need: Need | ((params: Record<string, string>) => Need)
  /** An extra check after the access check, e.g. "their own work". Throws to refuse. */
  check?: (g: GuardContext) => Promise<void>
}

/** Record kinds members may edit: knowledge. Every other kind (employees, triggers, settings, …) is for admins. */
export const KNOWLEDGE_KINDS = new Set(['contact', 'project', 'procedure', 'memory', 'skill', 'doc', 'template'])
/** Kinds whose records members may link from (knowledge, and sessions). */
const LINKABLE_KINDS = new Set([...KNOWLEDGE_KINDS, 'session'])

const knowledge = (p: Record<string, string>): Need => (KNOWLEDGE_KINDS.has(p.kind ?? '') ? 'member' : 'admin')

/** Members may pause, resume and cancel runs they asked for. Admins any run. */
const ownRun = async ({ principal, params, s }: GuardContext) => {
  if (principal.access === 'admin') return
  const run = await s.sessions.getRun(params.id ?? '')
  if (!run) return // the handler answers 404
  if (run.data.requesterId !== principal.contactId) throw new DeniedError('only admins can steer work someone else asked for')
}

/**
 * Every route and what it needs, first match wins. Anything not listed
 * needs `viewer` for GET and `admin` otherwise, so a new route is closed
 * until it is listed here.
 */
export const GUARD_RULES: GuardRule[] = [
  // Public: health, sign-in, webhooks (their signature is the auth), MCP (own bearer auth), metrics (own check).
  { method: 'GET', path: '/healthz', need: 'public' },
  { method: 'GET', path: '/readyz', need: 'public' },
  { method: '*', path: '/auth/*', need: 'public' },
  { method: 'GET', path: '/api/auth/config', need: 'public' },
  { method: '*', path: '/webhooks/*', need: 'public' },
  { method: '*', path: '/mcp', need: 'public' },
  { method: 'GET', path: '/metrics', need: 'public' },

  // Your own sign-in and tokens (tokens for others: admins, checked by the handler).
  { method: 'GET', path: '/api/me', need: 'viewer' },
  { method: 'POST', path: '/api/auth/logout', need: 'viewer' },
  { method: 'GET', path: '/api/auth/tokens', need: 'viewer' },
  { method: 'POST', path: '/api/auth/tokens', need: 'viewer' },
  { method: 'DELETE', path: '/api/auth/tokens/:id', need: 'viewer' },
  { method: 'POST', path: '/api/mcp/tokens', need: 'viewer' },
  { method: 'POST', path: '/api/auth/links', need: 'admin' },

  // Admin: secrets (even their names), employees, the kill switch, import and export.
  { method: '*', path: '/api/secrets', need: 'admin' },
  { method: '*', path: '/api/secrets/*', need: 'admin' },
  { method: '*', path: '/api/employees/*', need: 'admin' },
  { method: 'POST', path: '/api/control/*', need: 'admin' },
  { method: '*', path: '/api/import', need: 'admin' },
  { method: '*', path: '/api/import/*', need: 'admin' },
  { method: '*', path: '/api/export', need: 'admin' },
  { method: '*', path: '/api/export/*', need: 'admin' },
  { method: 'POST', path: '/api/events', need: 'admin' },

  // Knowledge edits: members for knowledge kinds; employees, triggers, limits, settings: admins.
  // A session's document and title are knowledge too (its other fields, e.g. its tools, are not: see api.ts).
  { method: 'PATCH', path: '/api/records/session/:id', need: 'member' },
  { method: 'POST', path: '/api/records/:kind', need: knowledge },
  { method: 'PATCH', path: '/api/records/:kind/:id', need: knowledge },
  { method: 'DELETE', path: '/api/records/:kind/:id', need: knowledge },
  {
    method: 'POST',
    path: '/api/records/:kind/:id/links',
    need: (p) => (LINKABLE_KINDS.has(p.kind ?? '') ? 'member' : 'admin'),
  },
  { method: 'DELETE', path: '/api/links/:id', need: 'member' },
  { method: 'PUT', path: '/api/files/:employeeId/content', need: 'member' },

  // Chat, messages to sessions, forks, and steering one's own work. Marking read is your own state.
  { method: 'POST', path: '/api/chat/read', need: 'viewer' },
  { method: 'POST', path: '/api/chat/*', need: 'member' },
  { method: 'PATCH', path: '/api/chat/*', need: 'member' },
  { method: 'DELETE', path: '/api/chat/*', need: 'member' },
  { method: 'POST', path: '/api/sessions/:id/message', need: 'member' },
  { method: 'POST', path: '/api/sessions/:id/fork', need: 'member' },
  { method: 'POST', path: '/api/runs/:id/pause', need: 'member', check: ownRun },
  { method: 'POST', path: '/api/runs/:id/resume', need: 'member', check: ownRun },
  { method: 'POST', path: '/api/runs/:id/cancel', need: 'member', check: ownRun },

  // Reading: everything else, for everyone signed in (secrets are above).
  { method: 'GET', path: '/api/*', need: 'viewer' },
  { method: 'GET', path: '/ws', need: 'viewer' },
]

export interface CompiledRule extends GuardRule {
  re: RegExp
  names: string[]
}

/** Compiles a guard table for `matchRule`. */
export function compileRules(rules: GuardRule[]): CompiledRule[] {
  return rules.map((r) => {
    const names: string[] = []
    const body = r.path
      .split('/')
      .map((seg) => {
        if (seg === '*') return '.*'
        if (seg.startsWith(':')) {
          names.push(seg.slice(1))
          return '([^/]+)'
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      })
      .join('/')
    return { ...r, re: new RegExp(`^${body}$`), names }
  })
}

/** The matching rule and its path parameters. `null` means the path isn't an API path (the web UI: public). */
export function matchRule(
  rules: CompiledRule[],
  method: string,
  path: string,
): { rule: GuardRule; params: Record<string, string> } | null {
  const m = method === 'HEAD' ? 'GET' : method
  for (const r of rules) {
    if (r.method !== '*' && r.method !== m) continue
    const hit = r.re.exec(path)
    if (!hit) continue
    const params: Record<string, string> = {}
    r.names.forEach((n, i) => {
      params[n] = decodeURIComponent(hit[i + 1]!)
    })
    return { rule: r, params }
  }
  if (path.startsWith('/api/') || path === '/ws')
    return { rule: { method: m, path, need: m === 'GET' ? 'viewer' : 'admin' }, params: {} }
  return null
}

// ── Credentials ─────────────────────────────────────────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface GuardOptions {
  rules?: GuardRule[]
  /** Failed credential checks per client address per minute before it gets 429s. Default 30. */
  maxFailures?: number
}

/** The client's address: the socket's, or the first `x-forwarded-for` hop with `TRUST_PROXY`. */
export function clientAddress(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (fwd) return fwd
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  return env?.incoming?.socket?.remoteAddress ?? 'local'
}

/** Whether cookies should be `Secure` for this request. */
export function secureCookies(c: Context, s: Services): boolean {
  const mode = s.config.COOKIE_SECURE
  if (mode === 'true') return true
  if (mode === 'false') return false
  if (s.config.PUBLIC_URL) return s.config.PUBLIC_URL.startsWith('https:')
  if (new URL(c.req.url).protocol === 'https:') return true
  return s.config.TRUST_PROXY && c.req.header('x-forwarded-proto') === 'https'
}

/** Sets the session and CSRF cookies. */
export function setSessionCookies(c: Context, s: Services, sessionId: string, maxAgeS: number) {
  const secure = secureCookies(c, s)
  setCookie(c, SESSION_COOKIE, sessionId, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: maxAgeS })
  const csrf = getCookie(c, CSRF_COOKIE) || randomToken()
  setCookie(c, CSRF_COOKIE, csrf, { httpOnly: false, secure, sameSite: 'Lax', path: '/', maxAge: maxAgeS })
}

export function clearSessionCookies(c: Context, s: Services) {
  const secure = secureCookies(c, s)
  for (const name of [SESSION_COOKIE, CSRF_COOKIE])
    setCookie(c, name, '', { httpOnly: name === SESSION_COOKIE, secure, sameSite: 'Lax', path: '/', maxAge: 0 })
}

function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The bearer token of a request, if any. */
export const bearerOf = (c: Context): string | null => {
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')
  return m ? m[1]!.trim() : null
}

/**
 * The origin a cookie-authenticated unsafe request must come from: `PUBLIC_URL`,
 * else the request's own host.
 */
function originAllowed(c: Context, s: Services, origin: string): boolean {
  let o: URL
  try {
    o = new URL(origin)
  } catch {
    return false
  }
  if (s.config.PUBLIC_URL) return o.origin === new URL(s.config.PUBLIC_URL).origin
  const host = c.req.header('host') ?? new URL(c.req.url).host
  return o.host === host
}

/**
 * CSRF protection for cookie-authenticated unsafe requests: the `Origin`
 * header must match the public origin, or the `x-mp-csrf` header must repeat
 * the `mp_csrf` cookie. WebSocket upgrades must come from the public origin
 * (browsers always send `Origin` there).
 */
export function checkCsrf(c: Context, s: Services): void {
  const origin = c.req.header('origin')
  const upgrade = c.req.header('upgrade')?.toLowerCase() === 'websocket'
  if (upgrade) {
    if (origin && !originAllowed(c, s, origin)) throw new DeniedError('cross-site WebSocket refused')
    return
  }
  if (SAFE_METHODS.has(c.req.method)) return
  if (origin && origin !== 'null' && originAllowed(c, s, origin)) return
  const cookie = getCookie(c, CSRF_COOKIE)
  const header = c.req.header(CSRF_HEADER)
  if (cookie && header && safeEqual(cookie, header)) return
  throw new DeniedError('cross-site request refused (send it from the web UI, or use a bearer token)')
}

async function principalFor(s: Services, contactId: string, via: Principal['via']): Promise<Principal | null> {
  const contact = (await s.directory.contacts.get(contactId)) as StoredRecord<ContactData> | null
  const access = accessOf(contact)
  if (!contact || !access) return null
  return {
    contactId,
    name: contact.data.name,
    ...(contact.data.email ? { email: contact.data.email } : {}),
    access,
    via,
  }
}

/**
 * The principal behind a request's credentials: `Authorization: Bearer <api token>`,
 * or the `mp_session` cookie (rotated and re-set when due). Null when there are none
 * or they don't check out.
 */
export async function authenticate(c: Context, s: Services): Promise<Principal | null> {
  const bearer = bearerOf(c)
  if (bearer) {
    const contactId = await contactForToken(s.records, bearer)
    return contactId ? principalFor(s, contactId, 'token') : null
  }
  const cookie = getCookie(c, SESSION_COOKIE)
  if (!cookie) return null
  const session = await resolveAuthSession(s, cookie)
  if (!session) return null
  const p = await principalFor(s, session.contactId, 'session')
  if (p && session.rotated) setSessionCookies(c, s, session.rotated, 14 * 24 * 3600)
  return p
}

/**
 * The one place access is enforced: resolves who is calling, refuses
 * cross-site cookie requests, and checks the route's rule in `GUARD_RULES`.
 * Public paths (sign-in, health, webhooks, MCP, metrics and the web UI) pass
 * through, with the principal set when credentials came along.
 */
export function guard(s: Services, opts: GuardOptions = {}): MiddlewareHandler {
  const rules = compileRules(opts.rules ?? GUARD_RULES)
  const failures = new RateLimiter(opts.maxFailures ?? 30, 60_000, () => s.clock.now())
  return async (c, next) => {
    const hit = matchRule(rules, c.req.method, c.req.path)
    const need = hit ? (typeof hit.rule.need === 'function' ? hit.rule.need(hit.params) : hit.rule.need) : 'public'
    const hasCredentials = !!bearerOf(c) || !!getCookie(c, SESSION_COOKIE)
    // Public routes don't look at credentials (the web UI, sign-in, webhooks and /mcp, which checks its own),
    // except /metrics, which admins may read.
    if (hasCredentials && (need !== 'public' || c.req.path === '/metrics')) {
      const addr = clientAddress(c, s.config.TRUST_PROXY)
      if (failures.blocked(addr)) {
        c.header('retry-after', String(failures.retryAfter(addr)))
        throw new LimitError('too many failed sign-in attempts, try again in a minute')
      }
      const p = await authenticate(c, s)
      if (p) {
        if (p.via === 'session') checkCsrf(c, s)
        c.set(PRINCIPAL as never, p as never)
      } else if (need !== 'public') {
        failures.hit(addr)
        throw new UnauthorizedError('your sign-in has expired or the token is not valid')
      }
    }
    if (need === 'public') return next()
    const p = maybePrincipal(c)
    if (!p) throw new UnauthorizedError()
    if (!atLeast(p.access, need))
      throw new DeniedError(`${need === 'admin' ? 'admins' : 'members'} only: you are signed in as a ${p.access}`)
    if (hit?.rule.check) await hit.rule.check({ c, principal: p, params: hit.params, s })
    return next()
  }
}
