import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OidcClient } from '../src/auth/oidc.ts'
import { cookiesOf, testApp, type TestApp } from './helpers.ts'

/** A tiny identity provider: discovery, JWKS (one RSA and one EC key), authorize and token endpoints. */
interface Idp {
  issuer: string
  /** What the next token request answers with. */
  next: { email?: string; emailVerified?: boolean; alg: 'RS256' | 'ES256'; tamper?: 'sig' | 'aud' | 'nonce' | 'exp' | 'iss' }
  /** Codes handed out by /authorize: code → the request it answers. */
  codes: Map<string, { challenge: string; nonce: string; redirect: string }>
  tokenRequests: URLSearchParams[]
  authHeaders: (string | undefined)[]
  close(): Promise<void>
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

function jwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject, alg: 'RS256' | 'ES256') {
  const data = `${b64(header)}.${b64(claims)}`
  const sig =
    alg === 'RS256'
      ? sign('sha256', Buffer.from(data), key)
      : sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
  return `${data}.${sig.toString('base64url')}`
}

async function startIdp(clientId: string): Promise<Idp> {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwks = {
    keys: [
      { ...(rsa.publicKey.export({ format: 'jwk' }) as object), kid: 'rsa1', use: 'sig', alg: 'RS256' },
      { ...(ec.publicKey.export({ format: 'jwk' }) as object), kid: 'ec1', use: 'sig', alg: 'ES256' },
    ],
  }
  const idp: Idp = {
    issuer: '',
    next: { alg: 'RS256', email: 'ana@example.com' },
    codes: new Map(),
    tokenRequests: [],
    authHeaders: [],
    close: async () => {},
  }
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', idp.issuer)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      })
    if (url.pathname === '/jwks') return json(200, jwks)
    if (url.pathname === '/authorize') {
      const code = `code_${idp.codes.size + 1}`
      idp.codes.set(code, {
        challenge: url.searchParams.get('code_challenge')!,
        nonce: url.searchParams.get('nonce')!,
        redirect: url.searchParams.get('redirect_uri')!,
      })
      res.writeHead(302, {
        location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`,
      })
      return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const form = new URLSearchParams(body)
      idp.tokenRequests.push(form)
      idp.authHeaders.push(req.headers.authorization)
      const pending = idp.codes.get(form.get('code') ?? '')
      const verifier = form.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (!pending || pending.challenge !== challenge || pending.redirect !== form.get('redirect_uri'))
        return json(400, { error: 'invalid_grant' })
      idp.codes.delete(form.get('code')!)
      const n = idp.next
      const now = Math.floor(Date.now() / 1000)
      const claims: Record<string, unknown> = {
        iss: n.tamper === 'iss' ? 'https://evil.example.com' : idp.issuer,
        aud: n.tamper === 'aud' ? 'someone-else' : clientId,
        sub: 'user-1',
        iat: now,
        exp: n.tamper === 'exp' ? now - 3600 : now + 300,
        nonce: n.tamper === 'nonce' ? 'wrong' : pending.nonce,
        ...(n.email ? { email: n.email } : {}),
        ...(n.emailVerified !== undefined ? { email_verified: n.emailVerified } : {}),
      }
      const key = n.tamper === 'sig' ? other.privateKey : n.alg === 'RS256' ? rsa.privateKey : ec.privateKey
      const idToken = jwt({ alg: n.alg, kid: n.alg === 'RS256' ? 'rsa1' : 'ec1', typ: 'JWT' }, claims, key, n.alg)
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token: idToken })
    }
    json(404, { error: 'not_found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  idp.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  idp.close = () => new Promise((resolve) => server.close(() => resolve()))
  return idp
}

let idp: Idp
let t: TestApp
let anaId: string

beforeAll(async () => {
  idp = await startIdp('mp-test')
  t = await testApp({
    workers: false,
    env: {
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'mp-test',
      OIDC_CLIENT_SECRET: 'sk-test-secret',
      OIDC_REDIRECT_URL: 'http://mp.local/auth/oidc/callback',
    },
  })
  anaId = (
    await t.a.services.directory.contacts.create({
      name: 'Ana Example',
      kind: 'person',
      email: 'ana@example.com',
      access: 'member',
    })
  ).id
})
afterAll(async () => {
  await t.close()
  await idp.close()
})

/** Runs the whole flow: start at the harness, "sign in" at the provider, come back to the callback. */
async function flow(next = '/chat') {
  const start = await t.a.app.request(`/auth/oidc/start?next=${encodeURIComponent(next)}`)
  expect(start.status).toBe(302)
  const authorize = new URL(start.headers.get('location')!)
  const state = cookiesOf(start).mp_oidc!
  const atIdp = await fetch(authorize, { redirect: 'manual' })
  const back = new URL(atIdp.headers.get('location')!)
  const callback = await t.a.app.request(`/auth/oidc/callback${back.search}`, { headers: { cookie: `mp_oidc=${state}` } })
  return { authorize, callback, cookies: cookiesOf(callback) }
}

describe('OIDC sign-in', () => {
  it('is offered on the login page', async () => {
    expect((await t.req('GET', '/api/auth/config', undefined, { authorization: '' })).body).toEqual({ oidc: true })
  })

  it('uses the code flow with PKCE, verifies an RS256 id_token and signs the contact in by email', async () => {
    idp.next = { alg: 'RS256', email: 'Ana@Example.com' }
    const { authorize, callback, cookies } = await flow('/chat')
    expect(authorize.searchParams.get('response_type')).toBe('code')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('scope')).toContain('openid')
    expect(authorize.searchParams.get('client_id')).toBe('mp-test')
    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('/chat')
    const me = await t.req('GET', '/api/me', undefined, { cookie: `mp_session=${cookies.mp_session}` })
    expect(me.body).toMatchObject({ contactId: anaId, via: 'session' })
    // The client secret goes in the Basic header, never in the form.
    expect(idp.authHeaders.at(-1)).toMatch(/^Basic /)
    expect(idp.tokenRequests.at(-1)!.get('client_secret')).toBeNull()
    expect(idp.tokenRequests.at(-1)!.get('code_verifier')).toBeTruthy()
  })

  it('verifies ES256 id_tokens too', async () => {
    idp.next = { alg: 'ES256', email: 'ana@example.com', emailVerified: true }
    const { callback } = await flow('/')
    expect(callback.headers.get('location')).toBe('/')
    expect(cookiesOf(callback).mp_session).toMatch(/^mps_/)
  })

  it('refuses unknown emails, and creates nobody', async () => {
    idp.next = { alg: 'RS256', email: 'stranger@example.com' }
    const before = await t.a.services.store.records.count('contact')
    const { callback, cookies } = await flow()
    expect(callback.headers.get('location')).toBe('/login?error=unknown_user')
    expect(cookies.mp_session).toBeUndefined()
    expect(await t.a.services.store.records.count('contact')).toBe(before)
  })

  it('refuses bad signatures, audiences, nonces, issuers, expired tokens and unverified emails', async () => {
    for (const tamper of ['sig', 'aud', 'nonce', 'exp', 'iss'] as const) {
      idp.next = { alg: 'RS256', email: 'ana@example.com', tamper }
      const { callback } = await flow()
      expect(callback.headers.get('location'), tamper).toBe('/login?error=oidc_failed')
    }
    idp.next = { alg: 'RS256', email: 'ana@example.com', emailVerified: false }
    expect((await flow()).callback.headers.get('location')).toBe('/login?error=oidc_failed')
  })

  it('refuses a callback without the state cookie, or with a forged one', async () => {
    idp.next = { alg: 'RS256', email: 'ana@example.com' }
    const start = await t.a.app.request('/auth/oidc/start')
    const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' })
    const back = new URL(atIdp.headers.get('location')!)
    const none = await t.a.app.request(`/auth/oidc/callback${back.search}`)
    expect(none.headers.get('location')).toBe('/login?error=oidc_failed')
    const forged = Buffer.from(
      JSON.stringify({ state: back.searchParams.get('state'), nonce: 'n', verifier: 'v', next: '/', exp: 9e15 }),
    )
    const f = await t.a.app.request(`/auth/oidc/callback${back.search}`, {
      headers: { cookie: `mp_oidc=${forged.toString('base64url')}.bad` },
    })
    expect(f.headers.get('location')).toBe('/login?error=oidc_failed')
  })

  it('is off without configuration', async () => {
    const off = await testApp({ workers: false })
    try {
      expect((await off.a.app.request('/auth/oidc/start')).headers.get('location')).toBe('/login?error=oidc_off')
    } finally {
      await off.close()
    }
  })
})

describe('OidcClient', () => {
  it('rejects alg none and unknown keys', async () => {
    const c = new OidcClient({ issuer: idp.issuer, clientId: 'mp-test', clientSecret: 'x', redirectUrl: 'http://mp.local/cb' })
    const none = `${b64({ alg: 'none' })}.${b64({ iss: idp.issuer, aud: 'mp-test', sub: 'x', exp: 9e9 })}.`
    await expect(c.verifyIdToken(none)).rejects.toThrow(/alg none/)
    const hs = `${b64({ alg: 'HS256' })}.${b64({})}.x`
    await expect(c.verifyIdToken(hs)).rejects.toThrow(/not allowed/)
    const k = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const unknown = jwt({ alg: 'RS256', kid: 'nope' }, { iss: idp.issuer }, k.privateKey, 'RS256')
    await expect(c.verifyIdToken(unknown)).rejects.toThrow(/no RS256 signing key/)
  })
})
