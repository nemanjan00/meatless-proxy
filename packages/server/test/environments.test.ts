import { DESKTOP_PORTS, fakeRuntime, type FakeRuntime } from '@mp/containers'
import { newId } from '@mp/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DESKTOP_COOKIE, PREVIEW_COOKIE, desktopPath } from '../src/previews/index.ts'
import type { LiveSocket } from '../src/live.ts'
import { testApp, type TestApp } from './helpers.ts'
import { encodeFrame, freePort, nextFrame, rawRequest, rawUpgrade, setCookieOf, upstreamApp } from './preview-helpers.ts'

/**
 * The Environments page's API (docs/spec.md "Environments"), and desktops on the preview origin:
 * who sees which environment, who may stop one, the note its session gets, metrics over the live
 * WebSocket, and the desktop viewer with its scoped cookie and WebSocket.
 */

type T = TestApp & { port: number | null }

let t: T
let rt: FakeRuntime
let pp: number
let up: Awaited<ReturnType<typeof upstreamApp>>
let employeeId: string
let ana: { id: string; headers: Record<string, string> }
let bob: { id: string; headers: Record<string, string> }
let vic: { id: string; headers: Record<string, string> }
/** Ana's session (she asked for it), with a desktop. */
let deskEnv: string
let deskSession: string
/** Bob's private session (a DM), with an app preview. */
let privEnv: string
let privSession: string
/** An environment no session points at. */
let orphanEnv: string

async function person(name: string, access: 'viewer' | 'member' | 'admin') {
  const c = await t.a.services.directory.contacts.create({
    name,
    kind: 'person',
    access,
    email: `${name.toLowerCase()}@example.com`,
  })
  return { id: c.id, headers: await t.as(c.id, { access }) }
}

/** Calls a stdlib tool as a run of the session. */
async function tool(sessionId: string, name: string, args: unknown) {
  const s = t.a.services
  const callId = newId('call')
  const r = await s.tools.execute(name, args, {
    employeeId,
    sessionId,
    runId: 'run_test',
    callId,
    idempotencyKey: `run_test:0:${callId}`,
    secrets: {},
    signal: new AbortController().signal,
    logger: s.logger,
    clock: s.clock,
    emit: () => {},
  })
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.output)}`)
  return r.output as any
}

const harnessHost = () => `127.0.0.1:${t.port}`
const previewHost = () => `127.0.0.1:${pp}`

/** Mints a desktop token through the API and exchanges it on the preview origin; returns the redirect and cookie. */
async function openDesktop(headers: Record<string, string>, body: Record<string, unknown> = {}, envId = deskEnv) {
  const res = await t.a.app.request(`http://${harnessHost()}/api/environments/${envId}/desktop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const tok = (await res.json()) as any
  if (res.status !== 200) return { status: res.status, tok }
  const u = new URL(tok.url)
  const ex = await rawRequest(pp, `${u.pathname}${u.search}`, { host: u.host })
  return { status: res.status, tok, ex, cookie: setCookieOf(ex.headers, DESKTOP_COOKIE) }
}

beforeAll(async () => {
  up = await upstreamApp()
  rt = fakeRuntime()
  pp = await freePort()
  t = await testApp({ http: true, workers: false, env: { PREVIEW_PORT: String(pp) }, overrides: { containers: rt } })
  const s = t.a.services
  employeeId = (await s.directory.employees.byHandle('meatless'))!.id
  ana = await person('Ana', 'member')
  bob = await person('Bob', 'member')
  vic = await person('Vic', 'viewer')

  const desk = await s.sessions.create({ employeeId, title: 'Check the checkout page' })
  deskSession = desk.id
  await s.records.link({ kind: 'session', id: desk.id }, { kind: 'contact', id: ana.id }, 'requested_by')
  const d = await tool(desk.id, 'env.up', { image: 'mcr.microsoft.com/playwright:v1', desktop: true, expose: [5173] })
  deskEnv = d.envId

  const priv = await s.sessions.create({ employeeId, title: 'Bob private work' })
  privSession = priv.id
  await s.records.update('session', priv.id, { private: { contacts: [bob.id], channels: [] } })
  privEnv = (await tool(priv.id, 'env.up', { profile: 'analyst', expose: [8000] })).envId

  orphanEnv = (await rt.createEnv({ name: 'left-behind', image: 'alpine:3', labels: { 'mp.session': 'ses_gone' } })).id
  rt.servePreview(deskEnv, DESKTOP_PORTS.view, { host: '127.0.0.1', port: up.port })
  rt.servePreview(deskEnv, DESKTOP_PORTS.control, { host: '127.0.0.1', port: up.port })
})

