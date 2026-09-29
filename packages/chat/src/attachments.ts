import {
  ConflictError,
  DeniedError,
  NotFoundError,
  ValidationError,
  errorMessage,
  silentLogger,
  systemClock,
  type Clock,
  type Json,
  type KindSchema,
  type Logger,
} from '@mp/core'
import { type FileStorage, sha256Hex, sniffImage } from '@mp/files'
import type { Records } from '@mp/records'
import type { Actor, Condition, Ref, StoredRecord } from '@mp/store'

/**
 * Chat attachments: images people and employees attach to messages. The bytes live in a
 * `FileStorage` (the files volume) under the owner `attachments`, apart from employees' own files:
 * `/pending/<id>` until a message claims them, then `/<channelId>/<id>`. The database keeps only
 * their metadata (a `chat_attachment` record, and a copy on the message).
 */

/** The storage owner holding every chat attachment. Employee ids (`emp_…`) can't collide with it. */
export const ATTACHMENTS_OWNER = 'attachments'

/** Accepted types, checked by magic bytes. No SVG: it is a document that can run script. */
export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export interface AttachmentLimits {
  /** Bytes per attachment. Default 10 MB. */
  maxBytes: number
  /** Attachments per message. Default 10. */
  maxPerMessage: number
  /** How long an upload can wait for its message; an older unclaimed upload is deleted. Default 1 hour. */
  claimWindowMs: number
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxPerMessage: 10,
  claimWindowMs: 60 * 60 * 1000,
}

const refFields = [
  { name: 'kind', type: 'string' as const, required: true },
  { name: 'id', type: 'string' as const, required: true },
]

export const attachmentSchema: KindSchema = {
  kind: 'chat_attachment',
  prefix: 'att',
  description: 'An image attached to a chat message. The bytes are on the files volume; this is its metadata.',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'mime', type: 'string', required: true, description: 'Sniffed from the bytes, never taken from the uploader.' },
    { name: 'size', type: 'number', required: true },
    { name: 'width', type: 'number' },
    { name: 'height', type: 'number' },
    { name: 'sha256', type: 'string', required: true },
    { name: 'uploadedBy', type: 'object', required: true, fields: refFields },
    { name: 'createdAt', type: 'timestamp', required: true },
    { name: 'channelId', type: 'ref', ref: 'channel', description: 'Set when a message claims it.' },
    { name: 'messageId', type: 'ref', ref: 'message', description: 'The message it belongs to; unset while pending.' },
    {
      name: 'description',
      type: 'string',
      description:
        'What the image shows, in 1-3 sentences, made by the model (or edited by a person). Untrusted: derived from the image.',
    },
    { name: 'visibleText', type: 'string', description: 'Important text visible in the image, verbatim (capped).' },
    { name: 'describedAt', type: 'timestamp' },
    { name: 'describedBy', type: 'string', description: 'The model that made the description.' },
    { name: 'descriptionEditedBy', type: 'object', fields: refFields, description: 'Set when a person edited the description.' },
    { name: 'descriptionEditedAt', type: 'timestamp' },
  ],
}

export interface AttachmentData extends Record<string, unknown> {
  name: string
  mime: string
  size: number
  width?: number
  height?: number
  sha256: string
  uploadedBy: Ref
  createdAt: string
  channelId?: string
  messageId?: string
  description?: string
  visibleText?: string
  describedAt?: string
  describedBy?: string
  descriptionEditedBy?: Ref
  descriptionEditedAt?: string
}
export type AttachmentRecord = StoredRecord<AttachmentData>

/** An attachment as a message carries it. */
export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  width?: number
  height?: number
  /** What the image shows (a saved description, see `ImageDescriber`). Derived from the image: untrusted. */
  description?: string
  /** Important text visible in the image, verbatim. */
  visibleText?: string
  /** Set when a person edited the description. */
  descriptionEditedBy?: Ref
}

export interface UploadInput {
  bytes: Uint8Array
  /** A file name, e.g. `chart.png`. Cleaned; defaults to `image.<ext>`. */
  name?: string
  /** Who uploads: only they can attach it to a message. */
  by: Ref
}

export interface ChatAttachments {
  readonly limits: AttachmentLimits
  /** Checks the bytes (an image by its magic bytes, within the size limit) and stores them as a pending upload. */
  upload(input: UploadInput): Promise<AttachmentRecord>
  /**
   * Checks that `ids` can go on a message by `by`: at most `maxPerMessage`, each a pending upload of
   * `by` within the claim window. `DeniedError` for someone else's upload, `ConflictError` for one
   * already on a message, `NotFoundError` for an unknown or expired one.
   */
  check(ids: string[], by: Ref): Promise<AttachmentRecord[]>
  /** Claims checked uploads for a message (compare-and-swap: one message wins). Rolls back on failure. */
  claim(ids: string[], o: { by: Ref; channelId: string; messageId: string }): Promise<Attachment[]>
  get(id: string): Promise<AttachmentRecord | null>
  /** The metadata and bytes, or null when either is gone. */
  read(id: string): Promise<{ attachment: AttachmentRecord; bytes: Uint8Array } | null>
  /** Deletes a message's attachments (bytes and records). */
  removeForMessage(messageId: string): Promise<number>
  /**
   * Deletes uploads nobody attached within the claim window, and claims whose message never
   * appeared (a crash between claiming and posting). Returns how many went.
   */
  cleanup(): Promise<number>
}

