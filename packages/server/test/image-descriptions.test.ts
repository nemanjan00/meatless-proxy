import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DESCRIBE_PROMPT } from '@mp/chat'
import { solidPng } from '@mp/files'
import { reply, type ModelRequest } from '@mp/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describedEvent } from '../src/image-descriptions.ts'
import { createMcpToken } from '../src/tokens.ts'
import { testApp, until, type TestApp } from './helpers.ts'

const red = solidPng(12, 6, [220, 20, 20, 255])
const DESCRIPTION = 'A red square with the word STOP on it.'

type App = TestApp & { port: number | null }

/** An app whose model describes images (counting the calls) and answers everything else with "ok". */
async function app(env: Record<string, string>, http = false) {
  const describes: ModelRequest[] = []
  const t = await testApp({
    http,
    env: { MODEL_VISION: 'on', ...env },
    script: async (req: ModelRequest) => {
      if (req.messages[0]?.content === DESCRIBE_PROMPT) {
        describes.push(req)
        return JSON.stringify({ description: DESCRIPTION, text: 'STOP' })
      }
      return reply('ok')
    },
  })
  const s = t.a.services
  const anaId = (await s.directory.contacts.create({ name: 'Ana Example', kind: 'person', access: 'member' })).id
  const bobId = (await s.directory.contacts.create({ name: 'Bob Example', kind: 'person', access: 'member' })).id
  const generalId = (await s.chat.channelByName('general'))!.id
  return { t, s, describes, anaId, bobId, ana: await t.as(anaId), bob: await t.as(bobId), generalId }
}

