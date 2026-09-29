import {
  ConflictError,
  DeniedError,
  ManualClock,
  NotFoundError,
  ValidationError,
  createEventBus,
  type KindSchema,
} from '@mp/core'
import { createEvents, type Events } from '@mp/events'
import { memoryStorage, solidPng, type FileStorage } from '@mp/files'
import { createRecords, type Records } from '@mp/records'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ATTACHMENTS_OWNER,
  attachmentLine,
  cleanAttachmentName,
  createChat,
  createChatAttachments,
  type Chat,
  type ChatAttachments,
} from '../src/index.ts'

const person: KindSchema = { kind: 'contact', prefix: 'con', core: [{ name: 'name', type: 'string', required: true }] }

let clock: ManualClock
let records: Records
let events: Events
let storage: FileStorage
let attachments: ChatAttachments
let chat: Chat
let ana: { kind: 'contact'; id: string }
let bob: { kind: 'contact'; id: string }
let channelId: string

const png = (w = 8, h = 4) => solidPng(w, h, [200, 30, 30, 255])

beforeEach(async () => {
  clock = new ManualClock()
  const bus = createEventBus({ now: () => clock.now() })
  records = createRecords({ store: memoryStore({ clock }), bus })
  records.kinds.define(person)
  ana = { kind: 'contact', id: (await records.create('contact', { name: 'Ana' })).id }
  bob = { kind: 'contact', id: (await records.create('contact', { name: 'Bob' })).id }
  events = createEvents({ records, clock, bus })
  storage = memoryStorage()
  attachments = createChatAttachments({ records, storage, clock, limits: { maxBytes: 64 * 1024, maxPerMessage: 3 } })
  chat = createChat({
    records,
    events,
    clock,
    bus,
    attachments,
    resolveName: async () => null,
    resolveSessionSlug: async () => null,
  })
  channelId = (await chat.createChannel({ name: 'design', createdBy: ana })).id
})

describe('uploads', () => {
  it('stores the bytes on the volume, pending, with the sniffed type and size', async () => {
    const a = await attachments.upload({ bytes: png(), name: '../../etc/chart.png', by: ana })
    expect(a.id).toMatch(/^att_/)
    expect(a.data).toMatchObject({ name: 'chart.png', mime: 'image/png', size: png().length, width: 8, height: 4 })
    expect(a.data.messageId).toBeUndefined()
    expect(await storage.read(ATTACHMENTS_OWNER, `/pending/${a.id}`)).toEqual(png())
    expect((await attachments.read(a.id))!.bytes).toEqual(png())
  })

  it('checks the content, not the name or claimed type', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    await expect(attachments.upload({ bytes: svg, name: 'cute.png', by: ana })).rejects.toBeInstanceOf(ValidationError)
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>')
    await expect(attachments.upload({ bytes: html, name: 'x.gif', by: ana })).rejects.toThrow(/only images/)
    // A real PNG named .jpg is stored as what it is.
    expect((await attachments.upload({ bytes: png(), name: 'photo.jpg', by: ana })).data.mime).toBe('image/png')
    await expect(attachments.upload({ bytes: new Uint8Array(), by: ana })).rejects.toThrow(/empty/)
  })

  it('refuses uploads over the size limit', async () => {
    const big = new Uint8Array(64 * 1024 + 1)
    big.set(png())
    await expect(attachments.upload({ bytes: big, by: ana })).rejects.toThrow(/at most 64 KB/)
    expect((await records.query('chat_attachment')).items).toHaveLength(0)
  })

  it('names nameless and odd uploads by type', () => {
    expect(cleanAttachmentName(undefined, 'image/jpeg')).toBe('image.jpg')
    expect(cleanAttachmentName('..', 'image/png')).toBe('image.png')
    expect(cleanAttachmentName('a\u0000b<c>.png', 'image/png')).toBe('abc.png')
    expect(attachmentLine({ id: 'att_1', name: 'c.png', mime: 'image/png', size: 1, width: 3, height: 2 })).toBe(
      '[image: c.png 3x2, attachment att_1]',
    )
  })
})

