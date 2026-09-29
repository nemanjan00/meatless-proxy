import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LiveHub, LiveSocket } from '../src/live.ts'
import type { Services } from '../src/services.ts'
import { testApp, type TestApp } from './helpers.ts'

let t: TestApp
let s: Services
let hub: LiveHub
let ana: string
let bob: string
let cara: string
let general: string

beforeAll(async () => {
  t = await testApp({ workers: false })
  s = t.a.services
  hub = t.a.live
  const person = async (name: string, handle: string) =>
    (await s.directory.contacts.create({ name, kind: 'person', handles: [{ system: 'mp', id: handle }] })).id
  ana = await person('Ana Example', 'ana')
  bob = await person('Bob Example', 'bob')
  cara = await person('Cara Example', 'cara')
  general = (await s.chat.channelByName('general'))!.id
})
afterAll(async () => {
  await t.close()
})

/** A socket on the hub, signed in as `contactId`, that records what it gets. */
function socket(contactId: string, opts: { admin?: boolean } = {}) {
  const got: any[] = []
  const sock: LiveSocket = { send: (d) => got.push(JSON.parse(d)), close: () => {} }
  const conn = hub.connect(sock, { contactId, ...(opts.admin ? { admin: true } : {}) })
  return {
    got,
    items: () => got.filter((m) => m.topic === 'inbox.item').map((m) => m.payload.item),
    reads: () => got.filter((m) => m.topic === 'inbox.read').map((m) => m.payload),
    errors: () => got.filter((m) => m.type === 'error').map((m) => m.message as string),
    subscribe: async (channels: string[]) => {
      conn.message(JSON.stringify({ type: 'subscribe', channels }))
      await hub.flush()
    },
    close: conn.close,
  }
}

/** Waits for the bus and the hub to deliver everything so far. */
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await s.bus.idle()
    await hub.flush()
  }
}

const post = (who: string, channelId: string, text: string, threadId?: string) =>
  s.chat.post({ channelId, author: { kind: 'contact', id: who }, text, ...(threadId ? { threadId } : {}) })

