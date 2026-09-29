import { attachmentView, type ChatAuthor } from '@mp/chat'
import { NotFoundError, ValidationError } from '@mp/core'
import { sniffImage } from '@mp/files'
import type { Services } from './services.ts'

/** An image as MCP clients send it to chat_post. */
export interface McpImageInput {
  name?: string | undefined
  mime?: string | undefined
  data: string
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Uploads the images of a chat_post as `author`, with the same checks as the web upload: the
 * per-message count, the size limit, and the type from the bytes. A declared `mime` that the bytes
 * don't bear out is refused rather than trusted. Returns the upload ids, for `chat.post`.
 */
export async function uploadMcpAttachments(s: Services, author: ChatAuthor, images: McpImageInput[]): Promise<string[]> {
  if (!images.length) return []
  const { maxPerMessage, maxBytes } = s.attachments.limits
  if (images.length > maxPerMessage) throw new ValidationError(`a message can have at most ${maxPerMessage} attachments`)
  const decoded = images.map((img, i) => {
    const data = img.data.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '')
    if (!data || !BASE64.test(data) || data.length % 4 === 1) throw new ValidationError(`attachment ${i + 1} is not valid base64`)
    // Checked before decoding, so a huge string isn't decoded only to be refused.
    if (Math.floor((data.length * 3) / 4) > maxBytes + 2)
      throw new ValidationError(`attachment ${i + 1} is over ${Math.round(maxBytes / 1024 / 1024)} MB`)
    const bytes = new Uint8Array(Buffer.from(data, 'base64'))
    const info = sniffImage(bytes)
    if (!info) throw new ValidationError(`attachment ${i + 1} is not a PNG, JPEG, GIF or WebP image`)
    if (img.mime && img.mime.toLowerCase() !== info.mime)
      throw new ValidationError(`attachment ${i + 1} says it is ${img.mime}, but it is ${info.mime}`)
    return { bytes, name: img.name }
  })
  const ids: string[] = []
  for (const d of decoded)
    ids.push((await s.attachments.upload({ bytes: d.bytes, ...(d.name ? { name: d.name } : {}), by: author })).id)
  return ids
}

/** chat_attachment: the image as MCP image content, plus its metadata, if the caller can see its channel. */
export async function mcpAttachmentContent(s: Services, id: string, canSee: (channelId: string) => Promise<boolean>) {
  const rec = await s.attachments.get(id)
  if (!rec?.data.channelId || !(await canSee(rec.data.channelId))) throw new NotFoundError('attachment', id)
  const got = await s.attachments.read(id)
  const info = got && sniffImage(got.bytes)
  if (!got || !info) throw new NotFoundError('attachment', id)
  return {
    content: [
      { type: 'image' as const, data: Buffer.from(got.bytes).toString('base64'), mimeType: info.mime },
      { type: 'text' as const, text: JSON.stringify({ ...attachmentView(rec), messageId: rec.data.messageId }) },
    ],
  }
}
