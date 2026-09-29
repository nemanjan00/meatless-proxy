import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A local fake of the Slack Web API (https://api.slack.com/methods): the
 * methods the integration calls, with Slack's payload shapes, its `ok: false`
 * error convention (HTTP 200), cursor pagination and bearer-token auth.
 */

export const TOKEN = 'xoxb-test'
export const BOT_USER = 'UBOT'
export const BOT_ID = 'BBOT'
export const APP_ID = 'AAPP'

export interface FakeMessage {
  ts: string
  user?: string
  bot_id?: string
  text: string
  thread_ts?: string
  reply_count?: number
  reactions?: { name: string; users: string[]; count: number }[]
  edited?: { user: string; ts: string }
  blocks?: unknown[]
  files?: { id: string; name: string; title?: string }[]
}
export interface FakeChannel {
  id: string
  name?: string
  is_private?: boolean
  is_member: boolean
  is_im?: boolean
  topic?: string
  messages: FakeMessage[]
}
export interface FakeUser {
  id: string
  name: string
  real_name?: string
  email?: string
  is_bot?: boolean
  tz?: string
}
/** A file shared in the fake workspace; `url` overrides its download URL. */
export interface FakeFile {
  id: string
  name: string
  mimetype: string
  bytes: Uint8Array
  mode?: string
  url?: string
  /** Serve it as Slack serves a download without files:read: its sign-in page. */
  asSignInPage?: boolean
  /** Claimed size in files.info (default: the real one). */
  size?: number
}
export interface ScriptedResponse {
  status: number
  headers?: Record<string, string>
  body?: string
}
export interface RecordedCall {
  method: string
  contentType: string
  auth: string | undefined
  params: Record<string, unknown>
}

/** A file uploaded with the external upload flow (getUploadURLExternal, the POST, completeUploadExternal). */
export interface FakeUpload {
  id: string
  filename: string
  length: number
  /** The bytes POSTed to the upload URL, and the token they carried. */
  bytes?: Uint8Array
  auth?: string | undefined
  /** Set by completeUploadExternal. */
  channel?: string
  thread_ts?: string
  title?: string
  comment?: string
}

type Handler = (p: Record<string, unknown>) => Record<string, unknown>

export interface FakeSlack {
  url: string
  calls: RecordedCall[]
  channels: Map<string, FakeChannel>
  users: Map<string, FakeUser>
  files: Map<string, FakeFile>
  /** Download requests: path and the token they carried. */
  downloads: { path: string; auth: string | undefined }[]
  /** Uploads by file id, from files.getUploadURLExternal on. */
  uploads: Map<string, FakeUpload>
  /** Queues raw responses for a method, used before the method's normal handler. */
  script(method: string, ...responses: ScriptedResponse[]): void
  /** Makes a method answer `{ ok: false, error, ...extra }`. */
  failWith(method: string, error: string, times?: number, extra?: Record<string, unknown>): void
  callsTo(method: string): RecordedCall[]
  close(): Promise<void>
}

const readBytes = (req: IncomingMessage) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    req.on('error', reject)
  })

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

const page = <T>(items: T[], p: Record<string, unknown>, def: number) => {
  const limit = Number(p.limit ?? def) || def
  const start = p.cursor ? Number(Buffer.from(String(p.cursor), 'base64').toString('utf8').replace('offset:', '')) : 0
  const slice = items.slice(start, start + limit)
  const next = start + limit < items.length ? Buffer.from(`offset:${start + limit}`).toString('base64') : ''
  return { slice, meta: { response_metadata: { next_cursor: next } }, has_more: next !== '' }
}

