import {
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
  'event.ingested',
  'event.routed',
  'control.changed',
] as const

export interface LiveHubOptions {
  /** Messages queued per socket before it is dropped as too slow. Default 500. */
  maxQueue?: number
  /** Bytes buffered by the socket before we stop sending and queue. Default 1 MiB. */
  maxBuffered?: number
}

const CHANNEL_RE = /^(now|events|(session|run|chat|records):[A-Za-z0-9_.:-]+)$/

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

  constructor(
    private s: Services,
    opts: LiveHubOptions = {},
  ) {
    this.maxQueue = opts.maxQueue ?? 500
    this.maxBuffered = opts.maxBuffered ?? 1024 * 1024
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

  /** Registers a socket. Returns the handlers to call for its messages and its close. */
  connect(socket: LiveSocket): { message(data: unknown): void; close(): void } {
    const client: Client = { socket, channels: new Set(), queue: [], closed: false }
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
      for (const c of chans) {
        if (!CHANNEL_RE.test(c)) continue
        if (msg.type === 'subscribe') client.channels.add(c)
        else client.channels.delete(c)
      }
      if (msg.type === 'subscribe') this.send(client, { type: 'subscribed', channels: [...client.channels] })
      return
    }
    this.send(client, { type: 'error', message: `unknown message type ${(msg as { type?: unknown }).type}` })
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
    const built = await this.payload(m)
    if (!built) return
    const chans: LiveChannel[] =
      built.topic === 'event.routed' ? ['events'] : channelsFor(built.topic as LiveTopic, built.payload as never)
    if (!chans.length) return
    const at = new Date(m.at).toISOString()
    for (const client of this.clients) {
      for (const channel of chans) {
        if (!client.channels.has(channel)) continue
        this.send(client, { type: 'event', channel, topic: built.topic, payload: built.payload, at } as LiveServerMessage)
      }
    }
  }
}