afterAll(async () => {
  await t?.close()
  await up?.close()
})

const ids = (r: { body: { items: { envId: string }[] } }) => r.body.items.map((e) => e.envId).sort()

describe('GET /api/environments', () => {
  it('shows each person the environments of the sessions they may read; admins also the ones left behind', async () => {
    expect(ids(await t.req('GET', '/api/environments'))).toEqual([deskEnv, orphanEnv].sort())
    expect(ids(await t.req('GET', '/api/environments', undefined, ana.headers))).toEqual([deskEnv])
    expect(ids(await t.req('GET', '/api/environments', undefined, bob.headers))).toEqual([deskEnv, privEnv].sort())
    expect(ids(await t.req('GET', '/api/environments', undefined, vic.headers))).toEqual([deskEnv])
    expect((await t.req('GET', '/api/environments', undefined, { authorization: '' })).status).toBe(401)
  })

  it('joins each with its session, employee, requester, image, network, ports and desktop', async () => {
    const [e] = (await t.req('GET', `/api/environments?sessionId=${deskSession}`, undefined, ana.headers)).body.items
    expect(e).toMatchObject({
      envId: deskEnv,
      status: 'running',
      session: { id: deskSession, title: 'Check the checkout page', status: 'active' },
      employee: { id: employeeId },
      requester: { id: ana.id, name: 'Ana' },
      image: 'mcr.microsoft.com/playwright:v1',
      ports: [5173],
      desktop: true,
      exec: null,
      stats: null,
      canStop: true,
      canControl: true,
    })
    // No network setting of its own: the deployment default, a direct network.
    expect(e.network).toMatchObject({ via: 'direct' })
    const [p] = (await t.req('GET', `/api/environments?sessionId=${privSession}`, undefined, bob.headers)).body.items
    expect(p).toMatchObject({
      profile: 'analyst',
      image: 'nemanjan00/dev:analyst',
      desktop: false,
      canStop: false,
      canControl: false,
    })
    const [o] = (await t.req('GET', '/api/environments')).body.items.filter((x: any) => x.envId === orphanEnv)
    expect(o).toMatchObject({ session: null, canStop: true })
  })

  it('filters by employee, session and desktop', async () => {
    expect(ids(await t.req('GET', '/api/environments?desktop=true', undefined, bob.headers))).toEqual([deskEnv])
    expect(ids(await t.req('GET', `/api/environments?employeeId=${employeeId}`, undefined, bob.headers))).toHaveLength(2)
    expect(ids(await t.req('GET', '/api/environments?employeeId=emp_nobody', undefined, bob.headers))).toEqual([])
    expect(ids(await t.req('GET', `/api/environments?sessionId=${privSession}`, undefined, ana.headers))).toEqual([])
  })

  it('shows the env.exec running now, until it ends', async () => {
    const bus = t.a.services.bus
    bus.publish('env.exec.started', {
      sessionId: deskSession,
      envId: deskEnv,
      runId: 'run_1',
      callId: 'c1',
      cmd: ['npm', 'test'],
      startedAt: '2026-09-29T10:00:00.000Z',
    })
    await t.settle()
    const [e] = (await t.req('GET', `/api/environments?sessionId=${deskSession}`)).body.items
    expect(e.exec).toEqual({ cmd: ['npm', 'test'], startedAt: '2026-09-29T10:00:00.000Z', runId: 'run_1' })
    // Another call's end doesn't end this one.
    bus.publish('env.exec.finished', { envId: deskEnv, callId: 'c0' })
    expect(t.a.environments.execOf(deskEnv)).not.toBeNull()
    bus.publish('env.exec.finished', { envId: deskEnv, callId: 'c1' })
    expect(t.a.environments.execOf(deskEnv)).toBeNull()
  })

  it('reads logs and processes for those who may see the environment, 404 for others', async () => {
    rt.appendLog(privEnv, 'server listening on 8000\n')
    const logs = await t.req('GET', `/api/environments/${privEnv}/logs?tail=10`, undefined, bob.headers)
    expect(logs.body).toEqual({ envId: privEnv, logs: 'server listening on 8000\n' })
    expect((await t.req('GET', `/api/environments/${privEnv}/logs`, undefined, ana.headers)).status).toBe(404)
    expect((await t.req('GET', `/api/environments/${privEnv}/logs`)).status).toBe(404)
    const procs = await t.req('GET', `/api/environments/${deskEnv}/processes`, undefined, vic.headers)
    expect(procs.body.containers[0]).toMatchObject({ name: 'main', role: 'main' })
    expect((await t.req('GET', `/api/environments/${privEnv}/processes`, undefined, ana.headers)).status).toBe(404)
    expect((await t.req('GET', '/api/environments/mp-nope/logs')).status).toBe(404)
  })
})