export interface ChatAttachmentsOptions {
  records: Records
  storage: FileStorage
  clock?: Clock
  logger?: Logger
  limits?: Partial<AttachmentLimits>
}

/** Metadata as a message carries it. */
export const attachmentView = (a: AttachmentRecord): Attachment => ({
  id: a.id,
  name: a.data.name,
  mime: a.data.mime,
  size: a.data.size,
  ...(a.data.width ? { width: a.data.width } : {}),
  ...(a.data.height ? { height: a.data.height } : {}),
  ...(a.data.description ? { description: a.data.description } : {}),
  ...(a.data.description && a.data.visibleText ? { visibleText: a.data.visibleText } : {}),
  ...(a.data.description && a.data.descriptionEditedBy
    ? { descriptionEditedBy: { kind: a.data.descriptionEditedBy.kind, id: a.data.descriptionEditedBy.id } }
    : {}),
})

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** A safe display name: the last path segment, no control characters, at most 120 characters. */
export function cleanAttachmentName(raw: string | undefined, mime: string): string {
  const base = String(raw ?? '')
    .split(/[\\/]/)
    .pop()!
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f"<>]/g, '')
    .trim()
    .slice(-120)
  return base && base !== '.' && base !== '..' ? base : `image.${EXT[mime] ?? 'bin'}`
}

/** A description as the model sees it: one line, quoted (JSON string escaping), at most `max` characters. */
export function quoteForModel(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return JSON.stringify(one.length > max ? `${one.slice(0, max - 1)}…` : one)
}

/**
 * How an event or a tool shows an attachment to the model, e.g. `[image: chart.png 800x600, attachment att_…]`,
 * or with its saved description `[image: chart.png 800x600, attachment att_…: "A bar chart of …"]`. With
 * `text`, the text visible in it follows (`; text: "…"`).
 */
export function attachmentLine(a: Attachment, o: { text?: boolean } = {}): string {
  const size = a.width && a.height ? ` ${a.width}x${a.height}` : ''
  const desc = a.description ? `: ${quoteForModel(a.description, 600)}` : ''
  const text = o.text && a.description && a.visibleText ? `; text: ${quoteForModel(a.visibleText, 400)}` : ''
  return `[image: ${a.name}${size}, attachment ${a.id}${desc}${text}]`
}

const formatBytes = (n: number) =>
  n >= 1024 * 1024 ? `${Math.round((n / 1024 / 1024) * 10) / 10} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`

const pendingPath = (id: string) => `/pending/${id}`
const channelPath = (channelId: string, id: string) => `/${channelId}/${id}`
const sameRef = (a: Ref, b: Ref) => a.kind === b.kind && a.id === b.id
/** The record actor for a person or a session; others (employees) act as the system. */
const actorOpt = (r: Ref): { actor?: Actor } =>
  r.kind === 'contact' || r.kind === 'session' ? { actor: { type: r.kind, id: r.id } } : {}

