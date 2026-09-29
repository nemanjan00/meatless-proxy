import type { ApiErrorBody } from './errors.ts'

// ─── Chat attachments: images on messages ───────────────────────────────────
//
// Served by packages/server/src/http/chat-attachments.ts. Upload an image first (it is checked by
// its content: PNG, JPEG, GIF or WebP), then post a message with its id in `attachments`. Only the
// uploader can attach an upload, within an hour; unattached uploads are deleted after that.

/** An image on a message. */
export interface ChatAttachment {
  id: string
  name: string
  /** Sniffed from the bytes. */
  mime: string
  size: number
  width?: number
  height?: number
  /** What the image shows: its saved description, made by the model (or edited by a person). Untrusted. */
  description?: string
  /** Important text visible in the image, verbatim. */
  visibleText?: string
  /** Set when a person edited the description. */
  descriptionEditedBy?: { kind: string; id: string }
}

/** `GET /api/chat/attachments/:id/description` (and what `POST …/describe` and `PATCH` return). */
export interface AttachmentDescription {
  attachment: ChatAttachment
  /** When the description was made (or first made, for an edited one). */
  describedAt?: string
  /** The model that made it. */
  describedBy?: string
  editedAt?: string
  /** The name of the person who edited it. */
  editedByName?: string
  /** Whether descriptions can be made (`IMAGE_DESCRIBE` isn't off and the model can see images). */
  available: boolean
  /** Why not, when they can't. */
  unavailableReason?: string
  /** `view`, `upload` or `off`. */
  mode: string
  /** Whether the signed-in person may edit, clear or redo it (an admin, or the uploader). */
  canEdit: boolean
}

/** `POST /api/chat/attachments` → the pending upload. */
export interface UploadedAttachment {
  attachment: ChatAttachment
  /** When it is deleted unless a message claims it. */
  expiresAt: string
}

/** The routes of this section (merged into `ROUTES`). */
export const ATTACHMENT_ROUTES = {
  uploadAttachment: ['POST', '/api/chat/attachments'],
  getAttachment: ['GET', '/api/chat/attachments/:id'],
  attachmentDescription: ['GET', '/api/chat/attachments/:id/description'],
  describeAttachment: ['POST', '/api/chat/attachments/:id/describe'],
  updateAttachment: ['PATCH', '/api/chat/attachments/:id'],
} as const

export interface UploadOptions {
  /** The file name to show, e.g. `chart.png`. */
  name?: string
  /** Upload progress, 0 to 1 (only where the platform reports it: `XMLHttpRequest` in browsers). */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** The client methods of this section (part of `ApiClient`). */
export interface AttachmentsApi {
  /**
   * `POST /api/chat/attachments?name=` with the image as the raw body → the pending upload (201).
   * 422 for anything that isn't a PNG, JPEG, GIF or WebP by content, or over the size limit.
   */
  uploadAttachment(file: Blob, opts?: UploadOptions): Promise<UploadedAttachment>
  /**
   * The URL of `GET /api/chat/attachments/:id` (the image, for anyone who can see its channel),
   * for `<img src>`. `download` asks for `Content-Disposition: attachment`.
   */
  attachmentUrl(id: string, opts?: { download?: boolean }): string
  /** `GET /api/chat/attachments/:id/description`: the saved description (same visibility as the image). */
  attachmentDescription(id: string): Promise<AttachmentDescription>
  /** `POST /api/chat/attachments/:id/describe`: makes, or redoes, the description (admins and the uploader). */
  describeAttachment(id: string): Promise<AttachmentDescription>
  /**
   * `PATCH /api/chat/attachments/:id` `{ description }`: edits the description (marked as edited by you),
   * or clears it with `null`. Admins and the uploader.
   */
  updateAttachment(id: string, body: { description: string | null }): Promise<AttachmentDescription>
}

export interface RawRequest {
  base: string
  fetch: typeof fetch
  headers: () => Record<string, string>
}

interface ErrorBody {
  error?: Partial<ApiErrorBody>
}

/** The `AttachmentsApi` half of `createApiClient`. `fail` turns an error response into the client's error; `call` is its JSON request. */
export function attachmentsMethods(
  raw: RawRequest,
  fail: (status: number, body: ErrorBody | undefined, fallback: string) => Error,
  call: <T>(
    route: keyof typeof ATTACHMENT_ROUTES,
    params?: Record<string, string>,
    query?: undefined,
    body?: unknown,
  ) => Promise<T>,
): AttachmentsApi {
  const urlFor = (name?: string) =>
    `${raw.base}${ATTACHMENT_ROUTES.uploadAttachment[1]}${name ? `?name=${encodeURIComponent(name)}` : ''}`
  const parse = (text: string): unknown => {
    try {
      return text ? JSON.parse(text) : undefined
    } catch {
      return undefined
    }
  }
  return {
    uploadAttachment(file, opts = {}) {
      const name = opts.name ?? (file as { name?: string }).name
      const url = urlFor(name)
      const headers = { accept: 'application/json', 'content-type': file.type || 'application/octet-stream', ...raw.headers() }
      // Browsers report upload progress only through XMLHttpRequest.
      if (opts.onProgress && typeof XMLHttpRequest !== 'undefined') {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', url)
          xhr.withCredentials = true
          for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) opts.onProgress!(e.loaded / e.total)
          }
          xhr.onload = () => {
            const body = parse(xhr.responseText)
            if (xhr.status >= 200 && xhr.status < 300) {
              opts.onProgress!(1)
              resolve(body as UploadedAttachment)
            } else reject(fail(xhr.status, body as ErrorBody, `upload failed: ${xhr.status}`))
          }
          xhr.onerror = () => reject(fail(0, undefined, 'upload failed: network error'))
          xhr.onabort = () => reject(new DOMException('upload aborted', 'AbortError'))
          opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
          xhr.send(file)
        })
      }
      return raw
        .fetch(url, { method: 'POST', headers, body: file, ...(opts.signal ? { signal: opts.signal } : {}) })
        .then(async (res) => {
          const body = parse(await res.text())
          if (!res.ok) throw fail(res.status, body as ErrorBody, `upload failed: ${res.status}`)
          opts.onProgress?.(1)
          return body as UploadedAttachment
        })
    },
    attachmentUrl: (id, opts = {}) =>
      `${raw.base}/api/chat/attachments/${encodeURIComponent(id)}${opts.download ? '?download=1' : ''}`,
    attachmentDescription: (id) => call('attachmentDescription', { id }),
    describeAttachment: (id) => call('describeAttachment', { id }, undefined, {}),
    updateAttachment: (id, body) => call('updateAttachment', { id }, undefined, body),
  }
}
