import {
  type InboxItem,
  channelsFor,
  type ApiEntry,
  type LiveChannel,
  type LiveClientMessage,
  type LiveServerMessage,
  type LiveTopic,
  type NowItem,
} from '@mp/api'
import type { Checklist } from '@mp/checklists'
import { errorMessage, type BusMessage } from '@mp/core'
import type { Message } from '@mp/chat'
import type { Run } from '@mp/sessions'
import type { Services } from './services.ts'
import { ChatVisibility } from './auth/visibility.ts'
import { INBOX_READ_TOPIC, type InboxViewer, PersonInbox } from './inbox.ts'
import { Views, mapChecklist, mapEvent } from './http/views.ts'

/** What the Now page shows about a live run beyond its record (see `NowItem`). */
export interface RunActivity {
  step: NowItem['step']
  recentTools: NowItem['recentTools']
  streaming: { content: string; reasoning: string }
}

const MAX_STREAM = 8000
const MAX_TOOLS = 10

/** Follows the bus to know what each live run is doing right now. */
export class NowTracker {
  private runs = new Map<string, RunActivity>()
  private offs: (() => void)[] = []

  constructor(s: Services) {
    const bus = s.bus
    const at = (m: BusMessage) => new Date(m.at).toISOString()
    this.offs.push(
      bus.subscribe<{ runId: string; content?: string; reasoning?: string }>('model.delta', (m) => {
        const a = this.get(m.payload.runId, at(m))
        if (a.step.kind !== 'model') a.step = { kind: 'model', label: 'thinking', since: at(m) }
        if (m.payload.content) a.streaming.content = (a.streaming.content + m.payload.content).slice(-MAX_STREAM)
        if (m.payload.reasoning) a.streaming.reasoning = (a.streaming.reasoning + m.payload.reasoning).slice(-MAX_STREAM)
      }),
      bus.subscribe<{ runId: string; name: string }>('tool.called', (m) => {
        const a = this.get(m.payload.runId, at(m))
        a.step = { kind: 'tool', label: m.payload.name, since: at(m) }
        a.streaming = { content: '', reasoning: '' }
        a.recentTools.push({ name: m.payload.name, at: at(m) })
        if (a.recentTools.length > MAX_TOOLS) a.recentTools.shift()
      }),
      bus.subscribe<{ runId: string; name: string; isError: boolean }>('tool.result', (m) => {
        const a = this.get(m.payload.runId, at(m))
        const last = [...a.recentTools].reverse().find((t) => t.name === m.payload.name)
        if (last && m.payload.isError) last.isError = true
        a.step = { kind: 'model', label: 'thinking', since: at(m) }
      }),
      bus.subscribe<{ runId: string; to: string }>('run.state', (m) => {
        if (['completed', 'failed', 'cancelled'].includes(m.payload.to)) this.runs.delete(m.payload.runId)
        else if (m.payload.to !== 'running') this.runs.delete(m.payload.runId)
      }),
    )
  }

  private get(runId: string, since: string): RunActivity {
    let a = this.runs.get(runId)
    if (!a) {
      a = { step: { kind: 'model', label: 'thinking', since }, recentTools: [], streaming: { content: '', reasoning: '' } }
      this.runs.set(runId, a)
    }
    return a
  }

  activity(runId: string): RunActivity | undefined {
    return this.runs.get(runId)
  }

  close() {
    for (const off of this.offs) off()
  }
}

/** The part of a socket the hub needs (hono's `WSContext` fits). */
export interface LiveSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly raw?: unknown
}

interface Client {
  socket: LiveSocket
  /** The signed-in contact: DMs they aren't in are never sent to them. Unset: no filtering (in-process use). */
  contactId?: string
  /** Whether they are an admin (their inbox also has paused runs nobody asked for). */
  admin?: boolean
  /** Inbox item ids already sent on `person:` (edits and reactions republish a message; it toasts once). */
  sentItems: Set<string>
  channels: Set<LiveChannel>
  queue: string[]
  closed: boolean
}

/** Bus topics forwarded to live clients. */
export const LIVE_TOPICS = [
  'record.changed',
  'link.changed',
  'entry.appended',
  'run.state',
  'session.head',
  'step.started',
  'model.delta',
  'tool.called',
  'tool.result',
  'usage.recorded',
  'checklist.changed',
  'chat.message',
  'chat.activity',
  'chat.activity.done',
  'event.ingested',
  'event.routed',
  'control.changed',
  'preview.commit',
  INBOX_READ_TOPIC,
] as const

