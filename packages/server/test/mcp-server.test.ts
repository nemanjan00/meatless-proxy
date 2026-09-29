import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { sleep } from '@mp/core'
import { callTools, reply, type ModelRequest } from '@mp/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMcpToken } from '../src/tokens.ts'
import { testApp, until, type TestApp } from './helpers.ts'

let t: TestApp & { port: number | null }
let token: string
let anaId: string

const text = (r: any) => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n')
const json = (r: any) => JSON.parse(text(r))

beforeAll(async () => {
  t = await testApp({
    http: true,
    script: async (req: ModelRequest) => {
      const last = req.messages.at(-1)!
      if (last.role === 'tool') return reply('Answered Ana.')
      const m = /What is 2\+2/.test(last.content ?? '')
      if (!m) return reply('ok')
      const q = (await t.a.services.chat.search('What is 2+2')).find((x) => !x.data.threadId)!
      return callTools([{ name: 'chat.reply', args: { threadId: q.id, text: 'It is 4.' } }])
    },
  })
  const s = t.a.services
  const ana = await s.directory.contacts.create({
    name: 'Ana Example',
    kind: 'person',
    access: 'member',
    handles: [{ system: 'mp', id: 'ana' }],
  })
  anaId = ana.id
  token = (await createMcpToken(s, ana.id, 'test')).token
  const doc = await s.docs.create({
    title: 'Deploy runbook',
    body: '# Deploy\n\n## Rollback\n\nRun the rollback job, then tell #general.',
  })
  expect(doc.id).toMatch(/^doc_/)
})
afterAll(async () => {
  await t.close()
})

async function connect(tok: string) {
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const notes: any[] = []
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void notes.push(n.params.data))
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${t.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tok}` } },
  })
  await client.connect(transport)
  return { client, notes }
}

describe('MCP server /mcp', () => {
  it('refuses requests without a valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${t.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer nope',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(res.status).toBe(401)
    await expect(connect('wrong')).rejects.toThrow()
  })

  it('offers the tools, acts as the contact, and notifies about replies and finished work', async () => {
    const { client, notes } = await connect(token)
    const tools = (await client.listTools()).tools.map((x) => x.name).sort()
    expect(tools).toEqual([
      'ask',
      'chat_attachment',
      'chat_inbox',
      'chat_join',
      'chat_join_channel',
      'chat_leave',
      'chat_leave_channel',
      'chat_post',
      'chat_react',
      'chat_read',
      'chat_search',
      'docs_read',
      'docs_search',
      'my_work',
      'session_get',
      'sessions_search',
    ])

    const posted = json(
      await client.callTool({ name: 'chat_post', arguments: { channel: 'general', text: 'Hello from my own agent' } }),
    )
    expect(posted.messageId).toMatch(/^msg_/)
    const msg = await t.a.services.chat.getMessage(posted.messageId)
    expect(msg!.data.author).toEqual({ kind: 'contact', id: anaId })
    const read = json(await client.callTool({ name: 'chat_read', arguments: { channel: 'general' } }))
    expect(read.at(-1)).toMatchObject({ author: 'Ana Example', text: 'Hello from my own agent' })
    expect((await client.callTool({ name: 'chat_read', arguments: { channel: 'nope' } })).isError).toBe(true)

    const asked = json(await client.callTool({ name: 'ask', arguments: { employee: 'meatless', question: 'What is 2+2?' } }))
    expect(asked.threadId).toMatch(/^msg_/)
    const dm = await t.a.services.chat.getChannel(asked.channelId)
    expect(dm!.data).toMatchObject({ dm: true })

    const replyNote = await until(() => notes.find((n) => n.type === 'chat.reply'), 'a reply notification', 10_000)
    expect(replyNote).toMatchObject({ threadId: asked.threadId, text: 'It is 4.', author: 'Meatless' })
    const finished = await until(() => notes.find((n) => n.type === 'work.finished'), 'a finished notification', 10_000)
    expect(finished).toMatchObject({ state: 'completed' })

    const work = json(await client.callTool({ name: 'my_work', arguments: {} }))
    expect(work.runs.length).toBeGreaterThanOrEqual(1)
    expect(work.runs[0]).toMatchObject({ state: 'completed' })
    const session = json(await client.callTool({ name: 'session_get', arguments: { id: work.runs[0].sessionId } }))
    expect(session).toMatchObject({ employee: 'Meatless', lastRun: { state: 'completed' } })
    const found = json(await client.callTool({ name: 'sessions_search', arguments: { text: 'router' } }))
    expect(found.length).toBeGreaterThanOrEqual(1)

    const docs = json(await client.callTool({ name: 'docs_search', arguments: { text: 'rollback' } }))
    expect(docs[0]).toMatchObject({ title: 'Deploy runbook' })
    expect(text(await client.callTool({ name: 'docs_read', arguments: { id: docs[0].id, chapter: 'Rollback' } }))).toContain(
      'rollback job',
    )
    expect(text(await client.callTool({ name: 'docs_read', arguments: { id: docs[0].id } }))).toContain('# Deploy runbook')

    // Replying in the thread as Ana goes back to the employee; Ana's own messages don't notify Ana.
    const before = notes.length
    await client.callTool({
      name: 'chat_post',
      arguments: { channel: asked.channelId, text: 'Thanks!', thread_id: asked.threadId },
    })
    await t.settle()
    expect(notes.slice(before).filter((n) => n.type?.startsWith('chat.') && n.author === 'Ana Example')).toEqual([])
    expect(t.a.mcp.size).toBe(1)
    await client.close()
  })

  it('notifies a contact mentioned in a thread they are not in', async () => {
    const { client, notes } = await connect(token)
    await client.listTools()
    await sleep(300) // the client opens its notification stream right after initializing
    const general = (await t.a.services.chat.channelByName('general'))!
    const employee = (await t.a.services.directory.employees.byHandle('meatless'))!
    await t.a.services.chat.post({
      channelId: general.id,
      author: { kind: 'contact', id: employee.data.contactId },
      text: 'Can @ana approve this?',
    })
    const note = await until(() => notes.find((n) => n.type === 'chat.mention'), 'a mention notification', 10_000)
    expect(note).toMatchObject({ text: 'Can @ana approve this?' })
    await client.close()
  })
})