const upload = async (t: App, headers: Record<string, string>, bytes = red, name = 'stop.png') => {
  const res = await t.a.app.request(`/api/chat/attachments?name=${name}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', ...headers },
    body: bytes as Uint8Array<ArrayBuffer>,
  })
  return ((await res.json()) as any).attachment as { id: string }
}

/** Uploads an image and posts it in a channel (no tags: nobody is asked to act). */
async function postImage(
  x: Awaited<ReturnType<typeof app>>,
  channelId = x.generalId,
  headers = x.ana,
  text = 'look',
  bytes = red,
) {
  const up = await upload(x.t, headers, bytes)
  const m = await x.t.req('POST', `/api/chat/channels/${channelId}/messages`, { text, attachments: [up.id] }, headers)
  expect(m.status).toBe(201)
  return { id: up.id, messageId: m.body.id as string }
}

describe('IMAGE_DESCRIBE=view (the default)', () => {
  let x: Awaited<ReturnType<typeof app>>
  let dmId: string
  beforeAll(async () => {
    x = await app({}, true)
    const employeeId = (await x.s.directory.employees.byHandle('meatless'))!.id
    dmId = (await x.t.req('POST', '/api/chat/dms', { members: [{ kind: 'employee', id: employeeId }] }, x.ana)).body.id
  })
  afterAll(() => x.t.close())

  it('describes nothing until asked', async () => {
    expect(x.s.describer).toMatchObject({ mode: 'view', available: true })
    const { id } = await postImage(x)
    await x.t.settle()
    expect(x.describes).toHaveLength(0)
    const got = await x.t.req('GET', `/api/chat/attachments/${id}/description`, undefined, x.bob)
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ available: true, mode: 'view', canEdit: false, attachment: { id } })
    expect(got.body.attachment.description).toBeUndefined()
  })

  it('POST describe: the uploader and admins make or redo one; others may not', async () => {
    const { id, messageId } = await postImage(x)
    expect((await x.t.req('POST', `/api/chat/attachments/${id}/describe`, {}, x.bob)).status).toBe(403)
    const before = x.describes.length
    const r = await x.t.req('POST', `/api/chat/attachments/${id}/describe`, {}, x.ana)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      attachment: { id, description: DESCRIPTION, visibleText: 'STOP' },
      describedBy: 'scripted',
      canEdit: true,
    })
    expect(x.describes.length).toBe(before + 1)
    // The message carries it, so every view of the message has it.
    const thread = await x.t.req('GET', `/api/chat/threads/${messageId}`, undefined, x.bob)
    expect(thread.body.root.data.attachments[0]).toMatchObject({ description: DESCRIPTION, visibleText: 'STOP' })
    // Usage is recorded for the person who asked.
    await x.t.settle()
    const used = await x.s.usage.totals({ requesterId: x.anaId } as any)
    expect(used.totalTokens).toBeGreaterThan(0)
    // An admin may redo it.
    expect((await x.t.req('POST', `/api/chat/attachments/${id}/describe`, {})).status).toBe(200)
    expect(x.describes.length).toBe(before + 2)
  })

  it('PATCH: edits are marked with who made them, null clears; only admins and the uploader', async () => {
    const { id } = await postImage(x)
    const patch = (body: unknown, h: Record<string, string> = {}) => x.t.req('PATCH', `/api/chat/attachments/${id}`, body, h)
    expect((await patch({ description: 'Mine now' }, x.bob)).status).toBe(403)
    const viewer = (await x.s.directory.contacts.create({ name: 'Vic', kind: 'person', access: 'viewer' })).id
    expect((await patch({ description: 'x' }, await x.t.as(viewer))).status).toBe(403)
    expect((await patch({ description: 42 }, x.ana)).status).toBe(400)
    const ed = await patch({ description: 'A stop sign, drawn.' }, x.ana)
    expect(ed.status).toBe(200)
    expect(ed.body).toMatchObject({
      attachment: { description: 'A stop sign, drawn.', descriptionEditedBy: { kind: 'contact', id: x.anaId } },
      editedByName: 'Ana Example',
    })
    const byAdmin = await patch({ description: 'Admin was here.' })
    expect(byAdmin.status).toBe(200)
    expect(byAdmin.body.editedByName).not.toBe('Ana Example')
    const cleared = await patch({ description: null }, x.ana)
    expect(cleared.status).toBe(200)
    expect(cleared.body.attachment.description).toBeUndefined()
    expect(cleared.body.attachment.descriptionEditedBy).toBeUndefined()
    expect((await patch({ description: 'x' }, x.ana)).status).toBe(200)
    expect((await x.t.req('PATCH', '/api/chat/attachments/att_nope', { description: 'x' }, x.ana)).status).toBe(404)
  })

  it('a DM image’s description is its members’ only, admins included; the generic records API shows none', async () => {
    const { id } = await postImage(x, dmId)
    await x.s.describer.describeAttachment(id)
    expect((await x.t.req('GET', `/api/chat/attachments/${id}/description`, undefined, x.ana)).status).toBe(200)
    expect((await x.t.req('GET', `/api/chat/attachments/${id}/description`, undefined, x.bob)).status).toBe(404)
    expect((await x.t.req('GET', `/api/chat/attachments/${id}/description`)).status).toBe(404)
    expect((await x.t.req('PATCH', `/api/chat/attachments/${id}`, { description: 'x' })).status).toBe(404)
    expect((await x.t.req('POST', `/api/chat/attachments/${id}/describe`, {})).status).toBe(404)
    expect((await x.t.req('GET', '/api/records/chat_attachment', undefined, x.bob)).status).toBe(404)
    expect((await x.t.req('GET', '/api/records/image_description', undefined, x.bob)).status).toBe(404)
    // Search finds it for members only.
    const mine = await x.t.req('GET', `/api/chat/search?text=${encodeURIComponent('word STOP')}`, undefined, x.ana)
    expect(mine.body.some((r: any) => r.channel.id === dmId)).toBe(true)
    const theirs = await x.t.req('GET', `/api/chat/search?text=${encodeURIComponent('word STOP')}`, undefined, x.bob)
    expect(theirs.body.some((r: any) => r.channel.id === dmId)).toBe(false)
  })

  it('an event is rendered with the saved description, as information inside the event', async () => {
    const { id, messageId } = await postImage(x, x.generalId, x.ana, 'what is this?')
    const event = (await x.s.rawEvents.query({ limit: 500 })).find((e) => (e.data.payload as any)?.messageId === messageId)!
    expect(event.data.text).toContain(`[image: stop.png 12x6, attachment ${id}]`)
    // Before a description exists, the line is plain.
    expect((await describedEvent(x.s.attachments)(event)).data.text).toBe(event.data.text)
    await x.s.describer.describeAttachment(id)
    const shown = await describedEvent(x.s.attachments)(event)
    expect(shown.data.text).toContain(`[image: stop.png 12x6, attachment ${id}: "${DESCRIPTION}"]`)
    // Through the router: what the session gets.
    const employeeId = (await x.s.directory.employees.byHandle('meatless'))!.id
    const session = await x.s.sessions.create({
      employeeId,
      title: 'Watcher',
      entries: [{ kind: 'system', content: { text: 'w' } }],
    })
    const out = await x.s.router.deliver(event, {
      sessionId: session.id,
      reason: 'subscription',
      expectedToAct: false,
      trusted: true,
      fork: false,
      priority: 0,
    })
    expect(out.type).toBe('run')
    const entry = (await x.s.sessions.runHistory((out as any).runId)).find((e) => e.kind === 'event')!
    expect((entry.content as any).text).toContain(`attachment ${id}: "${DESCRIPTION}"`)
    // The stored event is untouched.
    expect((await x.s.rawEvents.get(event.id))!.data.text).toBe(event.data.text)
    await x.t.settle()
  })

  it('MCP: chat_read, chat_search and chat_attachment carry the description; describe_only returns only text', async () => {
    const token = (await createMcpToken(x.s, x.anaId, 'test')).token
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${x.t.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
    try {
      const json = (r: any) => JSON.parse((r.content as { text: string }[]).map((c) => c.text).join(''))
      const { id, messageId } = await postImage(x, x.generalId, x.ana, 'mcp look', solidPng(13, 7, [10, 200, 10, 255]))
      // describe_only makes one (for the caller) and returns text only.
      const before = x.describes.length
      const only: any = await client.callTool({ name: 'chat_attachment', arguments: { id, describe_only: true } })
      expect(only.content).toHaveLength(1)
      expect(JSON.parse(only.content[0].text)).toMatchObject({ id, description: DESCRIPTION, visibleText: 'STOP', messageId })
      expect(x.describes.length).toBe(before + 1)
      // The full look has the image and the saved description, with no new call.
      const full: any = await client.callTool({ name: 'chat_attachment', arguments: { id } })
      expect(full.content[0].type).toBe('image')
      expect(JSON.parse(full.content[1].text)).toMatchObject({ description: DESCRIPTION, descriptionNote: expect.any(String) })
      expect(x.describes.length).toBe(before + 1)
      const read = json(await client.callTool({ name: 'chat_read', arguments: { channel: 'general' } }))
      expect(read.find((m: any) => m.id === messageId).attachments[0]).toMatchObject({
        description: DESCRIPTION,
        visibleText: 'STOP',
      })
      const found = json(await client.callTool({ name: 'chat_search', arguments: { query: 'word STOP' } }))
      expect(found.results.some((r: any) => r.messageId === messageId && r.attachments[0].description === DESCRIPTION)).toBe(true)
    } finally {
      await client.close()
    }
  })
})

describe('IMAGE_DESCRIBE=upload', () => {
  let x: Awaited<ReturnType<typeof app>>
  beforeAll(async () => {
    x = await app({ IMAGE_DESCRIBE: 'upload' })
  })
  afterAll(() => x.t.close())

  it('describes a posted message’s images in the background, once each, and the first look reuses it', async () => {
    const { id, messageId } = await postImage(x)
    await until(async () => (await x.s.attachments.get(id))?.data.description, 'the background description')
    await x.t.settle()
    expect(x.describes).toHaveLength(1)
    expect((await x.s.chat.getMessage(messageId))!.data.attachments![0]!.description).toBe(DESCRIPTION)
    // Attributed to the uploader.
    const used = await x.s.usage.totals({ requesterId: x.anaId } as any)
    expect(used.totalTokens).toBeGreaterThan(0)
    expect(await x.s.describer.describeAttachment(id)).toMatchObject({ ok: true, reused: true })
    // The same bytes again: reused, no second call.
    const again = await postImage(x)
    await until(async () => (await x.s.attachments.get(again.id))?.data.description, 'the reused description')
    expect(x.describes).toHaveLength(1)
  })
})

describe('IMAGE_DESCRIBE=off', () => {
  let x: Awaited<ReturnType<typeof app>>
  beforeAll(async () => {
    x = await app({ IMAGE_DESCRIBE: 'off' })
  })
  afterAll(() => x.t.close())

  it('makes no descriptions, and says why', async () => {
    const { id } = await postImage(x)
    await x.t.settle()
    const r = await x.t.req('POST', `/api/chat/attachments/${id}/describe`, {}, x.ana)
    expect(r.status).toBe(503)
    expect(r.body.error.message).toMatch(/IMAGE_DESCRIBE=off/)
    const got = await x.t.req('GET', `/api/chat/attachments/${id}/description`, undefined, x.ana)
    expect(got.body).toMatchObject({ available: false, mode: 'off', canEdit: true })
    // People can still write one.
    expect((await x.t.req('PATCH', `/api/chat/attachments/${id}`, { description: 'Hand-written.' }, x.ana)).status).toBe(200)
    expect(x.describes).toHaveLength(0)
  })
})

describe('MODEL_VISION=off', () => {
  let x: Awaited<ReturnType<typeof app>>
  beforeAll(async () => {
    x = await app({ MODEL_VISION: 'off', IMAGE_DESCRIBE: 'upload' })
  })
  afterAll(() => x.t.close())

  it('can’t make descriptions: nothing is queued or called, and the API says the model can’t see images', async () => {
    const { id } = await postImage(x)
    await x.t.settle()
    expect(x.describes).toHaveLength(0)
    const got = await x.t.req('GET', `/api/chat/attachments/${id}/description`, undefined, x.ana)
    expect(got.body).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/can't see images/) })
    expect((await x.t.req('POST', `/api/chat/attachments/${id}/describe`, {}, x.ana)).status).toBe(503)
  })
})
