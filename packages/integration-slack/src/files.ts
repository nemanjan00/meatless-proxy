import { DeniedError, LimitError, MpError, NotFoundError, UnavailableError, ValidationError, errorMessage } from '@mp/core'
import { type SlackClient, slackErrorCode } from './client.ts'

/**
 * Files people share in Slack: metadata from `files.info`, and the bytes from the file's
 * `url_private_download`, fetched with the bot token (bot scope `files:read`).
 *
 * - files.info: https://docs.slack.dev/reference/methods/files.info/
 * - file object: https://docs.slack.dev/reference/objects/file-object/
 */

/** Largest file downloaded. */
export const SLACK_FILE_MAX_BYTES = 25 * 1024 * 1024
/** Redirects followed, each to a Slack host. */
const MAX_REDIRECTS = 5

/** A file as the model sees it. */
export interface SlackFileInfo {
  id: string
  name: string
  mime?: string
  filetype?: string
  size?: number
  title?: string
  /** `hosted` (in Slack), `external` (e.g. Google Drive: not downloadable), `snippet`, `tombstone` (deleted). */
  mode?: string
}

export interface SlackDownload extends SlackFileInfo {
  bytes: Uint8Array
}

export interface DownloadOptions {
  maxBytes?: number
  signal?: AbortSignal
}

/**
 * Slack's own hosts, the only ones a download (and its redirects) may reach: `slack.com`,
 * `slack-edge.com` and `slack-files.com`, with their subdomains (`files.slack.com`).
 */
export function isSlackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return ['slack.com', 'slack-edge.com', 'slack-files.com'].some((d) => h === d || h.endsWith(`.${d}`))
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)

