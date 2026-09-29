import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createChatAttachments } from '@mp/chat'
import { ManualClock, createEventBus, memoryLogger } from '@mp/core'
import { memoryStorage, sha256Hex, sniffImage, solidPng } from '@mp/files'
import { callTools, reply, type ModelCapabilities, type ModelClient, type ModelRequest } from '@mp/model'
import { createRecords } from '@mp/records'
import { memoryStore } from '@mp/store'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imageLoader, resolveVision, startAttachmentCleanup } from '../src/attachments.ts'
import { createMcpToken } from '../src/tokens.ts'
import { testApp, until, type TestApp } from './helpers.ts'

const red = solidPng(12, 6, [220, 20, 20, 255])
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

let t: TestApp & { port: number | null }
let anaId: string
let bobId: string
let ana: Record<string, string>
let bob: Record<string, string>
let admin: Record<string, string>
let generalId: string
let dmId: string
/** What the model saw on each call. */
const seen: ModelRequest[] = []

/** POSTs raw bytes to the upload endpoint. */
const upload = async (bytes: Uint8Array, headers: Record<string, string>, o: { name?: string; type?: string } = {}) => {
  const res = await t.a.app.request(`/api/chat/attachments${o.name ? `?name=${encodeURIComponent(o.name)}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': o.type ?? 'image/png', ...headers },
    body: bytes as Uint8Array<ArrayBuffer>,
  })
  return { status: res.status, body: (await res.json()) as any }
}
const download = (id: string, headers: Record<string, string>, query = '') =>
  t.a.app.request(`/api/chat/attachments/${id}${query}`, { headers })

beforeAll(async () => {
  t = await testApp({
    http: true,
    env: { MODEL_VISION: 'on', CHAT_ATTACHMENT_MAX_BYTES: '65536', CHAT_ATTACHMENTS_PER_MESSAGE: '3' },
    script: async (req: ModelRequest) => {
      seen.push(req)
      const last = req.messages.at(-1)!
      const m = /look at (att_\w+)/.exec(last.content ?? '')
      if (last.role !== 'tool' && m) return callTools([{ name: 'image.view', args: { attachment: m[1] } }])
      return reply('ok')
    },
  })
  const s = t.a.services
  anaId = (await s.directory.contacts.create({ name: 'Ana Example', kind: 'person', access: 'member' })).id
  bobId = (await s.directory.contacts.create({ name: 'Bob Example', kind: 'person', access: 'member' })).id
  ana = await t.as(anaId)
  bob = await t.as(bobId)
  admin = (await t.admin()).headers
  generalId = (await s.chat.channelByName('general'))!.id
  const employeeId = (await s.directory.employees.byHandle('meatless'))!.id
  dmId = (await t.req('POST', '/api/chat/dms', { members: [{ kind: 'employee', id: employeeId }] }, ana)).body.id
})
afterAll(() => t.close())

describe('uploads over HTTP', () => {
  it('stores an image, typed by its content', async () => {
    const r = await upload(red, ana, { name: 'chart.png', type: 'application/octet-stream' })
    expect(r.status).toBe(201)
    expect(r.body.attachment).toMatchObject({ name: 'chart.png', mime: 'image/png', size: red.length, width: 12, height: 6 })
    expect(Date.parse(r.body.expiresAt)).toBeGreaterThan(Date.now() + 59 * 60_000)
  })

  it('refuses what isn’t an image whatever it claims, and what is too large', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect((await upload(svg, ana, { name: 'x.png', type: 'image/png' })).status).toBe(422)
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    expect((await upload(html, ana, { type: 'image/gif' })).status).toBe(422)
    const big = new Uint8Array(70_000)
    big.set(red)
    expect((await upload(big, ana)).status).toBe(413)
    // Viewers can't upload.
    const viewer = (await t.a.services.directory.contacts.create({ name: 'Vic', kind: 'person', access: 'viewer' })).id
    expect((await upload(red, await t.as(viewer))).status).toBe(403)
  })

  it('takes a multipart form too', async () => {
    const form = new FormData()
    form.append('file', new Blob([red as Uint8Array<ArrayBuffer>], { type: 'image/png' }), 'form.png')
    const res = await t.a.app.request('/api/chat/attachments', { method: 'POST', headers: ana, body: form })
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).attachment.name).toBe('form.png')
  })
})

