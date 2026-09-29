import type { UploadedAttachment } from '@mp/api'
import { attachmentView } from '@mp/chat'
import { NotFoundError } from '@mp/core'
import { sniffImage } from '@mp/files'
import { Hono, type Context } from 'hono'
import { principalOf } from '../auth/guard.ts'
import type { ChatVisibility } from '../auth/visibility.ts'
import type { Services } from '../services.ts'
import { BadRequestError } from './util.ts'

/** RFC 5987 `filename*` for a Content-Disposition header, plus an ASCII fallback. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** The upload's bytes: the raw body, or the `file` field of a multipart form. */
async function uploadBody(c: Context, maxBytes: number): Promise<{ bytes: Uint8Array; name?: string }> {
  const declared = Number(c.req.header('content-length') ?? Number.NaN)
  // A multipart body carries a little more than the file.
  if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) throw new TooLargeError(maxBytes)
  const type = c.req.header('content-type') ?? ''
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') throw new BadRequestError('send the image as the `file` field')
    return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.length > maxBytes) throw new TooLargeError(maxBytes)
  return { bytes }
}

class TooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super('too large')
  }
}

/**
 * Chat attachments over HTTP (docs/spec.md#attachments):
 * - `POST /api/chat/attachments?name=`: an image (raw body, or multipart `file`), checked by its content
 *   and size, stored as a pending upload of the signed-in person. Members only (the guard's `POST /api/chat/*`).
 * - `GET /api/chat/attachments/:id`: the image, for anyone who can see its message's channel (a DM's
 *   members only; 404 otherwise, so a DM's attachments don't show they exist). A pending upload only for
 *   its uploader. Served with the sniffed type, `nosniff`, `inline` (images only, never SVG or HTML),
 *   and a sandboxing CSP of its own.
 */
export function chatAttachmentRoutes(s: Services, vis: ChatVisibility): Hono {
  const app = new Hono()

  app.post('/api/chat/attachments', async (c) => {
    const me = principalOf(c).contactId
    const max = s.attachments.limits.maxBytes
    let body: { bytes: Uint8Array; name?: string }
    try {
      body = await uploadBody(c, max)
    } catch (e) {
      if (e instanceof TooLargeError)
        return c.json(
          { error: { code: 'validation', message: `an attachment can be at most ${Math.round(max / 1024 / 1024)} MB` } },
          413,
        )
      throw e
    }
    const name = c.req.query('name') ?? body.name
    const rec = await s.attachments.upload({ bytes: body.bytes, ...(name ? { name } : {}), by: { kind: 'contact', id: me } })
    const expiresAt = new Date(Date.parse(rec.data.createdAt) + s.attachments.limits.claimWindowMs).toISOString()
    return c.json({ attachment: attachmentView(rec), expiresAt } satisfies UploadedAttachment, 201)
  })

  app.get('/api/chat/attachments/:id', async (c) => {
    const me = principalOf(c).contactId
    const id = c.req.param('id')
    const rec = await s.attachments.get(id)
    const mine = rec?.data.uploadedBy.kind === 'contact' && rec.data.uploadedBy.id === me
    const visible = rec && (rec.data.channelId ? await vis.canSeeChannel(me, rec.data.channelId) : mine)
    if (!rec || !visible) throw new NotFoundError('attachment', id)
    const got = await s.attachments.read(id)
    if (!got) throw new NotFoundError('attachment', id)
    // The type comes from the bytes, again: never from the uploader, never anything a browser would run.
    const info = sniffImage(got.bytes)
    const download = c.req.query('download') === '1' || !info
    return new Response(new Uint8Array(got.bytes) as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        'content-type': info?.mime ?? 'application/octet-stream',
        'content-length': String(got.bytes.length),
        'x-content-type-options': 'nosniff',
        'content-disposition': disposition(download ? 'attachment' : 'inline', rec.data.name),
        'content-security-policy': "default-src 'none'; sandbox",
        // An id's bytes never change, but a DM's membership can: private, and checked again after a day.
        'cache-control': 'private, max-age=86400',
      },
    })
  })

  return app
}
