import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Preview tokens and preview cookies (docs/spec.md "Live previews"). Both are signed with HMAC-SHA256
 * under keys of their own, derived from SECRETS_KEY (so every instance agrees), and scoped to one
 * environment, one port and one viewer.
 *
 * - A **token** lives about 5 minutes and works once: the UI mints it for the signed-in viewer and
 *   the preview origin exchanges it for its cookie.
 * - A **cookie** lives 12 hours, sliding: it is re-issued while it is used.
 *
 * The two use different keys, so one can never stand in for the other.
 */

/** How long a preview token is valid. */
export const PREVIEW_TOKEN_TTL_MS = 5 * 60_000
/** How long a preview cookie is valid after it was last (re-)issued. */
export const PREVIEW_COOKIE_TTL_MS = 12 * 3600_000
/** A cookie older than this is re-issued with a fresh expiry when it is used. */
export const PREVIEW_COOKIE_REFRESH_MS = 10 * 60_000

/** What a token or cookie grants: one port of one environment, to one viewer. */
export interface PreviewScope {
  envId: string
  port: number
  /** The viewer's contact id. */
  contactId: string
  /**
   * A desktop viewer (the noVNC page on the preview origin, at `desktopPath`) rather than the app on
   * the port. Its cookie is scoped to that path, and it opens nothing else.
   */
  desktop?: boolean
}

export interface PreviewGrant extends PreviewScope {
  /** Epoch ms. */
  issuedAt: number
  expiresAt: number
  /** Tokens only: makes each one single-use. */
  nonce?: string
}

export type VerifyResult =
  | { ok: true; grant: PreviewGrant }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'used' }

const TOKEN_PREFIX = 'mpp_'

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** Derives a key for one purpose from the secrets key. */
export function deriveKey(secretsKey: string, purpose: string): Buffer {
  return createHash('sha256').update(`mp ${purpose}\0${secretsKey}`).digest()
}

interface Wire {
  e: string
  p: number
  c: string
  i: number
  x: number
  n?: string
  d?: 1
}

function sign(key: Buffer, g: PreviewGrant): string {
  const wire: Wire = {
    e: g.envId,
    p: g.port,
    c: g.contactId,
    i: g.issuedAt,
    x: g.expiresAt,
    ...(g.nonce ? { n: g.nonce } : {}),
    ...(g.desktop ? { d: 1 as const } : {}),
  }
  const body = b64(JSON.stringify(wire))
  return `${body}.${b64(createHmac('sha256', key).update(body).digest())}`
}

function open(key: Buffer, value: string, now: number): VerifyResult {
  const [body, mac, extra] = value.split('.')
  if (!body || !mac || extra !== undefined) return { ok: false, reason: 'malformed' }
  const want = createHmac('sha256', key).update(body).digest()
  const got = Buffer.from(mac, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'signature' }
  let w: Wire
  try {
    w = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Wire
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (
    typeof w.e !== 'string' ||
    !w.e ||
    !Number.isInteger(w.p) ||
    typeof w.c !== 'string' ||
    !w.c ||
    typeof w.x !== 'number' ||
    typeof w.i !== 'number'
  )
    return { ok: false, reason: 'malformed' }
  if (now >= w.x) return { ok: false, reason: 'expired' }
  return {
    ok: true,
    grant: {
      envId: w.e,
      port: w.p,
      contactId: w.c,
      issuedAt: w.i,
      expiresAt: w.x,
      ...(w.n ? { nonce: w.n } : {}),
      ...(w.d === 1 ? { desktop: true } : {}),
    },
  }
}

export interface PreviewSignerOptions {
  /** SECRETS_KEY. Without it the keys are random per process (tokens don't survive a restart). */
  secretsKey?: string
  now: () => number
  tokenTtlMs?: number
  cookieTtlMs?: number
}

/** Mints and checks preview tokens and cookies. */
export class PreviewSigner {
  private tokenKey: Buffer
  private cookieKey: Buffer
  private used = new Map<string, number>()
  readonly tokenTtlMs: number
  readonly cookieTtlMs: number

  constructor(private opts: PreviewSignerOptions) {
    // One random fallback for both, so a missing SECRETS_KEY still gives distinct derived keys.
    const base = opts.secretsKey ?? randomBytes(32).toString('hex')
    this.tokenKey = deriveKey(base, 'preview token')
    this.cookieKey = deriveKey(base, 'preview cookie')
    this.tokenTtlMs = opts.tokenTtlMs ?? PREVIEW_TOKEN_TTL_MS
    this.cookieTtlMs = opts.cookieTtlMs ?? PREVIEW_COOKIE_TTL_MS
  }

  /** A short-lived, single-use token for `scope`. */
  token(scope: PreviewScope): { token: string; expiresAt: number } {
    const now = this.opts.now()
    const expiresAt = now + this.tokenTtlMs
    const nonce = randomBytes(12).toString('base64url')
    return { token: TOKEN_PREFIX + sign(this.tokenKey, { ...scope, issuedAt: now, expiresAt, nonce }), expiresAt }
  }

  /** Checks a token without using it up. */
  checkToken(token: string): VerifyResult {
    if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: 'malformed' }
    const r = open(this.tokenKey, token.slice(TOKEN_PREFIX.length), this.opts.now())
    if (r.ok && (!r.grant.nonce || this.used.has(r.grant.nonce)))
      return { ok: false, reason: r.grant.nonce ? 'used' : 'malformed' }
    return r
  }

  /** Checks a token and uses it up: the same token never works twice (on this instance). */
  redeemToken(token: string): VerifyResult {
    const r = this.checkToken(token)
    if (!r.ok) return r
    const now = this.opts.now()
    for (const [n, exp] of this.used) if (exp <= now) this.used.delete(n)
    this.used.set(r.grant.nonce!, r.grant.expiresAt)
    return r
  }

  /** A preview cookie value for `scope`, valid for `cookieTtlMs` from now. */
  cookie(scope: PreviewScope): string {
    const now = this.opts.now()
    return sign(this.cookieKey, {
      envId: scope.envId,
      port: scope.port,
      contactId: scope.contactId,
      issuedAt: now,
      expiresAt: now + this.cookieTtlMs,
      ...(scope.desktop ? { desktop: true } : {}),
    })
  }

  checkCookie(value: string): VerifyResult {
    return open(this.cookieKey, value, this.opts.now())
  }

  /** Whether a cookie should be re-issued (sliding expiry). */
  dueForRefresh(grant: PreviewGrant): boolean {
    return this.opts.now() - grant.issuedAt >= PREVIEW_COOKIE_REFRESH_MS
  }
}