describe('messages with attachments over HTTP', () => {
  it('posts an image-only message and serves it to those who can see the channel', async () => {
    const up = (await upload(red, ana, { name: 'q3.png' })).body.attachment
    const m = await t.req('POST', `/api/chat/channels/${generalId}/messages`, { text: '', attachments: [up.id] }, ana)
    expect(m.status).toBe(201)
    expect(m.body.data.attachments).toEqual([up])
    const res = await download(up.id, bob)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="q3.png"/)
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(red)
    expect((await download(up.id, bob, '?download=1')).headers.get('content-disposition')).toMatch(/^attachment;/)
    // The thread and channel views carry the metadata.
    const list = await t.req('GET', `/api/chat/channels/${generalId}/messages`, undefined, bob)
    expect(list.body.find((x: any) => x.id === m.body.id).data.attachments).toHaveLength(1)
  })

  it('keeps a DM’s images to its members (admins included)', async () => {
    const up = (await upload(red, ana)).body.attachment
    await t.req('POST', `/api/chat/channels/${dmId}/messages`, { text: 'private', attachments: [up.id] }, ana)
    expect((await download(up.id, ana)).status).toBe(200)
    expect((await download(up.id, bob)).status).toBe(404)
    expect((await download(up.id, admin)).status).toBe(404)
    expect((await download('att_nope', ana)).status).toBe(404)
  })

  it('serves a pending upload only to its uploader', async () => {
    const up = (await upload(red, ana)).body.attachment
    expect((await download(up.id, ana)).status).toBe(200)
    expect((await download(up.id, bob)).status).toBe(404)
  })

  it('refuses attaching someone else’s upload, and more than the limit', async () => {
    const up = (await upload(red, ana)).body.attachment
    const r = await t.req('POST', `/api/chat/channels/${generalId}/messages`, { text: 'mine', attachments: [up.id] }, bob)
    expect(r.status).toBe(403)
    const ids = []
    for (let i = 0; i < 4; i++) ids.push((await upload(red, ana)).body.attachment.id)
    expect((await t.req('POST', `/api/chat/channels/${generalId}/messages`, { text: 'x', attachments: ids }, ana)).status).toBe(
      422,
    )
    expect(
      (await t.req('POST', `/api/chat/channels/${generalId}/messages`, { text: 'x', attachments: 'att_1' }, ana)).status,
    ).toBe(400)
    expect((await t.req('POST', `/api/chat/channels/${generalId}/messages`, { text: '' }, ana)).status).toBe(400)
  })

  it('deletes a message’s images with it', async () => {
    const up = (await upload(red, ana)).body.attachment
    const m = await t.req('POST', `/api/chat/channels/${generalId}/messages`, { text: 'oops', attachments: [up.id] }, ana)
    const del = await t.req('DELETE', `/api/chat/messages/${m.body.id}`, undefined, ana)
    expect(del.status).toBe(200)
    expect(del.body.data.attachments).toBeUndefined()
    expect((await download(up.id, ana)).status).toBe(404)
    expect(await t.a.services.attachments.get(up.id)).toBeNull()
  })
})

