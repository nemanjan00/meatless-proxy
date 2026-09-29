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
}

export interface RawRequest {
  base: string
  fetch: typeof fetch
  headers: () => Record<string, string>
}

interface ErrorBody {
  error?: Partial<ApiErrorBody>
}

/** The `AttachmentsApi` half of `createApiClient`. `fail` turns an error response into the client's error. */
export function attachmentsMethods(
  raw: RawRequest,
  fail: (status: number, body: ErrorBody | undefined, fallback: string) => Error,
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
  }
}
