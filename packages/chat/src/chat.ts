import { createHash } from 'node:crypto'
import {
  ConflictError,
  DeniedError,
  NotFoundError,
  ValidationError,
  newId,
  systemClock,
  type Clock,
  type EventBus,
  type Json,
  type KindSchema,
} from '@mp/core'
import type { Events } from '@mp/events'
import { parseDocLinks, type Records } from '@mp/records'
import type { Actor, Condition, Ref, StoredRecord } from '@mp/store'
import {
  type Attachment,
  type AttachmentData,
  type ChatAttachments,
  attachmentLine,
  attachmentSchema,
  attachmentsOf,
} from './attachments.ts'
import { addressedName, parseTags } from './tags.ts'

/**
 * The most of a message an event's text carries. The router decides from it and the work it starts
 * is briefed from it, so a request must fit (it was 200 characters, and the router passed on half a spec).
 */
export const EVENT_TEXT_MAX_CHARS = 4000

const eventText = (text: string) =>
  text.length > EVENT_TEXT_MAX_CHARS
    ? `${text.slice(0, EVENT_TEXT_MAX_CHARS)}… [${text.length - EVENT_TEXT_MAX_CHARS} more characters: chat.read for the rest]`
    : text

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
    { name: 'dm', type: 'boolean', description: 'A direct message between its members, not a named channel.' },
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
    { name: 'editedAt', type: 'timestamp', description: 'Set when the text was edited. Earlier texts are in the revisions.' },
    {
      name: 'deleted',
      type: 'boolean',
      description: 'Deleted by its author: the text is gone, a placeholder stays in the thread.',
    },
    { name: 'reactions', type: 'json', description: 'Emoji -> list of `{kind, id}` who reacted.' },
    {
      name: 'attachments',
      type: 'list',
      of: { type: 'json' },
      description:
        'Files and images attached to it: `{ id, kind, name, mime, size, width?, height? }`. The bytes are on the files volume.',
    },
  ],
}

/** A reader's position in a channel or thread: everything up to `lastReadAt` has been seen. Key `reader|scope`. */
export const readMarkerSchema: KindSchema = {
  kind: 'chat_read',
  prefix: 'crd',
  description: 'How far a person or session has read in a channel or thread.',
  core: [
    { name: 'reader', type: 'object', required: true, fields: refFields },
    { name: 'scope', type: 'string', required: true, description: 'A channel id, or a thread root message id.' },
    { name: 'lastReadAt', type: 'timestamp', required: true },
    { name: 'lastReadMessageId', type: 'ref', ref: 'message' },
  ],
}

/** The ids a tag points at: employee, session and contact ids. */
export function tagIds(t: ChatTag): string[] {
  switch (t.type) {
    case 'employee':
      return [t.employeeId]
    case 'session':
      return [t.sessionId, t.employeeId]
    case 'person':
      return [t.contactId]
    default:
      return []
  }
}

const EMOJI_MAX = 32

function checkEmoji(emoji: string): string {
  const e = typeof emoji === 'string' ? emoji.trim() : ''
  if (!e || e.length > EMOJI_MAX || /\s/.test(e)) throw new ValidationError('a reaction is one emoji or a short :name:')
  return e
}

/** Role of links from a channel to its members (contacts, employees, sessions). */
export const MEMBER = 'member'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatAuthor {
  kind: 'contact' | 'session'
  id: string
}

/** Facts about an author, carried in the event payload next to `{kind, id}`: e.g. that a contact is a local AI agent. */
export interface AuthorInfo {
  /** The contact's kind, e.g. `agent` for a local agent connected over MCP. */
  contactKind?: string
  /** Display name. */
  name?: string
  /** For an agent: the name of the person it acts for. */
  onBehalfOf?: string
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
  dm?: boolean
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
  editedAt?: string
  deleted?: boolean
  /** Emoji -> who reacted with it. */
  reactions?: Record<string, Ref[]>
  /** Files and images attached to it (their bytes are chat attachments on the files volume). */
  attachments?: Attachment[]
}
export type Message = StoredRecord<MessageData>

