import type { AttachmentDescription, AttachmentText, UploadedAttachment } from '@mp/api'
import { type AttachmentRecord, attachmentText, attachmentView, isImageAttachment } from '@mp/chat'
import { DeniedError, NotFoundError, UnavailableError, ValidationError } from '@mp/core'
import { TEXT_PREVIEW_MAX_BYTES, downloadMime, isTextMime, sniffImage } from '@mp/files'
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

/** The upload's bytes: the raw body, or the `file` field of a multipart form, with the type the sender claims. */
async function uploadBody(c: Context, maxBytes: number): Promise<{ bytes: Uint8Array; name?: string; claimedMime?: string }> {
  const declared = Number(c.req.header('content-length') ?? Number.NaN)
  // A multipart body carries a little more than the file.
  if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) throw new TooLargeError(maxBytes)
  const type = c.req.header('content-type') ?? ''
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') throw new BadRequestError('send the file as the `file` field')
    return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, ...(file.type ? { claimedMime: file.type } : {}) }
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.length > maxBytes) throw new TooLargeError(maxBytes)
  return { bytes, ...(type ? { claimedMime: type } : {}) }
}

class TooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super('too large')
  }
}

/**
 * Chat attachments over HTTP (docs/spec.md#attachments):
 * - `POST /api/chat/attachments?name=`: any file (raw body, or multipart `file`), typed by its content
 *   (a claimed image that isn't one is refused), within the size limit, stored as a pending upload of the
 *   signed-in person. Members only (the guard's `POST /api/chat/*`).
 * - `GET /api/chat/attachments/:id`: the bytes, for anyone who can see its message's channel (a DM's
 *   members only; 404 otherwise, so a DM's attachments don't show they exist). A pending upload only for
 *   its uploader. Always `nosniff` and a sandboxing CSP of its own. Images (PNG, JPEG, GIF, WebP by
 *   content) are served `inline` with their type; every other file as a download (`attachment`), and as
 *   `application/octet-stream` when a browser could run or render it (HTML, SVG, XML, JS, PDF).
 * - `GET /api/chat/attachments/:id/text`: a text file's content as JSON, at most 256 KB (`truncated`
 *   past that). The same visibility. For previews, shown as plain text.
 * - `GET /api/chat/attachments/:id/description`: its saved description (the same visibility as the image).
 * - `POST /api/chat/attachments/:id/describe`: makes, or redoes, the description (one model call). Admins
 *   and the uploader.
 * - `PATCH /api/chat/attachments/:id` `{ description }`: edits the description (marked as edited by the
 *   caller) or clears it (`null`). Admins and the uploader.
 */
