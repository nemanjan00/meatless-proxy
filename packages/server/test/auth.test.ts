import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTES } from '@mp/api'
import { ManualClock, memoryLogger } from '@mp/core'
import { memoryStore } from '@mp/store'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GUARD_RULES, compileRules, matchRule } from '../src/auth/guard.ts'
import { RateLimiter } from '../src/auth/rate-limit.ts'
import { SESSION_GRACE_MS, SESSION_ROTATE_MS, SESSION_TTL_MS, createLoginLink } from '../src/auth/sessions.ts'
import { createMcpToken } from '../src/tokens.ts'
import { cookiesOf, testApp, type TestApp } from './helpers.ts'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
async function make(opts: Parameters<typeof testApp>[0] = {}) {
  const t = await testApp({ workers: false, ...opts })
  apps.push(t)
  return t
}
const anon = { authorization: '' }

async function person(t: TestApp, name: string, access?: 'viewer' | 'member' | 'admin', email?: string) {
  const c = await t.a.services.directory.contacts.create({
    name,
    kind: 'person',
    ...(access ? { access } : {}),
    ...(email ? { email } : {}),
  })
  return c.id
}

/** Exchanges a sign-in link at /auth/login; returns the response and its cookies. */
async function login(t: TestApp, token: string, headers: Record<string, string> = {}) {
  const res = await t.a.app.request(`/auth/login?token=${encodeURIComponent(token)}`, { headers })
  return { res, cookies: cookiesOf(res), setCookie: res.headers.getSetCookie() }
}
const cookieHeader = (c: Record<string, string>) => ({ cookie: `mp_session=${c.mp_session}; mp_csrf=${c.mp_csrf}` })

describe('nobody is trusted on their word', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await testApp({ workers: false })
  })
  afterAll(() => t.close())

  it('refuses the API and the WebSocket without sign-in, whatever x-mp-contact says', async () => {
    const someone = await person(t, 'Mallory Example', 'admin')
    for (const [method, path] of [
      ['GET', '/api/me'],
      ['GET', '/api/kinds'],
      ['GET', '/api/chat/channels'],
      ['POST', '/api/control/pause-all'],
      ['GET', '/ws'],
    ] as const) {
      const r = await t.req(method, path, undefined, anon)
      expect(r.status, `${method} ${path}`).toBe(401)
    }
    const raw = await t.a.app.request('/api/me', { headers: { 'x-mp-contact': someone } })
    expect(raw.status).toBe(401)
    expect(((await raw.json()) as any).error.code).toBe('unauthorized')
    const bad = await t.req('GET', '/api/me', undefined, { authorization: 'Bearer mpt_nope' })
    expect(bad.status).toBe(401)
    const badCookie = await t.req('GET', '/api/me', undefined, { cookie: 'mp_session=mps_nope' })
    expect(badCookie.status).toBe(401)
  })

  it('keeps health, the login config and sign-in public', async () => {
    expect((await t.req('GET', '/healthz', undefined, anon)).status).toBe(200)
    expect((await t.req('GET', '/api/auth/config', undefined, anon)).body).toEqual({ oidc: false })
    const r = await t.a.app.request('/auth/login?token=mpl_nope')
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe('/login?error=invalid_link')
  })

  it('has a rule for every API route, and closes unknown unsafe routes to non-admins', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const concrete = path.replace(/:([A-Za-z]+)/g, (_, n) => (n === 'kind' ? 'project' : `x_${n}`))
      const hit = matchRule(compiled, method, concrete)
      expect(hit, name).not.toBeNull()
      const need = typeof hit!.rule.need === 'function' ? hit!.rule.need(hit!.params) : hit!.rule.need
      if (method === 'GET' && !['listSecrets'].includes(name)) expect(['viewer', 'public'], name).toContain(need)
      if (['health', 'ready', 'authConfig'].includes(name)) expect(need, name).toBe('public')
    }
    const unknown = matchRule(compiled, 'POST', '/api/something-new')
    expect(unknown?.rule.need).toBe('admin')
    expect(matchRule(compiled, 'GET', '/api/something-new')?.rule.need).toBe('viewer')
    expect(matchRule(compiled, 'GET', '/sessions/abc')).toBeNull()
    expect(matchRule(compiled, 'POST', '/webhooks/slack')?.rule.need).toBe('public')
  })
})

