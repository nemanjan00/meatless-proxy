import { describe, expect, it } from 'vitest'
import { type LiveEvent, type LiveStatus, type WebSocketLike, channels, channelsFor, createLiveClient } from '../src/index.ts'

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  sent: unknown[] = []
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  closedWith: number | undefined
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code?: number) {
    this.closedWith = code
    this.readyState = 3
    this.onclose?.({})
  }
  // test helpers
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  drop() {
    this.readyState = 3
    this.onclose?.({})
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) })
  }
}

function fakeTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = []
  let next = 1
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++
      pending.push({ fn, ms, id })
      return id
    },
    clearTimeout: (id: unknown) => {
      const i = pending.findIndex((p) => p.id === id)
      if (i >= 0) pending.splice(i, 1)
    },
    /** Runs the earliest-scheduled timer with this delay (or any). */
    run(ms?: number) {
      const i = pending.findIndex((p) => ms === undefined || p.ms === ms)
      if (i < 0) throw new Error(`no timer ${ms}`)
      const [t] = pending.splice(i, 1)
      t!.fn()
    },
  }
}

function setup(opts: { pingMs?: number } = {}) {
  FakeSocket.all = []
  const timers = fakeTimers()
  const errors: string[] = []
  const live = createLiveClient({
    url: 'ws://example.com/ws',
    WebSocket: FakeSocket,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    minDelayMs: 100,
    maxDelayMs: 400,
    pingMs: opts.pingMs ?? 0,
    onError: (m) => errors.push(m),
  })
  return { live, timers, errors, sock: () => FakeSocket.all.at(-1)! }
}

const ev = (
  channel: string,
  topic = 'model.delta',
  payload: unknown = { runId: 'run_1', sessionId: 'ses_1', content: 'hi' },
) => ({
  type: 'event',
  channel,
  topic,
  payload,
  at: '2026-09-29T10:00:00.000Z',
})

describe('createLiveClient', () => {
  it('connects and reports status', () => {
    const { live, sock } = setup()
    const seen: LiveStatus[] = []
    live.onStatus((s) => seen.push(s))
    expect(sock().url).toBe('ws://example.com/ws')
    sock().open()
    expect(live.status).toBe('open')
    expect(seen).toEqual(['connecting', 'open'])
  })

  it('subscribes once per channel and routes events to matching handlers', () => {
    const { live, sock } = setup()
    sock().open()
    const a: LiveEvent[] = []
    const b: LiveEvent[] = []
    const offA = live.subscribe([channels.session('ses_1'), channels.now], (e) => a.push(e))
    live.subscribe([channels.session('ses_1')], (e) => b.push(e))
    expect(sock().sent).toEqual([{ type: 'subscribe', channels: ['session:ses_1', 'now'] }])

    sock().receive(ev('session:ses_1'))
    sock().receive(ev('now'))
    sock().receive(ev('run:run_9'))
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(1)

    offA()
    offA() // idempotent
    expect(sock().sent.at(-1)).toEqual({ type: 'unsubscribe', channels: ['now'] })
    sock().receive(ev('session:ses_1'))
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
  })

  it('queues subscriptions made before the socket opens and sends them on open', () => {
    const { live, sock } = setup()
    live.subscribe([channels.chat('chn_1')], () => {})
    expect(sock().sent).toEqual([])
    sock().open()
    expect(sock().sent).toEqual([{ type: 'subscribe', channels: ['chat:chn_1'] }])
  })

  it('reconnects with backoff and resubscribes', () => {
    const { live, sock, timers } = setup()
    sock().open()
    live.subscribe([channels.now, channels.run('run_1')], () => {})
    const first = sock()
    first.drop()
    expect(live.status).toBe('connecting')
    expect(timers.pending.map((t) => t.ms)).toEqual([100])
    timers.run(100)
    const second = sock()
    expect(second).not.toBe(first)
    second.drop() // fails before opening: backoff doubles
    expect(timers.pending.map((t) => t.ms)).toEqual([200])
    timers.run(200)
    sock().drop()
    timers.run(400)
    sock().drop()
    expect(timers.pending.map((t) => t.ms)).toEqual([400]) // capped
    timers.run(400)
    sock().open()
    expect(live.status).toBe('open')
    expect(sock().sent).toEqual([{ type: 'subscribe', channels: ['now', 'run:run_1'] }])
    // backoff resets after a successful open
    sock().drop()
    expect(timers.pending.map((t) => t.ms)).toEqual([100])
  })

  it('ignores messages from a replaced socket', () => {
    const { live, sock, timers } = setup()
    sock().open()
    const got: LiveEvent[] = []
    live.subscribe([channels.now], (e) => got.push(e))
    const old = sock()
    old.drop()
    timers.run()
    old.receive(ev('now'))
    expect(got).toHaveLength(0)
  })

  it('reports unparsable and error messages', () => {
    const { sock, errors } = setup()
    sock().open()
    sock().receive('not json')
    sock().receive({ type: 'error', message: 'unknown channel' })
    expect(errors).toEqual(['unparsable message', 'unknown channel'])
  })

  it('pings on an interval', () => {
    const { sock, timers } = setup({ pingMs: 1000 })
    sock().open()
    timers.run(1000)
    timers.run(1000)
    expect(sock().sent).toEqual([{ type: 'ping' }, { type: 'ping' }])
  })

  it('stops reconnecting after close', () => {
    const { live, sock, timers } = setup({ pingMs: 1000 })
    sock().open()
    live.close()
    expect(live.status).toBe('closed')
    expect(sock().closedWith).toBe(1000)
    expect(timers.pending).toHaveLength(0)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('throws without a WebSocket implementation', () => {
    const g = globalThis as { WebSocket?: unknown }
    const saved = g.WebSocket
    g.WebSocket = undefined
    try {
      expect(() => createLiveClient({ url: 'ws://example.com/ws' })).toThrow(/WebSocket/)
    } finally {
      g.WebSocket = saved
    }
  })
})

describe('channelsFor', () => {
  it('fans run events out to now, session and run', () => {
    expect(channelsFor('model.delta', { runId: 'run_1', sessionId: 'ses_1', content: 'x' })).toEqual([
      'now',
      'session:ses_1',
      'run:run_1',
    ])
  })
  it('sends entries to session and run only', () => {
    const entry = { id: 'ent_1', parent: null, kind: 'user', content: { text: 'x' }, hash: 'h', meta: {}, createdAt: '' }
    expect(channelsFor('entry.appended', { sessionId: 'ses_1', runId: 'run_1', entry })).toEqual(['session:ses_1', 'run:run_1'])
    expect(channelsFor('entry.appended', { sessionId: 'ses_1', entry })).toEqual(['session:ses_1'])
  })
  it('routes records, links, chat, events and control', () => {
    expect(
      channelsFor('record.changed', {
        kind: 'contact',
        id: 'con_1',
        version: 2,
        op: 'update',
        actor: { type: 'system', id: 'system' },
      }),
    ).toEqual(['records:contact'])
    expect(
      channelsFor('link.changed', {
        id: 'lnk_1',
        from: { kind: 'session', id: 's' },
        to: { kind: 'session', id: 't' },
        role: 'related',
        op: 'link',
      }),
    ).toEqual(['records:session'])
    expect(channelsFor('event.ingested', { event: {} as never })).toEqual(['events'])
    expect(channelsFor('chat.message', { channelId: 'chn_1', message: {} as never })).toEqual(['chat:chn_1'])
    expect(channelsFor('control.changed', { paused: true })).toEqual(['now'])
  })
})
