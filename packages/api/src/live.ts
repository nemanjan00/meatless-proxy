import type { ApiActor, ApiEntry, ApiEvent, Checklist, InboxItem, Json, Message, Run, RunState, TokenUsage } from './resources.ts'

/**
 * The live-update protocol on the WebSocket at `/ws`.
 *
 * The client loads current state over HTTP, subscribes to channels, then
 * applies the events it receives. Messages are JSON text frames.
 *
 * Channels:
 * - `now`: everything the Now page shows (run states, steps, deltas, tool calls, usage, checklists)
 * - `session:<sessionId>`: entries, run states, deltas, tool calls, usage and checklist of one session
 * - `run:<runId>`: the same, for one run
 * - `chat:<channelId>`: messages in a channel (including thread replies)
 * - `records:<kind>`: record changes of one kind
 * - `events`: newly ingested events
 * - `person:<contactId>`: your new inbox items and read marks (only you may subscribe to yours)
 */
export type LiveChannel =
  | 'now'
  | 'events'
  | `session:${string}`
  | `run:${string}`
  | `chat:${string}`
  | `records:${string}`
  | `person:${string}`

/** Channel name helpers. */
export const channels = {
  now: 'now' as const,
  events: 'events' as const,
  session: (id: string) => `session:${id}` as const,
  run: (id: string) => `run:${id}` as const,
  chat: (channelId: string) => `chat:${channelId}` as const,
  records: (kind: string) => `records:${kind}` as const,
  person: (contactId: string) => `person:${contactId}` as const,
}

/** Payload per topic. Every run-related payload carries `runId` and `sessionId`. */
export interface LiveTopics {
  /** A record was created, updated or deleted. */
  'record.changed': { kind: string; id: string; version: number; op: 'create' | 'update' | 'delete'; actor: ApiActor }
  /** A link was added, changed or removed. */
  'link.changed': {
    id: string
    from: { kind: string; id: string }
    to: { kind: string; id: string }
    role: string
    op: 'link' | 'update' | 'unlink'
  }
  /** An entry was appended to a session's tree (by a run, or by a commit/rewind). */
  'entry.appended': { sessionId: string; runId?: string; entry: ApiEntry }
  /** A run changed state. `run` is the run after the change. */
  'run.state': { runId: string; sessionId: string; employeeId: string; from: RunState; to: RunState; run: Run }
  /** The session's head moved (commit). */
  'session.head': { sessionId: string; from: string | null; to: string | null; runId?: string }
  /** A step started: a model call or a tool call. */
  'step.started': { runId: string; sessionId: string; step: number; kind: 'model' | 'tool'; name?: string }
  /** Streamed model output. `content` and `reasoning` are the new text since the last delta. */
  'model.delta': { runId: string; sessionId: string; content?: string; reasoning?: string }
  /** A tool call was made. `args` are already redacted. */
  'tool.called': { runId: string; sessionId: string; callId: string; name: string; args: Json }
  /** A tool call finished. */
  'tool.result': { runId: string; sessionId: string; callId: string; name: string; isError: boolean }
  /** A model call's usage was recorded. */
  'usage.recorded': { runId: string; sessionId: string; employeeId: string; model: string; usage: TokenUsage; cost: number }
  /** A session's checklist changed. */
  'checklist.changed': { sessionId: string; checklist: Checklist }
  /** A chat message was posted (top-level or reply). */
  'chat.message': { channelId: string; message: Message }
  /** An event was stored. */
  'event.ingested': { event: ApiEvent }
  /** The commit a session's environment runs changed (a live preview should reload). */
  'preview.commit': { sessionId: string; envId: string; sha: string; subject?: string; repo?: string }
  /** The global pause flag changed. */
  'control.changed': { paused: boolean }
  /** Something just became an inbox item for this person (the shape of `GET /api/inbox`). */
  'inbox.item': { contactId: string; item: InboxItem }
  /** This person marked items read (`ids`) or cleared their inbox (`clear`), on any device. */
  'inbox.read': { contactId: string; ids?: string[]; clear?: boolean }
}

export type LiveTopic = keyof LiveTopics

