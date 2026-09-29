import { reply } from '@mp/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testApp, until, type TestApp } from './helpers.ts'

/** DMs are visible to their members only: not to other people, and not to admins either. */

let t: TestApp & { port: number | null }
let ana: Record<string, string>
let bob: Record<string, string>
let admin: Record<string, string>
let anaId: string
let dmId: string
let msgId: string
let generalId: string

beforeAll(async () => {
  t = await testApp({ http: true, workers: false, script: [reply('ok')] })
  const s = t.a.services
  anaId = (await s.directory.contacts.create({ name: 'Ana Example', kind: 'person', access: 'member' })).id
  const bobId = (await s.directory.contacts.create({ name: 'Bob Example', kind: 'person', access: 'member' })).id
  ana = await t.as(anaId)
  bob = await t.as(bobId)
  admin = (await t.admin()).headers
  const employeeId = (await s.directory.employees.byHandle('meatless'))!.id
  const dm = await t.req('POST', '/api/chat/dms', { members: [{ kind: 'employee', id: employeeId }] }, ana)
  expect(dm.status).toBe(201)
  dmId = dm.body.id
  const m = await t.req('POST', `/api/chat/channels/${dmId}/messages`, { text: 'my salary question' }, ana)
  expect(m.status).toBe(201)
  msgId = m.body.id
  generalId = (await s.chat.channelByName('general'))!.id
  await t.req('POST', `/api/chat/channels/${generalId}/messages`, { text: 'hello everyone, salary day' }, ana)
})
afterAll(() => t.close())

describe('DMs over HTTP', () => {
  it('lists and reads a DM for its members only', async () => {
    const ids = async (h: Record<string, string>) =>
      (await t.req('GET', '/api/chat/channels', undefined, h)).body.map((c: any) => c.channel.id)
    expect(await ids(ana)).toContain(dmId)
    expect(await ids(bob)).not.toContain(dmId)
    expect(await ids(admin)).not.toContain(dmId)
    expect(await ids(bob)).toContain(generalId)

    expect((await t.req('GET', `/api/chat/channels/${dmId}/messages`, undefined, ana)).status).toBe(200)
    for (const h of [bob, admin]) {
      expect((await t.req('GET', `/api/chat/channels/${dmId}/messages`, undefined, h)).status).toBe(404)
      expect((await t.req('GET', `/api/chat/threads/${msgId}`, undefined, h)).status).toBe(404)
      expect((await t.req('POST', `/api/chat/channels/${dmId}/messages`, { text: 'let me in' }, h)).status).toBe(404)
      expect((await t.req('POST', `/api/chat/messages/${msgId}/reactions`, { emoji: '👀' }, h)).status).toBe(404)
      expect((await t.req('POST', `/api/chat/channels/${dmId}/members`, { type: 'person', id: 'con_x' }, h)).status).toBe(404)
    }
  })

  it('hides a DM from search, unread, the records API and events', async () => {
    const search = async (h: Record<string, string>) =>
      (await t.req('GET', '/api/chat/search?text=salary', undefined, h)).body.map((r: any) => r.message.data.text)
    expect(await search(ana)).toEqual(expect.arrayContaining(['my salary question', 'hello everyone, salary day']))
    expect(await search(bob)).toEqual(['hello everyone, salary day'])
    expect(await search(admin)).toEqual(['hello everyone, salary day'])
    expect((await t.req('GET', `/api/chat/search?text=salary&channelId=${dmId}`, undefined, bob)).status).toBe(404)

    const unread = (await t.req('GET', '/api/chat/unread', undefined, bob)).body.map((u: any) => u.channelId)
    expect(unread).not.toContain(dmId)

    const channels = (await t.req('GET', '/api/records/channel', undefined, bob)).body
    expect(channels.items.map((c: any) => c.id)).not.toContain(dmId)
    expect(channels.total).toBe(channels.items.length)
    const messages = (await t.req('GET', '/api/records/message?text=salary', undefined, admin)).body
    expect(messages.items.map((m: any) => m.data.text)).toEqual(['hello everyone, salary day'])
    const filtered = await t.req(
      'GET',
      `/api/records/message?where=${encodeURIComponent(JSON.stringify({ channelId: dmId }))}`,
      undefined,
      bob,
    )
    expect(filtered.body.items).toEqual([])
    expect((await t.req('GET', `/api/records/message/${msgId}`, undefined, bob)).status).toBe(404)
    expect((await t.req('GET', `/api/records/channel/${dmId}`, undefined, admin)).status).toBe(404)
    expect((await t.req('GET', `/api/records/message/${msgId}/revisions`, undefined, bob)).status).toBe(404)
    expect((await t.req('PATCH', `/api/records/message/${msgId}`, { data: { text: 'x' } }, admin)).status).toBe(404)
    expect((await t.req('GET', `/api/records/message/${msgId}`, undefined, ana)).status).toBe(200)

    const events = async (h: Record<string, string>) =>
      (await t.req('GET', '/api/events?source=chat&limit=500', undefined, h)).body.items.map(
        (e: any) => (e.data.payload as { channelId?: string }).channelId,
      )
    expect(await events(ana)).toContain(dmId)
    expect(await events(bob)).not.toContain(dmId)
    const dmEvent = (await t.a.services.records.query('event', { where: { 'payload.channelId': dmId } })).items[0]!
    expect((await t.req('GET', `/api/events/${dmEvent.id}`, undefined, bob)).status).toBe(404)
    expect((await t.req('GET', `/api/events/${dmEvent.id}`, undefined, ana)).status).toBe(200)
  })

  it('never returns secret values', async () => {
    await t.req('PUT', '/api/secrets', { name: 'STAGING_DB_URL', value: 'postgres://sk-test-value@db' }, admin)
    const list = await t.req('GET', '/api/secrets', undefined, admin)
    expect(list.body.map((x: any) => x.name)).toContain('STAGING_DB_URL')
    expect(JSON.stringify(list.body)).not.toContain('sk-test-value')
    expect((await t.req('GET', '/api/records/secret', undefined, admin)).status).toBe(404)
  })
})