const compiled = compileRules(GUARD_RULES)

describe('sign-in links and sessions', () => {
  it('a link works once, within 15 minutes, and starts a session cookie', async () => {
    const clock = new ManualClock(Date.UTC(2026, 8, 29, 9))
    const t = await make({ overrides: { clock } })
    const ana = await person(t, 'Ana Example', 'member')
    const link = await createLoginLink(t.a.services, ana)
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/login\?token=mpl_/)
    const stored = await t.a.services.records.query('login_link', {})
    expect(JSON.stringify(stored.items)).not.toContain(link.token)

    const { res, cookies, setCookie } = await login(t, link.token)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    const session = setCookie.find((c) => c.startsWith('mp_session='))!
    expect(session).toMatch(/HttpOnly/)
    expect(session).toMatch(/SameSite=Lax/)
    expect(session).toMatch(/Path=\//)
    expect(session).toMatch(/Max-Age=1209600/)
    expect(session).not.toMatch(/Secure/)
    expect(setCookie.find((c) => c.startsWith('mp_csrf='))).not.toMatch(/HttpOnly/)
    expect(JSON.stringify((await t.a.services.records.query('auth_session', {})).items)).not.toContain(cookies.mp_session)

    const me = await t.req('GET', '/api/me', undefined, cookieHeader(cookies))
    expect(me.body).toEqual({ contactId: ana, name: 'Ana Example', access: 'member', via: 'session' })

    // Once only.
    expect((await login(t, link.token)).res.headers.get('location')).toBe('/login?error=invalid_link')
    // Expired after 15 minutes.
    const late = await createLoginLink(t.a.services, ana)
    clock.advance(15 * 60_000 + 1)
    expect((await login(t, late.token)).res.headers.get('location')).toBe('/login?error=invalid_link')
  })

  it('goes back to a local page only', async () => {
    const t = await make()
    const ana = await person(t, 'Ana Example', 'member')
    const go = async (next: string) => {
      const link = await createLoginLink(t.a.services, ana)
      const r = await t.a.app.request(`/auth/login?token=${link.token}&next=${encodeURIComponent(next)}`)
      return r.headers.get('location')
    }
    expect(await go('/chat/chn_1')).toBe('/chat/chn_1')
    expect(await go('https://evil.example.com/')).toBe('/')
    expect(await go('//evil.example.com')).toBe('/')
    expect(await go('/auth/login')).toBe('/')
  })

  it('sets Secure over https, or when configured', async () => {
    const t = await make({ env: { PUBLIC_URL: 'https://mp.example.com' } })
    const ana = await person(t, 'Ana Example', 'member')
    const link = await createLoginLink(t.a.services, ana)
    expect(link.url.startsWith('https://mp.example.com/auth/login?token=')).toBe(true)
    const { setCookie } = await login(t, link.token)
    expect(setCookie.find((c) => c.startsWith('mp_session='))).toMatch(/Secure/)
    const off = await make({ env: { PUBLIC_URL: 'https://mp.example.com', COOKIE_SECURE: 'false' } })
    const bob = await person(off, 'Bob Example', 'member')
    const l2 = await createLoginLink(off.a.services, bob)
    expect((await login(off, l2.token)).setCookie.find((c) => c.startsWith('mp_session='))).not.toMatch(/Secure/)
  })

  it('slides the expiry, rotates the id every few hours, and ends on sign-out', async () => {
    const clock = new ManualClock(Date.UTC(2026, 8, 29, 9))
    const t = await make({ overrides: { clock } })
    const ana = await person(t, 'Ana Example', 'member')
    const { cookies } = await login(t, (await createLoginLink(t.a.services, ana)).token)
    const first = cookieHeader(cookies)

    // Used again within the rotation period: same id, expiry moved forward.
    clock.advance(60 * 60_000)
    const r1 = await t.a.app.request('/api/me', { headers: first })
    expect(r1.status).toBe(200)
    expect(r1.headers.getSetCookie()).toEqual([])

    // Past the rotation period: a new id; the old one keeps working for a minute only.
    clock.advance(SESSION_ROTATE_MS)
    const r2 = await t.a.app.request('/api/me', { headers: first })
    expect(r2.status).toBe(200)
    const rotated = cookiesOf(r2).mp_session!
    expect(rotated).toMatch(/^mps_/)
    expect(rotated).not.toBe(cookies.mp_session)
    const second = { cookie: `mp_session=${rotated}; mp_csrf=${cookies.mp_csrf}` }
    expect((await t.req('GET', '/api/me', undefined, first)).status).toBe(200)
    clock.advance(SESSION_GRACE_MS + 1)
    expect((await t.req('GET', '/api/me', undefined, first)).status).toBe(401)
    expect((await t.req('GET', '/api/me', undefined, second)).status).toBe(200)

    // Unused for 14 days: expired.
    clock.advance(SESSION_TTL_MS + 1)
    expect((await t.req('GET', '/api/me', undefined, second)).status).toBe(401)

    const { cookies: again } = await login(t, (await createLoginLink(t.a.services, ana)).token)
    const h = { ...cookieHeader(again), 'x-mp-csrf': again.mp_csrf! }
    const out = await t.a.app.request('/api/auth/logout', { method: 'POST', headers: h })
    expect(out.status).toBe(204)
    expect(out.headers.getSetCookie().find((c) => c.startsWith('mp_session='))).toMatch(/Max-Age=0/)
    expect((await t.req('GET', '/api/me', undefined, h)).status).toBe(401)
  })

  it('AI employees and people who left cannot sign in', async () => {
    const t = await make()
    const s = t.a.services
    const emp = (await s.directory.employees.byHandle('meatless'))!
    await expect(createLoginLink(s, emp.data.contactId)).rejects.toThrow(/can't sign in/)
    const aiToken = await createMcpToken(s, emp.data.contactId)
    expect((await t.req('GET', '/api/me', undefined, { authorization: `Bearer ${aiToken.token}` })).status).toBe(401)
    expect((await t.req('POST', '/api/auth/tokens', { contactId: emp.data.contactId })).status).toBe(403)

    const gone = await person(t, 'Gone Example', 'admin')
    const link = await createLoginLink(s, gone)
    await s.directory.contacts.update(gone, { status: 'left' })
    expect((await login(t, link.token)).res.headers.get('location')).toBe('/login?error=invalid_link')
  })
})

describe('CSRF', () => {
  let t: TestApp
  let h: Record<string, string>
  let csrf: string
  beforeAll(async () => {
    t = await testApp({ workers: false })
    const ana = await person(t, 'Ana Example', 'member')
    const { cookies } = await login(t, (await createLoginLink(t.a.services, ana)).token)
    h = cookieHeader(cookies)
    csrf = cookies.mp_csrf!
  })
  afterAll(() => t.close())

  const post = (headers: Record<string, string>) =>
    t.a.app.request('/api/chat/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'mp.local', ...headers },
      body: JSON.stringify({ scope: 'chn_x' }),
    })

  it('refuses cookie requests from another origin, or without proof', async () => {
    expect((await post(h)).status).toBe(403)
    expect((await post({ ...h, origin: 'https://evil.example.com' })).status).toBe(403)
    expect((await post({ ...h, origin: 'null' })).status).toBe(403)
    expect((await post({ ...h, 'x-mp-csrf': 'wrong' })).status).toBe(403)
  })

  it('accepts the same origin, or the double-submit token; reads need neither', async () => {
    expect((await post({ ...h, origin: 'http://mp.local' })).status).toBe(204)
    expect((await post({ ...h, 'x-mp-csrf': csrf })).status).toBe(204)
    expect((await t.a.app.request('/api/me', { headers: h })).status).toBe(200)
  })

  it('does not apply to bearer tokens', async () => {
    const r = await t.req('POST', '/api/chat/read', { scope: 'chn_x' }, { origin: 'https://elsewhere.example.com' })
    expect(r.status).toBe(204)
  })

  it('checks against PUBLIC_URL when it is set', async () => {
    const p = await make({ env: { PUBLIC_URL: 'https://mp.example.com' } })
    const ana = await person(p, 'Ana Example', 'member')
    const { cookies } = await login(p, (await createLoginLink(p.a.services, ana)).token)
    const req = (origin: string) =>
      p.a.app.request('/api/chat/read', {
        method: 'POST',
        headers: { ...cookieHeader(cookies), origin, host: 'mp.local', 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'chn_x' }),
      })
    expect((await req('https://mp.example.com')).status).toBe(204)
    expect((await req('http://mp.local')).status).toBe(403)
  })
})

