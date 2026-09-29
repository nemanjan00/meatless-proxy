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
import {
  addressedName,
  ChatTopics,
  createChat,
  normalizeChannelName,
  parseTags,
  type Chat,
  type ChatMessagePosted,
} from '../src/index.ts'

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

describe('addressedName', () => {
  it('reads a name the message opens by addressing', () => {
    expect(addressedName('Meatless, save it as your file')).toBe('Meatless')
    expect(addressedName('hey billing-bot: any news?')).toBe('billing-bot')
    expect(addressedName('Thanks, Ana, that works')).toBe('Ana')
    expect(addressedName('the script works, thanks')).toBeNull()
    expect(addressedName('`x`, y')).toBeNull()
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

describe('everyday chat features', () => {
  const A = () => ({ kind: 'contact' as const, id: ana })
  const S = () => ({ kind: 'session' as const, id: ses })
  const setupThread = async () => {
    const ch = await chat.createChannel({ name: 'general', createdBy: A() })
    const root = await chat.post({ channelId: ch.id, author: A(), text: 'Deploy today? @billing-bot' })
    return { ch, root }
  }
  const eventTypes = async () => (await events.query({ source: 'chat' })).map((e) => e.data.type)

  it('addressing an employee by name at the start tags it; a person addressed by name stays plain', async () => {
    const ch = await chat.createChannel({ name: 'addressing', createdBy: { kind: 'contact', id: ana } })
    const m = await chat.post({ channelId: ch.id, author: { kind: 'contact', id: ana }, text: 'Billing-bot, save it as a file' })
    expect(m.data.tags).toEqual([{ raw: 'Billing-bot', type: 'employee', employeeId: EMP }])
    const both = await chat.post({
      channelId: ch.id,
      author: { kind: 'contact', id: ana },
      text: 'billing-bot, ping @billing-bot',
    })
    expect(both.data.tags.filter((t) => t.type === 'employee')).toHaveLength(1)
    const person = await chat.post({ channelId: ch.id, author: { kind: 'contact', id: ana }, text: 'ana, lunch?' })
    expect(person.data.tags).toEqual([])
  })

  it('edits own messages: tags are resolved again, history kept, the thread hears about it', async () => {
    const { root } = await setupThread()
    clock.advance(1000)
    const edited = await chat.edit(root.id, 'Deploy tomorrow? @ana', A())
    expect(edited.data).toMatchObject({ text: 'Deploy tomorrow? @ana', editedAt: clock.iso() })
    expect(edited.data.tags).toEqual([{ raw: '@ana', type: 'person', contactId: ana }])
    const revs = await records.revisions<any>('message', root.id)
    expect(revs.map((r) => r.data?.text)).toEqual(['Deploy today? @billing-bot', 'Deploy tomorrow? @ana'])
    expect(await eventTypes()).toContain('message.edited')
    const ev = (await events.query({ type: 'message.edited' }))[0]!
    expect(ev.data.subject).toEqual({ system: 'mp', id: root.id })
    expect((ev.data.payload as any).previousText).toBe('Deploy today? @billing-bot')
  })

  it("refuses edits and deletions of someone else's message", async () => {
    const { root } = await setupThread()
    await expect(chat.edit(root.id, 'hijack', S())).rejects.toThrow('only the author')
    await expect(chat.delete(root.id, S())).rejects.toThrow('only the author')
    await expect(chat.edit('msg_missing', 'x', A())).rejects.toBeInstanceOf(NotFoundError)
    await expect(chat.edit(root.id, '  ', A())).rejects.toBeInstanceOf(ValidationError)
  })

  it('deletes: the text is gone, a placeholder stays, search skips it', async () => {
    const { ch, root } = await setupThread()
    const reply = await chat.post({ channelId: ch.id, threadId: root.id, author: S(), text: 'on it' })
    const del = await chat.delete(root.id, A())
    expect(del.data).toMatchObject({ deleted: true, text: '', tags: [] })
    expect((await chat.delete(root.id, A())).version).toBe(del.version) // idempotent
    expect((await chat.thread(root.id)).map((m) => m.id)).toEqual([root.id, reply.id])
    expect(await chat.search('deploy')).toEqual([])
    expect((await chat.search('', { includeDeleted: true, channelId: ch.id })).map((m) => m.id)).toContain(root.id)
    await expect(chat.edit(root.id, 'back', A())).rejects.toBeInstanceOf(ConflictError)
    await expect(chat.react(root.id, '✅', S())).rejects.toBeInstanceOf(ConflictError)
    expect(await eventTypes()).toContain('message.deleted')
  })

  it('reactions: idempotent, concurrent-safe, and an event for the thread', async () => {
    const { root } = await setupThread()
    await Promise.all([chat.react(root.id, '✅', A()), chat.react(root.id, '✅', S()), chat.react(root.id, '👀', A())])
    await chat.react(root.id, '✅', A())
    let m = (await chat.getMessage(root.id))!
    expect(m.data.reactions!['✅']!.map((r) => r.id).sort()).toEqual([ana, ses].sort())
    expect(m.data.reactions!['👀']).toEqual([A()])
    const added = await events.query({ type: 'reaction.added' })
    expect(added).toHaveLength(3)
    expect(added.every((e) => e.data.subject?.id === root.id)).toBe(true)
    expect(
      added.find((e) => (e.data.payload as any).by.id === ana && (e.data.payload as any).emoji === '✅')?.data.actorContactId,
    ).toBe(ana)
    m = await chat.unreact(root.id, '👀', A())
    expect(m.data.reactions!['👀']).toBeUndefined()
    await chat.unreact(root.id, '👀', A())
    await expect(chat.react(root.id, 'not an emoji', A())).rejects.toBeInstanceOf(ValidationError)
  })

  it('search filters by channel, author, thread and tag', async () => {
    const { ch, root } = await setupThread()
    const other = await chat.createChannel({ name: 'ops', createdBy: A() })
    await chat.post({ channelId: other.id, author: S(), text: 'deploy done @ana' })
    const reply = await chat.post({ channelId: ch.id, threadId: root.id, author: S(), text: 'deploy at 5' })
    expect((await chat.search('deploy')).length).toBe(3)
    expect((await chat.search('deploy', { channelId: ch.id })).map((m) => m.id).sort()).toEqual([root.id, reply.id].sort())
    expect((await chat.search('deploy', { author: S() })).length).toBe(2)
    expect((await chat.search('', { threadId: root.id })).map((m) => m.id).sort()).toEqual([root.id, reply.id].sort())
    expect((await chat.search('', { tagged: EMP })).map((m) => m.id)).toEqual([root.id])
    expect((await chat.search('', { tagged: ana })).map((m) => m.data.text)).toEqual(['deploy done @ana'])
    expect(await chat.search('deploy', { limit: 1 })).toHaveLength(1)
  })

  it('unread counts and mentions per reader, with markers that only move forward', async () => {
    const { ch, root } = await setupThread()
    const ops = await chat.createChannel({ name: 'ops', createdBy: A() })
    clock.advance(1000)
    await chat.post({ channelId: ch.id, threadId: root.id, author: S(), text: 'ping @ana' })
    await chat.post({ channelId: ops.id, author: S(), text: 'fyi' })
    let state = await chat.unread(A())
    const by = (id: string) => state.find((x) => x.channelId === id)!
    // Ana's own message doesn't count; the reply tagging her does, and is a mention.
    expect(by(ch.id)).toMatchObject({ unread: 1, mentions: 1, lastReadAt: null })
    expect(by(ops.id)).toMatchObject({ unread: 1, mentions: 0 })
    clock.advance(1000)
    await chat.markRead(A(), ch.id)
    state = await chat.unread(A(), { channelIds: [ch.id, ops.id] })
    expect(by(ch.id)).toMatchObject({ unread: 0, mentions: 0 })
    // Moving a marker back to an older message is ignored.
    await chat.markRead(A(), ch.id, { messageId: root.id })
    expect((await chat.unread(A(), { channelIds: [ch.id] }))[0]!.unread).toBe(0)
    // The bot, tagged as an employee, counts a mention through taggedIds.
    const bot = await chat.unread({ kind: 'contact', id: botContact }, { channelIds: [ch.id], taggedIds: [EMP] })
    expect(bot[0]).toMatchObject({ mentions: 1 })
  })

  it('opens one DM per set of members, whatever the order', async () => {
    const dm1 = await chat.openDm([A(), S()], A())
    const dm2 = await chat.openDm([S(), A(), A()], S())
    expect(dm2.id).toBe(dm1.id)
    expect(dm1.data.dm).toBe(true)
    expect((await chat.members(dm1.id)).map((m) => m.id).sort()).toEqual([ana, ses].sort())
    const [x, y] = await Promise.all([
      chat.openDm([A(), { kind: 'contact', id: botContact }], A()),
      chat.openDm([{ kind: 'contact', id: botContact }, A()], A()),
    ])
    expect(x.id).toBe(y.id)
    await expect(chat.openDm([A()], A())).rejects.toBeInstanceOf(ValidationError)
  })
})
