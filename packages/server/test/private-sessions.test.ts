import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { reply } from '@mp/model'
import type { Run, Session } from '@mp/sessions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRIVATE_TITLE } from '../src/auth/visibility.ts'
import { createMcpToken } from '../src/tokens.ts'
import { testApp, until, type TestApp } from './helpers.ts'

/**
 * Work that came from a DM is private: its sessions, runs, entries and events are for the DM's
 * members. Admins learn that a private session exists (a redacted row), nothing more. Runs with
 * DATABASE_URL set against Postgres too.
 */

const env: Record<string, string> = process.env.DATABASE_URL
  ? {
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_SCHEMA: `mp_private_${process.pid}_${Date.now()}`,
      SECRETS_KEY: 'test-secrets-key-not-a-real-one',
    }
  : {}

let t: TestApp & { port: number | null }
let ana: Record<string, string>
let bob: Record<string, string>
let carol: Record<string, string>
let admin: Record<string, string>
let anaId: string
let bobId: string
let employeeId: string
let dmId: string
let dmEventId: string
let work: Session
let workRun: Run
let routerId: string
let routerRun: Run
let publicSession: Session
let publicRunId: string

const SECRET = 'my salary is too low'

beforeAll(async () => {
  t = await testApp({ http: true, workers: false, script: [reply('ok')], env })
  const s = t.a.services
  anaId = (await s.directory.contacts.create({ name: 'Ana Example', kind: 'person', access: 'member' })).id
  bobId = (await s.directory.contacts.create({ name: 'Bob Example', kind: 'person', access: 'member' })).id
  const carolId = (await s.directory.contacts.create({ name: 'Carol Example', kind: 'person', access: 'viewer' })).id
  ana = await t.as(anaId)
  bob = await t.as(bobId)
  carol = await t.as(carolId)
  admin = (await t.admin()).headers
  employeeId = (await s.directory.employees.byHandle('meatless'))!.id

  // Ana DMs the employee: the router context gets it.
  const dm = await t.req('POST', '/api/chat/dms', { members: [{ kind: 'employee', id: employeeId }] }, ana)
  expect(dm.status).toBe(201)
  dmId = dm.body.id
  const m = await t.req('POST', `/api/chat/channels/${dmId}/messages`, { text: SECRET }, ana)
  expect(m.status).toBe(201)
  const ev = (await s.records.query('event', { where: { 'payload.channelId': dmId } })).items[0]!
  dmEventId = ev.id
  await s.router.route(dmEventId)
  routerId = (await s.routerSessionFor(employeeId))!
  routerRun = (await s.sessions.runs({ sessionId: routerId })).at(-1)!
  expect(routerRun.data.cause.eventId).toBe(dmEventId)
  // The router's decision line is committed to the shared context.
  await s.sessions.commitSummary(routerRun.id, `Handed Ana's pay question on: ${SECRET}`)

  // The router hands the request to a work session (its run started by the router's DM run).
  work = await s.sessions.create({ employeeId, title: 'Ana pay raise', document: `Ana says: ${SECRET}` })
  workRun = await s.sessions.createRun({
    sessionId: work.id,
    cause: { type: 'fork', parentRunId: routerRun.id },
    requesterId: anaId,
    input: [{ kind: 'user', content: { text: SECRET } }],
  })
  await s.sessions.append(workRun.id, { kind: 'assistant', content: { text: `Looking into: ${SECRET}` } })
  await s.checklists.addItem(work.id, { text: 'Check the pay bands' })
  await s.events.subscriptions.subscribe(work.id, { system: 'slack', id: 'C0TEST0001/1700000000.000100' })
  await s.usage.record({
    runId: workRun.id,
    sessionId: work.id,
    rootSessionId: work.id,
    employeeId,
    model: 'test-model',
    promptTokens: 100,
    completionTokens: 50,
  })
  work = (await s.sessions.get(work.id))!

  publicSession = await s.sessions.create({ employeeId, title: 'Quarterly report', document: 'public' })
  publicRunId = (await s.sessions.createRun({ sessionId: publicSession.id, cause: { type: 'manual' } })).id
})
afterAll(async () => {
  if (env.DATABASE_SCHEMA && t) {
    await t.close()
    const pg = (await import('pg')).default
    const p = new pg.Pool({ connectionString: env.DATABASE_URL })
    await p.query(`drop schema if exists "${env.DATABASE_SCHEMA}" cascade`).catch(() => {})
    await p.end()
    return
  }
  await t?.close()
})

