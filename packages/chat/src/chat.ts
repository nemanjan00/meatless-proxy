import { ConflictError, ValidationError, systemClock, type Clock, type EventBus, type Json, type KindSchema } from '@mp/core'
import type { Events } from '@mp/events'
import { parseDocLinks, type Records } from '@mp/records'
import type { Actor, Condition, Ref, StoredRecord } from '@mp/store'
import { parseTags } from './tags.ts'

// ─── Schemas ────────────────────────────────────────────────────────────────

const refFields = [
  { name: 'kind', type: 'string' as const, required: true },
  { name: 'id', type: 'string' as const, required: true },
]

export const channelSchema: KindSchema = {
  kind: 'channel',
  prefix: 'chn',
  description: 'A harness chat channel: where a kind of work goes. The record key is its name.',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true, description: 'Unique, lowercase, e.g. `deploys`.' },
    { name: 'topic', type: 'string' },
    { name: 'createdBy', type: 'object', required: true, fields: refFields },
    { name: 'archived', type: 'boolean', required: true },
    {
      name: 'contextSessionId',
      type: 'ref',
      ref: 'session',
      description: 'The context the channel is assigned to. Informational: routing uses triggers.',
    },
  ],
}

export const messageSchema: KindSchema = {
  kind: 'message',
  prefix: 'msg',
  description: 'A harness chat message. A top-level message is also the root of its thread.',
  titleField: 'text',
  core: [
    { name: 'channelId', type: 'ref', ref: 'channel', required: true },
    { name: 'threadId', type: 'ref', ref: 'message', description: 'The root message; null for a top-level message.' },
    { name: 'author', type: 'object', required: true, fields: refFields },
    { name: 'text', type: 'text', required: true },
    { name: 'tags', type: 'list', of: { type: 'json' }, required: true },
    { name: 'mentions', type: 'list', of: { type: 'object', fields: refFields }, required: true },
    { name: 'createdAt', type: 'timestamp', required: true },
  ],
}

/** Role of links from a channel to its members (contacts, employees, sessions). */
export const MEMBER = 'member'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatAuthor {
  kind: 'contact' | 'session'
  id: string
}

/** A tag resolved at post time. Tags that resolve to nothing are kept as `unresolved`. */
export type ChatTag = { raw: string } & (
  | { type: 'employee'; employeeId: string }
  | { type: 'session'; employeeId: string; sessionId: string }
  | { type: 'person'; contactId: string }
  | { type: 'unresolved'; name: string; slug?: string }
)

export interface ChannelData extends Record<string, unknown> {
  name: string
  topic?: string
  createdBy: Ref
  archived: boolean
  contextSessionId?: string
}
export type Channel = StoredRecord<ChannelData>

export interface MessageData extends Record<string, unknown> {
  channelId: string
  threadId: string | null
  author: ChatAuthor
  text: string
  tags: ChatTag[]
  mentions: Ref[]
  createdAt: string
}
export type Message = StoredRecord<MessageData>

export interface ChannelMember extends Ref {
  addedAt: string
}

/** Payload of the durable `chat` events. */
export interface ChatEventPayload {
  messageId: string
  channelId: string
  threadId: string | null
  text: string
  tags: ChatTag[]
  author: ChatAuthor
}

export type NameResolution =
  | { type: 'employee'; employeeId: string; contactId: string }
  | { type: 'person'; contactId: string }
  | null

export interface ChatOptions {
  records: Records
  events: Events
  clock?: Clock
  bus?: EventBus
  /** Resolves `@name` to an employee or a person (e.g. through directory handles). */
  resolveName: (name: string) => Promise<NameResolution>
  /** Resolves `@employee#slug` to a session id. */
  resolveSessionSlug: (employeeId: string, slug: string) => Promise<string | null>
}

export interface CreateChannelInput {
  name: string
  topic?: string
  createdBy: Ref
  contextSessionId?: string
  /** Members to add right away. */
  members?: Ref[]
}

export interface PostInput {
  channelId: string
  /** Reply in this thread. A reply's id is accepted too and normalised to its root. */
  threadId?: string | null
  author: ChatAuthor
  text: string
}