export function chatAttachmentRoutes(s: Services, vis: ChatVisibility): Hono {
  const app = new Hono()

  app.post('/api/chat/attachments', async (c) => {
    const me = principalOf(c).contactId
    const max = s.attachments.limits.maxBytes
    let body: Awaited<ReturnType<typeof uploadBody>>
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
    const rec = await s.attachments.upload({
      bytes: body.bytes,
      ...(name ? { name } : {}),
      ...(body.claimedMime ? { claimedMime: body.claimedMime } : {}),
      by: { kind: 'contact', id: me },
    })
    const expiresAt = new Date(Date.parse(rec.data.createdAt) + s.attachments.limits.claimWindowMs).toISOString()
    return c.json({ attachment: attachmentView(rec), expiresAt } satisfies UploadedAttachment, 201)
  })

  /** The attachment, if the caller can see it (404 otherwise, even for admins in someone else's DM). */
  const visibleAttachment = async (c: Context): Promise<AttachmentRecord> => {
    const me = principalOf(c).contactId
    const id = c.req.param('id')!
    const rec = await s.attachments.get(id)
    const mine = rec?.data.uploadedBy.kind === 'contact' && rec.data.uploadedBy.id === me
    const visible = rec && (rec.data.channelId ? await vis.canSeeChannel(me, rec.data.channelId) : mine)
    if (!rec || !visible) throw new NotFoundError('attachment', id)
    return rec
  }
  const canEdit = (c: Context, rec: AttachmentRecord) => {
    const p = principalOf(c)
    return p.access === 'admin' || (rec.data.uploadedBy.kind === 'contact' && rec.data.uploadedBy.id === p.contactId)
  }
  const requireEditor = (c: Context, rec: AttachmentRecord) => {
    if (!canEdit(c, rec)) throw new DeniedError("only an admin or the image's uploader can change its description")
  }
  const descriptionOf = async (c: Context, rec: AttachmentRecord): Promise<AttachmentDescription> => ({
    attachment: attachmentView(rec),
    ...(rec.data.description && rec.data.descriptionEditedBy?.kind === 'contact'
      ? { editedByName: (await s.directory.contacts.get(rec.data.descriptionEditedBy.id))?.data.name ?? 'someone' }
      : {}),
    ...(rec.data.description && rec.data.describedAt ? { describedAt: rec.data.describedAt } : {}),
    ...(rec.data.description && rec.data.describedBy ? { describedBy: rec.data.describedBy } : {}),
    ...(rec.data.description && rec.data.descriptionEditedAt ? { editedAt: rec.data.descriptionEditedAt } : {}),
    available: s.describer.available,
    ...(s.describer.unavailableReason ? { unavailableReason: s.describer.unavailableReason } : {}),
    mode: s.describer.mode,
    canEdit: canEdit(c, rec),
  })

  app.get('/api/chat/attachments/:id/description', async (c) => {
    const rec = await visibleAttachment(c)
    return c.json(await descriptionOf(c, rec))
  })

  app.get('/api/chat/attachments/:id/text', async (c) => {
    const rec = await visibleAttachment(c)
    if (isImageAttachment(rec.data) || !isTextMime(rec.data.mime))
      throw new ValidationError(`${rec.data.name} is not a text file`)
    const got = await s.attachments.read(rec.id)
    if (!got) throw new NotFoundError('attachment', rec.id)
    const { text, truncated } = attachmentText(got.bytes, TEXT_PREVIEW_MAX_BYTES)
    return c.json({ attachment: attachmentView(rec), text, truncated } satisfies AttachmentText, 200, {
      'cache-control': 'private, max-age=86400',
    })
  })

  app.post('/api/chat/attachments/:id/describe', async (c) => {
    const rec = await visibleAttachment(c)
    requireEditor(c, rec)
    if (!isImageAttachment(rec.data)) throw new ValidationError('only images have descriptions')
    if (!rec.data.messageId) throw new ValidationError('an upload is described once it is on a message')
    if (!s.describer.available) throw new UnavailableError(s.describer.unavailableReason ?? 'images cannot be described')
    const out = await s.describer.describeAttachment(rec.id, { force: true, by: { requesterId: principalOf(c).contactId } })
    if (!out.ok) throw new UnavailableError(out.reason)
    return c.json(await descriptionOf(c, (await s.attachments.get(rec.id)) ?? rec))
  })

  app.patch('/api/chat/attachments/:id', async (c) => {
    const rec = await visibleAttachment(c)
    requireEditor(c, rec)
    const body = (await c.req.json().catch(() => null)) as { description?: unknown } | null
    const d = body?.description
    if (d !== null && typeof d !== 'string') throw new BadRequestError('send { description: string | null }')
    const next = await s.describer.edit(rec.id, d === null || !d.trim() ? null : d, {
      kind: 'contact',
      id: principalOf(c).contactId,
    })
    return c.json(await descriptionOf(c, next))
  })

  app.get('/api/chat/attachments/:id', async (c) => {
    const rec = await visibleAttachment(c)
    const id = rec.id
    const got = await s.attachments.read(id)
    if (!got) throw new NotFoundError('attachment', id)
    // The type comes from the bytes, again: never from the uploader. Only images are shown inline;
    // every other file is a download, and never with a type a browser would run or render.
    const info = sniffImage(got.bytes)
    const download = c.req.query('download') === '1' || !info
    return new Response(new Uint8Array(got.bytes) as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        'content-type': info?.mime ?? downloadMime(rec.data.mime),
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
