import {
  ConflictError,
  DeniedError,
  LimitError,
  errorMessage,
  isMpError,
  type BusMessage,
  type FieldDef,
  type KindSchema,
} from '@mp/core'
import { ChatTopics, attachmentsOf, type Attachment, type ChatAuthor, type ChatMessagePosted, type Message } from '@mp/chat'
import type { Contact, ContactData } from '@mp/directory'
import type { Condition } from '@mp/store'
import { RateLimiter } from '../auth/rate-limit.ts'
import { ChatVisibility } from '../auth/visibility.ts'
import type { Services } from '../services.ts'
import { agentName, randomAgentName } from './names.ts'

/** Why a message was delivered to an agent, strongest first. */
export type DeliveryReason = 'mention' | 'dm' | 'thread' | 'channel'
const REASONS: DeliveryReason[] = ['mention', 'dm', 'thread', 'channel']

export const AGENT_DELIVERY = 'agent_delivery'

/**
 * One chat message delivered to one local agent. The record key is
 * `<agentId>|<messageId>`, so a message is delivered once per agent.
 * `readAt` is set when it was pushed over an open notification stream or
 * returned by `chat_inbox`.
 */
export const agentDeliverySchema: KindSchema = {
  kind: AGENT_DELIVERY,
  prefix: 'agd',
  description: 'A chat message delivered to a local AI agent (a contact of kind agent). Read ones have readAt.',
  core: [
    { name: 'agentId', type: 'ref', ref: 'contact', required: true },
    { name: 'messageId', type: 'ref', ref: 'message', required: true },
    { name: 'channelId', type: 'ref', ref: 'channel', required: true },
    { name: 'threadId', type: 'ref', ref: 'message', required: true, description: 'The thread root.' },
    { name: 'reason', type: 'enum', values: [...REASONS], required: true },
    { name: 'createdAt', type: 'timestamp', required: true },
    { name: 'readAt', type: 'timestamp' },
  ],
}

export interface AgentDeliveryData extends Record<string, unknown> {
  agentId: string
  messageId: string
  channelId: string
  threadId: string
  reason: DeliveryReason
  createdAt: string
  readAt?: string
}

/** Contact fields of local agents. */
export const agentContactFields: FieldDef[] = [
  { name: 'sponsor', type: 'ref', ref: 'contact', description: 'A local agent: the person it acts for (its token owner).' },
  { name: 'online', type: 'boolean', description: 'A local agent: connected to the harness MCP server now.' },
  { name: 'lastSeenAt', type: 'timestamp', description: 'A local agent: when it last joined or left.' },
]

/** A delivery as sent to the agent: enough to answer without another call. */
export interface AgentMessage {
  deliveryId: string
  reason: DeliveryReason
  channel: string
  channelId: string
  threadId: string
  messageId: string
  author: string
  text: string
  at: string
  /** Images on the message; fetch one with chat_attachment. */
  attachments?: Attachment[]
}

/** Gets a delivery to an agent's live connections. Returns true when it reached an open notification stream. */
export type DeliveryListener = (agentId: string, message: AgentMessage) => boolean | Promise<boolean>

export interface AgentChatOptions {
  /** Posts per agent per minute (default 20). */
  postsPerMinute?: number
  /** For names: a number in [0, 1). */
  random?: () => number
}

const agentKey = (name: string) => `agent-${name}`
const deliveryKey = (agentId: string, messageId: string) => `${agentId}|${messageId}`

/**
 * Local agents in harness chat (docs/spec.md#the-harness-as-an-mcp-server):
 * an MCP client that calls `chat_join` becomes a contact of kind `agent`,
 * sponsored by its token's person. It sees what its sponsor sees (plus its own
 * DMs), and gets messages that mention it, DMs to it, replies in threads it is
 * in, and messages in channels it joined, as delivery records it can read
 * back with `inbox`. Live connections are told through `onDelivery`.
 */
export class AgentChat {
  /** Name randomness (tests replace it). */
  random: () => number
  /** Posts per agent (tests replace it). */
  postLimiter: RateLimiter
  readonly vis: ChatVisibility
  private listeners = new Set<DeliveryListener>()
  private kinds = new Map<string, string | null>()
  private offs: (() => void)[] = []
  private pending = new Set<Promise<void>>()

