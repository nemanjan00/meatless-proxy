import { ManualClock } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from '../src/auth/headers.ts'
import {
  PREVIEW_COOKIE_REFRESH_MS,
  PREVIEW_COOKIE_TTL_MS,
  PREVIEW_TOKEN_TTL_MS,
  PreviewSigner,
  allowedSetCookie,
  frameAncestors,
  isPreviewHost,
  isPreviewOrigin,
  parsePreviewHost,
  previewFrameSources,
  previewMode,
  previewOrigin,
  previewRequestCookies,
} from '../src/previews/index.ts'
import { selfContainer } from '../src/previews/self.ts'

const scope = { envId: 'mp-bot-web', port: 5173, contactId: 'con_ana' }

describe('preview tokens', () => {
  const make = (key = 'k'.repeat(32)) => {
    const clock = new ManualClock(Date.UTC(2026, 8, 29, 9))
    return { clock, signer: new PreviewSigner({ secretsKey: key, now: () => clock.now() }) }
  }

  it('round-trips the scope and lives about 5 minutes', () => {
    const { clock, signer } = make()
    const { token, expiresAt } = signer.token(scope)
    expect(token).toMatch(/^mpp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(expiresAt - clock.now()).toBe(PREVIEW_TOKEN_TTL_MS)
    expect(PREVIEW_TOKEN_TTL_MS).toBe(5 * 60_000)
    const r = signer.checkToken(token)
    expect(r.ok && r.grant).toMatchObject(scope)
    clock.advance(PREVIEW_TOKEN_TTL_MS - 1)
    expect(signer.checkToken(token).ok).toBe(true)
    clock.advance(1)
    expect(signer.checkToken(token)).toEqual({ ok: false, reason: 'expired' })
  })

  it('works once', () => {
    const { signer } = make()
    const { token } = signer.token(scope)
    expect(signer.redeemToken(token).ok).toBe(true)
    expect(signer.redeemToken(token)).toEqual({ ok: false, reason: 'used' })
    expect(signer.checkToken(token)).toEqual({ ok: false, reason: 'used' })
    // Another token for the same scope is fine.
    expect(signer.redeemToken(signer.token(scope).token).ok).toBe(true)
  })

  it('refuses tampering: another env, port or viewer in the body, a changed signature, garbage', () => {
    const { signer } = make()
    const { token } = signer.token(scope)
    const [body, mac] = token.slice(4).split('.') as [string, string]
    const wire = JSON.parse(Buffer.from(body, 'base64url').toString())
    for (const change of [{ e: 'mp-other' }, { p: 8000 }, { c: 'con_admin' }, { x: wire.x + 3600_000 }]) {
      const forged = Buffer.from(JSON.stringify({ ...wire, ...change })).toString('base64url')
      expect(signer.checkToken(`mpp_${forged}.${mac}`)).toEqual({ ok: false, reason: 'signature' })
    }
    const flipped = mac.slice(0, -2) + (mac.endsWith('AA') ? 'BB' : 'AA')
    expect(signer.checkToken(`mpp_${body}.${flipped}`).ok).toBe(false)
    for (const bad of ['', 'mpp_', 'mpp_abc', `mpp_${body}`, `mpp_${body}.${mac}.x`, `${body}.${mac}`, 'mpp_!!.??'])
      expect(signer.checkToken(bad).ok, bad).toBe(false)
  })

  it('needs the same key: another SECRETS_KEY (another deployment) can not verify it', () => {
    const a = make('a'.repeat(32))
    const b = make('b'.repeat(32))
    expect(b.signer.checkToken(a.signer.token(scope).token)).toEqual({ ok: false, reason: 'signature' })
    // Same key, another instance: verifies.
    expect(make('a'.repeat(32)).signer.checkToken(a.signer.token(scope).token).ok).toBe(true)
    // Without a key, each process has its own random one.
    const r1 = new PreviewSigner({ now: () => 0 })
    const r2 = new PreviewSigner({ now: () => 0 })
    expect(r2.checkToken(r1.token(scope).token).ok).toBe(false)
  })

  it('keeps tokens and cookies apart', () => {
    const { signer } = make()
    const { token } = signer.token(scope)
    expect(signer.checkCookie(token.slice(4)).ok).toBe(false)
    const cookie = signer.cookie(scope)
    expect(signer.checkToken(`mpp_${cookie}`).ok).toBe(false)
    expect(signer.checkCookie(cookie).ok).toBe(true)
  })

  it('cookies last 12 hours and are due for a refresh after a while', () => {
    const { clock, signer } = make()
    const cookie = signer.cookie(scope)
    const r = signer.checkCookie(cookie)
    expect(r.ok && r.grant.expiresAt - r.grant.issuedAt).toBe(PREVIEW_COOKIE_TTL_MS)
    if (!r.ok) throw new Error('unreachable')
    expect(signer.dueForRefresh(r.grant)).toBe(false)
    clock.advance(PREVIEW_COOKIE_REFRESH_MS)
    expect(signer.dueForRefresh(r.grant)).toBe(true)
    clock.advance(PREVIEW_COOKIE_TTL_MS)
    expect(signer.checkCookie(cookie)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('preview origins', () => {
  const domain = previewMode({ PREVIEW_DOMAIN: 'Preview.Example.com', PREVIEW_PORT: 3001, PUBLIC_URL: 'https://mp.example.com' })
  const port = previewMode({ PREVIEW_DOMAIN: undefined, PREVIEW_PORT: 3001, PUBLIC_URL: undefined })

  it('recognises preview hosts and origins in domain mode', () => {
    expect(domain).toEqual({ kind: 'domain', domain: 'preview.example.com', scheme: 'https' })
    expect(isPreviewHost(domain, 'mp-bot-web-5173.preview.example.com')).toBe(true)
    expect(isPreviewHost(domain, 'MP-BOT-WEB-5173.PREVIEW.EXAMPLE.COM:443')).toBe(true)
    expect(isPreviewHost(domain, 'preview.example.com')).toBe(true)
    expect(isPreviewHost(domain, 'mp.example.com')).toBe(false)
    expect(isPreviewHost(domain, 'evilpreview.example.com')).toBe(false)
    expect(isPreviewOrigin(domain, 'https://a-1.preview.example.com')).toBe(true)
    expect(isPreviewOrigin(domain, 'https://mp.example.com')).toBe(false)
    expect(isPreviewOrigin(domain, 'null')).toBe(false)
    expect(isPreviewOrigin(domain, 'not a url')).toBe(false)
  })

  it('parses <env>-<port> labels', () => {
    expect(parsePreviewHost('mp-bot-web-5173.preview.example.com', 'preview.example.com')).toEqual({
      label: 'mp-bot-web-5173',
      port: 5173,
    })
    expect(parsePreviewHost('a.b-1.preview.example.com', 'preview.example.com')).toBeNull()
    expect(parsePreviewHost('mp-bot-web.preview.example.com', 'preview.example.com')).toBeNull()
    expect(parsePreviewHost('mp-bot-99999.preview.example.com', 'preview.example.com')).toBeNull()
    expect(parsePreviewHost('mp-bot-80.elsewhere.com', 'preview.example.com')).toBeNull()
  })

  it('recognises the preview port in port mode', () => {
    expect(isPreviewHost(port, 'localhost:3001')).toBe(true)
    expect(isPreviewHost(port, 'localhost:3000')).toBe(false)
    expect(isPreviewHost(port, 'localhost')).toBe(false)
    expect(isPreviewOrigin(port, 'http://localhost:3001')).toBe(true)
    expect(isPreviewOrigin(port, 'http://localhost:3000')).toBe(false)
    expect(isPreviewOrigin(port, 'http://localhost')).toBe(false)
    const off = previewMode({ PREVIEW_DOMAIN: undefined, PREVIEW_PORT: 0, PUBLIC_URL: undefined })
    expect(isPreviewHost(off, 'localhost:0')).toBe(false)
  })

  it('builds each preview origin', () => {
    const d = { PREVIEW_DOMAIN: 'preview.example.com', PREVIEW_PORT: 3001, PUBLIC_URL: 'https://mp.example.com' }
    expect(previewOrigin(d, { envId: 'mp-Bot-Web', port: 5173 }, 'ignored')).toBe('https://mp-bot-web-5173.preview.example.com')
    const p = { PREVIEW_DOMAIN: undefined, PREVIEW_PORT: 3001, PUBLIC_URL: undefined }
    expect(previewOrigin(p, { envId: 'x', port: 5173 }, 'mp.test:3000')).toBe('http://mp.test:3001')
    expect(previewOrigin({ ...p, PUBLIC_URL: 'https://mp.example.com' }, { envId: 'x', port: 1 }, 'other:1')).toBe(
      'https://mp.example.com:3001',
    )
  })

  it('frames previews only from their origins (CSP frame-src), in both modes', () => {
    expect(previewFrameSources({ PREVIEW_DOMAIN: 'p.example.com', PREVIEW_PORT: 3001, PUBLIC_URL: undefined })).toEqual([
      'https://*.p.example.com',
    ])
    expect(previewFrameSources({ PREVIEW_DOMAIN: undefined, PREVIEW_PORT: 3001, PUBLIC_URL: 'https://mp.example.com' })).toEqual([
      'https://mp.example.com:3001',
    ])
    expect(previewFrameSources({ PREVIEW_DOMAIN: undefined, PREVIEW_PORT: 3001, PUBLIC_URL: undefined }, 'mp.test:3000')).toEqual(
      ['http://mp.test:3001'],
    )
    expect(previewFrameSources({ PREVIEW_DOMAIN: undefined, PREVIEW_PORT: 0, PUBLIC_URL: undefined }, 'mp.test')).toEqual([])
    const csp = contentSecurityPolicy({ PREVIEW_PORT: 3001, PUBLIC_URL: 'https://mp.example.com' })
    expect(csp).toContain('frame-src https://mp.example.com:3001;')
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('frame-ancestors names the harness, or nobody', () => {
    expect(frameAncestors('https://mp.example.com')).toBe('frame-ancestors https://mp.example.com')
    expect(frameAncestors(null)).toBe("frame-ancestors 'none'")
  })
})

describe('previews behind a tunnel of their own (PREVIEW_PUBLIC_URL)', () => {
  const config = {
    PREVIEW_DOMAIN: undefined,
    PREVIEW_PORT: 3001,
    PUBLIC_URL: 'https://harness.example.com',
    PREVIEW_PUBLIC_URL: 'https://previews.example.net/',
  }
  it('links, frames and refusals use the preview address', async () => {
    const o = await import('../src/previews/origins.ts')
    const mode = o.previewMode(config)
    expect(o.previewOrigin(config, { envId: 'mp-ana-x', port: 5173 }, 'harness.example.com')).toBe('https://previews.example.net')
    expect(o.previewFrameSources(config)).toEqual(['https://previews.example.net'])
    // The harness never answers on the preview address, nor to requests from it.
    expect(o.isPreviewHost(mode, 'previews.example.net')).toBe(true)
    expect(o.isPreviewOrigin(mode, 'https://previews.example.net')).toBe(true)
    expect(o.isPreviewHost(mode, 'harness.example.com')).toBe(false)
  })

  it('must be a different host from PUBLIC_URL', async () => {
    const { loadConfig } = await import('../src/config.ts')
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.com', PREVIEW_PUBLIC_URL: 'https://a.example.com:8443' })).toThrow(
      /PREVIEW_PUBLIC_URL: must be a different host/,
    )
    expect(
      loadConfig({ PUBLIC_URL: 'https://a.example.com', PREVIEW_PUBLIC_URL: 'https://b.example.com' }).PREVIEW_PUBLIC_URL,
    ).toBe('https://b.example.com')
  })
})

describe('cookie stripping', () => {
  it("never passes the harness's cookies to a preview", () => {
    expect(previewRequestCookies('mp_session=s; app=1; mp_csrf=c; theme=dark; mp_preview=p; MP_OIDC=o')).toBe('app=1; theme=dark')
    expect(previewRequestCookies('mp_session=s')).toBeUndefined()
    expect(previewRequestCookies(undefined)).toBeUndefined()
  })

  it('lets a preview set only host-only cookies of its own', () => {
    expect(allowedSetCookie('app=1; Path=/; HttpOnly')).toBe(true)
    expect(allowedSetCookie('mp_session=evil; Path=/')).toBe(false)
    expect(allowedSetCookie('MP_CSRF=evil')).toBe(false)
    expect(allowedSetCookie('__Host-mp_session=x; Secure; Path=/')).toBe(false)
    expect(allowedSetCookie('wide=1; Domain=example.com')).toBe(false)
    expect(allowedSetCookie('wide=1; path=/; domain=.example.com')).toBe(false)
    expect(allowedSetCookie('=nameless')).toBe(false)
  })
})

describe('the harness container', () => {
  it('is SELF_CONTAINER, else the host name in Docker, else none', () => {
    expect(selfContainer({ SELF_CONTAINER: 'mp-app' }, false)).toEqual({ selfContainer: 'mp-app' })
    expect(selfContainer({ SELF_CONTAINER: undefined }, false)).toEqual({})
    expect(selfContainer({ SELF_CONTAINER: undefined }, true).selfContainer).toBeTruthy()
  })
})