describe('API tokens', () => {
  it('are created once, listed, revoked, and work for /api and /mcp alike', async () => {
    const t = await make({ http: true })
    const viewer = await person(t, 'Vic Viewer', 'viewer')
    const other = await person(t, 'Oli Other', 'member')
    const vh = await t.as(viewer)

    const created = await t.req('POST', '/api/auth/tokens', { name: 'laptop' }, vh)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ contactId: viewer, name: 'laptop', revoked: false })
    expect(created.body.token).toMatch(/^mpt_/)
    const mine = { authorization: `Bearer ${created.body.token}` }
    expect((await t.req('GET', '/api/me', undefined, mine)).body).toMatchObject({ contactId: viewer, via: 'token' })

    const list = await t.req('GET', '/api/auth/tokens', undefined, vh)
    expect(list.body.map((x: any) => x.name)).toContain('laptop')
    expect(JSON.stringify(list.body)).not.toContain(created.body.token)

    // The same token on the MCP server.
    const mcp = await fetch(`http://127.0.0.1:${t.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...mine },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    })
    expect(mcp.status).toBe(200)
    await mcp.body?.cancel()

    // Others' tokens are for admins.
    expect((await t.req('POST', '/api/auth/tokens', { contactId: other }, vh)).status).toBe(403)
    expect((await t.req('GET', `/api/auth/tokens?contactId=${other}`, undefined, vh)).status).toBe(403)
    expect((await t.req('GET', '/api/auth/tokens?all=true', undefined, vh)).status).toBe(403)
    const forOther = await t.req('POST', '/api/auth/tokens', { contactId: other, name: 'ci' })
    expect(forOther.status).toBe(201)
    expect((await t.req('DELETE', `/api/auth/tokens/${forOther.body.id}`, undefined, vh)).status).toBe(403)
    expect((await t.req('GET', `/api/auth/tokens?contactId=${other}`)).body).toHaveLength(1)

    const revoked = await t.req('DELETE', `/api/auth/tokens/${created.body.id}`, undefined, vh)
    expect(revoked.body.revoked).toBe(true)
    expect((await t.req('GET', '/api/me', undefined, mine)).status).toBe(401)
    expect((await t.req('DELETE', '/api/auth/tokens/mtk_nope', undefined, vh)).status).toBe(404)
    // The old MCP path does the same.
    expect((await t.req('POST', '/api/mcp/tokens', { name: 'x' }, vh)).status).toBe(201)
  })

  it('refuses a flood of bad tokens from one address', async () => {
    const t = await make()
    for (let i = 0; i < 30; i++)
      expect((await t.req('GET', '/api/me', undefined, { authorization: `Bearer mpt_guess${i}` })).status).toBe(401)
    const r = await t.a.app.request('/api/me', { headers: { authorization: 'Bearer mpt_guess' } })
    expect(r.status).toBe(429)
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('limits sign-in attempts per address', async () => {
    const t = await make()
    for (let i = 0; i < 20; i++)
      expect((await t.a.app.request(`/auth/login?token=mpl_guess${i}`)).headers.get('location')).toBe('/login?error=invalid_link')
    const r = await t.a.app.request('/auth/login?token=mpl_guess')
    expect(r.headers.get('location')).toBe('/login?error=too_many_attempts')
  })
})

describe('roles', () => {
  let t: TestApp
  let viewer: Record<string, string>
  let member: Record<string, string>
  let memberId: string
  let employeeId: string
  beforeAll(async () => {
    t = await testApp({ workers: false })
    viewer = await t.as(await person(t, 'Vic Viewer', 'viewer'))
    memberId = await person(t, 'Mel Member', 'member')
    member = await t.as(memberId)
    employeeId = (await t.a.services.directory.employees.byHandle('meatless'))!.id
  })
  afterAll(() => t.close())

  const status = async (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    (await t.req(method, path, body ?? (method === 'GET' || method === 'DELETE' ? undefined : {}), h)).status

  it('viewers read everything but secrets, and change nothing', async () => {
    for (const p of ['/api/kinds', '/api/now', '/api/sessions', '/api/chat/channels', '/api/records/project', '/api/triggers'])
      expect(await status('GET', p, viewer), p).toBe(200)
    expect(await status('GET', '/api/secrets', viewer)).toBe(403)
    const general = (await t.a.services.chat.channelByName('general'))!.id
    expect(await status('POST', `/api/chat/channels/${general}/messages`, viewer, { text: 'hi' })).toBe(403)
    expect(await status('POST', '/api/records/project', viewer, { data: { name: 'Nope' } })).toBe(403)
    expect(await status('POST', '/api/control/pause-all', viewer)).toBe(403)
  })

  it('members chat, edit knowledge and steer their own work; admins the rest', async () => {
    const general = (await t.a.services.chat.channelByName('general'))!.id
    expect(await status('POST', `/api/chat/channels/${general}/messages`, member, { text: 'hi' })).toBe(201)
    expect(await status('POST', '/api/records/project', member, { data: { name: 'Apollo' } })).toBe(201)
    expect(await status('PATCH', `/api/records/contact/${memberId}`, member, { data: { team: 'Ops' } })).toBe(200)
    // Access is for admins to change, also one's own.
    expect(await status('PATCH', `/api/records/contact/${memberId}`, member, { data: { access: 'admin' } })).toBe(403)
    expect(await status('POST', '/api/records/contact', member, { data: { name: 'X', kind: 'person', access: 'admin' } })).toBe(
      403,
    )
    expect(await status('PATCH', `/api/records/employee/${employeeId}`, member, { data: { personality: 'x' } })).toBe(403)
    expect(await status('POST', '/api/records/trigger', member, { data: {} })).toBe(403)
    const doc = await t.a.services.sessions.create({ employeeId, title: 'Notes' })
    expect(await status('PATCH', `/api/records/session/${doc.id}`, member, { data: { document: '# Notes' } })).toBe(200)
    expect(await status('PATCH', `/api/records/session/${doc.id}`, member, { data: { toolset: ['**'] } })).toBe(403)
    expect(await status('PATCH', `/api/records/session/${doc.id}`, viewer, { data: { document: 'x' } })).toBe(403)
    expect(await status('PUT', '/api/secrets', member, { name: 'X', value: 'y' })).toBe(403)
    expect(await status('POST', `/api/employees/${employeeId}/ssh-key`, member)).toBe(403)
    expect(await status('POST', '/api/control/pause-all', member)).toBe(403)
    expect(await status('POST', '/api/auth/links', member, { contactId: memberId })).toBe(403)
    expect(await status('POST', '/api/events', member, { source: 'x', type: 'y', payload: null })).toBe(403)

    // Their own run, not someone else's.
    const s = t.a.services
    const session = await s.sessions.create({ employeeId, title: 'Work' })
    const own = await s.sessions.createRun({ sessionId: session.id, cause: { type: 'manual' }, requesterId: memberId })
    const others = await s.sessions.createRun({ sessionId: session.id, mode: 'ephemeral', cause: { type: 'manual' } })
    expect(await status('POST', `/api/runs/${own.id}/pause`, member)).toBe(200)
    expect(await status('POST', `/api/runs/${own.id}/resume`, member)).toBe(200)
    expect(await status('POST', `/api/runs/${others.id}/pause`, member)).toBe(403)
    expect(await status('POST', `/api/runs/${others.id}/pause`, (await t.admin()).headers)).toBe(200)

    // Admins.
    expect(
      await status('PATCH', `/api/records/contact/${memberId}`, (await t.admin()).headers, { data: { access: 'viewer' } }),
    ).toBe(200)
    expect(await status('PUT', '/api/secrets', (await t.admin()).headers, { name: 'X', value: 'sk-test' })).toBe(200)
  })

  it('admins hand out sign-in links, by contact or email', async () => {
    const id = await person(t, 'Linda Link', 'member', 'linda@example.com')
    const r = await t.req('POST', '/api/auth/links', { email: 'LINDA@example.com' })
    expect(r.status).toBe(201)
    expect(r.body.contactId).toBe(id)
    const token = new URL(r.body.url).searchParams.get('token')!
    expect((await login(t, token)).res.headers.get('location')).toBe('/')
    expect((await t.req('POST', '/api/auth/links', { email: 'nobody@example.com' })).status).toBe(400)
    expect((await t.req('POST', '/api/auth/links', {})).status).toBe(400)
  })

  it('hides the auth kinds from the records API', async () => {
    const kinds = (await t.req('GET', '/api/kinds')).body.map((k: any) => k.kind)
    for (const k of ['login_link', 'auth_session', 'mcp_token', 'secret']) expect(kinds).not.toContain(k)
    expect((await t.req('GET', '/api/records/auth_session')).status).toBe(404)
    const contact = (await t.req('GET', '/api/kinds')).body.find((k: any) => k.kind === 'contact')
    expect(contact.extensions.find((f: any) => f.name === 'access')).toMatchObject({ values: ['viewer', 'member', 'admin'] })
  })
})

describe('bootstrap', () => {
  it('creates an admin with ADMIN_EMAIL, logs a one-time link until an admin signed in', async () => {
    const store = memoryStore()
    const logs: any[] = []
    const env = { ADMIN_EMAIL: 'boss@example.com' }
    const t1 = await make({ env, overrides: { store, logger: memoryLogger(logs) } })
    const admin = (await t1.a.services.records.query('contact', { where: { access: 'admin' } })).items
    expect(admin).toHaveLength(1)
    expect(admin[0]!.data).toMatchObject({ name: 'Admin', email: 'boss@example.com', handles: [{ system: 'mp', id: 'admin' }] })
    const line = logs.find((l) => l.msg.startsWith('bootstrap: sign in as the admin'))
    expect(line.fields.url).toMatch(/\/auth\/login\?token=mpl_/)
    // No "Web user" any more.
    expect(await t1.a.services.directory.contacts.byHandle('mp', 'web')).toBeNull()
    await t1.close()
    apps.splice(apps.indexOf(t1), 1)

    // Not signed in yet: the next start logs a fresh link, for the same admin.
    const logs2: any[] = []
    const t2 = await make({ env, overrides: { store, logger: memoryLogger(logs2) } })
    const again = logs2.find((l) => l.msg.startsWith('bootstrap: sign in as the admin'))
    expect(again.fields.contactId).toBe(admin[0]!.id)
    const token = new URL(again.fields.url).searchParams.get('token')!
    expect((await login(t2, token)).res.headers.get('location')).toBe('/')
    await t2.close()
    apps.splice(apps.indexOf(t2), 1)

    const logs3: any[] = []
    await make({ env, overrides: { store, logger: memoryLogger(logs3) } })
    expect(logs3.find((l) => l.msg.startsWith('bootstrap: sign in as the admin'))).toBeUndefined()
  })
})

describe('ADMIN_EMAIL set after the first start', () => {
  it('gives the first-start admin the email, and makes an existing contact with it an admin', async () => {
    const store = memoryStore()
    const t1 = await make({ overrides: { store } })
    const first = (await t1.a.services.records.query<any>('contact', { where: { access: 'admin' } })).items
    expect(first).toHaveLength(1)
    expect(first[0]!.data.email).toBeUndefined()
    await t1.close()
    apps.splice(apps.indexOf(t1), 1)

    // Next start with ADMIN_EMAIL: the same admin contact gets the email (no second admin), and a link for it.
    const logs: any[] = []
    const t2 = await make({ env: { ADMIN_EMAIL: 'me@example.com' }, overrides: { store, logger: memoryLogger(logs) } })
    const admins = (await t2.a.services.records.query<any>('contact', { where: { access: 'admin' } })).items
    expect(admins.map((a) => [a.id, a.data.email])).toEqual([[first[0]!.id, 'me@example.com']])
    const line = logs.find((l) => l.msg.startsWith('bootstrap: sign in as the admin'))
    expect(line.fields).toMatchObject({ contactId: first[0]!.id, email: 'me@example.com' })
    // A person who already exists becomes an admin when ADMIN_EMAIL names them; nobody is demoted.
    const bob = await t2.a.services.directory.contacts.create({ name: 'Bob', kind: 'person', email: 'bob@example.com' })
    await t2.close()
    apps.splice(apps.indexOf(t2), 1)
    const t3 = await make({ env: { ADMIN_EMAIL: 'bob@example.com' }, overrides: { store } })
    const after = (await t3.a.services.records.query<any>('contact', { where: { access: 'admin' } })).items.map((a) => a.id)
    expect(after.sort()).toEqual([first[0]!.id, bob.id].sort())
  })
})

describe('security headers', () => {
  it('sends a CSP on the UI, and nosniff and a referrer policy everywhere', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-web-'))
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title>')
      const t = await make({ env: { MP_WEB_DIST: dir, PREVIEW_DOMAIN: 'preview.example.com' } })
      const page = await t.a.app.request('/now')
      expect(page.status).toBe(200)
      const csp = page.headers.get('content-security-policy')!
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("script-src 'self'")
      expect(csp).toContain('frame-src https://*.preview.example.com')
      expect(page.headers.get('x-content-type-options')).toBe('nosniff')
      expect(page.headers.get('referrer-policy')).toBe('same-origin')
      expect(page.headers.get('x-frame-options')).toBe('DENY')
      const api = await t.a.app.request('/api/me')
      expect(api.headers.get('x-content-type-options')).toBe('nosniff')
      expect(api.headers.get('content-security-policy')).toBeNull()

      // Without a domain, previews are on the preview port of the host the UI is served at.
      const portMode = await make({ env: { MP_WEB_DIST: dir } })
      expect((await portMode.a.app.request('http://mp.test:3000/')).headers.get('content-security-policy')).toContain(
        'frame-src http://mp.test:3001;',
      )
      const noPreview = await make({ env: { MP_WEB_DIST: dir, PREVIEW_PORT: '0' } })
      expect((await noPreview.a.app.request('/')).headers.get('content-security-policy')).toContain("frame-src 'none'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RateLimiter', () => {
  it('allows limit hits per window and forgets old ones', () => {
    let now = 0
    const r = new RateLimiter(2, 1000, () => now)
    expect(r.hit('a')).toBe(true)
    expect(r.hit('a')).toBe(true)
    expect(r.hit('a')).toBe(false)
    expect(r.hit('b')).toBe(true)
    expect(r.blocked('a')).toBe(true)
    expect(r.retryAfter('a')).toBe(1)
    now = 1001
    expect(r.blocked('a')).toBe(false)
    expect(r.hit('a')).toBe(true)
  })
})