export interface Chat {
  /** `ConflictError` if the name is taken. The name is normalised: a leading `#` is dropped, lowercased. */
  createChannel(input: CreateChannelInput): Promise<Channel>
  getChannel(id: string): Promise<Channel | null>
  channelByName(name: string): Promise<Channel | null>
  listChannels(q?: { archived?: boolean }): Promise<Channel[]>
  updateChannel(id: string, patch: { topic?: string | null; contextSessionId?: string | null }, actor?: Actor): Promise<Channel>
  archive(id: string, actor?: Actor): Promise<Channel>
  /** Idempotent. The member record must exist. */
  addMember(channelId: string, ref: Ref, actor?: Actor): Promise<void>
  removeMember(channelId: string, ref: Ref, actor?: Actor): Promise<void>
  members(channelId: string): Promise<ChannelMember[]>
  /** Stores the message, then ingests a durable `chat` event for it. Archived channels refuse posts (`ConflictError`). */
  post(input: PostInput): Promise<Message>
  getMessage(id: string): Promise<Message | null>
  /** The root message followed by its replies, oldest first. */
  thread(rootId: string): Promise<Message[]>
  /** Top-level messages of a channel, oldest first: the latest `limit` (default 50) before `before` (a message id). */
  messages(channelId: string, q?: { limit?: number; before?: string }): Promise<Message[]>
  /** Messages whose text contains `text` (case-insensitive), newest first. */
  search(text: string, q?: { channelId?: string; limit?: number }): Promise<Message[]>
}

export const ChatTopics = {
  message: 'chat.message',
} as const

export interface ChatMessagePosted {
  channelId: string
  threadId: string | null
  messageId: string
}

// ─── Service ────────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/

export function normalizeChannelName(name: string): string {
  const n = String(name ?? '')
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
  if (!NAME_RE.test(n)) throw new ValidationError('channel name must be lowercase letters, digits, `-` or `_` (max 80)', [n])
  return n
}

const authorActor = (a: ChatAuthor): Actor => ({ type: a.kind, id: a.id })