export interface ReadMarkerData extends Record<string, unknown> {
  reader: Ref
  scope: string
  lastReadAt: string
  lastReadMessageId?: string
}

/** Unread state of one channel for one reader. */
export interface UnreadState {
  channelId: string
  /** Messages (top-level and replies) by others since the reader's marker. */
  unread: number
  /** Of those, messages that tag the reader. */
  mentions: number
  lastReadAt: string | null
}

export interface SearchQuery {
  channelId?: string
  /** Messages by this contact or session. */
  author?: Ref
  /** Messages that tag this employee, session or contact (by id). */
  tagged?: string
  /** Replies in this thread (and its root). */
  threadId?: string
  /** Include deleted messages (their text is empty, so they only match other filters). Default false. */
  includeDeleted?: boolean
  limit?: number
}

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
  author: ChatAuthor & AuthorInfo
  /** Files and images attached to the message (metadata only; the model looks at an image with `image.view`, reads a text file with `chat.attachment_text`). */
  attachments?: Attachment[]
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
  /** Attachments. Without it, messages can't have any. */
  attachments?: ChatAttachments
  /**
   * Called after a message with images is posted (and its event ingested), e.g. to describe them in
   * the background. Errors are the caller's to handle: a failure here doesn't fail the post.
   */
  onAttachments?: (message: Message, attachments: Attachment[]) => Promise<void>
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
  /** Extra facts about the author for the durable event's payload (the message record keeps `{kind, id}`). */
  authorInfo?: AuthorInfo
  /**
   * Ids of uploads (`ChatAttachments.upload`) by the same author to attach. The text may be empty
   * when there are attachments.
   */
  attachments?: string[]
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
  /**
   * Messages whose text contains `text` (case-insensitive), or with an image whose saved description or
   * visible text contains it, newest first. An empty text matches everything the filters allow.
   */
  search(text: string, q?: SearchQuery): Promise<Message[]>
  /**
   * Changes a message's text. Only its author may (`DeniedError` otherwise). Tags are resolved
   * again, the earlier text stays in the record's revisions, and a `message.edited` event goes to the thread.
   */
  edit(messageId: string, text: string, by: Ref): Promise<Message>
  /** Deletes a message: only its author may. The text and attachments are removed and a placeholder stays in the thread. */
  delete(messageId: string, by: Ref): Promise<Message>
  /** Adds a reaction (idempotent). A `reaction.added` event goes to the thread, so a subscribed session can act on it. */
  react(messageId: string, emoji: string, by: Ref): Promise<Message>
  /** Removes a reaction (idempotent). */
  unreact(messageId: string, emoji: string, by: Ref): Promise<Message>
  /** Moves a reader's marker in a channel or thread to now (or to a given message). */
  markRead(reader: Ref, scope: string, opts?: { messageId?: string }): Promise<void>
  /** Unread counts and mentions per channel, for the given channels (default: all that aren't archived). */
  unread(reader: Ref, opts?: { channelIds?: string[]; taggedIds?: string[] }): Promise<UnreadState[]>
  /**
   * The DM between exactly these members, created if it doesn't exist yet. Order doesn't matter;
   * the same set of members always gets the same DM.
   */
  openDm(members: Ref[], createdBy: Ref): Promise<Channel>
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
  for (const s of [channelSchema, messageSchema, readMarkerSchema]) if (!records.kinds.has(s.kind)) records.kinds.define(s)

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
    // Addressing an employee by name at the start ("Meatless, …") counts as tagging it.
    const addressed = addressedName(text)
    if (addressed) {
      const r = await opts.resolveName(addressed.toLowerCase())
      if (
        r?.type === 'employee' &&
        !out.some((t) => t.type !== 'unresolved' && 'employeeId' in t && t.employeeId === r.employeeId)
      )
        out.push({ raw: addressed, type: 'employee', employeeId: r.employeeId })
    }
    return out
  }

  const ownMessage = async (messageId: string, by: Ref) => {
    const msg = await records.get<MessageData>('message', messageId)
    if (!msg) throw new NotFoundError('message', messageId)
    if (msg.data.author.kind !== by.kind || msg.data.author.id !== by.id)
      throw new DeniedError('only the author can change a message')
    return msg
  }

  /** A durable event on the message's thread, so subscribed sessions hear about edits, deletions and reactions. */
  const threadEvent = async (msg: Message, type: string, extra: Record<string, unknown>, by?: Ref) => {
    const threadId = msg.data.threadId ?? msg.id
    const actor = by ?? msg.data.author
    await events.ingest({
      source: 'chat',
      type,
      dedupeKey: `chat:${msg.id}:${type}:${msg.version}:${actor.kind}:${actor.id}:${clock.now()}`,
      subject: { system: 'mp', id: threadId },
      payload: {
        messageId: msg.id,
        channelId: msg.data.channelId,
        threadId: msg.data.threadId,
        author: msg.data.author,
        ...extra,
      } as unknown as Json,
      text: `${type}: ${eventText(msg.data.text)}`,
      ...(actor.kind === 'contact' ? { actorContactId: actor.id } : {}),
    })
    bus?.publish<ChatMessagePosted>(ChatTopics.message, {
      channelId: msg.data.channelId,
      threadId: msg.data.threadId,
      messageId: msg.id,
    })
  }

  /** Compare-and-swap on a message's reactions, retried on conflicts. `fn` returns null for "no change". */
  const changeReactions = async (
    messageId: string,
    fn: (cur: Record<string, Ref[]>) => Promise<Record<string, Ref[]> | null>,
  ): Promise<{ message: Message; changed: boolean }> => {
    for (let i = 0; ; i++) {
      const msg = await records.get<MessageData>('message', messageId)
      if (!msg) throw new NotFoundError('message', messageId)
      if (msg.data.deleted) throw new ConflictError('a deleted message cannot get reactions')
      const next = await fn(msg.data.reactions ?? {})
      if (!next) return { message: msg, changed: false }
      try {
        const updated = await records.update<MessageData>(
          'message',
          msg.id,
          { reactions: next },
          { expectedVersion: msg.version },
        )
        return { message: updated, changed: true }
      } catch (err) {
        if (!(err instanceof ConflictError) || i >= 10) throw err
      }
    }
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
      const attachmentIds = input.attachments ?? []
      if (attachmentIds.length && !opts.attachments) throw new ValidationError('this chat takes no attachments')
      if (typeof input.text !== 'string' || (!input.text.trim() && !attachmentIds.length))
        throw new ValidationError('message text is required')
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
      let attachments: Attachment[] = []
      let id: string | undefined
      if (attachmentIds.length) {
        // Claimed first, for the message about to exist: a crash in between leaves a claim the cleanup removes.
        id = newId('msg', clock.now())
        attachments = await opts.attachments!.claim(attachmentIds, { by: author, channelId: ch.id, messageId: id })
      }
      const msg = await records.create<MessageData>(
        'message',
        {
          channelId: ch.id,
          threadId,
          author,
          text: input.text,
          tags,
          mentions,
          createdAt: clock.iso(),
          ...(attachments.length ? { attachments } : {}),
        },
        { actor: authorActor(author), ...(id ? { id } : {}) },
      )
      const payload: ChatEventPayload = {
        messageId: msg.id,
        channelId: ch.id,
        threadId,
        text: input.text,
        tags,
        author: { ...input.authorInfo, ...author },
        ...(attachments.length ? { attachments } : {}),
      }
      // Images are named, not shown: the session looks at one with image.view when it needs to.
      const lines = attachments.map((a) => attachmentLine(a)).join('\n')
      await events.ingest({
        source: 'chat',
        type: threadId ? 'message.replied' : 'message.posted',
        dedupeKey: `chat:${msg.id}`,
        subject: { system: 'mp', id: threadId ?? msg.id },
        payload: payload as unknown as Json,
        text: `#${ch.data.name}: ${eventText(input.text)}${lines ? `\n${lines}` : ''}`,
        ...(author.kind === 'contact' ? { actorContactId: author.id } : {}),
      })
      bus?.publish<ChatMessagePosted>(ChatTopics.message, { channelId: ch.id, threadId, messageId: msg.id })
      if (attachments.length && opts.onAttachments) await opts.onAttachments(msg, attachments).catch(() => {})
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
      const where: Condition[] = []
      if (text) where.push({ field: 'text', op: 'like', value: text })
      if (q.channelId) where.push({ field: 'channelId', op: 'eq', value: q.channelId })
      if (q.author) where.push({ field: 'author', op: 'eq', value: { kind: q.author.kind, id: q.author.id } })
      if (!q.includeDeleted) where.push({ field: 'deleted', op: 'ne', value: true })
      const limit = q.limit ?? 50
      let items = (await records.query<MessageData>('message', { where, orderBy: { field: 'id', dir: 'desc' } })).items
      if (text && opts.attachments) {
        // Attachments match by name, and images by their saved description and the text visible in them.
        const seen = new Set(items.map((m) => m.id))
        const extra: Message[] = []
        for (const field of ['name', 'description', 'visibleText']) {
          const found = await records.query<AttachmentData>(attachmentSchema.kind, {
            where: [
              { field, op: 'like', value: text },
              { field: 'messageId', op: 'exists', value: true },
            ],
            limit: 1000,
          })
          for (const a of found.items) {
            const id = a.data.messageId!
            if (seen.has(id)) continue
            seen.add(id)
            const m = await records.get<MessageData>('message', id)
            if (!m) continue
            if (q.channelId && m.data.channelId !== q.channelId) continue
            if (q.author && (m.data.author.kind !== q.author.kind || m.data.author.id !== q.author.id)) continue
            if (!q.includeDeleted && m.data.deleted) continue
            extra.push(m)
          }
        }
        if (extra.length) items = [...items, ...extra].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      }
      if (q.threadId) items = items.filter((m) => m.id === q.threadId || m.data.threadId === q.threadId)
      if (q.tagged) items = items.filter((m) => m.data.tags.some((t) => tagIds(t).includes(q.tagged!)))
      return items.slice(0, limit)
    },

    async edit(messageId, text, by) {
      if (typeof text !== 'string' || !text.trim()) throw new ValidationError('message text is required')
      const msg = await ownMessage(messageId, by)
      if (msg.data.deleted) throw new ConflictError('a deleted message cannot be edited')
      const tags = await resolveTags(text)
      const mentions = parseDocLinks(text).map((l) => ({ kind: l.kind, id: l.id }))
      const next = await records.update<MessageData>(
        'message',
        msg.id,
        { text, tags, mentions, editedAt: clock.iso() },
        { actor: authorActor(msg.data.author), expectedVersion: msg.version },
      )
      await threadEvent(next, 'message.edited', { text, tags, previousText: msg.data.text })
      return next
    },

    async delete(messageId, by) {
      const msg = await ownMessage(messageId, by)
      if (msg.data.deleted) return msg
      const next = await records.update<MessageData>(
        'message',
        msg.id,
        { text: '', tags: [], mentions: [], deleted: true, editedAt: clock.iso(), attachments: undefined },
        { actor: authorActor(msg.data.author), expectedVersion: msg.version },
      )
      if (attachmentsOf(msg.data).length) await opts.attachments?.removeForMessage(msg.id)
      await threadEvent(next, 'message.deleted', {})
      return next
    },

    async react(messageId, emoji, by) {
      const e = checkEmoji(emoji)
      return changeReactions(messageId, async (cur) => {
        const list = cur[e] ?? []
        if (list.some((r) => r.kind === by.kind && r.id === by.id)) return null
        return { ...cur, [e]: [...list, { kind: by.kind, id: by.id }] }
      }).then(async (r) => {
        if (r.changed) await threadEvent(r.message, 'reaction.added', { emoji: e, by: { kind: by.kind, id: by.id } }, by)
        return r.message
      })
    },

    async unreact(messageId, emoji, by) {
      const e = checkEmoji(emoji)
      const r = await changeReactions(messageId, async (cur) => {
        const list = cur[e] ?? []
        if (!list.some((x) => x.kind === by.kind && x.id === by.id)) return null
        const rest = list.filter((x) => !(x.kind === by.kind && x.id === by.id))
        const next = { ...cur }
        if (rest.length) next[e] = rest
        else delete next[e]
        return next
      })
      return r.message
    },

    async markRead(reader, scope, o = {}) {
      const key = `${reader.kind}:${reader.id}|${scope}`
      let at = clock.iso()
      if (o.messageId) at = (await records.require<MessageData>('message', o.messageId)).data.createdAt
      const data: ReadMarkerData = {
        reader: { kind: reader.kind, id: reader.id },
        scope,
        lastReadAt: at,
        ...(o.messageId ? { lastReadMessageId: o.messageId } : {}),
      }
      const existing = await records.getByKey<ReadMarkerData>('chat_read', key)
      if (!existing) {
        try {
          await records.create<ReadMarkerData>('chat_read', data, { key })
          return
        } catch (err) {
          if (!(err instanceof ConflictError)) throw err
        }
      }
      const cur = (await records.getByKey<ReadMarkerData>('chat_read', key))!
      // Markers only move forward.
      if (cur.data.lastReadAt >= data.lastReadAt) return
      await records.update<ReadMarkerData>('chat_read', cur.id, data, { replace: true })
    },

    async unread(reader, o = {}) {
      const channelIds = o.channelIds ?? (await chat.listChannels({ archived: false })).map((c) => c.id)
      const tagged = new Set([reader.id, ...(o.taggedIds ?? [])])
      const out: UnreadState[] = []
      for (const channelId of channelIds) {
        const marker = await records.getByKey<ReadMarkerData>('chat_read', `${reader.kind}:${reader.id}|${channelId}`)
        const since = marker?.data.lastReadAt ?? null
        const where: Condition[] = [
          { field: 'channelId', op: 'eq', value: channelId },
          { field: 'deleted', op: 'ne', value: true },
        ]
        if (since) where.push({ field: 'createdAt', op: 'gt', value: since })
        const msgs = (await records.query<MessageData>('message', { where })).items.filter(
          (m) => !(m.data.author.kind === reader.kind && m.data.author.id === reader.id),
        )
        out.push({
          channelId,
          unread: msgs.length,
          mentions: msgs.filter((m) => m.data.tags.some((t) => tagIds(t).some((id) => tagged.has(id)))).length,
          lastReadAt: since,
        })
      }
      return out
    },

    async openDm(members, createdBy) {
      const uniq = [...new Map(members.map((m) => [`${m.kind}:${m.id}`, { kind: m.kind, id: m.id }])).values()]
      if (uniq.length < 2) throw new ValidationError('a DM needs at least two members')
      const key = uniq
        .map((m) => `${m.kind}:${m.id}`)
        .sort()
        .join(',')
      const name = `dm-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
      const existing = await records.getByKey<ChannelData>('channel', name)
      if (existing) return existing
      try {
        const ch = await chat.createChannel({ name, createdBy, members: uniq })
        return records.update<ChannelData>('channel', ch.id, { dm: true })
      } catch (err) {
        if (err instanceof ConflictError) {
          const again = await records.getByKey<ChannelData>('channel', name)
          if (again) return again
        }
        throw err
      }
    },
  }
  return chat
}