  constructor(
    private s: Services,
    opts: AgentChatOptions = {},
  ) {
    this.random = opts.random ?? Math.random
    this.postLimiter = new RateLimiter(opts.postsPerMinute ?? 20, 60_000, () => s.clock.now())
    this.vis = new ChatVisibility(s)
    const { records } = s
    if (!records.kinds.has(AGENT_DELIVERY)) records.kinds.define(agentDeliverySchema)
    const have = new Set([...(records.kinds.get('contact').extensions ?? [])].map((f) => f.name))
    const missing = agentContactFields.filter((f) => !have.has(f.name))
    if (missing.length) records.kinds.extend('contact', missing)
  }

  /** Subscribes to chat and marks agents left online by an earlier process as offline. */
  start() {
    this.offs.push(
      this.s.bus.subscribe<ChatMessagePosted>(ChatTopics.message, (m) => {
        const p = this.onMessage(m)
          .catch((err) => this.s.logger.warn('agent delivery failed', { err: errorMessage(err) }))
          .finally(() => this.pending.delete(p))
        this.pending.add(p)
        return p
      }),
    )
    void this.resetPresence().catch((err) => this.s.logger.debug('agent presence reset failed', { err: errorMessage(err) }))
  }

  /** Waits for deliveries in flight (tests). */
  async idle() {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  close() {
    for (const off of this.offs.splice(0)) off()
  }

  onDelivery(fn: DeliveryListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  /** The agent contact with this id, or null when it isn't one. */
  async agent(id: string): Promise<Contact | null> {
    const c = await this.s.directory.contacts.get(id)
    return c?.data.kind === 'agent' ? c : null
  }

  /**
   * Joins chat as an agent sponsored by `sponsorId`: with the given name (reclaiming it when the
   * same person sponsors it, `DeniedError` when someone else does, `ConflictError` when a person
   * or employee has it), or a random free `adjective-noun` one.
   */
  async join(sponsorId: string, name?: string): Promise<{ agent: Contact; reclaimed: boolean }> {
    if (name !== undefined) {
      const n = agentName(name)
      for (let i = 0; i < 2; i++) {
        const existing = await this.s.records.getByKey<ContactData>('contact', agentKey(n))
        if (existing) return { agent: await this.reclaim(existing, sponsorId), reclaimed: true }
        if (await this.taken(n)) throw new ConflictError(`@${n} is taken: pick another name, or leave it out for a random one`)
        try {
          return { agent: await this.create(n, sponsorId), reclaimed: false }
        } catch (err) {
          if (!isMpError(err, 'conflict')) throw err
        }
      }
      throw new ConflictError(`@${n} is taken`)
    }
    for (let i = 0; i < 20; i++) {
      let n = randomAgentName(this.random)
      if (i >= 10) n = `${n}-${Math.floor(this.random() * 900) + 100}`
      if ((await this.s.records.getByKey('contact', agentKey(n))) || (await this.taken(n))) continue
      try {
        return { agent: await this.create(n, sponsorId), reclaimed: false }
      } catch (err) {
        if (!isMpError(err, 'conflict')) throw err
      }
    }
    throw new ConflictError('could not find a free name: give one')
  }

  private async reclaim(existing: Contact, sponsorId: string): Promise<Contact> {
    if (existing.data.kind !== 'agent' || existing.data.sponsor !== sponsorId)
      throw new DeniedError(`@${existing.data.name} is another person's agent`)
    return this.setOnline(existing.id, true)
  }

  /** Whether a person, employee or other contact already answers to `@name`. */
  private async taken(name: string): Promise<boolean> {
    return Boolean((await this.s.directory.contacts.byHandle('mp', name)) || (await this.s.directory.employees.byHandle(name)))
  }

  private async create(name: string, sponsorId: string): Promise<Contact> {
    const sponsor = await this.s.directory.contacts.require(sponsorId)
    const agent = await this.s.records.create<ContactData>(
      'contact',
      {
        name,
        kind: 'agent',
        handles: [{ system: 'mp', id: name }],
        status: 'active',
        bio: `A local AI agent connected over MCP on behalf of ${sponsor.data.name}.`,
        sponsor: sponsorId,
        online: true,
        lastSeenAt: this.s.clock.iso(),
      },
      { key: agentKey(name), actor: { type: 'contact', id: sponsorId } },
    )
    this.kinds.set(agent.id, 'agent')
    this.s.logger.info('agent joined chat', { agentId: agent.id, name, sponsor: sponsorId })
    return agent
  }

  /** Marks an agent online or offline (no write when it already is). */
  async setOnline(agentId: string, online: boolean): Promise<Contact> {
    const c = await this.s.directory.contacts.require(agentId)
    if ((c.data.online === true) === online) return c
    return this.s.records.update<ContactData>('contact', agentId, { online, lastSeenAt: this.s.clock.iso() })
  }

  /** Marks every agent offline (on start: no connection survives a restart). */
  async resetPresence() {
    // `where: { kind }` would match the record kind, so the contact kind is filtered here.
    const online = await this.s.records.query<ContactData>('contact', { where: { online: true }, limit: 10_000 })
    for (const c of online.items) if (c.data.kind === 'agent') await this.setOnline(c.id, false)
  }

  /** The sponsor's display name. */
  async sponsorName(agent: Contact): Promise<string> {
    const id = agent.data.sponsor
    return (typeof id === 'string' && (await this.s.directory.contacts.get(id))?.data.name) || 'unknown'
  }

  /** Counts a post by the agent: `LimitError` when it is over its rate. */
  hitPost(agentId: string) {
    if (!this.postLimiter.hit(agentId))
      throw new LimitError(`too many messages: try again in ${this.postLimiter.retryAfter(agentId)}s`)
  }

  // ── Visibility ────────────────────────────────────────────────────────────

  /** Whether an agent may see a channel: its sponsor may, or it is a member itself (its own DMs). */
  async canSee(agent: Contact, channelId: string): Promise<boolean> {
    if (await this.vis.canSeeChannel(agent.id, channelId)) return true
    const sponsor = agent.data.sponsor
    return typeof sponsor === 'string' && this.vis.canSeeChannel(sponsor, channelId)
  }

  /** Channels hidden from a reader: a person, or an agent (hidden from both it and its sponsor). */
  async hiddenChannels(reader: Contact): Promise<Set<string>> {
    const own = await this.vis.hiddenChannels(reader.id)
    const sponsor = reader.data.kind === 'agent' ? reader.data.sponsor : undefined
    if (typeof sponsor !== 'string') return own
    const theirs = await this.vis.hiddenChannels(sponsor)
    return new Set([...own].filter((id) => theirs.has(id)))
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  private async kindOf(contactId: string): Promise<string | null> {
    if (!this.kinds.has(contactId)) this.kinds.set(contactId, (await this.s.directory.contacts.get(contactId))?.data.kind ?? null)
    return this.kinds.get(contactId)!
  }

  private async onMessage(m: BusMessage<ChatMessagePosted>) {
    const msg = await this.s.chat.getMessage(m.payload.messageId)
    if (!msg || msg.data.deleted) return
    const found = new Map<string, DeliveryReason>()
    const add = (id: string, reason: DeliveryReason) => {
      const cur = found.get(id)
      if (!cur || REASONS.indexOf(reason) < REASONS.indexOf(cur)) found.set(id, reason)
    }
    const isAgent = async (id: string) => (await this.kindOf(id)) === 'agent'

    for (const t of msg.data.tags) if (t.type === 'person' && (await isAgent(t.contactId))) add(t.contactId, 'mention')
    const channel = await this.s.chat.getChannel(msg.data.channelId)
    for (const member of await this.s.chat.members(msg.data.channelId))
      if (member.kind === 'contact' && (await isAgent(member.id))) add(member.id, channel?.data.dm ? 'dm' : 'channel')
    if (msg.data.threadId) {
      // In a thread: it posted there, or was tagged there earlier.
      for (const earlier of await this.s.chat.thread(msg.data.threadId)) {
        if (earlier.id === msg.id) continue
        const a = earlier.data.author
        if (a.kind === 'contact' && (await isAgent(a.id))) add(a.id, 'thread')
        for (const t of earlier.data.tags) if (t.type === 'person' && (await isAgent(t.contactId))) add(t.contactId, 'thread')
      }
    }
    if (msg.data.author.kind === 'contact') found.delete(msg.data.author.id)
    if (!found.size) return

    for (const [agentId, reason] of found) {
      const agent = await this.agent(agentId)
      if (!agent || !(await this.canSee(agent, msg.data.channelId))) continue
      let delivery: { id: string }
      try {
        delivery = await this.s.records.create<AgentDeliveryData>(
          AGENT_DELIVERY,
          {
            agentId,
            messageId: msg.id,
            channelId: msg.data.channelId,
            threadId: msg.data.threadId ?? msg.id,
            reason,
            createdAt: this.s.clock.iso(),
          },
          { key: deliveryKey(agentId, msg.id) },
        )
      } catch (err) {
        if (isMpError(err, 'conflict')) continue // already delivered (an edit or a reaction republishes the message)
        throw err
      }
      const out = await this.render(delivery.id, reason, msg, channel?.data.name)
      let pushed = false
      for (const fn of this.listeners) if (await Promise.resolve(fn(agentId, out)).catch(() => false)) pushed = true
      if (pushed) await this.s.records.update<AgentDeliveryData>(AGENT_DELIVERY, delivery.id, { readAt: this.s.clock.iso() })
    }
  }

  /** An author's display name: a contact's name, or an employee's name for its sessions. */
  async authorName(a: ChatAuthor): Promise<string> {
    if (a.kind === 'contact') {
      const c = await this.s.directory.contacts.get(a.id)
      if (c?.data.kind === 'agent') return `${c.data.name} (agent of ${await this.sponsorName(c)})`
      return c?.data.name ?? a.id
    }
    const x = await this.s.sessions.get(a.id)
    if (!x) return a.id
    return `${(await this.s.directory.employees.get(x.data.employeeId))?.data.name ?? 'employee'} (${x.data.slug})`
  }

  private async render(deliveryId: string, reason: DeliveryReason, msg: Message, channelName?: string): Promise<AgentMessage> {
    return {
      deliveryId,
      reason,
      channel: channelName ?? (await this.s.chat.getChannel(msg.data.channelId))?.data.name ?? msg.data.channelId,
      channelId: msg.data.channelId,
      threadId: msg.data.threadId ?? msg.id,
      messageId: msg.id,
      author: await this.authorName(msg.data.author),
      text: msg.data.deleted ? '(deleted)' : msg.data.text,
      at: msg.data.createdAt,
      ...(attachmentsOf(msg.data).length && !msg.data.deleted ? { attachments: attachmentsOf(msg.data) } : {}),
    }
  }

  /**
   * Unread deliveries of an agent, oldest first, marked read. `since` (an ISO time) skips older
   * ones; `more` says whether there are further unread ones.
   */
  async inbox(agent: Contact, q: { since?: string; limit?: number } = {}): Promise<{ messages: AgentMessage[]; more: boolean }> {
    const where: Condition[] = [
      { field: 'agentId', op: 'eq', value: agent.id },
      { field: 'readAt', op: 'exists', value: false },
    ]
    if (q.since) where.push({ field: 'createdAt', op: 'gt', value: q.since })
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
    const page = await this.s.records.query<AgentDeliveryData>(AGENT_DELIVERY, { where, orderBy: { field: 'id' }, limit })
    const messages: AgentMessage[] = []
    const now = this.s.clock.iso()
    for (const d of page.items) {
      await this.s.records.update<AgentDeliveryData>(AGENT_DELIVERY, d.id, { readAt: now })
      const msg = await this.s.chat.getMessage(d.data.messageId)
      if (!msg || !(await this.canSee(agent, d.data.channelId))) continue
      messages.push(await this.render(d.id, d.data.reason, msg))
    }
    return { messages, more: page.total > page.items.length }
  }
}