describe('marking', () => {
  it('marks the work session, its run and the router run, but not the router context', async () => {
    const s = t.a.services
    expect(work.data.private).toEqual({ contacts: expect.arrayContaining([anaId]), channels: [dmId] })
    expect((await s.sessions.getRun(workRun.id))!.data.private).toBeTruthy()
    expect((await s.sessions.getRun(routerRun.id))!.data.private).toEqual(
      expect.objectContaining({ contacts: expect.arrayContaining([anaId]) }),
    )
    expect((await s.sessions.get(routerId))!.data.private).toBeUndefined()
    expect((await s.sessions.get(publicSession.id))!.data.private).toBeUndefined()
  })

  it('makes forks and loop children of a private session private too', async () => {
    const s = t.a.services
    const fork = await s.sessions.fork(work.id, { title: 'fork of pay' })
    expect(fork.data.private).toEqual(work.data.private)
    const [child] = await s.sessions.loop(work.id, ['a'])
    expect(child!.data.private).toEqual(work.data.private)
    expect((await t.req('GET', `/api/sessions/${fork.id}/history`, undefined, bob)).status).toBe(404)
    expect((await t.req('GET', `/api/sessions/${fork.id}/history`, undefined, ana)).status).toBe(200)
    // A fork through the API inherits too.
    const apiFork = await t.req('POST', `/api/sessions/${work.id}/fork`, {}, ana)
    expect(apiFork.status).toBe(201)
    expect((await t.req('GET', `/api/sessions/${apiFork.body.id}`, undefined, bob)).status).toBe(404)
  })

  it('makes a session delivered a DM into its inbox private', async () => {
    const s = t.a.services
    const busy = await s.sessions.create({ employeeId, title: 'busy session' })
    await s.sessions.createRun({ sessionId: busy.id, cause: { type: 'manual' } })
    await s.router.deliver((await s.rawEvents.get(dmEventId))!, {
      sessionId: busy.id,
      reason: 'subscription',
      expectedToAct: true,
      trusted: true,
      fork: false,
      priority: 0,
    })
    expect((await s.sessions.get(busy.id))!.data.private).toBeTruthy()
  })

  it('makes a session that subscribes to or joins a DM private', async () => {
    const s = t.a.services
    const sub = await s.sessions.create({ employeeId, title: 'subscriber' })
    const msg = (await s.chat.messages(dmId))[0]!
    await s.events.subscriptions.subscribe(sub.id, { system: 'mp', id: msg.id })
    await until(async () => (await s.sessions.get(sub.id))!.data.private, 'the subscriber marked')
    const member = await s.sessions.create({ employeeId, title: 'member' })
    await s.chat.addMember(dmId, { kind: 'session', id: member.id }, { type: 'contact', id: anaId })
    await until(async () => (await s.sessions.get(member.id))!.data.private, 'the member session marked')
  })
})

