import { reply } from '@mp/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LiveHub } from '../src/live.ts'
import { testApp, until, type TestApp } from './helpers.ts'

let t: TestApp & { port: number | null }

beforeAll(async () => {
  t = await testApp({ http: true, script: [reply('Streaming a longer answer to the socket, in several chunks.')] })
})
afterAll(async () => {
  await t.close()
})

function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const messages: any[] = []
  ws.onmessage = (ev) => messages.push(JSON.parse(String(ev.data)))
  const open = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('websocket error'))
  })
  return { ws, messages, open }
}

describe('websocket /ws', () => {
  it('subscribes, and streams run.state, entry.appended and model.delta of a run', async () => {
    const { ws, messages, open } = connect(t.port!)
    await open
    const s = t.a.services
    const routerId = (await s.routerSessionFor())!
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['now', `session:${routerId}`, 'events', 'records:message'] }))
    await until(() => messages.find((m) => m.type === 'subscribed'), 'the subscribe ack')
    expect(messages.find((m) => m.type === 'subscribed').channels).toEqual([
      'now',
      `session:${routerId}`,
      'events',
      'records:message',
    ])
    ws.send(JSON.stringify({ type: 'ping' }))
    await until(() => messages.find((m) => m.type === 'pong'), 'pong')

    const requests = (await s.chat.channelByName('requests'))!
    const post = await fetch(`http://127.0.0.1:${t.port}/api/chat/channels/${requests.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hi over the socket' }),
    })
    expect(post.status).toBe(201)

    const events = () => messages.filter((m) => m.type === 'event')
    await until(
      () => events().find((m) => m.topic === 'run.state' && m.payload.to === 'completed' && m.channel === 'now'),
      'run completed',
    )
    const topics = new Set(events().map((m) => m.topic))
    for (const topic of ['run.state', 'entry.appended', 'model.delta', 'event.ingested', 'record.changed', 'usage.recorded'])
      expect(topics, topic).toContain(topic)

    const state = events().find((m) => m.topic === 'run.state' && m.channel === `session:${routerId}`)
    expect(state.payload).toMatchObject({ sessionId: routerId, run: { kind: 'run', data: { sessionId: routerId } } })
    const entry = events().find((m) => m.topic === 'entry.appended' && m.payload.entry.kind === 'assistant')
    expect(entry).toMatchObject({
      channel: `session:${routerId}`,
      payload: { sessionId: routerId, entry: { content: { text: expect.stringContaining('Streaming') } } },
    })
    const deltas = events().filter((m) => m.topic === 'model.delta' && m.channel === 'now')
    expect(deltas.map((d) => d.payload.content ?? '').join('')).toContain('Streaming a longer answer')
    expect(events().find((m) => m.topic === 'event.ingested').channel).toBe('events')
    expect(events().find((m) => m.topic === 'record.changed').payload.kind).toBe('message')
    expect(typeof events()[0].at).toBe('string')
    // Nothing arrives on channels the socket didn't subscribe to.
    expect(events().every((m) => ['now', `session:${routerId}`, 'events', 'records:message'].includes(m.channel))).toBe(true)

    ws.send(JSON.stringify({ type: 'unsubscribe', channels: ['now'] }))
    ws.send('not json')
    await until(() => messages.find((m) => m.type === 'error'), 'an error message')
    ws.close()
  })

  it('rejects unknown channels', async () => {
    const { ws, messages, open } = connect(t.port!)
    await open
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['nope:x y'] }))
    await until(() => messages.find((m) => m.type === 'error'), 'an error')
    expect(messages.find((m) => m.type === 'error').message).toContain('unknown channels')
    ws.close()
  })
})

describe('slow clients', () => {
  it('drops a socket whose buffer does not drain', async () => {
    const hub = new LiveHub(t.a.services, { maxQueue: 5, maxBuffered: 10 })
    const sent: string[] = []
    let closed: number | undefined
    const socket = {
      raw: { bufferedAmount: 1_000_000 },
      send: (d: string) => void sent.push(d),
      close: (code?: number) => void (closed = code),
    }
    const conn = hub.connect(socket)
    for (let i = 0; i < 10; i++) conn.message(JSON.stringify({ type: 'ping' }))
    expect(closed).toBe(1013)
    expect(sent).toEqual([])
    expect(hub.size).toBe(0)
    hub.close()
  })
})