describe('the employee looks at an image', () => {
  it('views an attachment through the whole stack: a reference in the history, the bytes in the request', async () => {
    const s = t.a.services
    expect(s.vision).toMatchObject({ enabled: true, source: 'config' })
    const up = (await upload(red, ana, { name: 'red.png' })).body.attachment
    await t.req(
      'POST',
      `/api/chat/channels/${generalId}/messages`,
      { text: `@meatless look at ${up.id}`, attachments: [up.id] },
      ana,
    )
    await t.settle()
    const call = await until(() => seen.find((r) => r.messages.some((m) => m.role === 'tool' && m.images?.length)), 'the image')
    const tool = call.messages.find((m) => m.role === 'tool' && m.images?.length)!
    expect(tool.images![0]).toMatchObject({ mime: 'image/png', data: b64(red), name: 'red.png' })
    // The event named the image without showing it.
    const first = seen.find((r) => r.messages.some((m) => m.content?.includes(`look at ${up.id}`)))!
    expect(first.messages.some((m) => m.content?.includes(`[image: red.png 12x6, attachment ${up.id}]`))).toBe(true)
    // The history keeps a reference and a hash, not the bytes.
    const runs = await s.records.query<any>('run', { orderBy: { field: 'createdAt', dir: 'desc' }, limit: 10 })
    const histories = await Promise.all(runs.items.map((r) => s.sessions.runHistory(r.id)))
    const result = histories.flat().find((e) => e.kind === 'tool_result' && (e.content as any).name === 'image.view')!
    expect((result.content as any).images).toEqual([
      expect.objectContaining({ source: 'attachment', id: up.id, sha256: sha256Hex(red) }),
    ])
    expect(JSON.stringify(histories)).not.toContain(b64(red))
  })
})