describe('session routes', () => {
  const routes = () => [
    `/api/sessions/${work.id}/history`,
    `/api/sessions/${work.id}/tree`,
    `/api/sessions/${work.id}/entry-tree`,
    `/api/sessions/${work.id}/runs`,
    `/api/sessions/${work.id}/preview`,
    `/api/runs/${workRun.id}`,
    `/api/runs/${workRun.id}/history`,
    `/api/runs/${routerRun.id}`,
    `/api/runs/${routerRun.id}/history`,
    `/api/lineage/${work.id}`,
    `/api/lineage/${workRun.id}`,
    `/api/records/session/${work.id}`,
    `/api/records/run/${workRun.id}`,
    `/api/records/session/${work.id}/links`,
    `/api/records/session/${work.id}/revisions`,
    `/api/subscriptions?sessionId=${work.id}`,
    `/api/subjects/permalink?subject=${encodeURIComponent('slack:C0TEST0001/1700000000.000100')}&sessionId=${work.id}`,
  ]

  it('refuses every session route to people outside the DM, admins included', async () => {
    for (const h of [bob, carol, admin])
      for (const r of routes()) {
        const res = await t.req('GET', r, undefined, h)
        expect([403, 404], `${r}: ${res.status}`).toContain(res.status)
        expect(JSON.stringify(res.body ?? '')).not.toContain(SECRET)
      }
    for (const h of [bob, carol]) expect((await t.req('GET', `/api/sessions/${work.id}`, undefined, h)).status).toBe(404)
    expect((await t.req('POST', `/api/sessions/${work.id}/message`, { text: 'hi' }, bob)).status).toBe(404)
    expect((await t.req('POST', `/api/sessions/${work.id}/fork`, {}, bob)).status).toBe(404)
    expect((await t.req('PATCH', `/api/records/session/${work.id}`, { data: { title: 'x' } }, bob)).status).toBe(404)
    expect((await t.req('POST', `/api/runs/${workRun.id}/pause`, {}, bob)).status).toBe(404)
  })

  it('lets the DM member read it all', async () => {
    const detail = await t.req('GET', `/api/sessions/${work.id}`, undefined, ana)
    expect(detail.status).toBe(200)
    expect(detail.body.session.data.title).toBe('Ana pay raise')
    const history = await t.req('GET', `/api/sessions/${work.id}/history`, undefined, ana)
    expect(history.status).toBe(200)
    const runHistory = await t.req('GET', `/api/runs/${workRun.id}/history`, undefined, ana)
    expect(JSON.stringify(runHistory.body)).toContain(`Looking into: ${SECRET}`)
    for (const r of routes().filter((x) => !x.endsWith('/preview')))
      expect((await t.req('GET', r, undefined, ana)).status, r).toBe(200)
  })

  it('shows an admin that a private session exists, redacted', async () => {
    const detail = await t.req('GET', `/api/sessions/${work.id}`, undefined, admin)
    expect(detail.status).toBe(200)
    expect(detail.body.session.data.title).toBe(PRIVATE_TITLE)
    expect(detail.body.session.data.document).toBe('')
    expect(detail.body.activeRun).toBeNull()
    expect(JSON.stringify(detail.body)).not.toContain(SECRET)
    expect(JSON.stringify(detail.body)).not.toContain('Ana pay raise')
  })

  it('lists private sessions for members, redacted for admins, and not at all for others', async () => {
    const list = async (h: Record<string, string>, q = '') =>
      (await t.req('GET', `/api/sessions?limit=500&excludeRoles=none${q}`, undefined, h)).body.items as any[]
    const find = (items: any[]) => items.find((i) => i.session.id === work.id)
    expect(find(await list(ana)).session.data.title).toBe('Ana pay raise')
    expect(find(await list(bob))).toBeUndefined()
    expect(find(await list(carol))).toBeUndefined()
    const row = find(await list(admin))
    expect(row.session.data.title).toBe(PRIVATE_TITLE)
    expect(JSON.stringify(row)).not.toContain(SECRET)
    // Nothing it did either: no outcome on a redacted row.
    expect(row.outcome).toBeUndefined()
    expect(find(await list(bob))).toBeUndefined()
    expect((await list(bob)).some((i) => i.session.id === publicSession.id)).toBe(true)
    // Search (the ⌘K menu uses the list's text filter).
    expect(find(await list(bob, '&text=pay'))).toBeUndefined()
    expect(find(await list(ana, '&text=pay'))).toBeTruthy()
    // The records API.
    const recs = async (kind: string, h: Record<string, string>) =>
      (await t.req('GET', `/api/records/${kind}?limit=500`, undefined, h)).body.items.map((x: any) => x.id)
    expect(await recs('session', bob)).not.toContain(work.id)
    expect(await recs('session', admin)).not.toContain(work.id)
    expect(await recs('session', ana)).toContain(work.id)
    expect(await recs('run', bob)).not.toContain(workRun.id)
    expect(await recs('run', bob)).not.toContain(routerRun.id)
    expect(await recs('run', ana)).toContain(routerRun.id)
    expect(await recs('usage', bob)).toHaveLength(0)
  })

  it('redacts a router context’s DM entries for people outside the DM', async () => {
    const routerHistory = async (h: Record<string, string>) => {
      const r = await t.req('GET', `/api/sessions/${routerId}/history`, undefined, h)
      expect(r.status).toBe(200)
      return JSON.stringify(r.body)
    }
    expect(await routerHistory(ana)).toContain(SECRET)
    for (const h of [bob, carol, admin]) expect(await routerHistory(h)).not.toContain(SECRET)
    const tree = await t.req('GET', `/api/sessions/${routerId}/entry-tree`, undefined, bob)
    expect(tree.status).toBe(200)
    expect(JSON.stringify(tree.body)).not.toContain(SECRET)
    expect(tree.body.runs.map((r: any) => r.id)).not.toContain(routerRun.id)
    const runs = await t.req('GET', `/api/sessions/${routerId}/runs`, undefined, bob)
    expect(runs.body.map((r: any) => r.id)).not.toContain(routerRun.id)
    // The entry children route redacts too.
    const head = (await t.a.services.sessions.get(routerId))!.data.head!
    const path = await t.a.services.store.entries.path(head)
    for (const e of path) {
      const kids = await t.req('GET', `/api/entries/${e.id}/children`, undefined, bob)
      expect(JSON.stringify(kids.body)).not.toContain(SECRET)
    }
  })

  it('keeps usage numbers, with the private session’s title redacted', async () => {
    const rows = async (h: Record<string, string>) =>
      (await t.req('GET', '/api/usage/breakdown?groupBy=session', undefined, h)).body.rows as any[]
    const mine = (await rows(ana)).find((r) => r.key === work.id)
    expect(mine.label).toBe('Ana pay raise')
    const theirs = (await rows(bob)).find((r) => r.key === work.id)
    expect(theirs.label).toBe(PRIVATE_TITLE)
    expect(theirs.total).toBe(150)
  })

  it('leaves private runs out of Now and the inbox for others', async () => {
    const now = async (h: Record<string, string>) =>
      (await t.req('GET', '/api/now', undefined, h)).body.items.map((i: any) => i.run.id)
    expect(await now(ana)).toContain(workRun.id)
    expect(await now(bob)).not.toContain(workRun.id)
    expect(await now(admin)).not.toContain(workRun.id)
  })
})