/** A server → client event. `channel` is the subscribed channel it was delivered on. */
export type LiveEvent<K extends LiveTopic = LiveTopic> = {
  [T in K]: { type: 'event'; channel: LiveChannel; topic: T; payload: LiveTopics[T]; at: string }
}[K]

/** Client → server. */
export type LiveClientMessage =
  | { type: 'subscribe'; channels: LiveChannel[] }
  | { type: 'unsubscribe'; channels: LiveChannel[] }
  | { type: 'ping' }

/** Server → client. */
export type LiveServerMessage =
  | LiveEvent
  /** Acknowledges a subscribe with the channels now active for this socket. */
  | { type: 'subscribed'; channels: LiveChannel[] }
  | { type: 'pong' }
  | { type: 'error'; message: string }

/**
 * Which channels a bus event is forwarded to. The server uses this to fan out
 * bus events, the mock uses it to emit the same way.
 */
export function channelsFor<T extends LiveTopic>(topic: T, payload: LiveTopics[T]): LiveChannel[] {
  const p = payload as Record<string, unknown>
  const out: LiveChannel[] = []
  const runId = typeof p.runId === 'string' ? p.runId : undefined
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined
  switch (topic) {
    case 'record.changed':
    case 'link.changed': {
      const kinds =
        topic === 'record.changed'
          ? [(p as LiveTopics['record.changed']).kind]
          : [(p as LiveTopics['link.changed']).from.kind, (p as LiveTopics['link.changed']).to.kind]
      for (const k of new Set(kinds)) out.push(channels.records(k))
      return out
    }
    case 'chat.message':
      return [channels.chat((p as LiveTopics['chat.message']).channelId)]
    case 'event.ingested':
      return [channels.events]
    case 'control.changed':
      return [channels.now]
    case 'inbox.item':
    case 'inbox.read':
      return [channels.person((p as LiveTopics['inbox.read']).contactId)]
    case 'entry.appended':
    case 'session.head':
      if (sessionId) out.push(channels.session(sessionId))
      if (runId) out.push(channels.run(runId))
      return out
    default:
      // run.state, step.started, model.delta, tool.*, usage.recorded, checklist.changed
      out.push(channels.now)
      if (sessionId) out.push(channels.session(sessionId))
      if (runId) out.push(channels.run(runId))
      return out
  }
}

export type LiveStatus = 'connecting' | 'open' | 'closed'

export type LiveHandler = (event: LiveEvent) => void

/**
 * What the UI needs from a live connection. `createLiveClient` implements it
 * over a WebSocket, and a mock can implement it in memory.
 */
export interface LiveSource {
  /** Subscribes to channels; the handler gets events from any of them. Returns an unsubscribe function. */
  subscribe(chans: LiveChannel[], handler: LiveHandler): () => void
  /** Called with the current status, then on every change. Returns an unsubscribe function. */
  onStatus(handler: (status: LiveStatus) => void): () => void
  readonly status: LiveStatus
  close(): void
}

/** The part of the WebSocket API the client uses (browser `WebSocket` and `ws` both fit). */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export type WebSocketFactory = new (url: string) => WebSocketLike

export interface LiveClientOptions {
  /** e.g. `ws://localhost:3000/ws`, or a path like `/ws` (resolved against `location` in a browser). */
  url: string
  /** Defaults to the global `WebSocket`. */
  WebSocket?: WebSocketFactory
  /** Reconnect backoff: starts at `minDelayMs`, doubles up to `maxDelayMs`. Defaults 500 and 10 000. */
  minDelayMs?: number
  maxDelayMs?: number
  /** Ping interval to keep the socket alive; 0 disables. Default 25 000. */
  pingMs?: number
  /** Injectable timers (tests). */
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** Called with protocol errors and unparsable messages. */
  onError?: (message: string) => void
}

const OPEN = 1

