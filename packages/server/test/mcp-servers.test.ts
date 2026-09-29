import { DeniedError, ManualClock, createEventBus, memoryLogger, type LogLine } from '@mp/core'
import { fakeMcpHub } from '@mp/mcp'
import { type FakeOAuthMcp, startFakeOAuthMcp } from '@mp/mcp-sdk/testing'
import { createRecords } from '@mp/records'
import { memoryStore } from '@mp/store'
import type { ToolContext } from '@mp/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { wireMcpNotifications } from '../src/mcp-in.ts'
import { MCP_SERVER_STATUS_TOPIC, OAuthStates, safeReturnTo, wireMcpAlerts } from '../src/mcp-servers/index.ts'
import type { Services } from '../src/services.ts'
import { type TestApp, testApp, until } from './helpers.ts'
import { type Backend, memoryBackend, realBackend } from './scenarios.ts'

const TOKEN = 'sk-test-mcp-static-token'

function ctxFor(employeeId: string): ToolContext {
  return {
    employeeId,
    sessionId: 'ses_test',
    runId: 'run_test',
    callId: 'call_1',
    idempotencyKey: 'run_test:1:call_1',
    secrets: {},
    signal: new AbortController().signal,
    logger: memoryLogger([]),
    clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
    emit: () => {},
  }
}

async function person(t: TestApp, name: string, access: 'viewer' | 'member' | 'admin') {
  return (await t.a.services.directory.contacts.create({ name, kind: 'person', access })).id
}