describe('live metrics', () => {
  /** A socket on the live hub, signed in as `who`, subscribed to `channels`. */
  const socket = async (who: { id: string }, channels: string[], admin = false) => {
    const got: any[] = []
    const s: LiveSocket = { send: (d) => void got.push(JSON.parse(d)), close: () => {} }
    const conn = t.a.live.connect(s, { contactId: who.id, ...(admin ? { admin: true } : {}) })
    conn.message(JSON.stringify({ type: 'subscribe', channels }))
    await t.a.live.flush()
    return { got, stats: () => got.filter((m) => m.topic === 'env.stats'), close: conn.close }
  }

  it('samples nothing while nobody watches', async () => {
    let calls = 0
    const orig = rt.stats.bind(rt)
    rt.stats = async (id) => {
      calls++
      return orig(id)
    }
    await t.a.environments.tick()
    expect(calls).toBe(0)
    rt.stats = orig
  })

  it('pushes env.stats to watchers of the environments channel, filtered like sessions', async () => {
    rt.setStats(deskEnv, 'main', { cpuPercent: 37.5, memoryBytes: 123 })
    const bobS = await socket(bob, ['environments'])
    const anaS = await socket(ana, ['environments'])
    await t.a.environments.tick()
    await t.a.live.flush()
    expect(
      bobS
        .stats()
        .map((m) => m.payload.envId)
        .sort(),
    ).toEqual([deskEnv, privEnv].sort())
    expect(anaS.stats().map((m) => m.payload.envId)).toEqual([deskEnv])
    const m = anaS.stats()[0]
    expect(m.channel).toBe('environments')
    expect(m.payload.sessionId).toBe(deskSession)
    expect(m.payload.stats.containers.map((c: any) => c.name)).toEqual(['main', 'desktop'])
    expect(m.payload.stats.containers[0]).toMatchObject({ cpuPercent: 37.5, memoryBytes: 123 })
    // The list then carries the latest sample.
    const [e] = (await t.req('GET', `/api/environments?sessionId=${deskSession}`, undefined, ana.headers)).body.items
    expect(e.stats.containers[0].cpuPercent).toBe(37.5)
    bobS.close()
    anaS.close()
  })

  it('samples a session’s environment while someone watches that session only', async () => {
    const s = await socket(ana, [`session:${deskSession}`])
    await t.a.environments.tick()
    await t.a.live.flush()
    expect(s.stats().map((m) => [m.channel, m.payload.envId])).toEqual([[`session:${deskSession}`, deskEnv]])
    s.close()
  })

  it('refuses the environments channel to nobody signed in as someone else, and tells about changes', async () => {
    const s = await socket(bob, ['environments'])
    expect(s.got.find((m) => m.type === 'subscribed')?.channels).toEqual(['environments'])
    await t.a.environments.tick()
    const extra = await rt.createEnv({ name: 'extra', image: 'alpine:3', labels: { 'mp.session': privSession } })
    await t.a.environments.tick()
    await rt.destroyEnv(extra.id)
    await t.a.environments.tick()
    await t.a.live.flush()
    const changes = s.got.filter((m) => m.topic === 'env.changed' && m.payload.envId === extra.id).map((m) => m.payload.op)
    expect(changes).toEqual(['up', 'down'])
    s.close()
  })
})