export function createChatAttachments(opts: ChatAttachmentsOptions): ChatAttachments {
  const { records, storage } = opts
  const clock = opts.clock ?? systemClock
  const log = opts.logger ?? silentLogger
  const limits: AttachmentLimits = { ...DEFAULT_ATTACHMENT_LIMITS, ...opts.limits }
  if (!records.kinds.has(attachmentSchema.kind)) records.kinds.define(attachmentSchema)

  const pathOf = (a: AttachmentRecord) => (a.data.channelId ? channelPath(a.data.channelId, a.id) : pendingPath(a.id))
  const expired = (a: AttachmentRecord) => Date.parse(a.data.createdAt) + limits.claimWindowMs < clock.now()

  const removeBytes = async (a: AttachmentRecord) => {
    for (const p of new Set([pathOf(a), pendingPath(a.id)]))
      await storage.delete(ATTACHMENTS_OWNER, p).catch((e) => {
        if (!(e instanceof NotFoundError)) throw e
      })
  }
  const remove = async (a: AttachmentRecord) => {
    await removeBytes(a)
    await records.delete(attachmentSchema.kind, a.id, { cascade: true }).catch((e) => {
      if (!(e instanceof NotFoundError)) throw e
    })
  }

  const api: ChatAttachments = {
    limits,

    async upload({ bytes, name, by }) {
      if (!(bytes instanceof Uint8Array) || !bytes.length) throw new ValidationError('the attachment is empty')
      if (bytes.length > limits.maxBytes)
        throw new ValidationError(`an attachment can be at most ${formatBytes(limits.maxBytes)}`, [], {
          size: bytes.length,
          maxBytes: limits.maxBytes,
        })
      const info = sniffImage(bytes)
      if (!info) throw new ValidationError('only images can be attached: PNG, JPEG, GIF or WebP (checked by content)')
      if (!by?.kind || !by.id) throw new ValidationError('the uploader is required')
      const rec = await records.create<AttachmentData>(
        attachmentSchema.kind,
        {
          name: cleanAttachmentName(name, info.mime),
          mime: info.mime,
          size: bytes.length,
          ...(info.width ? { width: info.width } : {}),
          ...(info.height ? { height: info.height } : {}),
          sha256: sha256Hex(bytes),
          uploadedBy: { kind: by.kind, id: by.id },
          createdAt: clock.iso(),
        },
        actorOpt(by),
      )
      try {
        await storage.write(ATTACHMENTS_OWNER, pendingPath(rec.id), bytes)
      } catch (e) {
        await records.delete(attachmentSchema.kind, rec.id, { cascade: true }).catch(() => {})
        throw e
      }
      return rec
    },

    async check(ids, by) {
      if (!Array.isArray(ids)) throw new ValidationError('attachments must be a list of attachment ids')
      const uniq = [...new Set(ids.map(String))]
      if (uniq.length > limits.maxPerMessage)
        throw new ValidationError(`a message can have at most ${limits.maxPerMessage} attachments`, [], { count: uniq.length })
      const out: AttachmentRecord[] = []
      for (const id of uniq) {
        const a = await records.get<AttachmentData>(attachmentSchema.kind, id)
        if (!a || (!a.data.messageId && expired(a))) throw new NotFoundError('attachment', id)
        if (!sameRef(a.data.uploadedBy, by)) throw new DeniedError('only the uploader can attach an upload')
        if (a.data.messageId) throw new ConflictError(`attachment ${id} is already on a message`)
        out.push(a)
      }
      return out
    },

    async claim(ids, o) {
      const checked = await api.check(ids, o.by)
      const done: { before: AttachmentRecord; after: AttachmentRecord }[] = []
      try {
        for (const a of checked) {
          const after = await records.update<AttachmentData>(
            attachmentSchema.kind,
            a.id,
            { channelId: o.channelId, messageId: o.messageId },
            { expectedVersion: a.version, ...actorOpt(o.by) },
          )
          done.push({ before: a, after })
          await storage.move(ATTACHMENTS_OWNER, pendingPath(a.id), channelPath(o.channelId, a.id), { overwrite: true })
        }
      } catch (e) {
        // Put back what this call claimed, so the uploader can try again.
        for (const { before, after } of done.reverse()) {
          await storage
            .move(ATTACHMENTS_OWNER, channelPath(o.channelId, before.id), pendingPath(before.id), { overwrite: true })
            .catch(() => {})
          await records
            .update<AttachmentData>(
              attachmentSchema.kind,
              before.id,
              { channelId: undefined, messageId: undefined },
              { expectedVersion: after.version },
            )
            .catch((err) => log.warn('attachment rollback failed', { id: before.id, err: errorMessage(err) }))
        }
        if (e instanceof ConflictError) throw new ConflictError('an attachment was just attached to another message')
        throw e
      }
      return done.map((d) => attachmentView(d.after))
    },

    get: (id) => records.get<AttachmentData>(attachmentSchema.kind, id),

    async read(id) {
      const attachment = await api.get(id)
      if (!attachment) return null
      for (const p of new Set([pathOf(attachment), pendingPath(id)])) {
        try {
          return { attachment, bytes: await storage.read(ATTACHMENTS_OWNER, p) }
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e
        }
      }
      return null
    },

    async removeForMessage(messageId) {
      const found = await records.query<AttachmentData>(attachmentSchema.kind, { where: { messageId }, limit: 1000 })
      for (const a of found.items) await remove(a)
      return found.items.length
    },

    async cleanup() {
      const cutoff = new Date(clock.now() - limits.claimWindowMs).toISOString()
      let n = 0
      const pending: Condition[] = [
        { field: 'messageId', op: 'exists', value: false },
        { field: 'createdAt', op: 'lt', value: cutoff },
      ]
      for (const a of (await records.query<AttachmentData>(attachmentSchema.kind, { where: pending, limit: 1000 })).items) {
        await remove(a)
        n++
      }
      // Claimed in the last day, but the message never appeared.
      const recent: Condition[] = [
        { field: 'messageId', op: 'exists', value: true },
        { field: 'createdAt', op: 'lt', value: cutoff },
        { field: 'createdAt', op: 'gt', value: new Date(clock.now() - limits.claimWindowMs - 86_400_000).toISOString() },
      ]
      for (const a of (await records.query<AttachmentData>(attachmentSchema.kind, { where: recent, limit: 1000 })).items) {
        if (await records.get('message', a.data.messageId!)) continue
        await remove(a)
        n++
      }
      return n
    },
  }
  return api
}

/** The attachments of a message's data, tolerating older messages without any. */
export function attachmentsOf(data: { attachments?: unknown }): Attachment[] {
  return Array.isArray(data.attachments) ? (data.attachments as Attachment[]) : []
}

/** Attachment metadata as JSON, for event payloads. */
export const attachmentsJson = (list: Attachment[]) => list as unknown as Json