function mcpSuite(backend: Backend) {
  let t: TestApp
  let s: Services
  let cleanup: () => Promise<void>
  let fake: FakeOAuthMcp
  let tokenFake: FakeOAuthMcp
  let ana: string // employee
  let ben: string // employee

  beforeAll(async () => {
    const b = await backend.make()
    cleanup = b.cleanup
    fake = await startFakeOAuthMcp()
    tokenFake = await startFakeOAuthMcp({ staticToken: TOKEN })
    t = await testApp({
      env: {
        ...b.env,
        PUBLIC_URL: 'http://harness.test',
        MCP_SERVERS: JSON.stringify([{ name: 'fromenv', transport: 'http', url: 'http://127.0.0.1:1/mcp' }]),
      },
    })
    s = t.a.services
    await s.mcpServers!.start()
    ana = (await s.directory.employees.create({ name: 'Ana', personality: 'x', toolAllow: ['**'] })).id
    ben = (await s.directory.employees.create({ name: 'Ben', personality: 'x', toolAllow: ['**'] })).id
    // Router contexts, like the bootstrap employee has, so new tools reach new sessions.
    for (const id of [ana, ben]) {
      const router = await s.sessions.create({ employeeId: id, title: 'router', slug: 'router', toolset: ['chat.post'] })
      await s.directory.employees.update(id, { routerSessionId: router.id })
    }
  }, 30_000)

  afterAll(async () => {
    await t?.close()
    await fake?.close()
    await tokenFake?.close()
    await cleanup?.()
  })

  const visible = async (employeeId: string, name: string) =>
    until(async () => {
      const lists = await s.toolListsFor(employeeId)
      return { ok: s.tools.isAllowed(name, lists) }
    }).then((r) => r.ok)

  describe('validation and names', () => {
    it('refuses stdio, bad names, reserved and config names', async () => {
      const stdio = await t.req('POST', '/api/mcp-servers', {
        name: 'x',
        transport: 'stdio',
        command: 'rm',
        url: 'http://a.test',
      })
      expect(stdio.status).toBe(422)
      expect(stdio.body.error.message).toMatch(/MCP_SERVERS/)
      for (const name of ['Has Space', 'UPPER', '-lead', 'a.b', 'x'.repeat(41)]) {
        expect((await t.req('POST', '/api/mcp-servers', { name, url: tokenFake.url })).status, name).toBe(422)
      }
      expect((await t.req('POST', '/api/mcp-servers', { name: 'gitlab', url: tokenFake.url })).status).toBe(422)
      expect((await t.req('POST', '/api/mcp-servers', { name: 'fromenv', url: tokenFake.url })).status).toBe(409)
      expect((await t.req('POST', '/api/mcp-servers', { name: 'ok', url: 'ftp://nope.test' })).status).toBe(422)
      expect((await t.req('POST', '/api/mcp-servers', { name: 'ok', url: 'http://u:p@a.test/mcp' })).status).toBe(422)
      expect((await t.req('POST', '/api/mcp-servers', { name: 'ok', url: tokenFake.url, headers: { Host: 'x' } })).status).toBe(
        422,
      )
      expect((await t.req('POST', '/api/mcp-servers', { name: 'ok', url: tokenFake.url, employeeId: 'emp_nope' })).status).toBe(
        404,
      )
      expect((await t.req('POST', '/api/mcp-servers', { name: 'ok', url: tokenFake.url, auth: { type: 'token' } })).status).toBe(
        422,
      )
    })

    it('is for admins only, and hidden from the generic records API', async () => {
      const member = await person(t, 'Mia Member', 'member')
      expect((await t.req('GET', '/api/mcp-servers', undefined, { 'x-mp-contact': member })).status).toBe(403)
      expect(
        (await t.req('POST', '/api/mcp-servers', { name: 'm', url: tokenFake.url }, { 'x-mp-contact': member })).status,
      ).toBe(403)
      expect((await t.req('GET', '/api/records/mcp_server')).status).toBe(404)
      expect((await t.req('GET', '/api/records/mcp_oauth_state')).status).toBe(404)
    })

    it('lists config servers as read-only', async () => {
      const list = (await t.req('GET', '/api/mcp-servers?employeeId=global')).body
      const env = list.find((x: any) => x.name === 'fromenv')
      expect(env).toMatchObject({ id: 'config:fromenv', source: 'config', transport: 'http', employeeId: null })
      expect((await t.req('DELETE', '/api/mcp-servers/config:fromenv')).status).toBe(403)
      expect((await t.req('PATCH', '/api/mcp-servers/config:fromenv', { enabled: false })).status).toBe(403)
    })
  })

  describe('a global token server', () => {
    let id: string
    afterEach(() => undefined)

    it('stores the token as a global secret, never returns it, and registers tools for everyone', async () => {
      const r = await t.req('POST', '/api/mcp-servers', {
        name: 'notes',
        url: tokenFake.url,
        effect: 'read',
        headers: { 'X-Team': 'payments' },
        auth: { type: 'token', token: TOKEN },
      })
      expect(r.status).toBe(201)
      id = r.body.id
      expect(JSON.stringify(r.body)).not.toContain(TOKEN)
      expect(r.body).toMatchObject({
        name: 'notes',
        source: 'record',
        employeeId: null,
        auth: { type: 'token', header: 'Authorization', prefix: 'Bearer ', secret: 'MCP_NOTES_TOKEN', hasToken: true },
        status: { state: 'connected', toolCount: 2 },
      })
      const secrets = await s.secrets.list()
      expect(secrets.find((m) => m.name === 'MCP_NOTES_TOKEN')?.scope).toEqual({ type: 'global' })
      const stored = await s.records.get('mcp_server', id)
      expect(JSON.stringify(stored)).not.toContain(TOKEN)
      expect(tokenFake.authHeaders.at(-1)).toBe(`Bearer ${TOKEN}`)

      expect(await visible(ana, 'mcp.notes.echo')).toBe(true)
      expect(await visible(ben, 'mcp.notes.echo')).toBe(true)
      expect(s.tools.get('mcp.notes.echo')!.def).toMatchObject({
        effect: 'read',
        source: 'mcp',
        server: 'notes',
        secrets: ['MCP_NOTES_TOKEN'],
      })

      const out = await s.tools.execute('mcp.notes.echo', { text: `leak ${TOKEN}` }, ctxFor(ana))
      expect(out).toEqual({ output: 'leak [redacted]' })
      expect(JSON.stringify(t.logs)).not.toContain(TOKEN)

      const tools = (await t.req('GET', `/api/mcp-servers/${id}/tools`)).body
      expect(tools.map((x: any) => x.toolName).sort()).toEqual(['mcp.notes.echo', 'mcp.notes.whoami'])

      // New sessions get the tools through the router contexts.
      const router = await s.sessions.get((await s.directory.employees.get(ben))!.data.routerSessionId!)
      expect(router!.data.toolset).toContain('mcp.notes.echo')
    })

    it('keeps the token on an edit without one, and uses a new one', async () => {
      const kept = await t.req('PATCH', `/api/mcp-servers/${id}`, { url: tokenFake.url, auth: { type: 'token' } })
      expect(kept.status).toBe(200)
      expect(kept.body.auth).toMatchObject({ type: 'token', hasToken: true })
      const wrong = await t.req('PATCH', `/api/mcp-servers/${id}`, { auth: { type: 'token', token: 'sk-test-wrong-token' } })
      expect(wrong.body.status.state).toBe('needs_auth')
      expect(s.tools.get('mcp.notes.echo')).toBeNull()
      const right = await t.req('PATCH', `/api/mcp-servers/${id}`, { auth: { type: 'token', token: TOKEN } })
      expect(right.body.status).toMatchObject({ state: 'connected', toolCount: 2 })
      expect(s.tools.get('mcp.notes.echo')).not.toBeNull()
    })

    it('refuses a changed name, a global name for an employee, and a stale version', async () => {
      expect((await t.req('PATCH', `/api/mcp-servers/${id}`, { name: 'other' })).status).toBe(422)
      expect((await t.req('POST', '/api/mcp-servers', { name: 'notes', url: tokenFake.url, employeeId: ana })).status).toBe(409)
      expect((await t.req('POST', '/api/mcp-servers', { name: 'notes', url: tokenFake.url })).status).toBe(409)
      expect((await t.req('PATCH', `/api/mcp-servers/${id}`, { enabled: true, version: 1 })).status).toBe(409)
    })

    it('can be disabled and enabled', async () => {
      const off = await t.req('PATCH', `/api/mcp-servers/${id}`, { enabled: false })
      expect(off.body.status).toEqual({ state: 'disabled', toolCount: 0 })
      expect(s.tools.get('mcp.notes.echo')).toBeNull()
      const on = await t.req('PATCH', `/api/mcp-servers/${id}`, { enabled: true })
      expect(on.body.status.state).toBe('connected')
    })

    it('reconnects', async () => {
      const r = await t.req('POST', `/api/mcp-servers/${id}/reconnect`)
      expect(r.body.status.state).toBe('connected')
    })

    it('is deleted with the secret it generated', async () => {
      expect((await t.req('DELETE', `/api/mcp-servers/${id}`)).status).toBe(204)
      expect(s.tools.get('mcp.notes.echo')).toBeNull()
      expect((await s.secrets.list()).some((m) => m.name === 'MCP_NOTES_TOKEN')).toBe(false)
      expect((await t.req('GET', `/api/mcp-servers/${id}/tools`)).status).toBe(404)
    })

    it('does not delete a secret it was only told to use', async () => {
      await s.secrets.set('SHARED_NOTES_TOKEN', TOKEN, { type: 'global' })
      const r = await t.req('POST', '/api/mcp-servers', {
        name: 'shared',
        url: tokenFake.url,
        auth: { type: 'token', secret: 'SHARED_NOTES_TOKEN' },
      })
      expect(r.body.status.state).toBe('connected')
      await t.req('DELETE', `/api/mcp-servers/${r.body.id}`)
      expect((await s.secrets.list()).some((m) => m.name === 'SHARED_NOTES_TOKEN')).toBe(true)
    })
  })

  describe("an employee's OAuth server", () => {
    let id: string
    const start = async (who?: Record<string, string>) => {
      const r = await t.req('POST', `/api/mcp-servers/${id}/oauth/start`, { returnTo: `/employees/${ana}` }, who)
      expect(r.status).toBe(200)
      return r.body.authorizationUrl as string
    }
    const callback = async (url: URL, headers?: Record<string, string>) => {
      const res = await t.a.app.request(`${url.pathname}${url.search}`, {
        headers: headers ?? (await t.admin()).headers,
      })
      expect(res.status).toBe(303)
      expect(res.headers.get('cache-control')).toBe('no-store')
      return new URL(res.headers.get('location')!, 'http://harness.test')
    }

    it('starts as needs_auth, with no tools', async () => {
      const r = await t.req('POST', '/api/mcp-servers', { name: 'wiki', url: fake.url, employeeId: ana, auth: { type: 'oauth' } })
      expect(r.status).toBe(201)
      id = r.body.id
      expect(r.body).toMatchObject({
        employeeId: ana,
        auth: { type: 'oauth', hasTokens: false },
        status: { state: 'needs_auth' },
      })
      expect(s.tools.get('mcp.wiki.echo')).toBeNull()
      const mine = (await t.req('GET', `/api/mcp-servers?employeeId=${ana}`)).body
      expect(mine.map((x: any) => x.name)).toEqual(['wiki'])
      expect((await t.req('GET', `/api/mcp-servers?employeeId=${ben}`)).body).toEqual([])
      expect((await t.req('GET', '/api/mcp-servers?employeeId=global')).body.some((x: any) => x.name === 'wiki')).toBe(false)
    })

    it('signs in: discovery, registration, code exchange; tools only for that employee', async () => {
      const url = new URL(await start())
      expect(url.origin).toBe(fake.origin)
      expect(url.searchParams.get('redirect_uri')).toBe('http://harness.test/oauth/mcp/callback')
      const back = await fake.approve(url)
      const landed = await callback(back)
      expect(landed.pathname).toBe(`/employees/${ana}`)
      expect(landed.searchParams.get('mcp_oauth')).toBe('connected')
      expect(landed.searchParams.get('mcp_server')).toBe('wiki')
      expect(fake.stats).toMatchObject({ registrations: 1, codeExchanges: 1 })

      const info = (await t.req('GET', `/api/mcp-servers?employeeId=${ana}`)).body[0]
      expect(info).toMatchObject({ auth: { hasTokens: true }, status: { state: 'connected', toolCount: 2 } })

      // Credentials are secrets scoped to the employee, never in the record.
      const metas = (await s.secrets.list()).filter((m) => m.name.startsWith('MCP_WIKI_OAUTH_'))
      expect(metas.map((m) => m.name).sort()).toEqual([
        'MCP_WIKI_OAUTH_CLIENT',
        'MCP_WIKI_OAUTH_DISCOVERY',
        'MCP_WIKI_OAUTH_TOKENS',
      ])
      for (const m of metas) expect(m.scope).toEqual({ type: 'employee', id: ana })
      const tokens = JSON.parse((await s.secrets.resolve(['MCP_WIKI_OAUTH_TOKENS'], { employeeId: ana })).MCP_WIKI_OAUTH_TOKENS!)
      expect(JSON.stringify(await s.records.get('mcp_server', id))).not.toContain(tokens.access_token)

      expect(await visible(ana, 'mcp.wiki.echo')).toBe(true)
      expect(await visible(ben, 'mcp.wiki.echo')).toBe(false)
      const anaRouter = await s.sessions.get((await s.directory.employees.get(ana))!.data.routerSessionId!)
      const benRouter = await s.sessions.get((await s.directory.employees.get(ben))!.data.routerSessionId!)
      expect(anaRouter!.data.toolset).toContain('mcp.wiki.echo')
      expect(benRouter!.data.toolset).not.toContain('mcp.wiki.echo')

      expect(await s.tools.execute('mcp.wiki.echo', { text: 'hi' }, ctxFor(ana))).toEqual({ output: 'hi' })
      await expect(s.tools.execute('mcp.wiki.echo', { text: 'hi' }, ctxFor(ben))).rejects.toBeInstanceOf(DeniedError)
      const leak = await s.tools.execute('mcp.wiki.echo', { text: tokens.access_token }, ctxFor(ana))
      expect(leak.output).toBe('[redacted]')
    })

    it('another employee may have a server of the same name; each call goes to its own', async () => {
      const other = await startFakeOAuthMcp({ staticToken: TOKEN })
      try {
        const r = await t.req('POST', '/api/mcp-servers', {
          name: 'wiki',
          url: other.url,
          employeeId: ben,
          auth: { type: 'token', token: TOKEN },
        })
        expect(r.status).toBe(201)
        expect((await s.secrets.list()).find((m) => m.name === 'MCP_WIKI_TOKEN')?.scope).toEqual({ type: 'employee', id: ben })
        expect(await visible(ben, 'mcp.wiki.echo')).toBe(true)
        const who = (e: string) => s.tools.execute('mcp.wiki.whoami', {}, ctxFor(e)).then((x) => JSON.parse(x.output as string))
        expect((await who(ben)).clientId).toBe('static')
        expect((await who(ana)).clientId).not.toBe('static')
        await t.req('DELETE', `/api/mcp-servers/${r.body.id}`)
        expect(await visible(ben, 'mcp.wiki.echo')).toBe(false)
        expect(await visible(ana, 'mcp.wiki.echo')).toBe(true)
      } finally {
        await other.close()
      }
    })

    it('refuses a bad state, a replayed one, an expired one, and one from another person', async () => {
      const bad = await callback(new URL('http://harness.test/oauth/mcp/callback?state=nope&code=x'))
      expect(bad.searchParams.get('mcp_oauth')).toBe('error')
      expect(bad.searchParams.get('mcp_error')).toMatch(/unknown sign-in/)

      const noSignIn = await t.a.app.request('/oauth/mcp/callback?state=nope&code=x')
      expect(new URL(noSignIn.headers.get('location')!, 'http://x').searchParams.get('mcp_error')).toMatch(/sign in/)

      // Another admin can't finish my sign-in.
      const other = await person(t, 'Olga Other', 'admin')
      const otherHeaders = await t.as(other, { access: 'admin' })
      const url1 = await start()
      const back1 = await fake.approve(url1)
      const stolen = await callback(back1, otherHeaders)
      expect(stolen.searchParams.get('mcp_error')).toMatch(/someone else/)
      // …and that attempt didn't use it up: the right person still can, once.
      expect((await callback(back1)).searchParams.get('mcp_oauth')).toBe('connected')
      const replay = await callback(back1)
      expect(replay.searchParams.get('mcp_error')).toMatch(/already used/)

      // Expired.
      const url2 = new URL(await start())
      const state = url2.searchParams.get('state')!
      const pending = await s.records.query<any>('mcp_oauth_state', { where: { serverId: id }, limit: 100 })
      for (const r of pending.items.filter((x) => !x.data.usedAt))
        await s.records.update('mcp_oauth_state', r.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })
      const back2 = await fake.approve(url2)
      expect(back2.searchParams.get('state')).toBe(state)
      expect((await callback(back2)).searchParams.get('mcp_error')).toMatch(/expired/)

      // A member can't start or finish one.
      const member = await person(t, 'Max Member', 'member')
      expect((await t.req('POST', `/api/mcp-servers/${id}/oauth/start`, {}, { 'x-mp-contact': member })).status).toBe(403)
    })

    it('refreshes by itself; when the refresh fails it is needs_auth, with an event and an alert', async () => {
      await t.req('POST', `/api/mcp-servers/${id}/reconnect`)
      fake.expireAccessTokens()
      expect(await s.tools.execute('mcp.wiki.echo', { text: 'refreshed' }, ctxFor(ana))).toEqual({ output: 'refreshed' })
      expect(fake.stats.refreshes).toBeGreaterThanOrEqual(1)

      const events: any[] = []
      const off = s.bus.subscribe(MCP_SERVER_STATUS_TOPIC, (m) => void events.push(m.payload))
      const post = vi.fn(async () => 'msg_x')
      const offAlerts = wireMcpAlerts(s, { post })
      try {
        fake.expireAccessTokens()
        fake.revokeRefreshTokens()
        const failed = await s.tools.execute('mcp.wiki.echo', { text: 'x' }, ctxFor(ana)).catch((e) => e)
        expect(failed.code).toBe('unavailable')
        expect(failed.message).toContain('wiki')
        await until(() => events.some((e) => e.state === 'needs_auth'))
        expect(events.find((e) => e.state === 'needs_auth')).toMatchObject({ id, name: 'wiki', employeeId: ana })
        await until(() => post.mock.calls.length > 0)
        expect(post.mock.calls[0]).toMatchObject([
          expect.stringContaining(`mcp.needs_auth:${id}`),
          { condition: 'dependency.unavailable', dependency: 'MCP server wiki' },
          null,
        ])
        const info = (await t.req('GET', `/api/mcp-servers?employeeId=${ana}`)).body[0]
        expect(info.status.state).toBe('needs_auth')
        expect(s.tools.get('mcp.wiki.echo')).toBeNull()
      } finally {
        off()
        offAlerts()
      }
      // Connect again.
      const back = await fake.approve(await start())
      expect((await callback(back)).searchParams.get('mcp_oauth')).toBe('connected')
      expect(await s.tools.execute('mcp.wiki.echo', { text: 'back' }, ctxFor(ana))).toEqual({ output: 'back' })
    })

    it('disconnects: the tokens are deleted and it needs a sign-in', async () => {
      const r = await t.req('POST', `/api/mcp-servers/${id}/oauth/disconnect`)
      expect(r.body).toMatchObject({ auth: { hasTokens: false }, status: { state: 'needs_auth' } })
      expect((await s.secrets.list()).some((m) => m.name === 'MCP_WIKI_OAUTH_TOKENS')).toBe(false)
    })

    it('is deleted with its OAuth secrets and states', async () => {
      await start()
      expect((await t.req('DELETE', `/api/mcp-servers/${id}`)).status).toBe(204)
      expect((await s.secrets.list()).some((m) => m.name.startsWith('MCP_WIKI_OAUTH_'))).toBe(false)
      expect((await s.records.query('mcp_oauth_state', { where: { serverId: id } })).items).toEqual([])
    })
  })

  describe('state after a restart', () => {
    it('reconnects the servers from their records', async () => {
      const r = await t.req('POST', '/api/mcp-servers', {
        name: 'again',
        url: tokenFake.url,
        auth: { type: 'token', token: TOKEN },
      })
      const { McpServers } = await import('../src/mcp-servers/index.ts')
      // A second manager over the same records and a fresh hub: what a restart does.
      let second: InstanceType<typeof McpServers> | null = null
      const hub = (await import('@mp/mcp-sdk')).createMcpHub({
        resolveSecrets: (names, server) => second!.resolveSecrets(names, server),
        authProviderFor: (server) => second!.authProviderFor(server),
      })
      second = new McpServers({
        records: s.records,
        secrets: s.secrets,
        tools: (await import('@mp/tools')).createToolRegistry(),
        hub,
        directory: s.directory,
        sessions: s.sessions,
        bus: createEventBus({}),
        clock: s.clock,
        logger: s.logger,
        configServers: [],
        configTools: () => [],
        baseToolLists: async () => ({ allow: ['**'], deny: [] }),
      })
      try {
        await second.start()
        const list = await second.list(null)
        expect(list.find((x) => x.id === r.body.id)?.status.state).toBe('connected')
      } finally {
        await second.close()
        await hub.close()
        await t.req('DELETE', `/api/mcp-servers/${r.body.id}`)
      }
    })
  })
}

