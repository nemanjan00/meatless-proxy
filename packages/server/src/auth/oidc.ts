import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'

/** A JSON Web Key as found in a JWKS. */
type Jwk = { kty?: string; kid?: string; alg?: string; use?: string; crv?: string } & Record<string, unknown>

/**
 * A small OpenID Connect client: authorization code flow with PKCE (S256),
 * discovery, and id_token verification against the provider's JWKS (RS256
 * and ES256). No dependency: `fetch` and `node:crypto` only.
 */
export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  /** Our callback, e.g. `https://mp.example.com/auth/oidc/callback`. Must be registered with the provider. */
  redirectUrl: string
}

export interface OidcDeps {
  fetch?: typeof fetch
  now?: () => number
}

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
  token_endpoint_auth_methods_supported?: string[]
}

/** What `start()` returns and `finish()` needs back: kept in a signed cookie between the two. */
export interface OidcPending {
  state: string
  nonce: string
  verifier: string
  /** Where to go after signing in (a local path). */
  next: string
  /** Expiry, ms since the epoch. */
  exp: number
}

export interface OidcIdentity {
  sub: string
  email: string
}

export class OidcError extends Error {
  override readonly name = 'OidcError'
}

const SKEW_S = 60
const DISCOVERY_TTL_MS = 3600_000
const JWKS_REFRESH_MIN_MS = 60_000
const PENDING_TTL_MS = 10 * 60_000

const b64url = (b: Buffer) => b.toString('base64url')
const trimSlash = (s: string) => s.replace(/\/+$/, '')

export class OidcClient {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private discovered: { at: number; doc: Discovery } | null = null
  private jwks: { at: number; keys: Jwk[] } | null = null

  constructor(
    readonly settings: OidcSettings,
    deps: OidcDeps = {},
  ) {
    this.fetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
    this.now = deps.now ?? Date.now
  }

  /** The provider's metadata from `/.well-known/openid-configuration`, cached for an hour. */
  async discovery(): Promise<Discovery> {
    if (this.discovered && this.now() - this.discovered.at < DISCOVERY_TTL_MS) return this.discovered.doc
    const url = `${trimSlash(this.settings.issuer)}/.well-known/openid-configuration`
    const doc = (await this.getJson(url)) as Partial<Discovery>
    if (!doc.issuer || trimSlash(doc.issuer) !== trimSlash(this.settings.issuer))
      throw new OidcError(`discovery: issuer ${doc.issuer} does not match ${this.settings.issuer}`)
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
      if (typeof doc[k] !== 'string') throw new OidcError(`discovery: ${k} is missing`)
    this.discovered = { at: this.now(), doc: doc as Discovery }
    return doc as Discovery
  }

