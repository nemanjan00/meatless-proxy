import { NotFoundError, ValidationError } from '@mp/core'
import { attachmentView, type Attachment } from '@mp/chat'
import { basename, decodeContent, prepareImage, sha256Hex, sniffImage } from '@mp/files'
import type { ImageRef } from '@mp/model'
import { VISION_TAG } from '@mp/runner'
import type { Ref } from '@mp/store'
import type { ToolContext } from '@mp/tools'
import { fail, type Kit } from '../kit.ts'

export const DEFAULT_IMAGE_MAX_SIDE = 1568
export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** A file of the employee's filesystem (or shared with it), read with the employee's own permissions. */
export async function readImageFile(kit: Kit, ctx: ToolContext, path: string) {
  const f = await kit.deps.files.forEmployee(ctx.employeeId).read(path)
  const bytes = decodeContent(f.content, f.encoding)
  const info = sniffImage(bytes)
  if (!info) throw new ValidationError(`${f.path} is not an image (PNG, JPEG, GIF or WebP, checked by content)`)
  return { file: f, bytes, info, name: basename(f.path) }
}

/**
 * Whether an employee can see a chat channel: any named channel; a DM only when the employee, its
 * contact or one of its sessions is a member (the same rule as people's DMs).
 */
export async function employeeSeesChannel(kit: Kit, employeeId: string, channelId: string): Promise<boolean> {
  const ch = await kit.deps.chat.getChannel(channelId)
  if (!ch) return false
  if (ch.data.dm !== true) return true
  const contactId = (await kit.deps.directory.employees.get(employeeId))?.data.contactId
  for (const m of await kit.deps.chat.members(channelId)) {
    if (m.kind === 'employee' && m.id === employeeId) return true
    if (m.kind === 'contact' && m.id === contactId) return true
    if (m.kind === 'session' && (await kit.deps.sessions.get(m.id))?.data.employeeId === employeeId) return true
  }
  return false
}

/** Copies files of the employee's filesystem into chat uploads by `author`, returning their ids. */
export async function uploadFiles(kit: Kit, ctx: ToolContext, specs: unknown, author: Ref): Promise<string[]> {
  if (specs === undefined || specs === null) return []
  if (!Array.isArray(specs)) throw new ValidationError('attachments must be a list of { path }')
  if (!specs.length) return []
  const store = kit.deps.attachments
  if (!store) throw new ValidationError('this harness takes no chat attachments')
  if (specs.length > store.limits.maxPerMessage)
    throw new ValidationError(`a message can have at most ${store.limits.maxPerMessage} attachments`)
  const ids: string[] = []
  for (const s of specs) {
    const path = typeof s === 'string' ? s : (s as { path?: unknown } | null)?.path
    if (typeof path !== 'string' || !path.trim()) throw new ValidationError('each attachment needs a path')
    const img = await readImageFile(kit, ctx, path)
    ids.push((await store.upload({ bytes: img.bytes, name: img.name, by: author })).id)
  }
  return ids
}

export function registerImageTools(kit: Kit): void {
  const { deps } = kit
  const maxSide = deps.vision?.maxSide ?? DEFAULT_IMAGE_MAX_SIDE
  const maxBytes = deps.vision?.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES

  /** The image the model will get: its size after downscaling, and whether it fits. */
  const describe = (bytes: Uint8Array, name: string) => {
    const p = prepareImage(bytes, { maxSide })
    if (!p) throw new ValidationError(`${name} is not an image`)
    if (p.bytes.length > maxBytes)
      throw new ValidationError(
        `${name} is too large to look at (${Math.round(p.bytes.length / 1024)} KB, at most ${Math.round(maxBytes / 1024)} KB)`,
      )
    return p
  }

  kit.tool(
    {
      name: 'image.view',
      description:
        'Look at an image: an attachment of a chat message you can see (attachment: att_…, as messages show them), or an image file in your filesystem (path, e.g. /chart.png or /shared/<owner>/…). The image is attached to the result. Only look when you need to: images cost context.',
      effect: 'read',
      tags: [VISION_TAG],
      params: {
        properties: {
          attachment: { type: 'string', description: 'An attachment id (att_…).' },
          path: { type: 'string', description: 'A file path in your filesystem.' },
        },
      },
    },
    async (a, ctx) => {
      if (!deps.vision?.enabled) return fail("this model can't see images")
      const attachment = typeof a.attachment === 'string' ? a.attachment.trim() : ''
      const path = typeof a.path === 'string' ? a.path.trim() : ''
      if (!attachment === !path) return fail('give an attachment id or a path (one of them)')
      let ref: ImageRef
      let prepared: ReturnType<typeof describe>
      if (attachment) {
        const store = deps.attachments
        const rec = store ? await store.get(attachment) : null
        // Unknown, not on a message yet, or in a DM it isn't in: all look the same.
        if (!rec?.data.messageId || !rec.data.channelId || !(await employeeSeesChannel(kit, ctx.employeeId, rec.data.channelId)))
          throw new NotFoundError('attachment', attachment)
        const got = await store!.read(attachment)
        if (!got) return fail(`attachment ${attachment} is no longer available`)
        prepared = describe(got.bytes, rec.data.name)
        const v: Attachment = attachmentView(rec)
        ref = {
          source: 'attachment',
          id: rec.id,
          sha256: rec.data.sha256,
          name: v.name,
          mime: v.mime,
          ...(v.width ? { width: v.width } : {}),
          ...(v.height ? { height: v.height } : {}),
        }
      } else {
        const img = await readImageFile(kit, ctx, path)
        prepared = describe(img.bytes, img.file.path)
        ref = {
          source: 'file',
          owner: img.file.ownerEmployeeId,
          path: img.file.ownerPath,
          sha256: sha256Hex(img.bytes),
          name: img.name,
          mime: img.info.mime,
          ...(img.info.width ? { width: img.info.width } : {}),
          ...(img.info.height ? { height: img.info.height } : {}),
        }
      }
      const shown = prepared.width && prepared.height ? `${prepared.width}x${prepared.height}` : undefined
      return {
        output: {
          image: ref.name,
          mime: ref.mime,
          ...(ref.width && ref.height ? { size: `${ref.width}x${ref.height}` } : {}),
          ...(prepared.scaled && shown ? { shownAs: shown } : {}),
          note: 'The image is attached below.',
        },
        images: [ref],
      }
    },
  )
}
