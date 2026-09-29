import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createSlackIntegration } from '../src/index.ts'

/** Opt-in: `MP_LIVE_SLACK=1 SLACK_BOT_TOKEN=xoxb-… npx vitest run packages/integration-slack/test/live.test.ts`. One read call. */
const live = process.env.MP_LIVE_SLACK === '1' && !!process.env.SLACK_BOT_TOKEN

describe.skipIf(!live)('slack live smoke test', () => {
  it('lists one channel through the MCP tool', async () => {
    const integration = createSlackIntegration({
      secrets: { botToken: process.env.SLACK_BOT_TOKEN ?? '', signingSecret: process.env.SLACK_SIGNING_SECRET ?? 'unused' },
    })
    const server = integration.createMcpServer()
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    const client = new Client({ name: 'live', version: '0.0.0' })
    await client.connect(a)
    try {
      const r = (await client.callTool({ name: 'list_channels', arguments: { limit: 1, member_only: false } })) as {
        content: { text: string }[]
        isError?: boolean
      }
      expect(r.isError, r.content[0]?.text).not.toBe(true)
      expect(JSON.parse(r.content[0]?.text ?? '{}')).toHaveProperty('channels')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