describe('MCP tools', () => {
  let client: Client
  beforeAll(async () => {
    const token = (await createMcpToken(t.a.services, anaId, 'test')).token
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${t.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
  })
  afterAll(() => client.close())
  const json = (r: any) => JSON.parse((r.content as { text: string }[]).map((c) => c.text).join(''))

  it('posts base64 images, lists them in chat_read and chat_search, and returns one as image content', async () => {
    const posted = json(
      await client.callTool({
        name: 'chat_post',
        arguments: {
          channel: 'general',
          text: 'mcp screenshot',
          attachments: [{ name: 'shot.png', mime: 'image/png', data: b64(red) }],
        },
      }),
    )
    const msg = (await t.a.services.chat.getMessage(posted.messageId))!
    const att = msg.data.attachments![0]!
    expect(att).toMatchObject({ name: 'shot.png', mime: 'image/png' })
    const read = json(await client.callTool({ name: 'chat_read', arguments: { channel: 'general' } }))
    expect(read.find((m: any) => m.id === posted.messageId).attachments).toEqual([att])
    const found = json(await client.callTool({ name: 'chat_search', arguments: { query: 'mcp screenshot' } }))
    expect(found.results[0].attachments).toEqual([att])
    const got: any = await client.callTool({ name: 'chat_attachment', arguments: { id: att.id } })
    expect(got.content[0]).toEqual({ type: 'image', data: b64(red), mimeType: 'image/png' })
    expect(JSON.parse(got.content[1].text)).toMatchObject({ id: att.id, messageId: posted.messageId })
  })

  it('refuses spoofed types, bad base64 and non-images, and images it can’t see', async () => {
    const post = (a: unknown) =>
      client.callTool({ name: 'chat_post', arguments: { channel: 'general', text: 'x', attachments: [a] } })
    expect(((await post({ mime: 'image/jpeg', data: b64(red) })) as any).isError).toBe(true)
    expect(((await post({ data: '%%%' })) as any).isError).toBe(true)
    expect(((await post({ data: b64(new TextEncoder().encode('<svg/>')) })) as any).isError).toBe(true)
    // Bob's DM with the employee is not Ana's.
    const s = t.a.services
    const employeeId = (await s.directory.employees.byHandle('meatless'))!.id
    const bobDm = (await t.req('POST', '/api/chat/dms', { members: [{ kind: 'employee', id: employeeId }] }, bob)).body.id
    const up = (await upload(red, bob)).body.attachment
    await t.req('POST', `/api/chat/channels/${bobDm}/messages`, { text: 'bob only', attachments: [up.id] }, bob)
    expect(((await client.callTool({ name: 'chat_attachment', arguments: { id: up.id } })) as any).isError).toBe(true)
  })
})

describe('resolveVision', () => {
  const cfg = { MODEL_IMAGE_MAX_SIDE: 1568, MODEL_IMAGE_MAX_BYTES: 5_000_000 }
  const model = (name: string, caps?: () => Promise<ModelCapabilities | null>): ModelClient => ({
    defaultModel: name,
    complete: async () => {
      throw new Error('unused')
    },
    ...(caps ? { capabilities: caps } : {}),
  })
  const log = memoryLogger()

  it('follows MODEL_VISION when it is on or off', async () => {
    expect(await resolveVision({ ...cfg, MODEL_VISION: 'off' }, model('gpt-4o'), log)).toMatchObject({
      enabled: false,
      source: 'config',
    })
    expect(await resolveVision({ ...cfg, MODEL_VISION: 'on' }, model('tiny'), log)).toMatchObject({
      enabled: true,
      source: 'config',
    })
  })

  it('asks the provider on auto, and falls back to the model name', async () => {
    const auto = { ...cfg, MODEL_VISION: 'auto' as const }
    expect(
      await resolveVision(
        auto,
        model('gpt-4o', async () => ({ vision: false })),
        log,
      ),
    ).toMatchObject({ enabled: false, source: 'provider' })
    expect(
      await resolveVision(
        auto,
        model('kimi-k2-7-code', async () => null),
        log,
      ),
    ).toMatchObject({ enabled: true, source: 'name' })
    expect(
      await resolveVision(
        auto,
        model('text-only-1', async () => null),
        log,
      ),
    ).toMatchObject({ enabled: false, source: 'name' })
    const slow = model('claude-x', () => new Promise(() => {}))
    expect(await resolveVision(auto, slow, log, { timeoutMs: 20 })).toMatchObject({ enabled: true, source: 'name' })
    const broken = model('llava', async () => {
      throw new Error('boom')
    })
    expect(await resolveVision(auto, broken, log)).toMatchObject({ enabled: true, source: 'name' })
  })
})

describe('imageLoader and cleanup', () => {
  const setup = () => {
    const clock = new ManualClock()
    const records = createRecords({ store: memoryStore({ clock }), bus: createEventBus() })
    const storage = memoryStorage()
    const attachments = createChatAttachments({ records, storage, clock })
    return { clock, storage, attachments }
  }

  it('loads files and attachments only while their bytes match, downscaled and within the size limit', async () => {
    const { storage, attachments } = setup()
    await storage.write('emp_a', '/big.png', solidPng(400, 100, [0, 0, 255, 255]))
    const load = imageLoader({ attachments, storage, maxSide: 200, maxBytes: 100_000 })
    const big = await storage.read('emp_a', '/big.png')
    const ref = {
      source: 'file' as const,
      owner: 'emp_a',
      path: '/big.png',
      sha256: sha256Hex(big),
      name: 'big.png',
      mime: 'image/png',
    }
    const got = (await load(ref))!
    expect(got).toMatchObject({ mime: 'image/png', width: 200, height: 50 })
    expect(sniffImage(Buffer.from(got.data, 'base64'))).toEqual({ mime: 'image/png', width: 200, height: 50 })
    expect(await load({ ...ref, sha256: 'changed' })).toBeNull()
    expect(await load({ ...ref, path: '/gone.png' })).toBeNull()
    expect(await imageLoader({ attachments, storage, maxSide: 2000, maxBytes: 10 })(ref)).toBeNull()
    const up = await attachments.upload({ bytes: red, by: { kind: 'contact', id: 'con_a' } })
    expect((await load({ source: 'attachment', id: up.id, sha256: sha256Hex(red), name: 'x', mime: 'image/png' }))!.data).toBe(
      b64(red),
    )
  })

  it('removes orphaned uploads on a timer', async () => {
    const { clock, attachments } = setup()
    const up = await attachments.upload({ bytes: red, by: { kind: 'contact', id: 'con_a' } })
    clock.advance(2 * 60 * 60_000)
    const handle = startAttachmentCleanup(attachments, memoryLogger(), { everyMs: 10 })
    await until(async () => (await attachments.get(up.id)) === null, 'the cleanup')
    await handle.close()
  })
})
