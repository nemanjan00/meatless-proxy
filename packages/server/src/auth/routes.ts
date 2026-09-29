import type * as Api from '@mp/api'
import { DeniedError, LimitError, errorMessage } from '@mp/core'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Services } from '../services.ts'
import { createMcpToken } from '../tokens.ts'
import { BadRequestError, jsonBody } from '../http/util.ts'
import { getApiToken, listApiTokens, revokeApiToken } from './api-tokens.ts'
import {
  SESSION_COOKIE,
  clearSessionCookies,
  clientAddress,
  principalOf,
  secureCookies,
  setSessionCookies,
  type Principal,
} from './guard.ts'
import { OidcClient, openCookie, sealCookie, type OidcPending } from './oidc.ts'
import { RateLimiter } from './rate-limit.ts'
import {
  SESSION_TTL_MS,
  consumeLoginLink,
  contactByEmail,
  createAuthSession,
  createLoginLink,
  endAuthSession,
  findContact,
} from './sessions.ts'
import { accessOf } from './access.ts'

const OIDC_COOKIE = 'mp_oidc'

export interface AuthRoutesOptions {
  /** A key for signing the OIDC state cookie (SECRETS_KEY, or a random one per process). */
  cookieKey: string
  /** Replaces `fetch` for the OIDC provider (tests). */
  fetch?: typeof fetch
  /** Failed sign-in attempts per client address per minute before it is refused. Default 20. */
  loginLimit?: number
}

