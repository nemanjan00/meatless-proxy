import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ManualClock } from '@mp/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSlackIntegration, isSlackHost, mapSlackEvent, type SlackIntegration } from '../src/index.ts'
import { type FakeSlack, startFakeSlack, TOKEN } from './fake-slack.ts'

let slack: FakeSlack
let integration: SlackIntegration
const text = (s: string) => new TextEncoder().encode(s)

beforeEach(async () => {
  slack = await startFakeSlack()
  integration = createSlackIntegration({
    secrets: { botToken: TOKEN, signingSecret: 'shh-test' },
    baseUrl: slack.url,
    clock: new ManualClock(Date.UTC(2026, 8, 29, 12)),
    sleep: async () => {},
  })
  slack.files.set('F1', { id: 'F1', name: 'build log.txt', mimetype: 'text/plain', bytes: text('line 1\nline 2\n') })
})
afterEach(async () => {
  await slack.close()
})

describe('Slack hosts', () => {
  it("only Slack's own hosts", () => {
    for (const h of ['files.slack.com', 'slack.com', 'a.slack-edge.com', 'x.slack-files.com', 'FILES.SLACK.COM.'])
      expect(isSlackHost(h)).toBe(true)
    for (const h of ['evilslack.com', 'slack.com.evil.example', 'example.com', 'slack-edge.com.example.org'])
      expect(isSlackHost(h)).toBe(false)
  })
})

describe('downloadFile', () => {
  it('reads files.info and downloads the private URL with the bot token', async () => {
    const f = await integration.downloadFile('F1')
    expect(f).toMatchObject({ id: 'F1', name: 'build log.txt', mime: 'text/plain', size: 14 })
    expect(new TextDecoder().decode(f.bytes)).toBe('line 1\nline 2\n')
    expect(slack.callsTo('files.info')[0]!.params).toMatchObject({ file: 'F1' })
    expect(slack.downloads).toEqual([{ path: expect.stringContaining('/files-pri/T1-F1/download/'), auth: `Bearer ${TOKEN}` }])
  })

  it('follows redirects on allowed hosts only, and never sends the token elsewhere', async () => {
    const origin = new URL(slack.url).origin
    const target = `${origin}/files-pri/T1-F1/download/x`
    slack.files.get('F1')!.url = `${origin}/redirect?to=${encodeURIComponent(target)}`
    expect((await integration.downloadFile('F1')).size).toBe(14)
    slack.files.get('F1')!.url = `${origin}/redirect?to=${encodeURIComponent('https://evil.example.com/steal')}`
    await expect(integration.downloadFile('F1')).rejects.toThrow(/evil.example.com, which is not Slack/)
    slack.files.get('F1')!.url = 'https://evil.example.com/file'
    await expect(integration.downloadFile('F1')).rejects.toMatchObject({ code: 'denied' })
    expect(slack.downloads.every((d) => d.path.startsWith('/files-pri/'))).toBe(true)
  })

  it('enforces the size limit, from files.info and from the body', async () => {
    slack.files.set('F2', {
      id: 'F2',
      name: 'big.bin',
      mimetype: 'application/octet-stream',
      bytes: new Uint8Array(10),
      size: 26 * 1024 * 1024,
    })
    await expect(integration.downloadFile('F2')).rejects.toMatchObject({ code: 'limit' })
    expect(slack.downloads).toHaveLength(0)
    // files.info understates it: the body is cut off.
    slack.files.set('F3', {
      id: 'F3',
      name: 'lie.bin',
      mimetype: 'application/octet-stream',
      bytes: new Uint8Array(2048),
      size: 10,
    })
    await expect(integration.downloadFile('F3', { maxBytes: 1024 })).rejects.toMatchObject({ code: 'limit' })
  })

  it('explains the missing files:read scope, external and unknown files', async () => {
    slack.files.get('F1')!.asSignInPage = true
    await expect(integration.downloadFile('F1')).rejects.toThrow(/files:read/)
    slack.files.set('F4', {
      id: 'F4',
      name: 'doc',
      mimetype: 'application/vnd.google-apps.document',
      bytes: new Uint8Array(),
      mode: 'external',
    })
    await expect(integration.downloadFile('F4')).rejects.toThrow(/external file/)
    await expect(integration.downloadFile('F404')).rejects.toMatchObject({ code: 'not_found' })
    slack.failWith('files.info', 'missing_scope', 1)
    await expect(integration.downloadFile('F1')).rejects.toThrow(/files:read/)
    await expect(integration.downloadFile('not-an-id')).rejects.toMatchObject({ code: 'validation' })
  })
})

describe('the get_file tool without the harness', () => {
  it('returns the metadata only (the harness saves the file)', async () => {
    const server = integration.createMcpServer()
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(a)
    const r = (await client.callTool({ name: 'get_file', arguments: { file_id: 'F1' } })) as { content: { text: string }[] }
    expect(JSON.parse(r.content[0]!.text)).toEqual({
      id: 'F1',
      name: 'build log.txt',
      mime: 'text/plain',
      filetype: 'txt',
      size: 14,
      title: 'build log.txt',
      mode: 'hosted',
    })
    expect(slack.downloads).toHaveLength(0)
    await client.close()
  })
})

describe('files in events', () => {
  it('are listed in the text as [file: name, slack file F…]', async () => {
    const e = await mapSlackEvent(
      {
        type: 'event_callback',
        event_id: 'Ev1',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C1',
          channel_type: 'channel',
          user: 'U1',
          text: 'see logs',
          ts: '1.1',
          files: [
            { id: 'F1', name: 'build log.txt' },
            { id: 'F2', name: 'shot.png' },
          ],
        },
      },
      { self: { userIds: new Set(), botIds: new Set() }, channelName: async () => 'general' },
    )
    expect(e!.text).toBe('Slack #general U1: see logs [file: build log.txt, slack file F1] [file: shot.png, slack file F2]')
  })
})