function resolveUrl(url: string): string {
  if (/^wss?:\/\//.test(url)) return url
  const loc = (globalThis as { location?: { protocol: string; host: string } }).location
  if (!loc) return url
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${url.startsWith('/') ? '' : '/'}${url}`
}

/**
 * A WebSocket client with reference-counted channel subscriptions, automatic
 * reconnect with backoff, and resubscription after every reconnect.
 */
export function createLiveClient(opts: LiveClientOptions): LiveSource {
  const WS = opts.WebSocket ?? (globalThis as unknown as { WebSocket?: WebSocketFactory }).WebSocket
  if (!WS) throw new Error('no WebSocket implementation available')
  const setT = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clearT = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>))
  const minDelay = opts.minDelayMs ?? 500
  const maxDelay = opts.maxDelayMs ?? 10_000
  const pingMs = opts.pingMs ?? 25_000
  const url = resolveUrl(opts.url)

  const refs = new Map<LiveChannel, number>()
  const handlers = new Set<{ chans: Set<LiveChannel>; fn: LiveHandler }>()
  const statusHandlers = new Set<(s: LiveStatus) => void>()
  let status: LiveStatus = 'connecting'
  let socket: WebSocketLike | null = null
  let closed = false
  let delay = minDelay
  let reconnectTimer: unknown = null
  let pingTimer: unknown = null

  const setStatus = (s: LiveStatus) => {
    if (s === status) return
    status = s
    for (const h of statusHandlers) h(s)
  }

  const send = (msg: LiveClientMessage) => {
    if (socket && socket.readyState === OPEN) socket.send(JSON.stringify(msg))
  }

  const schedulePing = () => {
    if (!pingMs) return
    pingTimer = setT(() => {
      send({ type: 'ping' })
      schedulePing()
    }, pingMs)
  }

  const connect = () => {
    if (closed) return
    setStatus('connecting')
    const ws = new WS(url)
    socket = ws
    ws.onopen = () => {
      if (socket !== ws) return
      delay = minDelay
      setStatus('open')
      const active = [...refs.keys()]
      if (active.length) send({ type: 'subscribe', channels: active })
      schedulePing()
    }
    ws.onmessage = (ev) => {
      if (socket !== ws) return
      let msg: LiveServerMessage
      try {
        msg = JSON.parse(String(ev.data)) as LiveServerMessage
      } catch {
        opts.onError?.('unparsable message')
        return
      }
      if (msg.type === 'error') opts.onError?.(msg.message)
      if (msg.type !== 'event') return
      for (const h of [...handlers]) if (h.chans.has(msg.channel)) h.fn(msg)
    }
    ws.onerror = () => {
      // onclose follows and handles reconnecting.
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      if (pingTimer !== null) clearT(pingTimer)
      pingTimer = null
      if (closed) {
        setStatus('closed')
        return
      }
      setStatus('connecting')
      reconnectTimer = setT(() => {
        reconnectTimer = null
        connect()
      }, delay)
      delay = Math.min(delay * 2, maxDelay)
    }
  }

  connect()

  return {
    get status() {
      return status
    },
    subscribe(chans, fn) {
      const entry = { chans: new Set(chans), fn }
      handlers.add(entry)
      const fresh: LiveChannel[] = []
      for (const c of entry.chans) {
        const n = refs.get(c) ?? 0
        refs.set(c, n + 1)
        if (n === 0) fresh.push(c)
      }
      if (fresh.length) send({ type: 'subscribe', channels: fresh })
      let done = false
      return () => {
        if (done) return
        done = true
        handlers.delete(entry)
        const gone: LiveChannel[] = []
        for (const c of entry.chans) {
          const n = (refs.get(c) ?? 1) - 1
          if (n <= 0) {
            refs.delete(c)
            gone.push(c)
          } else refs.set(c, n)
        }
        if (gone.length) send({ type: 'unsubscribe', channels: gone })
      }
    },
    onStatus(fn) {
      statusHandlers.add(fn)
      fn(status)
      return () => statusHandlers.delete(fn)
    },
    close() {
      closed = true
      if (reconnectTimer !== null) clearT(reconnectTimer)
      if (pingTimer !== null) clearT(pingTimer)
      reconnectTimer = null
      pingTimer = null
      const ws = socket
      socket = null
      ws?.close(1000, 'client closed')
      setStatus('closed')
    },
  }
}