describe('events', () => {
  it('hides a Slack-style DM event from everyone but the person who wrote it', async () => {
    const s = t.a.services
    const { event } = await s.events.ingest({
      source: 'slack',
      type: 'message.direct',
      dedupeKey: `slack:test-dm-${Date.now()}`,
      subject: { system: 'slack', id: 'D0TEST/1.0' },
      actorContactId: anaId,
      payload: { channel: 'D0TEST', channel_type: 'im', text: 'slack secret about pay' },
      text: 'Slack DM ana: slack secret about pay',
    })
    expect(event.data.private).toEqual({ contacts: [anaId], channels: [] })
    const ids = async (h: Record<string, string>, q = '') =>
      (await t.req('GET', `/api/events?limit=500${q}`, undefined, h)).body.items.map((e: any) => e.id)
    expect(await ids(ana)).toContain(event.id)
    for (const h of [bob, carol, admin]) {
      expect(await ids(h)).not.toContain(event.id)
      expect(await ids(h, '&source=slack')).not.toContain(event.id)
      expect(await ids(h, '&routed=unmatched')).not.toContain(event.id)
      expect((await t.req('GET', `/api/events/${event.id}`, undefined, h)).status).toBe(404)
      expect((await t.req('GET', `/api/records/event/${event.id}`, undefined, h)).status).toBe(404)
    }
    expect((await t.req('GET', `/api/events/${event.id}`, undefined, ana)).status).toBe(200)
    // Paging still adds up for the writer: both queries are merged newest first.
    const page = await t.req('GET', '/api/events?limit=1', undefined, ana)
    expect(page.body.items).toHaveLength(1)
    expect(page.body.total).toBeGreaterThan(1)

    // Work it causes is private to Ana.
    const session = await s.sessions.create({ employeeId, title: 'slack dm work' })
    await s.sessions.createRun({ sessionId: session.id, cause: { type: 'event', eventId: event.id } })
    expect((await t.req('GET', `/api/sessions/${session.id}/history`, undefined, bob)).status).toBe(404)
    expect((await t.req('GET', `/api/sessions/${session.id}/history`, undefined, ana)).status).toBe(200)
  })

  it('recognises integration DMs by their payload', async () => {
    const { isIntegrationDm } = await import('../src/auth/visibility.ts')
    const dm = (source: string, type: string, payload: unknown) => isIntegrationDm({ source, type, payload: payload as never })
    expect(dm('slack', 'message.posted', { channel_type: 'im' })).toBe(true)
    expect(dm('slack', 'message.posted', { channel_type: 'mpim' })).toBe(true)
    expect(dm('slack', 'reaction.added', { channel: 'D123' })).toBe(true)
    expect(dm('slack', 'reaction.added', { channel: 'C123' })).toBe(false)
    expect(dm('slack', 'message.posted', { channel: 'C1', channel_type: 'channel' })).toBe(false)
    expect(dm('mcp:x', 'message.direct', null)).toBe(true)
    expect(dm('linear', 'issue.updated', { dm: true })).toBe(true)
    expect(dm('chat', 'message.posted', { channel_type: 'im' })).toBe(false)
  })
})

