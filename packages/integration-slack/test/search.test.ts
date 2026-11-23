import { ManualClock } from '@mp/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSlackIntegration } from '../src/index.ts'
import { type FakeSlack, startFakeSlack, TOKEN } from './fake-slack.ts'

let slack: FakeSlack
let client: Client
let closeServer: () => Promise<void>

// An hour after the fake workspace's newest message (1712000003).
const NOW = (1712000003 + 3600) * 1000

beforeEach(async () => {
  slack = await startFakeSlack()
  const c1 = slack.channels.get('C1')!
  c1.messages.push(
    { ts: '1712000002.700100', user: 'U2', text: '<@U9> can you check the Deploy logs?', thread_ts: '1712000002.000100' },
    // Three days before NOW.
    { ts: String(1712000003 + 3600 - 3 * 86400) + '.000100', user: 'U2', text: 'an old deploy note for <@U9>' },
  )
  c1.messages.find((m) => m.ts === '1712000002.000100')!.reply_count = 2
  slack.channels.set('C3', {
    id: 'C3',
    name: 'alerts',
    is_member: true,
    messages: [{ ts: '1712000003.500100', user: 'U1', text: 'deploy failed, <@U9|ana> please look' }],
  })
  const integration = createSlackIntegration({
    secrets: { botToken: TOKEN, signingSecret: 'shh-test' },
    baseUrl: slack.url,
    sleep: async () => {},
    clock: new ManualClock(NOW),
  })
  const server = integration.createMcpServer()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientSide)
  closeServer = () => server.close()
})
afterEach(async () => {
  await client.close()
  await closeServer()
  await slack.close()
})

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }
const search = async (args: Record<string, unknown>) => {
  const r = (await client.callTool({ name: 'search', arguments: args })) as ToolResult
  const text = r.content[0]?.text ?? ''
  let value: Record<string, unknown> = { text }
  try {
    value = JSON.parse(text)
  } catch {}
  return { isError: r.isError === true, value }
}
const tsOf = (v: Record<string, unknown>) => (v.messages as { ts: string }[]).map((m) => m.ts)

describe('search', () => {
  it("finds who is tagged across the app's channels, thread replies included, newest first", async () => {
    const r = await search({ mentions: 'U9' })
    expect(r.isError).toBe(false)
    expect(r.value.messages).toEqual([
      {
        channel: 'C3',
        channel_name: 'alerts',
        ts: '1712000003.500100',
        user: 'U1',
        text: 'deploy failed, <@U9|ana> please look',
      },
      {
        channel: 'C1',
        channel_name: 'general',
        ts: '1712000002.700100',
        user: 'U2',
        text: '<@U9> can you check the Deploy logs?',
        thread_ts: '1712000002.000100',
      },
    ])
    // Only the channels the app is in (C2 isn't one), and the message older than the window isn't there.
    expect(r.value).toMatchObject({ total: 2, channels_searched: 3 })
    expect(r.value).not.toHaveProperty('truncated')
    expect(slack.callsTo('conversations.history').map((c) => c.params.channel)).not.toContain('C2')
  })

  it('matches every word in any case, a quoted phrase as one, and the author', async () => {
    expect(tsOf((await search({ query: 'DEPLOY logs' })).value)).toEqual(['1712000002.700100'])
    expect(tsOf((await search({ query: '"deploy failed"' })).value)).toEqual(['1712000003.500100'])
    expect(tsOf((await search({ query: 'deploy', from: 'U1' })).value)).toEqual(['1712000003.500100', '1712000002.000100'])
    expect(tsOf((await search({ query: 'deploy', channels: ['C1'] })).value)).toEqual(['1712000002.700100', '1712000002.000100'])
  })

  it('reads further back with since_hours, up to a week', async () => {
    expect(tsOf((await search({ query: 'old deploy' })).value)).toEqual([])
    expect(tsOf((await search({ query: 'old deploy', since_hours: 96 })).value)).toHaveLength(1)
    expect((await search({ query: 'old deploy', since_hours: 24 * 8 })).isError).toBe(true)
  })

  it('needs something to look for, and a real user id', async () => {
    expect((await search({})).isError).toBe(true)
    expect((await search({ mentions: '@ana' })).isError).toBe(true)
  })

  it("a channel it can't read is reported and the rest still searched", async () => {
    const r = await search({ query: 'deploy', channels: ['C2', 'C3'] })
    expect(r.value).toMatchObject({ skipped: [{ channel: 'C2', error: 'not_in_channel' }] })
    expect(tsOf(r.value)).toEqual(['1712000003.500100'])
  })

  it('stops after its call budget and says so', async () => {
    for (let i = 0; i < 210; i++) slack.channels.set(`CX${i}`, { id: `CX${i}`, name: `x${i}`, is_member: true, messages: [] })
    const r = await search({ query: 'deploy' })
    expect(r.value.truncated).toBe(true)
    expect(slack.calls.length).toBeLessThanOrEqual(200 + 5)
  })
})