export function createChat(opts: ChatOptions): Chat {
  const { records, events } = opts
  const clock = opts.clock ?? systemClock
  const bus = opts.bus
  for (const s of [channelSchema, messageSchema]) if (!records.kinds.has(s.kind)) records.kinds.define(s)

  const requireChannel = (id: string) => records.require<ChannelData>('channel', id)

  const resolveTags = async (text: string): Promise<ChatTag[]> => {
    const out: ChatTag[] = []
    for (const t of parseTags(text)) {
      const unresolved: ChatTag = { raw: t.raw, type: 'unresolved', name: t.name, ...(t.slug ? { slug: t.slug } : {}) }
      const r = await opts.resolveName(t.name)
      if (!r) out.push(unresolved)
      else if (t.slug) {
        const sessionId = r.type === 'employee' ? await opts.resolveSessionSlug(r.employeeId, t.slug) : null
        out.push(
          sessionId && r.type === 'employee' ? { raw: t.raw, type: 'session', employeeId: r.employeeId, sessionId } : unresolved,
        )
      } else if (r.type === 'employee') out.push({ raw: t.raw, type: 'employee', employeeId: r.employeeId })
      else out.push({ raw: t.raw, type: 'person', contactId: r.contactId })
    }
    return out
  }

  const chat: Chat = {
    async createChannel(input) {
      const name = normalizeChannelName(input.name)
      if (await records.getByKey('channel', name)) throw new ConflictError(`channel #${name} already exists`)
      const actor: Actor | undefined =
        input.createdBy.kind === 'contact' || input.createdBy.kind === 'session'
          ? { type: input.createdBy.kind, id: input.createdBy.id }
          : undefined
      const ch = await records.create<ChannelData>(
        'channel',
        {
          name,
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          createdBy: { kind: input.createdBy.kind, id: input.createdBy.id },
          archived: false,
          ...(input.contextSessionId ? { contextSessionId: input.contextSessionId } : {}),
        },
        { key: name, ...(actor ? { actor } : {}) },
      )
      for (const m of input.members ?? []) await chat.addMember(ch.id, m, actor)
      return ch
    },
    getChannel: (id) => records.get<ChannelData>('channel', id),
    async channelByName(name) {
      let n: string
      try {
        n = normalizeChannelName(name)
      } catch {
        return null
      }
      return records.getByKey<ChannelData>('channel', n)
    },
    async listChannels(q = {}) {
      const where: Record<string, Json> = {}
      if (q.archived !== undefined) where.archived = q.archived
      return (await records.query<ChannelData>('channel', { where, orderBy: { field: 'name' } })).items
    },
    async updateChannel(id, patch, actor) {
      await requireChannel(id)
      const p: Partial<ChannelData> = {}
      if (patch.topic !== undefined) p.topic = patch.topic ?? undefined
      if (patch.contextSessionId !== undefined) p.contextSessionId = patch.contextSessionId ?? undefined
      return records.update<ChannelData>('channel', id, p, actor ? { actor } : {})
    },
    async archive(id, actor) {
      const ch = await requireChannel(id)
      if (ch.data.archived) return ch
      return records.update<ChannelData>('channel', id, { archived: true }, actor ? { actor } : {})
    },
    async addMember(channelId, ref, actor) {
      await requireChannel(channelId)
      await records.link({ kind: 'channel', id: channelId }, { kind: ref.kind, id: ref.id }, MEMBER, {}, actor ? { actor } : {})
    },
    async removeMember(channelId, ref, actor) {
      await records.unlink({ kind: 'channel', id: channelId }, { kind: ref.kind, id: ref.id }, MEMBER, actor ? { actor } : {})
    },
    async members(channelId) {
      const ls = await records.links({ from: { kind: 'channel', id: channelId }, role: MEMBER })
      return ls
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
        .map((l) => ({ kind: l.to.kind, id: l.to.id, addedAt: l.createdAt }))
    },
    async post(input) {
      if (typeof input.text !== 'string' || !input.text.trim()) throw new ValidationError('message text is required')
      if (!input.author || (input.author.kind !== 'contact' && input.author.kind !== 'session') || !input.author.id)
        throw new ValidationError('author must be { kind: "contact" | "session", id }')
      const ch = await requireChannel(input.channelId)
      if (ch.data.archived) throw new ConflictError(`channel #${ch.data.name} is archived`)
      let threadId: string | null = null
      if (input.threadId) {
        const parent = await records.require<MessageData>('message', input.threadId)
        if (parent.data.channelId !== ch.id) throw new ValidationError('thread belongs to another channel')
        threadId = parent.data.threadId ?? parent.id
      }
      const tags = await resolveTags(input.text)
      const mentions = parseDocLinks(input.text).map((l) => ({ kind: l.kind, id: l.id }))
      const author: ChatAuthor = { kind: input.author.kind, id: input.author.id }
      const msg = await records.create<MessageData>(
        'message',
        { channelId: ch.id, threadId, author, text: input.text, tags, mentions, createdAt: clock.iso() },
        { actor: authorActor(author) },
      )
      const payload: ChatEventPayload = { messageId: msg.id, channelId: ch.id, threadId, text: input.text, tags, author }
      await events.ingest({
        source: 'chat',
        type: threadId ? 'message.replied' : 'message.posted',
        dedupeKey: `chat:${msg.id}`,
        subject: { system: 'mp', id: threadId ?? msg.id },
        payload: payload as unknown as Json,
        text: `#${ch.data.name}: ${input.text.length > 200 ? `${input.text.slice(0, 200)}…` : input.text}`,
        ...(author.kind === 'contact' ? { actorContactId: author.id } : {}),
      })
      bus?.publish<ChatMessagePosted>(ChatTopics.message, { channelId: ch.id, threadId, messageId: msg.id })
      return msg
    },
    getMessage: (id) => records.get<MessageData>('message', id),
    async thread(rootId) {
      const root = await records.require<MessageData>('message', rootId)
      const replies = await records.query<MessageData>('message', { where: { threadId: root.id }, orderBy: { field: 'id' } })
      return [root, ...replies.items]
    },
    async messages(channelId, q = {}) {
      const where: Condition[] = [
        { field: 'channelId', op: 'eq', value: channelId },
        { field: 'threadId', op: 'exists', value: false },
      ]
      if (q.before) where.push({ field: 'id', op: 'lt', value: q.before })
      const page = await records.query<MessageData>('message', {
        where,
        orderBy: { field: 'id', dir: 'desc' },
        limit: q.limit ?? 50,
      })
      return page.items.reverse()
    },
    async search(text, q = {}) {
      const where: Condition[] = [{ field: 'text', op: 'like', value: text }]
      if (q.channelId) where.push({ field: 'channelId', op: 'eq', value: q.channelId })
      return (await records.query<MessageData>('message', { where, orderBy: { field: 'id', dir: 'desc' }, limit: q.limit ?? 50 }))
        .items
    },
  }
  return chat
}