describe('messages with attachments', () => {
  it('attaches uploads: metadata on the message, bytes moved under the channel, named in the event text', async () => {
    const a = await attachments.upload({ bytes: png(), name: 'a.png', by: ana })
    const b = await attachments.upload({ bytes: png(16, 16), name: 'b.png', by: ana })
    const m = await chat.post({ channelId, author: ana, text: '', attachments: [a.id, b.id] })
    expect(m.data.attachments!.map((x) => x.id)).toEqual([a.id, b.id])
    expect(m.data.attachments![1]).toEqual({
      id: b.id,
      name: 'b.png',
      mime: 'image/png',
      size: png(16, 16).length,
      width: 16,
      height: 16,
    })
    expect((await attachments.get(a.id))!.data).toMatchObject({ channelId, messageId: m.id })
    expect(await storage.stat(ATTACHMENTS_OWNER, `/pending/${a.id}`)).toBeNull()
    expect(await storage.read(ATTACHMENTS_OWNER, `/${channelId}/${a.id}`)).toEqual(png())
    const ev = (await events.query({ source: 'chat', type: 'message.posted' })).at(-1)!
    expect(ev.data.text).toBe(`#design: \n[image: a.png 8x4, attachment ${a.id}]\n[image: b.png 16x16, attachment ${b.id}]`)
    expect((ev.data.payload as any).attachments).toHaveLength(2)
    // Replies can have them too.
    const c = await attachments.upload({ bytes: png(), by: ana })
    const r = await chat.post({ channelId, threadId: m.id, author: ana, text: 'another', attachments: [c.id] })
    expect(r.data.attachments).toHaveLength(1)
  })

  it('refuses someone else’s upload, and one already used', async () => {
    const a = await attachments.upload({ bytes: png(), by: ana })
    await expect(chat.post({ channelId, author: bob, text: 'mine now', attachments: [a.id] })).rejects.toBeInstanceOf(DeniedError)
    await chat.post({ channelId, author: ana, text: 'first', attachments: [a.id] })
    await expect(chat.post({ channelId, author: ana, text: 'again', attachments: [a.id] })).rejects.toBeInstanceOf(ConflictError)
    await expect(chat.post({ channelId, author: ana, text: 'x', attachments: ['att_nope'] })).rejects.toBeInstanceOf(
      NotFoundError,
    )
    // Nothing was posted by the refused calls.
    expect((await chat.messages(channelId)).map((m) => m.data.text)).toEqual(['first'])
  })

  it('refuses more than the per-message limit, and uploads older than the claim window', async () => {
    const ids = []
    for (let i = 0; i < 4; i++) ids.push((await attachments.upload({ bytes: png(), by: ana })).id)
    await expect(chat.post({ channelId, author: ana, text: 'x', attachments: ids })).rejects.toThrow(/at most 3/)
    clock.advance(60 * 60 * 1000 + 1)
    await expect(chat.post({ channelId, author: ana, text: 'x', attachments: [ids[0]!] })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('lets exactly one of two racing posts claim an upload, and rolls the other back', async () => {
    const a = await attachments.upload({ bytes: png(), by: ana })
    const b = await attachments.upload({ bytes: png(), by: ana })
    const results = await Promise.allSettled([
      chat.post({ channelId, author: ana, text: 'one', attachments: [b.id, a.id] }),
      chat.post({ channelId, author: ana, text: 'two', attachments: [a.id] }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const posted = await chat.messages(channelId)
    expect(posted).toHaveLength(1)
    const winner = posted[0]!
    for (const x of winner.data.attachments!) expect((await attachments.get(x.id))!.data.messageId).toBe(winner.id)
    // An upload the losing post claimed and gave back can be used again.
    const loserIds = winner.data.text === 'two' ? [b.id] : []
    for (const id of loserIds) expect((await attachments.get(id))!.data.messageId).toBeUndefined()
  })

  it('deleting a message deletes its attachments', async () => {
    const a = await attachments.upload({ bytes: png(), by: ana })
    const m = await chat.post({ channelId, author: ana, text: 'pic', attachments: [a.id] })
    const del = await chat.delete(m.id, ana)
    expect(del.data.deleted).toBe(true)
    expect(del.data.attachments ?? []).toEqual([])
    expect(await attachments.get(a.id)).toBeNull()
    expect(await attachments.read(a.id)).toBeNull()
    expect(await storage.walk(ATTACHMENTS_OWNER)).toEqual([])
  })

  it('without attachments configured, a message can’t have any', async () => {
    const plain = createChat({ records, events, clock, resolveName: async () => null, resolveSessionSlug: async () => null })
    await expect(plain.post({ channelId, author: ana, text: 'x', attachments: ['att_1'] })).rejects.toThrow(/no attachments/)
    await expect(plain.post({ channelId, author: ana, text: ' ' })).rejects.toThrow(/text is required/)
  })
})

describe('cleanup', () => {
  it('removes uploads nobody attached within the window, and keeps the rest', async () => {
    const orphan = await attachments.upload({ bytes: png(), by: ana })
    const used = await attachments.upload({ bytes: png(), by: ana })
    await chat.post({ channelId, author: ana, text: 'x', attachments: [used.id] })
    expect(await attachments.cleanup()).toBe(0)
    clock.advance(30 * 60 * 1000)
    const fresh = await attachments.upload({ bytes: png(), by: ana })
    clock.advance(31 * 60 * 1000)
    expect(await attachments.cleanup()).toBe(1)
    expect(await attachments.get(orphan.id)).toBeNull()
    expect(await storage.stat(ATTACHMENTS_OWNER, `/pending/${orphan.id}`)).toBeNull()
    expect(await attachments.get(fresh.id)).not.toBeNull()
    expect((await attachments.read(used.id))!.bytes).toEqual(png())
  })

  it('removes a claim whose message never appeared', async () => {
    const a = await attachments.upload({ bytes: png(), by: ana })
    await attachments.claim([a.id], { by: ana, channelId, messageId: 'msg_never' })
    clock.advance(2 * 60 * 60 * 1000)
    expect(await attachments.cleanup()).toBe(1)
    expect(await storage.walk(ATTACHMENTS_OWNER)).toEqual([])
  })
})
