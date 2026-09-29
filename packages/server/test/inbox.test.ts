import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Services } from '../src/services.ts'
import { testApp, type TestApp } from './helpers.ts'

let t: TestApp
let s: Services
let ana: string
let bob: string
let asAna: Record<string, string>
let asBob: Record<string, string>

beforeAll(async () => {
  t = await testApp({ workers: false })
  s = t.a.services
  ana = (await s.directory.contacts.create({ name: 'Ana Example', kind: 'person', handles: [{ system: 'mp', id: 'ana' }] })).id
  bob = (await s.directory.contacts.create({ name: 'Bob Example', kind: 'person', handles: [{ system: 'mp', id: 'bob' }] })).id
  asAna = await t.as(ana)
  asBob = await t.as(bob, { access: 'viewer' })
})
afterAll(async () => {
  await t.close()
})

const post = async (who: string, channelId: string, text: string, threadId?: string) =>
  s.chat.post({ channelId, author: { kind: 'contact', id: who }, text, ...(threadId ? { threadId } : {}) })
const inboxOf = async (h: Record<string, string>) => (await t.req('GET', '/api/inbox', undefined, h)).body as any[]

describe('inbox', () => {
  it("shows mentions of you (not others') and replies in your threads, never your own messages", async () => {
    const general = (await s.chat.channelByName('general'))!
    const root = await post(ana, general.id, 'Ana starts a thread')
    const reply = await post(bob, general.id, 'Bob answers Ana', root.id)
    await post(ana, general.id, 'Ana answers back', root.id)
    const mention = await post(bob, general.id, 'Hey @ana, look')
    await post(ana, general.id, 'Ana tags @bob')
    // A thread Ana is tagged in: later replies count too.
    const tagged = await post(bob, general.id, '@ana see this thread')
    const later = await post(bob, general.id, 'more in the tagged thread', tagged.id)
    // A thread Ana has nothing to do with.
    const other = await post(bob, general.id, 'Bob alone')
    await post(bob, general.id, 'Bob replying to himself', other.id)

    const items = await inboxOf(asAna)
    const ids = items.map((i) => i.id)
    expect(ids).toEqual(
      expect.arrayContaining([`reply:${reply.id}`, `mention:${mention.id}`, `mention:${tagged.id}`, `reply:${later.id}`]),
    )
    expect(items.find((i) => i.id === `reply:${reply.id}`)).toMatchObject({
      type: 'reply',
      read: false,
      channelId: general.id,
      threadId: root.id,
      title: 'Bob Example replied in a thread',
    })
    expect(items.find((i) => i.id === `mention:${mention.id}`)).toMatchObject({
      type: 'mention',
      title: 'Bob Example mentioned you',
    })
    expect(items.some((i) => i.detail?.startsWith('Ana'))).toBe(false)
    expect(items.some((i) => i.detail?.includes('Bob alone') || i.detail?.includes('himself'))).toBe(false)

    // Bob sees only the mention of him.
    const bobs = await inboxOf(asBob)
    expect(bobs.filter((i) => i.type === 'mention').map((i) => i.detail)).toEqual(['Ana tags @bob'])
  })

  it('marks items read and clears the inbox, per person', async () => {
    const general = (await s.chat.channelByName('general'))!
    const m = await post(bob, general.id, '@ana one more')
    const id = `mention:${m.id}`
    expect((await t.req('POST', '/api/inbox/read', { ids: [id] }, asAna)).status).toBe(204)
    expect((await inboxOf(asAna)).find((i) => i.id === id)).toMatchObject({ read: true })
    expect((await inboxOf(asAna)).filter((i) => i.id !== id).every((i) => i.read === false)).toBe(true)

    // A viewer may mark their own inbox too.
    expect((await t.req('POST', '/api/inbox/read', { clear: true }, asBob)).status).toBe(204)
    expect((await inboxOf(asBob)).length).toBe(0)
    expect((await inboxOf(asAna)).length).toBeGreaterThan(0)

    await t.req('POST', '/api/inbox/read', { clear: true }, asAna)
    expect(await inboxOf(asAna)).toEqual([])
    // New items after clearing show up again.
    await new Promise((r) => setTimeout(r, 5))
    const fresh = await post(bob, general.id, '@ana after clearing')
    expect((await inboxOf(asAna)).map((i) => i.id)).toEqual([`mention:${fresh.id}`])

    expect((await t.req('POST', '/api/inbox/read', { ids: 'nope' }, asAna)).status).toBe(400)
    expect((await t.req('POST', '/api/inbox/read', { clear: 'yes' }, asAna)).status).toBe(400)
  })

  it("doesn't show mentions in DMs you aren't in", async () => {
    const emp = (await s.directory.employees.byHandle('meatless'))!
    const dm = await s.chat.openDm(
      [
        { kind: 'contact', id: bob },
        { kind: 'employee', id: emp.id },
      ],
      { kind: 'contact', id: bob },
    )
    const secret = await post(bob, dm.id, 'private note about @ana')
    expect((await inboxOf(asAna)).some((i) => i.id === `mention:${secret.id}`)).toBe(false)
  })
})