describe('MCP servers (memory)', () => mcpSuite(memoryBackend))

const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL
describe.skipIf(!DATABASE_URL || !REDIS_URL)('MCP servers (postgres+bullmq)', () =>
  mcpSuite(realBackend(DATABASE_URL!, REDIS_URL!)),
)

describe('OAuth states', () => {
  const make = () => {
    const clock = new ManualClock(Date.UTC(2026, 8, 29, 9))
    const records = createRecords({ store: memoryStore({ clock }) })
    return { clock, states: new OAuthStates(records, clock, memoryLogger([])) }
  }
  const input = { serverId: 'mcs_1', contactId: 'con_a', returnTo: '/settings', redirectUrl: 'http://h.test/oauth/mcp/callback' }

  it('is single-use, even with two uses at once', async () => {
    const { states } = make()
    const { state } = await states.create(input)
    const results = await Promise.allSettled([states.consume(state, 'con_a'), states.consume(state, 'con_a')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: expect.any(DeniedError) })
  })

  it('expires after 10 minutes', async () => {
    const { states, clock } = make()
    const { state, expiresAt } = await states.create(input)
    expect(Date.parse(expiresAt) - clock.now()).toBe(10 * 60_000)
    clock.advance(10 * 60_000 + 1)
    await expect(states.consume(state, 'con_a')).rejects.toThrow(/expired/)
  })

  it('is bound to the person who started it, and unknown states are refused', async () => {
    const { states } = make()
    const { state } = await states.create(input)
    await expect(states.consume(state, 'con_b')).rejects.toThrow(/someone else/)
    await expect(states.consume('forged', 'con_a')).rejects.toThrow(/unknown/)
    await expect(states.consume('', 'con_a')).rejects.toBeInstanceOf(DeniedError)
    expect(await states.consume(state, 'con_a')).toMatchObject({ serverId: 'mcs_1' })
  })
})