export async function startFakeSlack(): Promise<FakeSlack> {
  let tsCounter = 1712345678
  const nextTs = () => `${tsCounter++}.000100`
  const channels = new Map<string, FakeChannel>()
  const users = new Map<string, FakeUser>()
  const calls: RecordedCall[] = []
  const scripted = new Map<string, ScriptedResponse[]>()
  const failures = new Map<string, { error: string; times: number; extra?: Record<string, unknown> }>()
  const uploads = new Map<string, FakeUpload>()
  let fileCounter = 100
  const files = new Map<string, FakeFile>()
  const downloads: { path: string; auth: string | undefined }[] = []
  let origin = ''

  users.set('U1', { id: 'U1', name: 'ana', real_name: 'Ana Example', email: 'ana@example.com', tz: 'Europe/Belgrade' })
  users.set('U2', { id: 'U2', name: 'bo', real_name: 'Bo Example', email: 'bo@example.com' })
  users.set(BOT_USER, { id: BOT_USER, name: 'meatless', real_name: 'Meatless', is_bot: true })
  channels.set('C1', {
    id: 'C1',
    name: 'general',
    is_member: true,
    topic: 'Company-wide',
    messages: [
      { ts: '1712000003.000100', user: 'U2', text: 'third' },
      {
        ts: '1712000002.000100',
        user: 'U1',
        text: 'deploy?',
        thread_ts: '1712000002.000100',
        reply_count: 1,
        reactions: [{ name: 'eyes', users: ['U2'], count: 1 }],
      },
      { ts: '1712000002.500100', user: 'U2', text: 'on it', thread_ts: '1712000002.000100' },
      { ts: '1712000001.000100', user: BOT_USER, bot_id: BOT_ID, text: 'hello from the bot' },
    ],
  })
  channels.set('C2', { id: 'C2', name: 'random', is_member: false, messages: [] })
  channels.set('G1', { id: 'G1', name: 'secret', is_private: true, is_member: true, messages: [] })

  const err = (error: string) => ({ ok: false, error })
  const findChannel = (id: unknown) => channels.get(String(id))
  const topLevel = (c: FakeChannel) => c.messages.filter((m) => !m.thread_ts || m.thread_ts === m.ts)

  const handlers: Record<string, Handler> = {
    'auth.test': () => ({
      ok: true,
      url: 'https://example.slack.com/',
      team: 'Example',
      user: 'meatless',
      team_id: 'T1',
      user_id: BOT_USER,
      bot_id: BOT_ID,
    }),
    'chat.postMessage': (p) => {
      const c = findChannel(p.channel)
      if (!c) return err('channel_not_found')
      if (!c.is_member) return err('not_in_channel')
      if (!p.text) return err('no_text')
      if (String(p.text).length > 40_000) return err('msg_too_long')
      const thread = p.thread_ts ? String(p.thread_ts) : undefined
      if (thread) {
        const root = c.messages.find((m) => m.ts === thread)
        if (!root) return err('thread_not_found')
        root.thread_ts = thread
        root.reply_count = (root.reply_count ?? 0) + 1
      }
      if (p.blocks !== undefined && (!Array.isArray(p.blocks) || p.blocks.length > 50)) return err('invalid_blocks')
      const msg: FakeMessage = {
        ts: nextTs(),
        user: BOT_USER,
        bot_id: BOT_ID,
        text: String(p.text),
        ...(thread ? { thread_ts: thread } : {}),
        ...(Array.isArray(p.blocks) ? { blocks: p.blocks } : {}),
      }
      c.messages.unshift(msg)
      return { ok: true, channel: c.id, ts: msg.ts, message: { type: 'message', ...msg } }
    },
    'chat.update': (p) => {
      const c = findChannel(p.channel)
      if (!c) return err('channel_not_found')
      const m = c.messages.find((x) => x.ts === p.ts)
      if (!m) return err('message_not_found')
      if (m.user !== BOT_USER) return err('cant_update_message')
      m.text = String(p.text)
      if (Array.isArray(p.blocks)) m.blocks = p.blocks
      else delete m.blocks
      m.edited = { user: BOT_USER, ts: nextTs() }
      return { ok: true, channel: c.id, ts: m.ts, text: m.text, message: { ...m } }
    },
    'chat.postEphemeral': (p) => {
      const c = findChannel(p.channel)
      if (!c) return err('channel_not_found')
      if (!p.user) return err('user_not_found')
      return { ok: true, message_ts: nextTs() }
    },
    'files.info': (p) => {
      const f = files.get(String(p.file))
      if (!f) return err('file_not_found')
      const url = f.url ?? `${origin}/files-pri/T1-${f.id}/download/${encodeURIComponent(f.name)}`
      return {
        ok: true,
        file: {
          id: f.id,
          name: f.name,
          title: f.name,
          mimetype: f.mimetype,
          filetype: f.name.split('.').pop(),
          size: f.size ?? f.bytes.byteLength,
          mode: f.mode ?? 'hosted',
          url_private: url.replace('/download/', '/'),
          url_private_download: url,
        },
      }
    },
    // https://docs.slack.dev/reference/methods/files.getUploadURLExternal/ (form body)
    'files.getUploadURLExternal': (p) => {
      const length = Number(p.length)
      if (!p.filename || !Number.isInteger(length) || length <= 0) return err('invalid_arguments')
      const id = `FUP${fileCounter++}`
      uploads.set(id, { id, filename: String(p.filename), length })
      return { ok: true, upload_url: `${origin}/upload/v1/${id}`, file_id: id }
    },
    // https://docs.slack.dev/reference/methods/files.completeUploadExternal/
    'files.completeUploadExternal': (p) => {
      const list = (typeof p.files === 'string' ? JSON.parse(p.files) : p.files) as { id: string; title?: string }[] | undefined
      if (!Array.isArray(list) || !list.length) return err('invalid_arguments')
      const done = list.map((f) => ({ f, u: uploads.get(f.id) }))
      if (done.some(({ u }) => !u?.bytes)) return err('file_not_found')
      const c = p.channel_id ? findChannel(p.channel_id) : undefined
      if (p.channel_id) {
        if (!c) return err('channel_not_found')
        if (!c.is_member) return err('not_in_channel')
      }
      const thread = p.thread_ts ? String(p.thread_ts) : undefined
      if (c && thread && !c.messages.some((m) => m.ts === thread)) return err('invalid_thread_ts')
      const shared = done.map(({ f, u }) => {
        Object.assign(u!, {
          ...(c ? { channel: c.id } : {}),
          ...(thread ? { thread_ts: thread } : {}),
          ...(f.title ? { title: f.title } : {}),
          ...(p.initial_comment ? { comment: String(p.initial_comment) } : {}),
        })
        files.set(u!.id, { id: u!.id, name: u!.filename, mimetype: 'application/octet-stream', bytes: u!.bytes! })
        return { id: u!.id, name: u!.filename, title: f.title ?? u!.filename }
      })
      if (c)
        c.messages.unshift({
          ts: nextTs(),
          user: BOT_USER,
          bot_id: BOT_ID,
          text: p.initial_comment ? String(p.initial_comment) : '',
          ...(thread ? { thread_ts: thread } : {}),
          files: shared,
        })
      return {
        ok: true,
        files: shared.map((f) => ({ ...f, permalink: `https://example.slack.com/files/${BOT_USER}/${f.id}/${f.name}` })),
      }
    },
    'conversations.history': (p) => {
      const c = findChannel(p.channel)
      if (!c) return err('channel_not_found')
      if (!c.is_member && !c.is_im) return err('not_in_channel')
      const msgs = topLevel(c)
        .filter((m) => (!p.oldest || m.ts > String(p.oldest)) && (!p.latest || m.ts < String(p.latest)))
        .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      const { slice, meta, has_more } = page(msgs, p, 100)
      return { ok: true, messages: slice.map((m) => ({ type: 'message', ...m })), has_more, pin_count: 0, ...meta }
    },
    'conversations.replies': (p) => {
      const c = findChannel(p.channel)
      if (!c) return err('channel_not_found')
      const root = c.messages.find((m) => m.ts === p.ts)
      if (!root) return err('thread_not_found')
      const msgs = c.messages.filter((m) => m.ts === root.ts || m.thread_ts === root.ts).sort((a, b) => (a.ts < b.ts ? -1 : 1))
      const { slice, meta, has_more } = page(msgs, p, 1000)
      return { ok: true, messages: slice.map((m) => ({ type: 'message', ...m })), has_more, ...meta }
    },
    'reactions.add': (p) => {
      const c = findChannel(p.channel)
      if (!c) return err('channel_not_found')
      const m = c.messages.find((x) => x.ts === p.timestamp)
      if (!m) return err('message_not_found')
      if (!/^[a-z0-9_+-]+$/.test(String(p.name))) return err('invalid_name')
      m.reactions ??= []
      const r = m.reactions.find((x) => x.name === p.name)
      if (r?.users.includes(BOT_USER)) return err('already_reacted')
      if (r) {
        r.users.push(BOT_USER)
        r.count++
      } else m.reactions.push({ name: String(p.name), users: [BOT_USER], count: 1 })
      return { ok: true }
    },
    'reactions.remove': (p) => {
      const c = findChannel(p.channel)
      if (!c) return err('channel_not_found')
      const m = c.messages.find((x) => x.ts === p.timestamp)
      if (!m) return err('message_not_found')
      const r = m.reactions?.find((x) => x.name === p.name)
      if (!r?.users.includes(BOT_USER)) return err('no_reaction')
      r.users = r.users.filter((u) => u !== BOT_USER)
      r.count--
      if (m.reactions) m.reactions = m.reactions.filter((x) => x.count > 0)
      return { ok: true }
    },
    'users.info': (p) => {
      const u = users.get(String(p.user))
      if (!u) return err('user_not_found')
      return { ok: true, user: userJson(u) }
    },
    'users.lookupByEmail': (p) => {
      const u = [...users.values()].find((x) => x.email === p.email)
      if (!u) return err('users_not_found')
      return { ok: true, user: userJson(u) }
    },
    'conversations.open': (p) => {
      const ids = String(p.users ?? '')
        .split(',')
        .filter(Boolean)
      if (!ids.length) return err('users_list_not_supplied')
      if (ids.some((id) => !users.has(id))) return err('user_not_found')
      const id = `D${ids.join('')}`
      if (!channels.has(id)) channels.set(id, { id, is_member: true, is_im: ids.length === 1, messages: [] })
      return { ok: true, channel: { id }, ...(channels.get(id)?.messages.length ? { already_open: true } : {}) }
    },
    'conversations.list': (p) => {
      const types = String(p.types ?? 'public_channel').split(',')
      const all = [...channels.values()].filter(
        (c) => !c.is_im && types.includes(c.is_private ? 'private_channel' : 'public_channel') && (!c.is_private || c.is_member),
      )
      const { slice, meta } = page(all, p, 100)
      return {
        ok: true,
        channels: slice.map((c) => ({
          id: c.id,
          name: c.name,
          is_channel: !c.is_private,
          is_private: !!c.is_private,
          is_member: c.is_member,
          is_archived: false,
          topic: { value: c.topic ?? '', creator: '', last_set: 0 },
          purpose: { value: '', creator: '', last_set: 0 },
          num_members: 3,
        })),
        ...meta,
      }
    },
    'conversations.info': (p) => {
      const c = findChannel(p.channel)
      if (!c) return err('channel_not_found')
      return {
        ok: true,
        channel: c.is_im
          ? { id: c.id, is_im: true, user: 'U1' }
          : { id: c.id, name: c.name, is_channel: true, is_member: c.is_member },
      }
    },
  }

  const server: Server = createServer(async (req, res) => {
    // File downloads: /files-pri/T1-<id>/download/<name>, and /redirect?to=<url> (a 302).
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (path.startsWith('/redirect')) {
      const to = new URL(req.url ?? '', 'http://x').searchParams.get('to') ?? ''
      res.writeHead(302, { location: to })
      return res.end()
    }
    // Uploads: /upload/v1/<file id>, the bytes as the body (step 2 of the external upload flow).
    const up = /^\/upload\/v1\/([A-Z0-9]+)$/.exec(path)
    if (up) {
      const u = uploads.get(up[1]!)
      const bytes = await readBytes(req)
      if (!u || req.method !== 'POST') {
        res.writeHead(404)
        return res.end()
      }
      if (bytes.byteLength !== u.length) {
        res.writeHead(400)
        return res.end('length mismatch')
      }
      u.bytes = bytes
      u.auth = req.headers.authorization
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(`OK - ${bytes.byteLength}`)
    }
    const dl = /^\/files-pri\/T1-([A-Z0-9]+)\//.exec(path)
    if (dl) {
      downloads.push({ path, auth: req.headers.authorization })
      const f = files.get(dl[1]!)
      if (!f) {
        res.writeHead(404)
        return res.end()
      }
      if (f.asSignInPage || req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<html>Sign in to Slack</html>')
      }
      res.writeHead(200, { 'content-type': f.mimetype, 'content-length': String(f.bytes.byteLength) })
      return res.end(Buffer.from(f.bytes))
    }
    const method = (req.url ?? '').replace(/^\/api\//, '').split('?')[0] ?? ''
    const raw = await readBody(req)
    const contentType = String(req.headers['content-type'] ?? '')
    let params: Record<string, unknown> = {}
    if (contentType.startsWith('application/json')) params = raw ? JSON.parse(raw) : {}
    else params = Object.fromEntries(new URLSearchParams(raw))
    calls.push({ method, contentType, auth: req.headers.authorization, params })

    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
      res.end(body)
    }
    const queue = scripted.get(method)
    const next = queue?.shift()
    if (next) return send(next.status, next.body ?? '', next.headers)
    if (req.method !== 'POST') return send(405, JSON.stringify(err('method_not_allowed')))
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return send(200, JSON.stringify(err(req.headers.authorization ? 'invalid_auth' : 'not_authed')))
    const f = failures.get(method)
    if (f && f.times > 0) {
      f.times--
      return send(200, JSON.stringify({ ...err(f.error), ...f.extra }))
    }
    const h = handlers[method]
    if (!h) return send(404, JSON.stringify(err('unknown_method')))
    send(200, JSON.stringify(h(params)))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`

  return {
    url: `http://127.0.0.1:${port}/api`,
    calls,
    channels,
    users,
    files,
    downloads,
    uploads,
    script: (method, ...responses) => scripted.set(method, [...(scripted.get(method) ?? []), ...responses]),
    failWith: (method, error, times = Number.POSITIVE_INFINITY, extra) =>
      failures.set(method, { error, times, ...(extra ? { extra } : {}) }),
    callsTo: (method) => calls.filter((c) => c.method === method),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

function userJson(u: FakeUser) {
  return {
    id: u.id,
    team_id: 'T1',
    name: u.name,
    deleted: false,
    real_name: u.real_name,
    tz: u.tz ?? 'UTC',
    is_bot: !!u.is_bot,
    profile: {
      real_name: u.real_name,
      display_name: u.name,
      ...(u.email ? { email: u.email } : {}),
      title: '',
    },
  }
}
