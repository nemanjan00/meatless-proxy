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
  it("opens the conversation in Slack's web client, asking auth.test for the workspace once", async () => {
    expect(await integration.permalink('C1', '1712000002.000100')).toBe('https://app.slack.com/client/T1/C1')
    expect(await integration.permalink('D2', '1712000003.000100')).toBe('https://app.slack.com/client/T1/D2')
    expect(slack.callsTo('auth.test')).toHaveLength(1)
    expect(slack.callsTo('chat.getPermalink')).toHaveLength(0)
  })

  it('throws when the workspace is unknown, and asks again next time', async () => {
    slack.failWith('auth.test', 'ratelimited', 1)
    await expect(integration.permalink('C1', '1712000001.000100')).rejects.toThrow(/workspace id is unknown/)
    expect(await integration.permalink('C1', '1712000001.000100')).toBe('https://app.slack.com/client/T1/C1')
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