describe('desktops on the preview origin', () => {
  it('gives whoever may read the session a view-only desktop, control only to admins and the requester', async () => {
    const view = await openDesktop(bob.headers)
    expect(view.status).toBe(200)
    expect(view.tok).toMatchObject({
      envId: deskEnv,
      port: DESKTOP_PORTS.view,
      control: false,
      origin: `http://${previewHost()}`,
    })
    const ctl = await openDesktop(ana.headers, { control: true })
    expect(ctl.tok).toMatchObject({ port: DESKTOP_PORTS.control, control: true })
    expect((await openDesktop((await t.admin()).headers, { control: true })).tok.control).toBe(true)
    expect((await openDesktop(bob.headers, { control: true })).status).toBe(403)
    // A thumbnail is always a view.
    expect((await openDesktop(ana.headers, { control: true, thumbnail: true })).tok).toMatchObject({ control: false })
    expect((await openDesktop(vic.headers)).status).toBe(403)
    expect((await openDesktop(ana.headers, {}, privEnv)).status).toBe(404)
    expect((await openDesktop(bob.headers, {}, privEnv)).status).toBe(404) // no desktop there
    expect((await openDesktop(ana.headers, {}, 'mp-nope')).status).toBe(404)
  })

  it('exchanges the token for a cookie scoped to that desktop’s page, and serves the viewer there', async () => {
    const o = await openDesktop(bob.headers, { thumbnail: true })
    const path = desktopPath(deskEnv, DESKTOP_PORTS.view)
    expect(o.ex!.status).toBe(302)
    expect(o.ex!.headers.location).toBe(`${path}?thumbnail=1`)
    expect(o.cookie).toContain(`Path=${path}`)
    expect(o.cookie).toContain('HttpOnly')
    // Never the app preview's cookie.
    expect(setCookieOf(o.ex!.headers, PREVIEW_COOKIE)).toBeUndefined()
    const cookie = o.cookie!.split(';')[0]!

    const page = await rawRequest(pp, `${path}?thumbnail=1`, { host: previewHost(), cookie })
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toMatch(/text\/html/)
    expect(page.body).toContain('data-view-only="1"')
    expect(page.body).toContain('data-thumbnail="1"')
    expect(page.body).toContain('/__mp_preview/desktop.js')
    const csp = String(page.headers['content-security-policy'])
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain(`connect-src 'self' ws://${previewHost()} wss://${previewHost()}`)
    expect(csp).toContain(`frame-ancestors http://127.0.0.1:${t.port}`)

    // Without the cookie, or at another desktop's page, nothing.
    expect((await rawRequest(pp, path, { host: previewHost() })).status).toBe(401)
    expect((await rawRequest(pp, desktopPath(deskEnv, DESKTOP_PORTS.control), { host: previewHost(), cookie })).status).toBe(401)
    expect((await rawRequest(pp, desktopPath(privEnv, DESKTOP_PORTS.view), { host: previewHost(), cookie })).status).toBe(401)
    // The control page for the requester says so.
    const ctl = await openDesktop(ana.headers, { control: true })
    const ctlPage = await rawRequest(pp, desktopPath(deskEnv, DESKTOP_PORTS.control), {
      host: previewHost(),
      cookie: ctl.cookie!.split(';')[0]!,
    })
    expect(ctlPage.body).toContain('data-view-only="0"')
  })

  it('never lets a desktop cookie open the port as an app, or an app cookie open a desktop', async () => {
    const o = await openDesktop(bob.headers)
    const cookie = `${PREVIEW_COOKIE}=${o.cookie!.split(';')[0]!.split('=').slice(1).join('=')}`
    expect((await rawRequest(pp, '/', { host: previewHost(), cookie })).status).toBe(401)
    const tok = await t.a.app.request(`http://${harnessHost()}/api/previews/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bob.headers },
      body: JSON.stringify({ envId: deskEnv, port: 5173 }),
    })
    const u = new URL(((await tok.json()) as any).url)
    const ex = await rawRequest(pp, `${u.pathname}${u.search}`, { host: u.host })
    const app = setCookieOf(ex.headers, PREVIEW_COOKIE)!.split(';')[0]!
    const asDesktop = `${DESKTOP_COOKIE}=${app.split('=').slice(1).join('=')}`
    expect((await rawRequest(pp, desktopPath(deskEnv, 5173), { host: previewHost(), cookie: asDesktop })).status).toBe(401)
  })

  it('serves the viewer script and noVNC’s modules, and nothing outside them', async () => {
    const js = await rawRequest(pp, '/__mp_preview/desktop.js', { host: previewHost() })
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toMatch(/javascript/)
    expect(js.body).toContain("from '/__mp_preview/novnc/core/rfb.js'")
    const rfb = await rawRequest(pp, '/__mp_preview/novnc/core/rfb.js', { host: previewHost() })
    expect(rfb.status).toBe(200)
    expect(rfb.body).toMatch(/export default class RFB/)
    for (const bad of [
      '/__mp_preview/novnc/package.json',
      '/__mp_preview/novnc/../package.json',
      '/__mp_preview/novnc/%2e%2e/LICENSE.txt',
      '/__mp_preview/novnc/core/missing.js',
    ])
      expect((await rawRequest(pp, bad, { host: previewHost() })).status, bad).toBe(404)
    // Dot segments are resolved before routing: this is the app's path, which needs its cookie.
    expect((await rawRequest(pp, '/__mp_preview/novnc/core/../../../server/package.json', { host: previewHost() })).status).toBe(
      401,
    )
  })

  it('tunnels the desktop’s WebSocket to the bridge, at its root, without the harness’s cookies', async () => {
    const o = await openDesktop(bob.headers)
    const cookie = o.cookie!.split(';')[0]!
    const path = `${desktopPath(deskEnv, DESKTOP_PORTS.view)}websockify`
    const ws = await rawUpgrade(pp, path, {
      host: previewHost(),
      origin: `http://${previewHost()}`,
      cookie: `${cookie}; mp_session=x`,
    })
    expect(ws.status).toBe(101)
    const seen = up.seen.filter((x) => x.method === 'UPGRADE').at(-1)!
    expect(seen.url).toBe('/')
    expect(String(seen.headers.cookie ?? '')).not.toMatch(/mp_/)
    ws.socket!.write(encodeFrame('RFB 003.008', true))
    expect(await nextFrame(ws.socket!)).toBe('echo: RFB 003.008')
    ws.socket!.destroy()

    // Another page's origin, no cookie, or the view cookie on the control socket: refused.
    expect((await rawUpgrade(pp, path, { host: previewHost(), origin: 'http://evil.example.com', cookie })).status).toBe(403)
    expect((await rawUpgrade(pp, path, { host: previewHost() })).status).toBe(401)
    const other = `${desktopPath(deskEnv, DESKTOP_PORTS.control)}websockify`
    expect((await rawUpgrade(pp, other, { host: previewHost(), cookie })).status).toBe(401)
    // Other reserved paths never upgrade.
    expect((await rawUpgrade(pp, '/__mp_preview/novnc/core/rfb.js', { host: previewHost(), cookie })).status).toBe(404)
  })

  it('refuses app preview tokens for environments of sessions the viewer may not read', async () => {
    const r = await t.a.app.request(`http://${harnessHost()}/api/previews/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ana.headers },
      body: JSON.stringify({ envId: privEnv, port: 8000 }),
    })
    expect(r.status).toBe(404)
  })
})

describe('POST /api/environments/:id/stop', () => {
  it('is for admins and the requester', async () => {
    expect((await t.req('POST', `/api/environments/${deskEnv}/stop`, {}, bob.headers)).status).toBe(403)
    expect((await t.req('POST', `/api/environments/${deskEnv}/stop`, {}, vic.headers)).status).toBe(403)
    expect((await t.req('POST', `/api/environments/${privEnv}/stop`, {}, ana.headers)).status).toBe(404)
    expect((await t.req('POST', `/api/environments/${privEnv}/stop`, {}, bob.headers)).status).toBe(403)
    expect(await rt.getEnv(deskEnv)).not.toBeNull()
  })

  it('tears it down like env.down, and notes in the idle session’s history who stopped it', async () => {
    const changed: any[] = []
    const off = t.a.services.bus.subscribe('env.changed', (m) => void changed.push(m.payload))
    const r = await t.req('POST', `/api/environments/${deskEnv}/stop`, {}, ana.headers)
    off()
    expect(r.body).toEqual({ stopped: true, envId: deskEnv, sessionId: deskSession })
    expect(await rt.getEnv(deskEnv)).toBeNull()
    const s = await t.a.services.sessions.require(deskSession)
    expect(s.data.meta?.env).toBeUndefined()
    const history = await t.a.services.sessions.history(deskSession)
    const note = history.find((e) => e.kind === 'event' && (e.content as any).type === 'env.stopped')
    expect((note!.content as any).text).toMatch(/^Ana stopped this session's environment/)
    expect(changed).toContainEqual({ sessionId: deskSession, envId: deskEnv, op: 'down' })
    expect(ids(await t.req('GET', '/api/environments', undefined, ana.headers))).toEqual([])
    expect((await t.req('POST', `/api/environments/${deskEnv}/stop`, {}, ana.headers)).status).toBe(404)
  })

  it('tells a working session at its next step instead (an inbox item)', async () => {
    const s = t.a.services
    const run = await s.sessions.createRun({ sessionId: privSession, cause: { type: 'manual' } })
    await s.sessions.transition(run.id, 'queued', 'running')
    const r = await t.req('POST', `/api/environments/${privEnv}/stop`, {})
    expect(r.status).toBe(404) // the admin may not read the private session
    await s.records.link({ kind: 'session', id: privSession }, { kind: 'contact', id: bob.id }, 'requested_by')
    expect((await t.req('POST', `/api/environments/${privEnv}/stop`, {}, bob.headers)).status).toBe(200)
    const inbox = await s.sessions.inbox(privSession)
    expect(inbox.map((i) => [i.data.type, i.data.trusted, i.data.expectedToAct])).toEqual([['env.stopped', true, false]])
    expect(inbox[0]!.data.text).toMatch(/^Bob stopped/)
  })

  it('lets an admin remove an environment left behind', async () => {
    expect((await t.req('POST', `/api/environments/${orphanEnv}/stop`, {}, bob.headers)).status).toBe(404)
    expect((await t.req('POST', `/api/environments/${orphanEnv}/stop`, {})).body).toEqual({
      stopped: true,
      envId: orphanEnv,
      sessionId: null,
    })
    expect(await rt.getEnv(orphanEnv)).toBeNull()
  })
})