describe('DMs over the WebSocket', () => {
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

  it('needs sign-in', async () => {
    expect((await t.a.app.request('/ws')).status).toBe(401)
    const { open } = connect({})
    await expect(open).rejects.toThrow()
  })

  it('refuses a cross-site socket signed in by cookie', async () => {
    const link = await (await import('../src/auth/sessions.ts')).createLoginLink(t.a.services, anaId)
    const r = await t.a.app.request(`/auth/login?token=${link.token}`)
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    const cross = connect({ cookie, origin: 'https://evil.example.com' })
    await expect(cross.open).rejects.toThrow()
    const same = connect({ cookie, origin: `http://127.0.0.1:${t.port}` })
    await same.open
    same.ws.close()
  })

  it('does not subscribe others to a DM, nor send them its messages', async () => {
    const a = connect(ana)
    const b = connect(bob)
    const x = connect(admin)
    await Promise.all([a.open, b.open, x.open])
    const chans = [`chat:${dmId}`, `chat:${generalId}`, 'records:message', 'events']
    for (const c of [a, b, x]) c.ws.send(JSON.stringify({ type: 'subscribe', channels: chans }))
    for (const c of [a, b, x]) await until(() => c.messages.find((m) => m.type === 'subscribed'), 'subscribed')
    expect(a.messages.find((m) => m.type === 'subscribed').channels).toContain(`chat:${dmId}`)
    for (const c of [b, x]) {
      expect(c.messages.find((m) => m.type === 'subscribed').channels).not.toContain(`chat:${dmId}`)
      expect(c.messages.find((m) => m.type === 'error').message).toContain(`chat:${dmId}`)
    }

    await t.req('POST', `/api/chat/channels/${dmId}/messages`, { text: 'secret plans' }, ana)
    await t.req('POST', `/api/chat/channels/${generalId}/messages`, { text: 'public plans' }, ana)
    const saw = (c: typeof a, text: string) =>
      c.messages.some((m) => m.type === 'event' && JSON.stringify(m.payload).includes(text))
    await until(() => saw(a, 'secret plans') && saw(b, 'public plans') && saw(x, 'public plans'), 'the messages')
    await t.a.services.bus.idle()
    await t.a.live.flush()
    const dmIds = new Set([dmId])
    for (const c of [b, x]) {
      expect(saw(c, 'secret plans')).toBe(false)
      const leaked = c.messages.filter(
        (m) =>
          m.type === 'event' &&
          (dmIds.has(m.payload?.channelId) ||
            dmIds.has(m.payload?.event?.data?.payload?.channelId) ||
            (m.topic === 'record.changed' && m.payload.kind === 'channel' && m.payload.id === dmId)),
      )
      expect(leaked).toEqual([])
    }
    for (const c of [a, b, x]) c.ws.close()
  })
})