describe('per-person live inbox stream', () => {
  it('sends a mention to the person tagged only, in the shape of GET /api/inbox', async () => {
    const a = socket(ana)
    const b = socket(bob)
    await a.subscribe([`person:${ana}`])
    await b.subscribe([`person:${bob}`])
    const m = await post(bob, general, 'Hey @ana, can you look at this?')
    await settle()
    expect(a.items()).toHaveLength(1)
    const item = a.items()[0]
    expect(item).toMatchObject({
      id: `mention:${m.id}`,
      type: 'mention',
      read: false,
      channelId: general,
      threadId: m.id,
      title: 'Bob Example mentioned you',
      author: { type: 'person', id: bob, name: 'Bob Example' },
      channel: { id: general, name: 'general', dm: false },
    })
    expect(a.got.find((x) => x.topic === 'inbox.item')).toMatchObject({ type: 'event', channel: `person:${ana}` })
    // Bob wrote it: nothing for him.
    expect(b.items()).toEqual([])
    // The list agrees with the stream.
    const list = (await t.req('GET', '/api/inbox', undefined, await t.as(ana))).body as any[]
    expect(list.find((i) => i.id === item.id)).toEqual(item)
    a.close()
    b.close()
  })

  it('sends a reply in a thread you started, and never your own messages', async () => {
    const a = socket(ana)
    const b = socket(bob)
    await a.subscribe([`person:${ana}`])
    await b.subscribe([`person:${bob}`])
    const root = await post(ana, general, 'Ana starts a thread')
    await post(ana, general, 'And tags herself, @ana')
    await settle()
    expect(a.items()).toEqual([])
    const reply = await post(bob, general, 'Bob answers Ana', root.id)
    await settle()
    expect(a.items().map((i) => i.id)).toEqual([`reply:${reply.id}`])
    expect(a.items()[0]).toMatchObject({ type: 'reply', threadId: root.id, title: 'Bob Example replied in a thread' })
    // Ana answering back reaches Bob (he posted in the thread), not Ana.
    const back = await post(ana, general, 'Thanks Bob', root.id)
    await settle()
    expect(b.items().map((i) => i.id)).toEqual([`reply:${back.id}`])
    expect(a.items()).toHaveLength(1)
    a.close()
    b.close()
  })

  it('sends a DM to its members only, even when it tags someone outside', async () => {
    const a = socket(ana)
    const c = socket(cara, { admin: true })
    await a.subscribe([`person:${ana}`])
    await c.subscribe([`person:${cara}`])
    const dm = await s.chat.openDm(
      [
        { kind: 'contact', id: ana },
        { kind: 'contact', id: bob },
      ],
      { kind: 'contact', id: bob },
    )
    const m = await post(bob, dm.id, 'Private note, and @cara is not here')
    await settle()
    expect(a.items().map((i) => i.id)).toEqual([`dm:${m.id}`])
    expect(a.items()[0]).toMatchObject({ type: 'dm', channel: { id: dm.id, dm: true }, title: 'Bob Example sent you a message' })
    // Not in the DM (an admin either): nothing, not even for the tag.
    expect(c.items()).toEqual([])
    // The list agrees: Ana has the DM, Cara hasn't.
    expect(
      ((await t.req('GET', '/api/inbox', undefined, await t.as(ana))).body as any[]).some((i) => i.id === `dm:${m.id}`),
    ).toBe(true)
    const caras = (await t.req('GET', '/api/inbox', undefined, await t.as(cara))).body as any[]
    expect(caras.some((i) => i.detail?.includes('Private note'))).toBe(false)
    a.close()
    c.close()
  })

  it("refuses someone else's person channel, and anyone's without a sign-in", async () => {
    const b = socket(bob)
    await b.subscribe([`person:${ana}`, `person:${bob}`])
    expect(b.errors().join(' ')).toContain(`unknown channels: person:${ana}`)
    expect(b.got.find((m) => m.type === 'subscribed').channels).toEqual([`person:${bob}`])
    await post(cara, general, '@ana over here')
    await settle()
    expect(b.items()).toEqual([])
    b.close()

    const got: any[] = []
    const anon = hub.connect({ send: (d) => got.push(JSON.parse(d)), close: () => {} })
    anon.message(JSON.stringify({ type: 'subscribe', channels: [`person:${ana}`] }))
    await hub.flush()
    expect(got.find((m) => m.type === 'subscribed').channels).toEqual([])
    anon.close()
  })

  it('toasts a message once: edits and reactions republish it, but send nothing new', async () => {
    const a = socket(ana)
    await a.subscribe([`person:${ana}`])
    const m = await post(bob, general, '@ana first version')
    await settle()
    await s.chat.edit(m.id, '@ana second version', { kind: 'contact', id: bob })
    await s.chat.react(m.id, '👍', { kind: 'contact', id: cara })
    await settle()
    expect(a.items().map((i) => i.id)).toEqual([`mention:${m.id}`])
    a.close()
  })

  it("doesn't send what is already read, or from before the inbox was cleared", async () => {
    const a = socket(ana)
    await a.subscribe([`person:${ana}`])
    const asAna = await t.as(ana)
    const m = await post(bob, general, '@ana read before it arrives?')
    await t.req('POST', '/api/inbox/read', { ids: [`mention:${m.id}`] }, asAna)
    await s.chat.edit(m.id, '@ana edited', { kind: 'contact', id: bob })
    const fresh = socket(ana)
    await fresh.subscribe([`person:${ana}`])
    await settle()
    expect(fresh.items()).toEqual([])
    a.close()
    fresh.close()
  })

  it('publishes inbox.read to your own sockets when you mark read or clear', async () => {
    const a1 = socket(ana)
    const a2 = socket(ana)
    const b = socket(bob)
    await a1.subscribe([`person:${ana}`])
    await a2.subscribe([`person:${ana}`])
    await b.subscribe([`person:${bob}`])
    const asAna = await t.as(ana)
    expect((await t.req('POST', '/api/inbox/read', { ids: ['mention:x'] }, asAna)).status).toBe(204)
    await settle()
    expect(a1.reads()).toEqual([{ contactId: ana, ids: ['mention:x'] }])
    expect(a2.reads()).toEqual([{ contactId: ana, ids: ['mention:x'] }])
    await t.req('POST', '/api/inbox/read', { clear: true }, asAna)
    await settle()
    expect(a1.reads().at(-1)).toEqual({ contactId: ana, clear: true })
    expect(b.reads()).toEqual([])
    a1.close()
    a2.close()
    b.close()
  })

  it('sends a paused run to its requester, and a nobody-asked one to admins only', async () => {
    const a = socket(ana)
    const b = socket(bob)
    const admin = socket(cara, { admin: true })
    for (const [x, id] of [
      [a, ana],
      [b, bob],
      [admin, cara],
    ] as const)
      await x.subscribe([`person:${id}`])
    const employeeId = (await s.directory.employees.byHandle('meatless'))!.id
    const session = await s.sessions.create({ employeeId, title: 'Refund PAY-9' })
    const mine = await s.sessions.createRun({ sessionId: session.id, cause: { type: 'manual' }, requesterId: ana })
    await s.sessions.transition(mine.id, 'queued', 'paused', { pauseReason: 'token limit per run reached' })
    const other = await s.sessions.create({ employeeId, title: 'Nightly cleanup' })
    const nobodys = await s.sessions.createRun({ sessionId: other.id, cause: { type: 'manual' } })
    await s.sessions.transition(nobodys.id, 'queued', 'paused', { pauseReason: 'paused by hand' })
    await settle()
    expect(a.items().map((i) => i.id)).toEqual([`paused:${mine.id}`])
    expect(a.items()[0]).toMatchObject({ type: 'limit', runId: mine.id, sessionId: session.id, title: 'Paused: Refund PAY-9' })
    expect(b.items()).toEqual([])
    expect(admin.items().map((i) => i.id)).toEqual([`paused:${nobodys.id}`])
    // The list agrees.
    const bobs = (await t.req('GET', '/api/inbox', undefined, await t.as(bob))).body as any[]
    expect(bobs.some((i) => i.runId === mine.id || i.runId === nobodys.id)).toBe(false)
    const anas = (await t.req('GET', '/api/inbox', undefined, await t.as(ana))).body as any[]
    expect(anas.filter((i) => i.runId === mine.id || i.runId === nobodys.id).map((i) => i.id)).toEqual([`paused:${mine.id}`])
    a.close()
    b.close()
    admin.close()
  })

  it('sends a run you asked for that waits on a reply', async () => {
    const a = socket(ana)
    await a.subscribe([`person:${ana}`])
    const employeeId = (await s.directory.employees.byHandle('meatless'))!.id
    const session = await s.sessions.create({ employeeId, title: 'Ask Ana' })
    const run = await s.sessions.createRun({ sessionId: session.id, cause: { type: 'manual' }, requesterId: ana })
    await s.sessions.transition(run.id, 'queued', 'running')
    await s.sessions.suspend(run.id, { type: 'delivery' })
    await settle()
    expect(a.items()).toEqual([
      expect.objectContaining({ id: `waiting:${run.id}`, type: 'waiting', title: 'Waiting on you: Ask Ana' }),
    ])
    a.close()
  })

  it('sends an alert that tags you as an alert', async () => {
    const a = socket(ana)
    await a.subscribe([`person:${ana}`])
    const employee = (await s.directory.employees.byHandle('meatless'))!
    const alerts = await s.chat.createChannel({
      name: 'alerts',
      createdBy: { kind: 'contact', id: employee.data.contactId },
      members: [{ kind: 'employee', id: employee.id }],
    })
    const m = await post(employee.data.contactId, alerts.id, 'Run failed: PAY-9\n\n@ana')
    await settle()
    expect(a.items()).toEqual([
      expect.objectContaining({ id: `alert:${m.id}`, type: 'alert', employee: { id: employee.id, name: 'Meatless' } }),
    ])
    a.close()
  })
})