/** A local path to go to after signing in (never another site). */
export function safeNext(next: string | undefined): string {
  if (!next?.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  if (next.startsWith('/auth/') || next.startsWith('/login')) return '/'
  return next
}

const loginError = (c: Context, code: string) => c.redirect(`/login?error=${encodeURIComponent(code)}`, 303)

/**
 * Sign-in, sign-out and token routes:
 * - `GET /auth/login?token=&next=`: a one-time link becomes a session cookie
 * - `GET /auth/oidc/start?next=` and `GET /auth/oidc/callback`: OIDC (when configured)
 * - `GET /api/auth/config`: what the login page offers (public)
 * - `GET /api/me`, `POST /api/auth/logout`
 * - `GET|POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id`: API tokens (others' tokens: admins)
 * - `POST /api/auth/links`: a sign-in link for someone (admins)
 */
export function authRoutes(s: Services, opts: AuthRoutesOptions): Hono {
  const app = new Hono()
  const cfg = s.config
  const now = () => s.clock.now()
  const logins = new RateLimiter(opts.loginLimit ?? 20, 60_000, now)
  const issuing = new RateLimiter(30, 60_000, now)
  const oidc =
    cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID && cfg.OIDC_CLIENT_SECRET && cfg.OIDC_REDIRECT_URL
      ? new OidcClient(
          {
            issuer: cfg.OIDC_ISSUER,
            clientId: cfg.OIDC_CLIENT_ID,
            clientSecret: cfg.OIDC_CLIENT_SECRET,
            redirectUrl: cfg.OIDC_REDIRECT_URL,
          },
          { ...(opts.fetch ? { fetch: opts.fetch } : {}), now },
        )
      : null

  /** Brute-force protection: an address with too many failed sign-ins in a minute is refused for a while. */
  const blocked = (c: Context) => {
    const addr = clientAddress(c, cfg.TRUST_PROXY)
    if (!logins.blocked(addr)) return false
    c.header('retry-after', String(logins.retryAfter(addr)))
    return true
  }
  const failed = (c: Context, code: string) => {
    logins.hit(clientAddress(c, cfg.TRUST_PROXY))
    return loginError(c, code)
  }

  const startSession = async (c: Context, contactId: string, via: 'link' | 'oidc', next: string) => {
    const id = await createAuthSession(s, contactId, via)
    setSessionCookies(c, s, id, Math.floor(SESSION_TTL_MS / 1000))
    s.logger.info('signed in', { contactId, via })
    return c.redirect(safeNext(next), 303)
  }

  // ── Sign-in links ────────────────────────────────────────────────────────

  app.get('/auth/login', async (c) => {
    if (blocked(c)) return loginError(c, 'too_many_attempts')
    const token = c.req.query('token') ?? ''
    const contactId = token ? await consumeLoginLink(s, token) : null
    if (!contactId) return failed(c, 'invalid_link')
    return startSession(c, contactId, 'link', c.req.query('next') ?? '/')
  })

  app.post('/api/auth/links', async (c) => {
    const me = principalOf(c)
    if (!issuing.hit(me.contactId)) throw new LimitError('too many sign-in links, try again in a minute')
    const body = await jsonBody<{ contactId?: unknown; email?: unknown }>(c)
    const who = typeof body.contactId === 'string' ? body.contactId : typeof body.email === 'string' ? body.email : ''
    if (!who) throw new BadRequestError('contactId or email is required')
    const contactId = await findContact(s, who)
    if (!contactId) throw new BadRequestError(`no contact ${who}`)
    const link = await createLoginLink(s, contactId, { createdBy: me.contactId })
    s.logger.info('sign-in link created', { contactId, by: me.contactId })
    return c.json({ contactId, url: link.url, expiresAt: link.expiresAt } satisfies Api.LoginLink, 201)
  })

  // ── OIDC ─────────────────────────────────────────────────────────────────

  app.get('/api/auth/config', (c) => c.json({ oidc: !!oidc } satisfies Api.AuthConfig))

  app.get('/auth/oidc/start', async (c) => {
    if (!oidc) return loginError(c, 'oidc_off')
    if (blocked(c)) return loginError(c, 'too_many_attempts')
    try {
      const { url, pending } = await oidc.start(safeNext(c.req.query('next')))
      setCookie(c, OIDC_COOKIE, sealCookie(pending, opts.cookieKey), {
        httpOnly: true,
        secure: secureCookies(c, s),
        sameSite: 'Lax',
        path: '/auth/oidc',
        maxAge: 600,
      })
      return c.redirect(url, 302)
    } catch (err) {
      s.logger.warn('oidc start failed', { err: errorMessage(err) })
      return loginError(c, 'oidc_unavailable')
    }
  })

  app.get('/auth/oidc/callback', async (c) => {
    if (!oidc) return loginError(c, 'oidc_off')
    if (blocked(c)) return loginError(c, 'too_many_attempts')
    const pending = openCookie<OidcPending>(getCookie(c, OIDC_COOKIE), opts.cookieKey)
    setCookie(c, OIDC_COOKIE, '', { path: '/auth/oidc', maxAge: 0 })
    let email: string
    try {
      const q = c.req.query()
      email = (await oidc.finish({ ...q }, pending)).email
    } catch (err) {
      s.logger.warn('oidc sign-in failed', { err: errorMessage(err) })
      return failed(c, 'oidc_failed')
    }
    const contact = await contactByEmail(s, email)
    if (!contact || !accessOf(contact)) {
      // Nobody is created: an admin adds the person to the directory first.
      s.logger.info('oidc sign-in refused: no contact with that email')
      return failed(c, 'unknown_user')
    }
    return startSession(c, contact.id, 'oidc', pending?.next ?? '/')
  })

  // ── Current user and sign-out ───────────────────────────────────────────

  app.get('/api/me', (c) => {
    const p = principalOf(c)
    return c.json({
      contactId: p.contactId,
      name: p.name,
      access: p.access,
      ...(p.email ? { email: p.email } : {}),
      via: p.via,
      deployment: { defaultNetwork: cfg.DEFAULT_NETWORK, directNetwork: cfg.DOCKER_DIRECT_NETWORK },
    } satisfies Api.Me)
  })

  app.post('/api/auth/logout', async (c) => {
    const p = principalOf(c)
    const cookie = getCookie(c, SESSION_COOKIE)
    if (p.via === 'session' && cookie) await endAuthSession(s, cookie)
    clearSessionCookies(c, s)
    return c.body(null, 204)
  })

  // ── API tokens (the same tokens as MCP tokens) ──────────────────────────

  /** The contact a token request is for: yourself, or anyone for admins. */
  const tokenOwner = (p: Principal, contactId: unknown): string => {
    if (contactId === undefined || contactId === null || contactId === '' || contactId === p.contactId) return p.contactId
    if (typeof contactId !== 'string') throw new BadRequestError('contactId must be a string')
    if (p.access !== 'admin') throw new DeniedError("only admins can manage other people's tokens")
    return contactId
  }

  app.get('/api/auth/tokens', async (c) => {
    const p = principalOf(c)
    const all = c.req.query('all') === 'true'
    if (all && p.access !== 'admin') throw new DeniedError('only admins can list every token')
    const list = await listApiTokens(s, all ? undefined : tokenOwner(p, c.req.query('contactId')))
    return c.json(list satisfies Api.ApiToken[])
  })

  const createToken = async (c: Context) => {
    const p = principalOf(c)
    if (!issuing.hit(p.contactId)) throw new LimitError('too many new tokens, try again in a minute')
    const body = await jsonBody<{ contactId?: unknown; name?: unknown }>(c)
    const contactId = tokenOwner(p, body.contactId)
    if (body.name !== undefined && typeof body.name !== 'string') throw new BadRequestError('name must be a string')
    const contact = await s.directory.contacts.require(contactId)
    if (!accessOf(contact)) throw new DeniedError('tokens are for people: AI employees act with their own permissions')
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : undefined
    const t = await createMcpToken(s, contactId, name)
    s.logger.info('api token created', { tokenId: t.id, contactId, by: p.contactId })
    return c.json({ ...(await getApiToken(s, t.id)), token: t.token } satisfies Api.CreatedApiToken, 201)
  }
  app.post('/api/auth/tokens', createToken)
  app.post('/api/mcp/tokens', createToken)

  app.delete('/api/auth/tokens/:id', async (c) => {
    const p = principalOf(c)
    const t = await getApiToken(s, c.req.param('id'))
    tokenOwner(p, t.contactId)
    const r = await revokeApiToken(s, t.id)
    s.logger.info('api token revoked', { tokenId: t.id, by: p.contactId })
    return c.json(r satisfies Api.ApiToken)
  })

  return app
}