describe('the live stream', () => {
  function connect(headers: Record<string, string>) {
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, { headers } as never)
    const messages: any[] = []
    ws.onmessage = (ev) => messages.push(JSON.parse(String(ev.data)))
    const open = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('websocket error'))
    })
    return { ws, messages, open }
  }

  it('sends private entries, runs and steps to the DM members only', async () => {
    const s = t.a.services
    const clients = [connect(ana), connect(bob), connect(admin)]
    await Promise.all(clients.map((c) => c.open))
    const chans = [
      `session:${work.id}`,
      `run:${workRun.id}`,
      `session:${routerId}`,
      'now',
      'events',
      'records:session',
      'records:run',
    ]
    for (const c of clients) c.ws.send(JSON.stringify({ type: 'subscribe', channels: chans }))
    for (const c of clients) await until(() => c.messages.find((m) => m.type === 'subscribed'), 'subscribed')

    await s.sessions.append(workRun.id, { kind: 'assistant', content: { text: 'live secret about pay' } })
    s.bus.publish('model.delta', { runId: workRun.id, sessionId: work.id, content: 'streamed secret about pay' })
    // A new DM request to the router context: its entries carry the marker from the start.
    await t.req('POST', `/api/chat/channels/${dmId}/messages`, { text: 'router live secret' }, ana)
    const ev2 = (
      await s.records.query('event', { where: { 'payload.channelId': dmId }, orderBy: { field: 'receivedAt', dir: 'desc' } })
    ).items[0]!
    await s.router.route(ev2.id)
    await s.sessions.append(publicRunId, { kind: 'assistant', content: { text: 'public progress' } })

    const [a, b, x] = clients as [ReturnType<typeof connect>, ReturnType<typeof connect>, ReturnType<typeof connect>]
    const saw = (c: typeof a, text: string) =>
      c.messages.some((m) => m.type === 'event' && JSON.stringify(m.payload).includes(text))
    await until(() => saw(a, 'live secret about pay') && saw(a, 'streamed secret') && saw(a, 'router live secret'), 'ana sees it')
    await s.bus.idle()
    await t.a.live.flush()
    for (const c of [b, x]) {
      expect(saw(c, 'live secret about pay')).toBe(false)
      expect(saw(c, 'streamed secret')).toBe(false)
      expect(saw(c, 'router live secret')).toBe(false)
      expect(c.messages.some((m) => m.type === 'event' && m.payload?.sessionId === work.id)).toBe(false)
      expect(c.messages.some((m) => m.type === 'event' && m.topic === 'record.changed' && m.payload.id === work.id)).toBe(false)
    }
    for (const c of clients) c.ws.close()
  })
})

describe('the MCP server', () => {
  async function connect(contactId: string) {
    const { token } = await createMcpToken(t.a.services, contactId, 'test')
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${t.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
    return client
  }
  const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join('\n')

  it('answers session_get, sessions_search and my_work only for the DM members', async () => {
    const b = await connect(bobId)
    const got = await b.callTool({ name: 'session_get', arguments: { id: work.id } })
    expect(got.isError).toBe(true)
    expect(text(got)).not.toContain(SECRET)
    const found = await b.callTool({ name: 'sessions_search', arguments: { text: 'pay' } })
    expect(text(found)).not.toContain(work.id)
    await b.close()

    const a = await connect(anaId)
    const mine = await a.callTool({ name: 'session_get', arguments: { id: work.id } })
    expect(mine.isError).toBeFalsy()
    expect(text(mine)).toContain('Ana pay raise')
    expect(text(await a.callTool({ name: 'sessions_search', arguments: { text: 'pay' } }))).toContain(work.id)
    expect(text(await a.callTool({ name: 'my_work', arguments: {} }))).toContain(workRun.id)
    await a.close()
  })
})
