import { ManualClock } from '@mp/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSlackIntegration, type SlackIntegration } from '../src/index.ts'
import { type FakeSlack, startFakeSlack, TOKEN } from './fake-slack.ts'

let slack: FakeSlack
let integration: SlackIntegration

beforeEach(async () => {
  slack = await startFakeSlack()
  integration = createSlackIntegration({
    secrets: { botToken: TOKEN, signingSecret: 'shh-test' },
    baseUrl: slack.url,
    clock: new ManualClock(Date.UTC(2026, 8, 29, 12)),
    sleep: async () => {},
  })
})
afterEach(async () => {
  await slack.close()
})

describe('permalink', () => {
  it("asks chat.getPermalink once and keeps the answer: permalinks don't change", async () => {
    const url = await integration.permalink('C1', '1712000002.000100')
    expect(url).toBe('https://example.slack.com/archives/C1/p1712000002000100')
    expect(await integration.permalink('C1', '1712000002.000100')).toBe(url)
    expect(slack.callsTo('chat.getPermalink')).toHaveLength(1)
    expect(slack.callsTo('chat.getPermalink')[0]!.params).toEqual({ channel: 'C1', message_ts: '1712000002.000100' })
  })

  it('asks for two at once only once', async () => {
    const [a, b] = await Promise.all([
      integration.permalink('C1', '1712000003.000100'),
      integration.permalink('C1', '1712000003.000100'),
    ])
    expect(a).toBe(b)
    expect(slack.callsTo('chat.getPermalink')).toHaveLength(1)
  })

  it("throws when Slack can't give one, and asks again next time", async () => {
    await expect(integration.permalink('C9', '1712000002.000100')).rejects.toThrow(/channel_not_found/)
    slack.failWith('chat.getPermalink', 'ratelimited', 1)
    await expect(integration.permalink('C1', '1712000001.000100')).rejects.toThrow()
    expect(await integration.permalink('C1', '1712000001.000100')).toMatch(/^https:\/\/example\.slack\.com\/archives\/C1\//)
  })

  it('refuses an answer that is not an https link', async () => {
    slack.script('chat.getPermalink', { status: 200, body: JSON.stringify({ ok: true, permalink: 'javascript:alert(1)' }) })
    await expect(integration.permalink('C1', '1712000002.000100')).rejects.toThrow(/no permalink/)
  })
})

describe('channelName', () => {
  it('names channels from the cache it keeps for events', async () => {
    expect(await integration.channelName('C1')).toBe('general')
    expect(await integration.channelName('C1')).toBe('general')
    expect(slack.callsTo('conversations.info')).toHaveLength(1)
    expect(await integration.channelName('C404')).toBeUndefined()
  })
})
