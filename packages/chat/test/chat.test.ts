import {
  ConflictError,
  ManualClock,
  NotFoundError,
  ValidationError,
  createEventBus,
  type BusMessage,
  type KindSchema,
} from '@mp/core'
import { createEvents, type Events } from '@mp/events'
import { createRecords, type Records } from '@mp/records'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import { ChatTopics, createChat, normalizeChannelName, parseTags, type Chat, type ChatMessagePosted } from '../src/index.ts'

describe('parseTags', () => {
  it('parses names and session slugs', () => {
    expect(parseTags('hey @billing-bot and @ana, see @billing-bot#pay-123-refund.')).toEqual([
      { raw: '@billing-bot', name: 'billing-bot' },
      { raw: '@ana', name: 'ana' },
      { raw: '@billing-bot#pay-123-refund', name: 'billing-bot', slug: 'pay-123-refund' },
    ])
  })
  it('ignores emails, code spans and fenced code', () => {
    expect(parseTags('mail ana@example.com or @bob@example.com')).toEqual([])
    expect(parseTags('run `@ana` then\n```\n@bob\n```\n@carl')).toEqual([{ raw: '@carl', name: 'carl' }])
    expect(parseTags('unterminated ```\n@bob')).toEqual([])
  })
  it('dedupes case-insensitively and trims trailing punctuation', () => {
    expect(parseTags('@Ana @ana! (@ana.) @dev_ops-')).toEqual([
      { raw: '@Ana', name: 'Ana' },
      { raw: '@dev_ops', name: 'dev_ops' },
    ])
  })
  it('handles line starts and punctuation before the tag', () => {
    expect(parseTags('@a\n(@b) "@c"').map((t) => t.name)).toEqual(['a', 'b', 'c'])
    expect(parseTags('see https://x.test/@path and a:@b').map((t) => t.name)).toEqual([])
  })
})

describe('normalizeChannelName', () => {
  it('normalises and validates', () => {
    expect(normalizeChannelName('#Deploys')).toBe('deploys')
    expect(() => normalizeChannelName('has space')).toThrow(ValidationError)
    expect(() => normalizeChannelName('')).toThrow(ValidationError)
  })
})

const person: KindSchema = { kind: 'contact', prefix: 'con', core: [{ name: 'name', type: 'string', required: true }] }
const session: KindSchema = { kind: 'session', prefix: 'ses', core: [{ name: 'slug', type: 'string', required: true }] }
const EMP = 'emp_01J00000000000000000000001'

let clock: ManualClock
let records: Records
let events: Events
let chat: Chat
let posted: BusMessage<ChatMessagePosted>[]
let ana: string
let botContact: string
let ses: string

beforeEach(async () => {
  clock = new ManualClock()
  const bus = createEventBus({ now: () => clock.now() })
  posted = []
  bus.subscribe<ChatMessagePosted>(ChatTopics.message, (m) => void posted.push(m))
  records = createRecords({ store: memoryStore({ clock }), bus })
  records.kinds.define(person)
  records.kinds.define(session)
  ana = (await records.create('contact', { name: 'Ana' })).id
  botContact = (await records.create('contact', { name: 'Billing bot' })).id
  ses = (await records.create('session', { slug: 'pay-123' })).id
  events = createEvents({ records, clock, bus })
  chat = createChat({
    records,
    events,
    clock,
    bus,
    resolveName: async (name) =>
      name === 'billing-bot'
        ? { type: 'employee', employeeId: EMP, contactId: botContact }
        : name === 'ana'
          ? { type: 'person', contactId: ana }
          : null,
    resolveSessionSlug: async (employeeId, slug) => (employeeId === EMP && slug === 'pay-123' ? ses : null),
  })
})

