import { createHash, randomBytes } from 'node:crypto'
import type { Hono, MiddlewareHandler } from 'hono'
import type { Services } from '../services.ts'
import { defineAuthKinds } from './access.ts'
import { guard, type GuardOptions } from './guard.ts'
import { securityHeaders } from './headers.ts'
import { authRoutes } from './routes.ts'
import { ChatVisibility } from './visibility.ts'

export { ACCESS_LEVELS, AUTH_KINDS, accessField, accessOf, atLeast, defineAuthKinds, type Access } from './access.ts'
export { listApiTokens, revokeApiToken, type ApiTokenInfo } from './api-tokens.ts'
export { ensureAdmin, type AdminBootstrap } from './bootstrap-admin.ts'
export {
  CSRF_COOKIE,
  CSRF_HEADER,
  GUARD_RULES,
  KNOWLEDGE_KINDS,
  SESSION_COOKIE,
  UnauthorizedError,
  maybePrincipal,
  principalOf,
  type GuardRule,
  type Principal,
} from './guard.ts'
export { contentSecurityPolicy, securityHeaders } from './headers.ts'
export { OidcClient, OidcError, type OidcSettings } from './oidc.ts'
export { RateLimiter } from './rate-limit.ts'
export {
  LOGIN_LINK_TTL_MS,
  SESSION_ROTATE_MS,
  SESSION_TTL_MS,
  consumeLoginLink,
  createAuthSession,
  createLoginLink,
  findContact,
  publicOrigin,
  resolveAuthSession,
} from './sessions.ts'
export { ChatVisibility } from './visibility.ts'

export interface AuthOptions extends GuardOptions {
  /** Replaces `fetch` for the OIDC provider (tests). */
  fetch?: typeof fetch
  /** Failed sign-in attempts per client address per minute before it is refused. Default 20. */
  loginLimit?: number
}

export interface Auth {
  /** Security headers, then the guard: mount first, on every path. */
  middleware: MiddlewareHandler[]
  /** Sign-in, sign-out, current user and token routes. */
  routes: Hono
  visibility: ChatVisibility
}

/** Sign-in and access control for the HTTP app (see docs/spec.md "Sign-in and roles"). */
export function createAuth(s: Services, opts: AuthOptions = {}): Auth {
  defineAuthKinds(s.records)
  // A key of its own for the OIDC state cookie, derived from SECRETS_KEY so every instance agrees.
  const cookieKey = s.config.SECRETS_KEY
    ? createHash('sha256').update(`mp oidc state cookie\0${s.config.SECRETS_KEY}`).digest('hex')
    : randomBytes(32).toString('hex')
  return {
    middleware: [securityHeaders(s.config), guard(s, opts)],
    routes: authRoutes(s, {
      cookieKey,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.loginLimit ? { loginLimit: opts.loginLimit } : {}),
    }),
    visibility: new ChatVisibility(s),
  }
}