export interface LiveHubOptions {
  /** Messages queued per socket before it is dropped as too slow. Default 500. */
  maxQueue?: number
  /** Bytes buffered by the socket before we stop sending and queue. Default 1 MiB. */
  maxBuffered?: number
}

const CHANNEL_RE = /^(now|events|(session|run|chat|records|person):[A-Za-z0-9_.:-]+)$/
/** A new chat message or run state older than this isn't news (a reaction republishes an old message). */
const FRESH_MS = 2 * 60_000
/** Inbox item ids remembered per socket. */
const MAX_SENT_ITEMS = 500
/** Record kinds that can belong to a DM. */
const CHAT_RECORD_KINDS = new Set(['channel', 'message', 'event'])

/**
 * The WebSocket fan-out: turns bus messages into `@mp/api` live events and
 * sends them to the sockets subscribed to their channels. Messages are
 * processed in order. A socket that can't keep up is closed (1013).
 */
export class LiveHub {
  private clients = new Set<Client>()
  private offs: (() => void)[] = []
  private chain: Promise<void> = Promise.resolve()
  private maxQueue: number
  private maxBuffered: number
  private visibility: ChatVisibility
  private inbox: PersonInbox
  /** `contact:channel` → whether they may see it, briefly cached (one lookup per event and client otherwise). */
  private seen = new Map<string, { at: number; ok: boolean }>()

  constructor(
    private s: Services,
    opts: LiveHubOptions = {},
  ) {
    this.maxQueue = opts.maxQueue ?? 500
    this.maxBuffered = opts.maxBuffered ?? 1024 * 1024
    this.visibility = new ChatVisibility(s)
    this.inbox = new PersonInbox(s, this.visibility)
    for (const topic of LIVE_TOPICS) {
      this.offs.push(
        s.bus.subscribe(topic, (m) => {
          if (!this.clients.size) return
          this.chain = this.chain.then(() =>
            this.forward(m).catch((err) => s.logger.debug('live event dropped', { topic, err: errorMessage(err) })),
          )
        }),
      )
    }
  }

  get size() {
    return this.clients.size
  }

  /**
   * Registers a socket, for the signed-in `viewer` (whose DMs filter what it gets). Returns the
   * handlers to call for its messages and its close.
   */
  connect(socket: LiveSocket, viewer?: InboxViewer): { message(data: unknown): void; close(): void } {
    const client: Client = {
      socket,
      channels: new Set(),
      queue: [],
      closed: false,
      sentItems: new Set(),
      ...(viewer ? { contactId: viewer.contactId, ...(viewer.admin ? { admin: true } : {}) } : {}),
    }
    this.clients.add(client)
    return {
      message: (data) => this.onMessage(client, data),
      close: () => {
        client.closed = true
        this.clients.delete(client)
      },
    }
  }

  /** Resolves once every bus message received so far was forwarded. */
  flush(): Promise<void> {
    return this.chain
  }

  close() {
    for (const off of this.offs) off()
    for (const c of this.clients) c.socket.close(1001, 'server shutting down')
    this.clients.clear()
  }