describe('channels', () => {
  it('creates, finds, lists and archives', async () => {
    const ch = await chat.createChannel({ name: '#Deploys', topic: 'releases', createdBy: { kind: 'contact', id: ana } })
    expect(ch.id).toMatch(/^chn_/)
    expect(ch.data).toMatchObject({ name: 'deploys', archived: false, topic: 'releases' })
    expect((await chat.channelByName('deploys'))!.id).toBe(ch.id)
    expect((await chat.channelByName('#DEPLOYS'))!.id).toBe(ch.id)
    expect(await chat.channelByName('not valid!')).toBeNull()
    await expect(chat.createChannel({ name: 'deploys', createdBy: { kind: 'contact', id: ana } })).rejects.toBeInstanceOf(
      ConflictError,
    )
    const b = await chat.createChannel({ name: 'billing', createdBy: { kind: 'session', id: ses } })
    expect((await chat.listChannels()).map((c) => c.data.name)).toEqual(['billing', 'deploys'])
    await chat.archive(b.id)
    expect((await chat.archive(b.id)).data.archived).toBe(true)
    expect((await chat.listChannels({ archived: false })).map((c) => c.data.name)).toEqual(['deploys'])
    expect((await chat.listChannels({ archived: true })).map((c) => c.data.name)).toEqual(['billing'])
  })

  it('updates topic and context', async () => {
    const ch = await chat.createChannel({ name: 'x', createdBy: { kind: 'contact', id: ana } })
    const u = await chat.updateChannel(ch.id, { topic: 't', contextSessionId: ses })
    expect(u.data).toMatchObject({ topic: 't', contextSessionId: ses })
    const v = await chat.updateChannel(ch.id, { contextSessionId: null })
    expect(v.data.contextSessionId).toBeUndefined()
    expect(v.data.topic).toBe('t')
    await expect(chat.updateChannel('chn_missing', { topic: 'x' })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('manages members', async () => {
    const ch = await chat.createChannel({
      name: 'inc',
      createdBy: { kind: 'contact', id: ana },
      members: [{ kind: 'contact', id: ana }],
    })
    await chat.addMember(ch.id, { kind: 'session', id: ses })
    await chat.addMember(ch.id, { kind: 'session', id: ses })
    expect((await chat.members(ch.id)).map((m) => m.id)).toEqual([ana, ses])
    await chat.removeMember(ch.id, { kind: 'contact', id: ana })
    expect((await chat.members(ch.id)).map((m) => m.id)).toEqual([ses])
    await expect(chat.addMember(ch.id, { kind: 'contact', id: 'con_missing' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(chat.addMember('chn_missing', { kind: 'contact', id: ana })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('messages', () => {
  it('posts a top-level message with resolved tags and ingests an event', async () => {
    const ch = await chat.createChannel({ name: 'billing', createdBy: { kind: 'contact', id: ana } })
    const msg = await chat.post({
      channelId: ch.id,
      author: { kind: 'contact', id: ana },
      text: `@billing-bot please refund, cc @ana and @billing-bot#pay-123 @billing-bot#nope @ghost, see [[session:${ses}]]`,
    })
    expect(msg.id).toMatch(/^msg_/)
    expect(msg.data.threadId).toBeNull()
    expect(msg.data.tags).toEqual([
      { raw: '@billing-bot', type: 'employee', employeeId: EMP },
      { raw: '@ana', type: 'person', contactId: ana },
      { raw: '@billing-bot#pay-123', type: 'session', employeeId: EMP, sessionId: ses },
      { raw: '@billing-bot#nope', type: 'unresolved', name: 'billing-bot', slug: 'nope' },
      { raw: '@ghost', type: 'unresolved', name: 'ghost' },
    ])
    expect(msg.data.mentions).toEqual([{ kind: 'session', id: ses }])
    expect((await records.backlinks({ kind: 'session', id: ses })).map((r) => r.id)).toEqual([msg.id])

    const [e] = await events.query({ source: 'chat' })
    expect(e!.key).toBe(`chat:${msg.id}`)
    expect(e!.data).toMatchObject({
      type: 'message.posted',
      subject: { system: 'mp', id: msg.id },
      actorContactId: ana,
      payload: { messageId: msg.id, channelId: ch.id, threadId: null, author: { kind: 'contact', id: ana } },
    })
    await Promise.resolve()
    expect(posted.map((p) => p.payload)).toEqual([{ channelId: ch.id, threadId: null, messageId: msg.id }])
  })

  it('replies go to the thread root and are events on the thread', async () => {
    const ch = await chat.createChannel({ name: 'billing', createdBy: { kind: 'contact', id: ana } })
    const root = await chat.post({ channelId: ch.id, author: { kind: 'contact', id: ana }, text: 'root' })
    clock.advance(1000)
    const r1 = await chat.post({ channelId: ch.id, threadId: root.id, author: { kind: 'session', id: ses }, text: 'on it' })
    clock.advance(1000)
    const r2 = await chat.post({ channelId: ch.id, threadId: r1.id, author: { kind: 'contact', id: ana }, text: 'thanks' })
    expect(r2.data.threadId).toBe(root.id)
    expect((await chat.thread(root.id)).map((m) => m.id)).toEqual([root.id, r1.id, r2.id])
    const replies = await events.query({ type: 'message.replied' })
    expect(replies.map((e) => e.data.subjectKey)).toEqual([`mp:${root.id}`, `mp:${root.id}`])
    expect(replies[0]!.data.actorContactId).toBeUndefined()
    expect((await chat.messages(ch.id)).map((m) => m.id)).toEqual([root.id])
  })

  it('refuses bad posts', async () => {
    const ch = await chat.createChannel({ name: 'a', createdBy: { kind: 'contact', id: ana } })
    const other = await chat.createChannel({ name: 'b', createdBy: { kind: 'contact', id: ana } })
    const root = await chat.post({ channelId: other.id, author: { kind: 'contact', id: ana }, text: 'x' })
    const author = { kind: 'contact' as const, id: ana }
    await expect(chat.post({ channelId: ch.id, author, text: '  ' })).rejects.toBeInstanceOf(ValidationError)
    await expect(chat.post({ channelId: ch.id, author: { kind: 'bot', id: 'x' } as any, text: 'x' })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(chat.post({ channelId: ch.id, threadId: root.id, author, text: 'x' })).rejects.toBeInstanceOf(ValidationError)
    await expect(chat.post({ channelId: ch.id, threadId: 'msg_missing', author, text: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
    await expect(chat.post({ channelId: 'chn_missing', author, text: 'x' })).rejects.toBeInstanceOf(NotFoundError)
    await chat.archive(ch.id)
    await expect(chat.post({ channelId: ch.id, author, text: 'x' })).rejects.toBeInstanceOf(ConflictError)
  })

  it('pages top-level messages', async () => {
    const ch = await chat.createChannel({ name: 'a', createdBy: { kind: 'contact', id: ana } })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push((await chat.post({ channelId: ch.id, author: { kind: 'contact', id: ana }, text: `m${i}` })).id)
      clock.advance(10)
    }
    expect((await chat.messages(ch.id, { limit: 2 })).map((m) => m.id)).toEqual(ids.slice(3))
    expect((await chat.messages(ch.id, { limit: 2, before: ids[3] })).map((m) => m.id)).toEqual(ids.slice(1, 3))
    expect((await chat.messages(ch.id, { before: ids[0] })).length).toBe(0)
  })

  it('searches message text', async () => {
    const a = await chat.createChannel({ name: 'a', createdBy: { kind: 'contact', id: ana } })
    const b = await chat.createChannel({ name: 'b', createdBy: { kind: 'contact', id: ana } })
    const m1 = await chat.post({ channelId: a.id, author: { kind: 'contact', id: ana }, text: 'Refund PAY-123' })
    const m2 = await chat.post({ channelId: b.id, author: { kind: 'contact', id: ana }, text: 'refund done' })
    await chat.post({ channelId: b.id, author: { kind: 'contact', id: ana }, text: 'other' })
    expect((await chat.search('REFUND')).map((m) => m.id)).toEqual([m2.id, m1.id])
    expect((await chat.search('refund', { channelId: a.id })).map((m) => m.id)).toEqual([m1.id])
  })

  it('concurrent posts each get their own event', async () => {
    const ch = await chat.createChannel({ name: 'a', createdBy: { kind: 'contact', id: ana } })
    const msgs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => chat.post({ channelId: ch.id, author: { kind: 'contact', id: ana }, text: `m${i}` })),
    )
    expect(new Set(msgs.map((m) => m.id)).size).toBe(10)
    expect((await events.query({ source: 'chat' })).length).toBe(10)
  })
})