describe('notification preferences', () => {
  it('are the defaults until changed, per person, and viewers may change their own', async () => {
    const asAna = await t.as(ana)
    const asBob = await t.as(bob, { access: 'viewer' })
    expect((await t.req('GET', '/api/me/notifications', undefined, asAna)).body).toEqual({
      toasts: true,
      desktop: false,
      sound: false,
      hideDmText: false,
      mutedChannels: [],
    })
    const put = await t.req('PUT', '/api/me/notifications', { sound: true, mutedChannels: [general, general] }, asBob)
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ sound: true, toasts: true, mutedChannels: [general] })
    expect((await t.req('PUT', '/api/me/notifications', { desktop: true }, asBob)).body).toMatchObject({
      sound: true,
      desktop: true,
      mutedChannels: [general],
    })
    // Ana's are untouched.
    expect((await t.req('GET', '/api/me/notifications', undefined, asAna)).body).toMatchObject({ sound: false, desktop: false })
  })

  it('refuse bad bodies and anonymous callers, and are hidden from the records API', async () => {
    const asAna = await t.as(ana)
    for (const body of [{ sound: 'yes' }, { mutedChannels: 'x' }, { mutedChannels: [1] }, { nope: true }])
      expect((await t.req('PUT', '/api/me/notifications', body, asAna)).status, JSON.stringify(body)).toBe(400)
    expect((await t.req('GET', '/api/me/notifications', undefined, { authorization: '' })).status).toBe(401)
    expect((await t.req('PUT', '/api/me/notifications', { sound: true }, { authorization: '' })).status).toBe(401)
    await t.req('PUT', '/api/me/notifications', { sound: true }, asAna)
    expect((await t.req('GET', '/api/records/notification_prefs', undefined, await t.as(bob))).status).toBe(404)
    expect((await t.req('GET', '/api/records/inbox_state', undefined, await t.as(bob))).status).toBe(404)
  })

  it('keep every change when two writes race', async () => {
    const asCara = await t.as(cara)
    await Promise.all([
      t.req('PUT', '/api/me/notifications', { sound: true }, asCara),
      t.req('PUT', '/api/me/notifications', { hideDmText: true }, asCara),
      t.req('PUT', '/api/me/notifications', { toasts: false }, asCara),
    ])
    expect((await t.req('GET', '/api/me/notifications', undefined, asCara)).body).toMatchObject({
      sound: true,
      hideDmText: true,
      toasts: false,
    })
  })
})
