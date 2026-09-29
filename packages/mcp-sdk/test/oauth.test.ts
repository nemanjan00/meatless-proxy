import { UnavailableError } from '@mp/core'
import { resultText, type McpServerStatus } from '@mp/mcp'
import { managedMcpHubContract } from '@mp/mcp/contract'
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginAuthorization,
  completeAuthorization,
  createMcpHub,
  type OAuthStorage,
  type OAuthStorageKey,
  type SdkMcpHub,
  StoredOAuthProvider,
  type StoredOAuthOptions,
} from '../src/index.ts'
import { type FakeOAuthMcp, startFakeOAuthMcp } from '../src/testing.ts'
import { demoServer, inMemoryServers } from './helpers.ts'

managedMcpHubContract('sdk (in-memory transport)', async () => {
  const mem = inMemoryServers({ demo: demoServer })
  return { hub: createMcpHub({ transportFactory: mem.factory }), demo: { name: 'demo', transport: 'stdio', command: 'unused' } }
})

function memoryStorage(): OAuthStorage & { map: Map<OAuthStorageKey, string> } {
  const map = new Map<OAuthStorageKey, string>()
  return {
    map,
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  }
}

const REDIRECT = 'http://harness.test/oauth/mcp/callback'

describe('OAuth against a fake authorization server and MCP server', () => {
  let fake: FakeOAuthMcp | undefined
  let hub: SdkMcpHub | undefined
  afterEach(async () => {
    await hub?.close()
    await fake?.close()
    hub = undefined
    fake = undefined
  })

  /** Signs in: begin, the browser consents, the callback completes. */
  async function signIn(opts: StoredOAuthOptions, serverUrl: string) {
    const state = 'state-123'
    const url = await beginAuthorization({ ...opts, serverUrl, state })
    expect(url.searchParams.get('state')).toBe(state)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    const back = await fake!.approve(url)
    expect(back.origin + back.pathname).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe(state)
    await completeAuthorization({ ...opts, serverUrl, code: back.searchParams.get('code')! })
  }

  const oauthHub = (opts: StoredOAuthOptions, url: string) => {
    const provider = new StoredOAuthProvider(opts)
    const statuses: McpServerStatus[] = []
    const h = createMcpHub({ servers: [{ name: 'fake', transport: 'http', url }], authProviderFor: () => provider })
    h.onStatus((_s, st) => statuses.push(st))
    return { hub: h, statuses, provider }
  }

  it('discovers, registers, exchanges the code, and calls a tool with the token', async () => {
    fake = await startFakeOAuthMcp()
    const storage = memoryStorage()
    const opts = { storage, redirectUrl: REDIRECT }
    await signIn(opts, fake.url)
    expect(fake.stats).toMatchObject({ registrations: 1, authorizations: 1, codeExchanges: 1 })
    expect([...storage.map.keys()].sort()).toEqual(['client', 'discovery', 'tokens'])
    const tokens = JSON.parse(storage.map.get('tokens')!)
    expect(tokens.access_token).toBeTruthy()

    const h = oauthHub(opts, fake.url)
    hub = h.hub
    expect((await hub.listTools('fake')).map((t) => t.name).sort()).toEqual(['echo', 'whoami'])
    expect(hub.status('fake')).toMatchObject({ state: 'connected', toolCount: 2 })
    const who = JSON.parse(resultText(await hub.callTool('fake', 'whoami', {})))
    expect(who.clientId).toBe(JSON.parse(storage.map.get('client')!).client_id)
    expect(fake.authHeaders.every((h) => h === `Bearer ${tokens.access_token}`)).toBe(true)
  })

  it('masks the access token when a tool echoes it back', async () => {
    fake = await startFakeOAuthMcp()
    const opts = { storage: memoryStorage(), redirectUrl: REDIRECT }
    await signIn(opts, fake.url)
    hub = oauthHub(opts, fake.url).hub
    const token = JSON.parse((opts.storage as ReturnType<typeof memoryStorage>).map.get('tokens')!).access_token as string
    const r = await hub.callTool('fake', 'echo', { text: `the token is ${token}` })
    expect(resultText(r)).toBe('the token is [redacted]')
  })

  it('refreshes an expired access token by itself', async () => {
    fake = await startFakeOAuthMcp()
    const storage = memoryStorage()
    const opts = { storage, redirectUrl: REDIRECT }
    await signIn(opts, fake.url)
    const first = JSON.parse(storage.map.get('tokens')!).access_token
    const h = oauthHub(opts, fake.url)
    hub = h.hub
    await hub.listTools('fake')
    fake.expireAccessTokens()
    expect(resultText(await hub.callTool('fake', 'echo', { text: 'still works' }))).toBe('still works')
    expect(fake.stats.refreshes).toBe(1)
    expect(JSON.parse(storage.map.get('tokens')!).access_token).not.toBe(first)
    expect(hub.status('fake').state).toBe('connected')
  })

  it('reports needs_auth when the refresh fails, and never starts a sign-in by itself', async () => {
    fake = await startFakeOAuthMcp()
    const storage = memoryStorage()
    const opts = { storage, redirectUrl: REDIRECT }
    await signIn(opts, fake.url)
    const h = oauthHub(opts, fake.url)
    hub = h.hub
    await hub.listTools('fake')
    fake.expireAccessTokens()
    fake.revokeRefreshTokens()
    const err = await hub.callTool('fake', 'echo', { text: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(UnavailableError)
    expect(err.details).toMatchObject({ server: 'fake', needsAuth: true })
    expect(hub.status('fake').state).toBe('needs_auth')
    expect(h.statuses.at(-1)!.state).toBe('needs_auth')
    expect(storage.map.has('tokens')).toBe(false)
    expect(storage.map.has('verifier')).toBe(false)
    expect(fake.stats.authorizations).toBe(1)

    // Signing in again brings it back.
    await signIn(opts, fake.url)
    h.provider.forget()
    expect((await hub.reconnect('fake')).state).toBe('connected')
    expect(resultText(await hub.callTool('fake', 'echo', { text: 'back' }))).toBe('back')
  })

  it('a server that was never signed in to is needs_auth, without retrying', async () => {
    fake = await startFakeOAuthMcp()
    const h = oauthHub({ storage: memoryStorage(), redirectUrl: REDIRECT }, fake.url)
    hub = h.hub
    const [r] = await hub.start()
    expect(r).toMatchObject({ server: 'fake', ok: false })
    expect(hub.status('fake')).toMatchObject({ state: 'needs_auth' })
    expect(fake.stats.authorizations).toBe(0)
  })

  it('uses a pre-registered client without registering', async () => {
    fake = await startFakeOAuthMcp()
    // Register once "by hand", then configure that client id.
    const reg = await fetch(`${fake.origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }),
    }).then((r) => r.json())
    const opts = { storage: memoryStorage(), redirectUrl: REDIRECT, clientId: reg.client_id, clientSecret: reg.client_secret }
    await signIn(opts, fake.url)
    expect(fake.stats.registrations).toBe(1)
    hub = oauthHub(opts, fake.url).hub
    expect(JSON.parse(resultText(await hub.callTool('fake', 'whoami', {}))).clientId).toBe(reg.client_id)
  })

  it('uses a configured authorization server when the MCP server does not advertise one', async () => {
    fake = await startFakeOAuthMcp({ noResourceMetadata: true })
    const opts = { storage: memoryStorage(), redirectUrl: REDIRECT, authorizationServer: fake.origin, scopes: ['read'] }
    await signIn(opts, fake.url)
    hub = oauthHub(opts, fake.url).hub
    expect(JSON.parse(resultText(await hub.callTool('fake', 'whoami', {}))).scope).toBe('read')
  })

  it('refuses a replayed or unknown authorization code', async () => {
    fake = await startFakeOAuthMcp()
    const opts = { storage: memoryStorage(), redirectUrl: REDIRECT }
    const url = await beginAuthorization({ ...opts, serverUrl: fake.url, state: 's' })
    const code = (await fake.approve(url)).searchParams.get('code')!
    await completeAuthorization({ ...opts, serverUrl: fake.url, code })
    await expect(completeAuthorization({ ...opts, serverUrl: fake.url, code })).rejects.toThrow()
    await expect(completeAuthorization({ ...opts, serverUrl: fake.url, code: 'made-up' })).rejects.toThrow()
  })
})

describe('token auth over http', () => {
  let fake: FakeOAuthMcp | undefined
  let hub: SdkMcpHub | undefined
  afterEach(async () => {
    await hub?.close()
    await fake?.close()
  })

  it('injects the secret as a prefixed header and masks it in results', async () => {
    fake = await startFakeOAuthMcp({ staticToken: 'sk-test-static-token' })
    const resolved: string[][] = []
    hub = createMcpHub({
      servers: [
        {
          name: 'tok',
          transport: 'http',
          url: fake.url,
          env: { 'X-Plain': 'yes' },
          secrets: { Authorization: 'MCP_TOK_TOKEN' },
          secretPrefix: { Authorization: 'Bearer ' },
        },
      ],
      resolveSecrets: async (names, server) => {
        resolved.push([server.name, ...names])
        return { MCP_TOK_TOKEN: 'sk-test-static-token' }
      },
    })
    const r = await hub.callTool('tok', 'echo', { text: 'sk-test-static-token!' })
    expect(resultText(r)).toBe('[redacted]!')
    expect(fake.authHeaders[0]).toBe('Bearer sk-test-static-token')
    expect(resolved).toEqual([['tok', 'MCP_TOK_TOKEN']])
  })

  it('reports a wrong token as needs_auth', async () => {
    fake = await startFakeOAuthMcp({ staticToken: 'sk-test-right' })
    hub = createMcpHub({
      servers: [
        {
          name: 'tok',
          transport: 'http',
          url: fake.url,
          secrets: { Authorization: 'T' },
          secretPrefix: { Authorization: 'Bearer ' },
        },
      ],
      resolveSecrets: async () => ({ T: 'sk-test-wrong' }),
    })
    await expect(hub.listTools('tok')).rejects.toBeInstanceOf(UnavailableError)
    expect(hub.status('tok').state).toBe('needs_auth')
  })

  it('removing a server while it connects closes the connection', async () => {
    fake = await startFakeOAuthMcp({ open: true })
    hub = createMcpHub({})
    hub.addServer({ name: 'open', transport: 'http', url: fake.url })
    const p = hub.listTools('open').catch((e) => e)
    expect(await hub.removeServer('open')).toBe(true)
    const r = await p
    expect(r instanceof Error || Array.isArray(r)).toBe(true)
    expect(hub.servers()).toEqual([])
  })
})