describe('safeReturnTo', () => {
  it('keeps harness paths and drops anything else', () => {
    expect(safeReturnTo('/employees/emp_1?tab=mcp', '/settings')).toBe('/employees/emp_1?tab=mcp')
    for (const bad of ['https://evil.test/', '//evil.test/x', '/\\evil.test', 'javascript:alert(1)', 42, undefined])
      expect(safeReturnTo(bad, '/settings')).toBe('/settings')
  })
})

describe('notifications from runtime servers', () => {
  it('become events with the server name as the source and its employee', async () => {
    const logs: LogLine[] = []
    const t = await testApp({ workers: false })
    try {
      const s = t.a.services
      const hub = fakeMcpHub({ servers: { mcs_abc: { tools: [] } } })
      const emp = (await s.directory.employees.list()).items[0]!.id
      wireMcpNotifications({
        hub,
        events: s.rawEvents,
        directory: s.directory,
        servers: [],
        logger: memoryLogger(logs),
        runtime: (name) =>
          name === 'mcs_abc'
            ? {
                name: 'notes',
                employeeId: emp,
                events: [{ method: 'notifications/notes/*', type: 'note.changed', idFrom: 'id' }],
              }
            : undefined,
      })
      hub.notify('mcs_abc', 'notifications/notes/updated', { id: 'n1' })
      const ev = await until(async () => (await s.records.query<any>('event', { where: { source: 'mcp:notes' } })).items[0])
      expect(ev.data).toMatchObject({ source: 'mcp:notes', type: 'note.changed', employeeId: emp })
    } finally {
      await t.close()
    }
  })
})