  /** Builds the authorization URL and the state to keep until the callback. */
  async start(next = '/'): Promise<{ url: string; pending: OidcPending }> {
    const d = await this.discovery()
    const pending: OidcPending = {
      state: b64url(randomBytes(24)),
      nonce: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(32)),
      next,
      exp: this.now() + PENDING_TTL_MS,
    }
    const url = new URL(d.authorization_endpoint)
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUrl,
      scope: 'openid email profile',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: b64url(createHash('sha256').update(pending.verifier).digest()),
      code_challenge_method: 'S256',
    }
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return { url: url.toString(), pending }
  }

  /** Handles the callback: checks the state, exchanges the code, verifies the id_token and returns who signed in. */
  async finish(query: { code?: string; state?: string; error?: string }, pending: OidcPending | null): Promise<OidcIdentity> {
    if (query.error) throw new OidcError(`the provider refused: ${query.error}`)
    if (!pending || pending.exp <= this.now()) throw new OidcError('the sign-in took too long or was not started here')
    if (!query.state || !safeEqual(query.state, pending.state)) throw new OidcError('state does not match')
    if (!query.code) throw new OidcError('no code')
    const d = await this.discovery()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: this.settings.redirectUrl,
      code_verifier: pending.verifier,
      client_id: this.settings.clientId,
    })
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
    const methods = d.token_endpoint_auth_methods_supported
    if (!methods || methods.includes('client_secret_basic')) {
      const id = encodeURIComponent(this.settings.clientId)
      const secret = encodeURIComponent(this.settings.clientSecret)
      headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
    } else body.set('client_secret', this.settings.clientSecret)
    const res = await this.fetch(d.token_endpoint, { method: 'POST', headers, body: body.toString() })
    const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; access_token?: string; error?: string }
    if (!res.ok || !tokens.id_token) throw new OidcError(`token exchange failed: ${tokens.error ?? res.status}`)
    const claims = await this.verifyIdToken(tokens.id_token, pending.nonce)
    let email = typeof claims.email === 'string' ? claims.email : undefined
    let verified = claims.email_verified
    if (!email && d.userinfo_endpoint && tokens.access_token) {
      const info = (await this.getJson(d.userinfo_endpoint, { authorization: `Bearer ${tokens.access_token}` })) as Record<
        string,
        unknown
      >
      if (info.sub === claims.sub && typeof info.email === 'string') {
        email = info.email
        verified = info.email_verified
      }
    }
    if (!email) throw new OidcError('the provider did not share an email address')
    if (verified === false || verified === 'false') throw new OidcError('the email address is not verified')
    return { sub: String(claims.sub), email }
  }

  /** Verifies an id_token's signature (RS256 or ES256, key from the JWKS) and its claims. Returns the claims. */
  async verifyIdToken(token: string, nonce?: string): Promise<Record<string, unknown>> {
    const parts = token.split('.')
    if (parts.length !== 3) throw new OidcError('id_token is not a JWT')
    const [h, p, sig] = parts as [string, string, string]
    let header: { alg?: string; kid?: string }
    let claims: Record<string, unknown>
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
    } catch {
      throw new OidcError('id_token is not valid JSON')
    }
    if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new OidcError(`id_token alg ${header.alg} is not allowed`)
    const jwk = await this.key(header.kid, header.alg)
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    const data = Buffer.from(`${h}.${p}`)
    const signature = Buffer.from(sig, 'base64url')
    const ok =
      header.alg === 'RS256'
        ? verify('sha256', data, key, signature)
        : verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
    if (!ok) throw new OidcError('id_token signature is invalid')

    const d = await this.discovery()
    const now = Math.floor(this.now() / 1000)
    if (typeof claims.iss !== 'string' || trimSlash(claims.iss) !== trimSlash(d.issuer)) throw new OidcError('wrong issuer')
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(this.settings.clientId)) throw new OidcError('wrong audience')
    if (aud.length > 1 && claims.azp !== this.settings.clientId) throw new OidcError('wrong authorized party')
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) throw new OidcError('id_token expired')
    if (typeof claims.iat === 'number' && claims.iat - SKEW_S > now) throw new OidcError('id_token issued in the future')
    if (nonce !== undefined && (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)))
      throw new OidcError('nonce does not match')
    if (typeof claims.sub !== 'string' || !claims.sub) throw new OidcError('id_token has no subject')
    return claims
  }

  private async key(kid: string | undefined, alg: 'RS256' | 'ES256'): Promise<Jwk> {
    const kty = alg === 'RS256' ? 'RSA' : 'EC'
    const pick = () =>
      this.jwks?.keys.find(
        (k) =>
          k.kty === kty &&
          (kid === undefined || k.kid === kid) &&
          (k.use === undefined || k.use === 'sig') &&
          (k.alg === undefined || k.alg === alg) &&
          (alg !== 'ES256' || k.crv === 'P-256'),
      )
    let found = this.jwks ? pick() : undefined
    if (!found && (!this.jwks || this.now() - this.jwks.at >= JWKS_REFRESH_MIN_MS)) {
      const d = await this.discovery()
      const set = (await this.getJson(d.jwks_uri)) as { keys?: unknown }
      if (!Array.isArray(set.keys)) throw new OidcError('the JWKS has no keys')
      this.jwks = { at: this.now(), keys: set.keys as never }
      found = pick()
    }
    if (!found) throw new OidcError(`no ${alg} signing key ${kid ?? ''} in the JWKS`)
    return found
  }

  private async getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const res = await this.fetch(url, { headers: { accept: 'application/json', ...headers } })
    if (!res.ok) throw new OidcError(`GET ${url} failed: ${res.status}`)
    return res.json()
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Signs a value for a cookie: `<base64url json>.<hmac>`. */
export function sealCookie(value: unknown, key: string): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`
}

/** The value of a cookie made by `sealCookie`, or null when it was tampered with. */
export function openCookie<T>(sealed: string | undefined, key: string): T | null {
  if (!sealed) return null
  const i = sealed.lastIndexOf('.')
  if (i <= 0) return null
  const body = sealed.slice(0, i)
  if (!safeEqual(sealed.slice(i + 1), createHmac('sha256', key).update(body).digest('base64url'))) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}