  private onMessage(client: Client, data: unknown) {
    let msg: LiveClientMessage
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data)) as LiveClientMessage
    } catch {
      return this.send(client, { type: 'error', message: 'unparsable message' })
    }
    if (msg.type === 'ping') return this.send(client, { type: 'pong' })
    if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
      const chans = Array.isArray(msg.channels) ? msg.channels.filter((c) => typeof c === 'string') : []
      const bad = chans.filter((c) => !CHANNEL_RE.test(c))
      if (bad.length) this.send(client, { type: 'error', message: `unknown channels: ${bad.join(', ')}` })
      if (msg.type === 'unsubscribe') {
        for (const c of chans) client.channels.delete(c as LiveChannel)
        return
      }
      this.chain = this.chain.then(() =>
        this.subscribe(client, chans.filter((c) => CHANNEL_RE.test(c)) as LiveChannel[]).catch((err) => {
          this.s.logger.warn('live subscribe failed', { err: errorMessage(err) })
          this.send(client, { type: 'error', message: 'subscribe failed' })
        }),
      )
      return
    }
    this.send(client, { type: 'error', message: `unknown message type ${(msg as { type?: unknown }).type}` })
  }

  /**
   * Subscribes, except to DMs the client isn't in and to someone else's `person:` channel
   * (answered like unknown channels, so they stay private).
   */
  private async subscribe(client: Client, chans: LiveChannel[]) {
    const refused: string[] = []
    for (const c of chans) {
      const chat = c.startsWith('chat:') ? c.slice(5) : null
      const person = c.startsWith('person:') ? c.slice(7) : null
      if (chat && !(await this.maySee(client, chat))) refused.push(c)
      else if (person !== null && (!client.contactId || person !== client.contactId)) refused.push(c)
      else client.channels.add(c)
    }
    if (refused.length) this.send(client, { type: 'error', message: `unknown channels: ${refused.join(', ')}` })
    this.send(client, { type: 'subscribed', channels: [...client.channels] })
  }

  private async maySee(client: Client, channelId: string): Promise<boolean> {
    if (!client.contactId) return true
    const key = `${client.contactId}:${channelId}`
    const hit = this.seen.get(key)
    const now = this.s.clock.now()
    if (hit && now - hit.at < 5000) return hit.ok
    const ok = await this.visibility.canSeeChannel(client.contactId, channelId)
    if (this.seen.size > 10_000) this.seen.clear()
    this.seen.set(key, { at: now, ok })
    return ok
  }

  /** The chat channel a live event is about (to hide DMs from non-members), if any. */
  private async chatChannelOf(topic: string, payload: Record<string, any>): Promise<string | null | undefined> {
    if (topic === 'chat.message' || topic === 'chat.activity' || topic === 'chat.activity.done') return payload.channelId
    if (topic === 'event.ingested') {
      const e = payload.event as { data?: { source?: string; payload?: { channelId?: unknown } } } | undefined
      return e?.data?.source === 'chat' && typeof e.data.payload?.channelId === 'string' ? e.data.payload.channelId : null
    }
    if (topic === 'record.changed' && CHAT_RECORD_KINDS.has(payload.kind)) {
      if (payload.kind === 'channel') return payload.id
      const r = await this.s.records.get(payload.kind, payload.id)
      // A chat record we can't place is dropped rather than risk showing a DM.
      if (!r) return undefined
      return this.visibility.channelOfRecord(r)
    }
    if (topic === 'link.changed') {
      const from = payload.from as { kind?: string; id?: string } | undefined
      return from?.kind === 'channel' ? (from.id ?? null) : null
    }
    return null
  }

  private send(client: Client, msg: LiveServerMessage) {
    if (client.closed) return
    client.queue.push(JSON.stringify(msg))
    this.drain(client)
  }

  private buffered(client: Client): number {
    const raw = client.socket.raw as { bufferedAmount?: number } | undefined
    return typeof raw?.bufferedAmount === 'number' ? raw.bufferedAmount : 0
  }

  private drain(client: Client) {
    while (client.queue.length && this.buffered(client) < this.maxBuffered) {
      try {
        client.socket.send(client.queue.shift()!)
      } catch {
        client.closed = true
        this.clients.delete(client)
        return
      }
    }
    if (client.queue.length > this.maxQueue) {
      client.closed = true
      this.clients.delete(client)
      client.socket.close(1013, 'too slow: live updates dropped')
      return
    }
    if (client.queue.length) setTimeout(() => this.drain(client), 50)
  }

  /** Builds the API payload of a bus message, or null to drop it. */
  private async payload(m: BusMessage): Promise<{ topic: string; payload: Record<string, unknown> } | null> {
    const p = m.payload as Record<string, any>
    const views = new Views(this.s)
    switch (m.topic) {
      case 'entry.appended': {
        const entry = await this.s.store.entries.get(p.id)
        if (!entry) return null
        const sessionId = typeof entry.meta.sessionId === 'string' ? entry.meta.sessionId : undefined
        if (!sessionId) return null
        const runId = typeof entry.meta.runId === 'string' ? entry.meta.runId : undefined
        return { topic: m.topic, payload: { sessionId, ...(runId ? { runId } : {}), entry: entry as ApiEntry } }
      }
      case 'run.state': {
        const run = (await this.s.sessions.getRun(p.runId)) as Run | null
        if (!run) return null
        return { topic: m.topic, payload: { ...p, run } }
      }
      case 'checklist.changed': {
        const c = await this.s.records.get<Checklist['data']>('checklist', p.checklistId)
        if (!c) return null
        return { topic: m.topic, payload: { sessionId: p.sessionId, checklist: mapChecklist(c as Checklist) } }
      }
      case 'chat.message': {
        const msg = await this.s.chat.getMessage(p.messageId)
        if (!msg) return null
        return { topic: m.topic, payload: { channelId: p.channelId, message: await views.message(msg as Message) } }
      }
      case 'event.ingested': {
        if (p.created === false) return null
        const e = await this.s.rawEvents.get(p.eventId)
        if (!e) return null
        return { topic: m.topic, payload: { event: mapEvent(e) } }
      }
      case 'usage.recorded': {
        // The usage ledger's message (with cost); the runner's raw one is dropped.
        if (typeof p.id !== 'string' || typeof p.promptTokens !== 'number') return null
        return {
          topic: m.topic,
          payload: {
            runId: p.runId,
            sessionId: p.sessionId,
            employeeId: p.employeeId,
            model: p.model,
            usage: {
              input: p.promptTokens,
              output: p.completionTokens,
              cached: p.cachedTokens ?? 0,
              ...(p.reasoningTokens ? { reasoning: p.reasoningTokens } : {}),
            },
            cost: p.costUsd ?? 0,
          },
        }
      }
      case 'tool.called':
        return { topic: m.topic, payload: { callId: '', args: null, ...p } }
      case 'tool.result':
        return { topic: m.topic, payload: { callId: '', ...p } }
      default:
        return { topic: m.topic, payload: p }
    }
  }

  private async forward(m: BusMessage) {
    if (m.topic === 'chat.message' || m.topic === 'run.state') await this.notify(m)
    const built = await this.payload(m)
    if (!built) return
    const chans: LiveChannel[] =
      built.topic === 'event.routed' ? ['events'] : channelsFor(built.topic as LiveTopic, built.payload as never)
    if (!chans.length) return
    const at = new Date(m.at).toISOString()
    const chat = await this.chatChannelOf(built.topic, built.payload)
    for (const client of this.clients) {
      if (client.contactId && chat !== null && (chat === undefined || !(await this.maySee(client, chat)))) continue
      for (const channel of chans) {
        if (!client.channels.has(channel)) continue
        this.send(client, { type: 'event', channel, topic: built.topic, payload: built.payload, at } as LiveServerMessage)
      }
    }
  }

  /**
   * A new message or run state that is an inbox item for someone on their `person:` channel is
   * sent to them as `inbox.item`, with the inbox's own rule (`PersonInbox.itemFor*`), once per socket.
   */
  private async notify(m: BusMessage) {
    const listening = [...this.clients].filter((c) => c.contactId && c.channels.has(`person:${c.contactId}`))
    if (!listening.length) return
    const p = m.payload as { messageId?: string; runId?: string; to?: string }
    const views = new Views(this.s)
    const now = this.s.clock.now()
    let find: (viewer: InboxViewer) => Promise<InboxItem | null>
    if (m.topic === 'chat.message') {
      const msg = typeof p.messageId === 'string' ? await this.s.chat.getMessage(p.messageId) : null
      if (!msg || now - Date.parse(msg.data.createdAt) > FRESH_MS) return
      find = (viewer) => this.inbox.itemForMessage(msg, viewer, views)
    } else {
      if (p.to !== 'paused' && p.to !== 'suspended') return
      const run = typeof p.runId === 'string' ? ((await this.s.sessions.getRun(p.runId)) as Run | null) : null
      if (!run) return
      find = (viewer) => this.inbox.itemForRun(run, viewer, views)
    }
    const at = new Date(m.at).toISOString()
    const byPerson = new Map<string, Promise<InboxItem | null>>()
    for (const client of listening) {
      const contactId = client.contactId!
      const key = `${contactId}:${client.admin ? 1 : 0}`
      if (!byPerson.has(key)) byPerson.set(key, find({ contactId, admin: !!client.admin }))
      const item = await byPerson.get(key)!
      if (!item || item.read || client.sentItems.has(item.id)) continue
      client.sentItems.add(item.id)
      if (client.sentItems.size > MAX_SENT_ITEMS) client.sentItems.delete(client.sentItems.values().next().value!)
      const channel = `person:${contactId}` as LiveChannel
      this.send(client, { type: 'event', channel, topic: 'inbox.item', payload: { contactId, item }, at })
    }
  }
}
