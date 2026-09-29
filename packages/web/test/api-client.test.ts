import { channels, createApiClient, createLiveClient, type LiveEvent, type WebSocketLike } from '@mp/api'
import { describe, expect, it } from 'vitest'

class MockSocket implements WebSocketLike {
  static last: MockSocket
  readyState = 0
  sent: string[] = []
  onopen: ((e: unknown) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor(readonly url: string) {
    MockSocket.last = this
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
    this.onclose?.({})
  }
}

describe('@mp/api in the browser build', () => {
  it('fetches through the typed client with a same-origin base url', async () => {
    const calls: string[] = []
    const api = createApiClient({
      baseUrl: '',
      fetch: (async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify({ items: [], paused: false, counts: {} }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const now = await api.now()
    expect(now.paused).toBe(false)
    expect(calls).toEqual(['/api/now'])
  })

  it('resolves a relative ws url against the page and resubscribes after a reconnect', () => {
    const timers: (() => void)[] = []
    const live = createLiveClient({
      url: '/ws',
      WebSocket: MockSocket,
      pingMs: 0,
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {},
    })
    expect(MockSocket.last.url).toBe(`ws://${location.host}/ws`)
    const got: LiveEvent[] = []
    live.subscribe([channels.session('ses_1')], (e) => got.push(e))
    const first = MockSocket.last
    first.readyState = 1
    first.onopen?.({})
    expect(JSON.parse(first.sent[0]!)).toEqual({ type: 'subscribe', channels: ['session:ses_1'] })
    first.onmessage?.({
      data: JSON.stringify({
        type: 'event',
        channel: 'session:ses_1',
        topic: 'model.delta',
        payload: { runId: 'r', sessionId: 'ses_1', content: 'hi' },
        at: '',
      }),
    })
    expect(got).toHaveLength(1)
    first.readyState = 3
    first.onclose?.({})
    expect(live.status).toBe('connecting')
    timers.shift()!()
    const second = MockSocket.last
    expect(second).not.toBe(first)
    second.readyState = 1
    second.onopen?.({})
    expect(JSON.parse(second.sent[0]!)).toEqual({ type: 'subscribe', channels: ['session:ses_1'] })
    live.close()
    expect(live.status).toBe('closed')
  })
})