/** `files.info` → the file's metadata and its download URL. */
export async function fileInfo(client: SlackClient, fileId: string): Promise<SlackFileInfo & { url?: string }> {
  if (!/^F[A-Z0-9]+$/.test(fileId)) throw new ValidationError(`not a Slack file id: ${fileId} (they look like F0123ABCD)`)
  let r: Awaited<ReturnType<SlackClient['call']>>
  try {
    r = await client.call('files.info', { file: fileId, count: 0 })
  } catch (err) {
    const code = slackErrorCode(err)
    if (code === 'file_not_found' || code === 'file_deleted') throw new NotFoundError('Slack file', fileId, { error: code })
    if (code === 'missing_scope') throw new DeniedError('the Slack app lacks the files:read scope: add it and reinstall the app')
    throw err
  }
  const f = (r.file ?? {}) as Record<string, unknown>
  const size = typeof f.size === 'number' ? f.size : undefined
  const url = str(f.url_private_download) ?? str(f.url_private)
  return {
    id: str(f.id) ?? fileId,
    name: str(f.name) ?? str(f.title) ?? fileId,
    ...(str(f.mimetype) ? { mime: str(f.mimetype)! } : {}),
    ...(str(f.filetype) ? { filetype: str(f.filetype)! } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(str(f.title) ? { title: str(f.title)! } : {}),
    ...(str(f.mode) ? { mode: str(f.mode)! } : {}),
    ...(url ? { url } : {}),
  }
}

/**
 * Downloads a file shared in Slack: `files.info`, then its `url_private_download` with the bot
 * token. Only Slack's hosts are contacted (redirects included; `allowHost` adds a test server),
 * the token is sent to nothing else, and the body is cut off past `maxBytes` (25 MB).
 */
export async function downloadSlackFile(
  deps: { client: SlackClient; token: string; fetch?: typeof fetch; allowHost?: (host: string) => boolean },
  fileId: string,
  opts: DownloadOptions = {},
): Promise<SlackDownload> {
  const max = opts.maxBytes ?? SLACK_FILE_MAX_BYTES
  const info = await fileInfo(deps.client, fileId)
  if (info.mode === 'external')
    throw new ValidationError(`${info.name} is an external file (not stored in Slack): open its link instead`)
  if (info.mode === 'tombstone') throw new MpError('not_found', `${info.name} was deleted`)
  if (info.size !== undefined && info.size > max) throw new LimitError(`${info.name} is ${info.size} bytes; the limit is ${max}`)
  if (!info.url) throw new MpError('not_found', `${info.name} has no download URL`)
  const doFetch = deps.fetch ?? fetch
  const allowed = (u: URL) => (u.protocol === 'https:' && isSlackHost(u.hostname)) || (deps.allowHost?.(u.host) ?? false)

  let url: URL
  try {
    url = new URL(info.url)
  } catch {
    throw new MpError('integration_request', `slack: bad download URL for ${fileId}`)
  }
  let res: Response | undefined
  for (let hop = 0; ; hop++) {
    if (!allowed(url)) throw new DeniedError(`the download of ${fileId} would go to ${url.host}, which is not Slack`)
    try {
      res = await doFetch(url.href, {
        method: 'GET',
        headers: { authorization: `Bearer ${deps.token}` },
        redirect: 'manual',
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (err) {
      const reason = errorMessage(err).split(deps.token).join('[redacted]')
      throw new UnavailableError(`slack file download failed: ${reason}`)
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {})
      if (hop >= MAX_REDIRECTS) throw new MpError('integration_request', `slack file download: too many redirects`)
      url = new URL(res.headers.get('location')!, url)
      continue
    }
    break
  }
  if (res.status >= 500) {
    await res.body?.cancel().catch(() => {})
    throw new UnavailableError(`slack file download: HTTP ${res.status}`)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new MpError('integration_request', `slack file download: HTTP ${res.status}`, { status: res.status })
  }
  // Without files:read, Slack answers the download URL with its sign-in page.
  const type = res.headers.get('content-type') ?? ''
  if (type.startsWith('text/html') && !(info.mime ?? '').startsWith('text/html')) {
    await res.body?.cancel().catch(() => {})
    throw new DeniedError('Slack answered with a web page instead of the file: the app needs the files:read scope')
  }
  const length = Number(res.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(length) && length > max) {
    await res.body?.cancel().catch(() => {})
    throw new LimitError(`${info.name} is ${length} bytes; the limit is ${max}`)
  }
  const bytes = await readCapped(res, max, info.name)
  const { url: _url, ...meta } = info
  return { ...meta, size: bytes.byteLength, bytes }
}

async function readCapped(res: Response, max: number, name: string): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new LimitError(`${name} is over ${max} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/**
 * Sharing a file into Slack with the external upload flow (`files.upload` is being retired):
 *
 * 1. `files.getUploadURLExternal { filename, length }` → `{ upload_url, file_id }`
 *    https://docs.slack.dev/reference/methods/files.getUploadURLExternal/
 * 2. POST the bytes to `upload_url` (Slack's hosts only, over https)
 * 3. `files.completeUploadExternal { files: [{ id, title }], channel_id, thread_ts?, initial_comment? }`
 *    https://docs.slack.dev/reference/methods/files.completeUploadExternal/
 *
 * Overview: https://docs.slack.dev/messaging/working-with-files/#uploading_files. Bot scope `files:write`.
 */

/** Largest file uploaded. */
export const SLACK_UPLOAD_MAX_BYTES = 25 * 1024 * 1024

export interface SlackUploadInput {
  bytes: Uint8Array
  /** The file name Slack shows (and derives the type from). */
  filename: string
  channel: string
  thread_ts?: string
  /** Default: the file name. */
  title?: string
  /** A message posted with the file (mrkdwn). */
  comment?: string
}

export interface SlackUploadResult {
  fileId: string
  channel: string
  thread_ts?: string
  permalink?: string
}

const MISSING_WRITE_SCOPE = 'the Slack app lacks the files:write scope: add files:write and reinstall the app'

/** Slack's missing scope as a `DeniedError` naming `files:write`; other errors unchanged. */
const writeScope = (err: unknown) => (slackErrorCode(err) === 'missing_scope' ? new DeniedError(MISSING_WRITE_SCOPE) : err)

/**
 * Uploads a file into a channel or thread (see above). The bytes go to Slack's hosts only
 * (`allowHost` adds a test server), redirects aren't followed, and files over `maxBytes` (25 MB)
 * or empty ones are refused before anything is sent.
 */
export async function uploadSlackFile(
  deps: { client: SlackClient; token: string; fetch?: typeof fetch; allowHost?: (host: string) => boolean },
  input: SlackUploadInput,
  opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<SlackUploadResult> {
  const max = opts.maxBytes ?? SLACK_UPLOAD_MAX_BYTES
  const size = input.bytes.byteLength
  const filename = input.filename.trim()
  if (!filename) throw new ValidationError('the file needs a name')
  if (size === 0) throw new ValidationError(`${filename} is empty: Slack takes no empty files`)
  if (size > max) throw new LimitError(`${filename} is ${size} bytes; the limit is ${max}`)

  const slot = await deps.client.call('files.getUploadURLExternal', { filename, length: size }).catch((err) => {
    throw writeScope(err)
  })
  const fileId = str(slot.file_id)
  const uploadUrl = str(slot.upload_url)
  if (!fileId || !uploadUrl)
    throw new MpError('integration_request', 'slack files.getUploadURLExternal: no upload_url or file_id')
  let url: URL
  try {
    url = new URL(uploadUrl)
  } catch {
    throw new MpError('integration_request', 'slack: bad upload URL')
  }
  const allowed = (url.protocol === 'https:' && isSlackHost(url.hostname)) || (deps.allowHost?.(url.host) ?? false)
  if (!allowed) throw new DeniedError(`the upload of ${filename} would go to ${url.host}, which is not Slack`)

  const doFetch = deps.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(url.href, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/octet-stream' },
      body: input.bytes as Uint8Array<ArrayBuffer>,
      redirect: 'manual',
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    const reason = errorMessage(err).split(deps.token).join('[redacted]')
    throw new UnavailableError(`slack file upload failed: ${reason}`)
  }
  await res.body?.cancel().catch(() => {})
  if (res.status >= 500) throw new UnavailableError(`slack file upload: HTTP ${res.status}`)
  if (res.status !== 200)
    throw new MpError('integration_request', `slack file upload: HTTP ${res.status}`, { status: res.status })

  const done = await deps.client
    .call(
      'files.completeUploadExternal',
      {
        files: [{ id: fileId, title: input.title?.trim() || filename }],
        channel_id: input.channel,
        thread_ts: input.thread_ts,
        initial_comment: input.comment,
      },
      { write: true, json: true },
    )
    .catch((err) => {
      throw writeScope(err)
    })
  const file = (Array.isArray(done.files) ? (done.files[0] as Record<string, unknown> | undefined) : undefined) ?? {}
  const permalink = str(file.permalink)
  return {
    fileId: str(file.id) ?? fileId,
    channel: input.channel,
    ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
    ...(permalink ? { permalink } : {}),
  }
}
