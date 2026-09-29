import {
  type ApiRecord,
  ApiRequestError,
  type AttachmentDescription,
  type AttachmentsApi,
  type ChatAttachment,
  type MessageData,
  hasTextPreview,
  IMAGE_ATTACHMENT_MIMES,
  TEXT_PREVIEW_MAX_BYTES,
} from '@mp/api'
import { type MockDb, mockId } from './data.ts'

/**
 * Chat attachments in the mock: uploads live in memory as object URLs; a couple of seeded messages
 * carry demo images (drawn as SVG, which the real server never shows inline: only PNG, JPEG, GIF and
 * WebP are images there) and a demo script. Any file can be uploaded; the type comes from the
 * browser's `File.type` or the extension (the server sniffs the bytes).
 */

const TYPES: readonly string[] = IMAGE_ATTACHMENT_MIMES
const MAX_BYTES = 10 * 1024 * 1024

const TEXT_EXT: Record<string, string> = {
  sh: 'text/x-shellscript',
  py: 'text/x-python',
  ts: 'text/typescript',
  js: 'text/javascript',
  md: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  html: 'text/html',
  svg: 'image/svg+xml',
}

/** The mock's type for an upload: an image by its declared type, text by extension, else the declared type. */
function mimeOf(file: Blob, name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  if (ext && TEXT_EXT[ext]) return TEXT_EXT[ext]
  return file.type || 'application/octet-stream'
}

/** A seeded script, as an employee would attach it. */
const DEMO_SCRIPT = `#!/bin/sh
# Frees disk on staging-eu-1: old WAL segments and docker leftovers.
set -eu
echo "before:"; df -h /var/lib/postgresql | tail -1
docker system prune --force --filter "until=168h"
docker image prune --all --force --filter "until=168h"
find /var/lib/postgresql/wal-archive -type f -mtime +7 -delete
find /tmp -maxdepth 1 -name 'build-*' -mtime +1 -exec rm -rf {} +
journalctl --vacuum-time=7d
apt-get clean
echo "after:"; df -h /var/lib/postgresql | tail -1
`

const svg = (w: number, h: number, body: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Inter, system-ui, sans-serif">${body}</svg>`,
  )}`

/** A bar chart of disk usage, as the infra employee would make with code.run. */
function diskChart(): string {
  const bars = [
    ['postgres', 212, '#5e6ad2'],
    ['docker', 61, '#4ea7fc'],
    ['logs', 18, '#27a644'],
    ['wal', 9, '#f0bf00'],
    ['other', 6, '#8a8f98'],
  ] as const
  const rows = bars
    .map(([name, gb, color], i) => {
      const y = 92 + i * 88
      const w = (gb / 212) * 820
      return `<text x="40" y="${y + 36}" font-size="24" fill="#d0d6e0">${name}</text><rect x="190" y="${y + 8}" width="${w}" height="44" rx="6" fill="${color}"/><text x="${200 + w}" y="${y + 38}" font-size="22" fill="#8a8f98">${gb} G</text>`
    })
    .join('')
  return svg(
    1200,
    560,
    `<rect width="1200" height="560" fill="#0f1011"/><text x="40" y="56" font-size="28" font-weight="600" fill="#f7f8f8">staging-eu-1 · disk by use</text>${rows}`,
  )
}

/** Two charges two seconds apart, as a timeline. */
function chargesTimeline(): string {
  const tick = (x: number, label: string) =>
    `<line x1="${x}" y1="250" x2="${x}" y2="262" stroke="#62666d" stroke-width="2"/><text x="${x}" y="292" font-size="20" fill="#8a8f98" text-anchor="middle">${label}</text>`
  const charge = (x: number, key: string) =>
    `<circle cx="${x}" cy="180" r="16" fill="#eb5757"/><text x="${x}" y="130" font-size="22" fill="#f7f8f8" text-anchor="middle">$412.00</text><text x="${x}" y="226" font-size="18" fill="#8a8f98" text-anchor="middle">${key}</text>`
  return svg(
    1000,
    340,
    `<rect width="1000" height="340" fill="#0f1011"/><text x="40" y="56" font-size="26" font-weight="600" fill="#f7f8f8">INV-1002 · charges on Sep 27</text><line x1="80" y1="250" x2="920" y2="250" stroke="#34343a" stroke-width="3"/>${tick(160, '14:02:10')}${tick(500, '14:02:11')}${tick(840, '14:02:12')}${charge(160, 'key a81f…')}${charge(840, 'key 3c07…')}`,
  )
}

/** A screenshot-like image of the provider dashboard. */
function dashboard(): string {
  const row = (y: number, a: string, b: string, c: string) =>
    `<text x="48" y="${y}" font-size="20" fill="#d0d6e0">${a}</text><text x="420" y="${y}" font-size="20" fill="#8a8f98">${b}</text><text x="760" y="${y}" font-size="20" fill="${c === 'succeeded' ? '#27a644' : '#eb5757'}">${c}</text>`
  return svg(
    960,
    420,
    `<rect width="960" height="420" fill="#f8f8f8"/><rect width="960" height="64" fill="#ffffff"/><text x="48" y="42" font-size="24" font-weight="600" fill="#282a30">Payments · INV-1002</text><rect x="24" y="88" width="912" height="308" rx="12" fill="#ffffff" stroke="#e9e8ea"/>${row(140, 'ch_3Pq…a81f', 'Sep 27 14:02:10', 'succeeded')}${row(196, 'ch_3Pq…3c07', 'Sep 27 14:02:12', 'succeeded')}${row(252, 're_1Mx…77aa', 'Sep 29 09:15:44', 'pending')}`,
  )
}

interface Stored {
  attachment: ChatAttachment
  url: string
  /** A text file's content, for previews. */
  text?: string
  owner: string
  claimed: boolean
  describedAt?: string
  editedAt?: string
}

export function createMockAttachmentsApi(ctx: {
  db: MockDb
  meId: string
  meName?: string
  /** The signed-in person's access (admins may edit any description). Default admin. */
  access?: () => string
  latencyMs?: number
}) {
  const store = new Map<string, Stored>()
  let seq = 0

  const seed = (
    messageNo: number,
    items: {
      name: string
      url: string
      width: number
      height: number
      size: number
      description?: string
      visibleText?: string
      mime?: string
      text?: string
    }[],
  ) => {
    const m = ctx.db.records.get('message')?.get(mockId('msg', messageNo)) as ApiRecord<MessageData> | undefined
    if (!m) return
    const list = items.map((it) => {
      const mime = it.mime ?? 'image/png'
      const image = TYPES.includes(mime)
      const attachment: ChatAttachment = {
        id: mockId('att', ++seq),
        kind: image ? 'image' : 'file',
        name: it.name,
        mime,
        size: it.size,
        ...(image ? { width: it.width, height: it.height } : {}),
        ...(it.description ? { description: it.description } : {}),
        ...(it.visibleText ? { visibleText: it.visibleText } : {}),
      }
      store.set(attachment.id, {
        attachment,
        url: it.url,
        ...(it.text !== undefined ? { text: it.text } : {}),
        owner: 'seed',
        claimed: true,
        ...(it.description ? { describedAt: new Date(ctx.db.now() - 3_600_000).toISOString() } : {}),
      })
      return attachment
    })
    m.data = { ...m.data, attachments: list }
  }
  seed(3, [
    {
      name: 'charges-timeline.png',
      url: chargesTimeline(),
      width: 1000,
      height: 340,
      size: 48_213,
      description:
        'A timeline of invoice INV-1002 on Sep 27 with two $412.00 charges two seconds apart, each with a different idempotency key.',
      visibleText: 'INV-1002 · charges on Sep 27\n$412.00 key a81f… 14:02:10\n$412.00 key 3c07… 14:02:12',
    },
    { name: 'provider-dashboard.png', url: dashboard(), width: 960, height: 420, size: 131_877 },
  ])
  seed(20, [
    {
      name: 'disk-by-use.png',
      url: diskChart(),
      width: 1200,
      height: 560,
      size: 61_402,
      description: 'A horizontal bar chart of disk usage on staging-eu-1: postgres uses by far the most, followed by docker.',
      visibleText: 'staging-eu-1 · disk by use\npostgres 212 G\ndocker 61 G\nlogs 18 G\nwal 9 G\nother 6 G',
    },
    {
      name: 'free-disk.sh',
      url: `data:text/x-shellscript;charset=utf-8,${encodeURIComponent(DEMO_SCRIPT)}`,
      width: 0,
      height: 0,
      size: new TextEncoder().encode(DEMO_SCRIPT).length,
      mime: 'text/x-shellscript',
      text: DEMO_SCRIPT,
    },
  ])

  /** The same attachment object everywhere: in the store and on its message. */
  const replace = (next: ChatAttachment) => {
    const s = store.get(next.id)
    if (s) s.attachment = next
    for (const m of (ctx.db.records.get('message')?.values() ?? []) as Iterable<ApiRecord<MessageData>>) {
      if (m.data.attachments?.some((x) => x.id === next.id))
        m.data = { ...m.data, attachments: m.data.attachments.map((x) => (x.id === next.id ? next : x)) }
    }
  }
  const visible = (id: string) => {
    const s = store.get(id)
    if (!s || (!s.claimed && s.owner !== ctx.meId)) throw new ApiRequestError(404, 'not_found', `attachment ${id} not found`)
    return s
  }
  const canEdit = (s: Stored) => (ctx.access?.() ?? 'admin') === 'admin' || s.owner === ctx.meId
  const view = (s: Stored): AttachmentDescription => ({
    attachment: s.attachment,
    ...(s.attachment.description && s.describedAt ? { describedAt: s.describedAt, describedBy: 'kimi-k2-7-code' } : {}),
    ...(s.attachment.descriptionEditedBy
      ? { editedByName: ctx.meName ?? 'you', ...(s.editedAt ? { editedAt: s.editedAt } : {}) }
      : {}),
    available: true,
    mode: 'view',
    canEdit: canEdit(s),
  })
  const pause = () => (ctx.latencyMs ? new Promise((r) => setTimeout(r, ctx.latencyMs)) : Promise.resolve())

  const readText = async (file: Blob): Promise<string | undefined> => {
    try {
      if (typeof file.text === 'function') return await file.text()
      return await new Response(file).text()
    } catch {
      return undefined
    }
  }

  const dims = async (file: Blob): Promise<{ width?: number; height?: number }> => {
    if (typeof createImageBitmap !== 'function') return {}
    try {
      const b = await createImageBitmap(file)
      const d = { width: b.width, height: b.height }
      b.close()
      return d
    } catch {
      return {}
    }
  }

  const api: AttachmentsApi = {
    async uploadAttachment(file, opts = {}) {
      const name = opts.name ?? (file as File).name ?? 'file'
      const mime = mimeOf(file, name)
      const image = TYPES.includes(mime)
      // Like the server: a file named or typed as an image must be one (here: declared as one).
      if (!image && /\.(png|jpe?g|gif|webp)$/i.test(name))
        throw new ApiRequestError(
          422,
          'validation',
          `${name} says it is an image, but its content is not a PNG, JPEG, GIF or WebP`,
        )
      if (!file.size) throw new ApiRequestError(422, 'validation', 'the attachment is empty')
      if (file.size > MAX_BYTES) throw new ApiRequestError(422, 'validation', 'an attachment can be at most 10 MB')
      // Progress in a few steps, like a real upload.
      for (const f of [0.2, 0.55, 0.85]) {
        opts.onProgress?.(f)
        if (ctx.latencyMs) await new Promise((r) => setTimeout(r, ctx.latencyMs! / 2))
      }
      const attachment: ChatAttachment = {
        id: mockId('att', ++seq),
        kind: image ? 'image' : 'file',
        name,
        mime,
        size: file.size,
        ...(image ? await dims(file) : {}),
      }
      const text = hasTextPreview(attachment) ? await readText(file) : undefined
      let url = ''
      try {
        if (typeof URL.createObjectURL === 'function') url = URL.createObjectURL(file)
      } catch {
        // jsdom: no object URLs.
      }
      // jsdom has no object URLs: a text file can still be a data URL.
      if (!url && text !== undefined) url = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`
      store.set(attachment.id, { attachment, url, ...(text !== undefined ? { text } : {}), owner: ctx.meId, claimed: false })
      opts.onProgress?.(1)
      return { attachment, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    },
    attachmentUrl: (id) => store.get(id)?.url ?? '',
    async attachmentText(id) {
      const s = visible(id)
      if (s.text === undefined) throw new ApiRequestError(422, 'validation', `${s.attachment.name} is not a text file`)
      await pause()
      const truncated = s.text.length > TEXT_PREVIEW_MAX_BYTES
      return { attachment: s.attachment, text: truncated ? s.text.slice(0, TEXT_PREVIEW_MAX_BYTES) : s.text, truncated }
    },
    async attachmentDescription(id) {
      await pause()
      return view(visible(id))
    },
    async describeAttachment(id) {
      const s = visible(id)
      if (!TYPES.includes(s.attachment.mime)) throw new ApiRequestError(422, 'validation', 'only images have descriptions')
      if (!canEdit(s))
        throw new ApiRequestError(403, 'denied', "only an admin or the image's uploader can change its description")
      await pause()
      const { descriptionEditedBy: _, ...rest } = s.attachment
      replace({
        ...rest,
        description: `An image named ${s.attachment.name} (a mock description: the real one comes from the model).`,
      })
      s.describedAt = new Date().toISOString()
      return view(s)
    },
    async updateAttachment(id, body) {
      const s = visible(id)
      if (!canEdit(s))
        throw new ApiRequestError(403, 'denied', "only an admin or the image's uploader can change its description")
      await pause()
      const { description: _d, visibleText: _t, descriptionEditedBy: _e, ...rest } = s.attachment
      if (body.description === null) replace(rest)
      else {
        replace({
          ...rest,
          description: body.description,
          ...(s.attachment.visibleText ? { visibleText: s.attachment.visibleText } : {}),
          descriptionEditedBy: { kind: 'contact', id: ctx.meId },
        })
        s.editedAt = new Date().toISOString()
      }
      return view(s)
    },
  }

  /** Claims uploads of the current person for a message (the mock of the server's checks). */
  const take = (ids: string[]): ChatAttachment[] => {
    if (ids.length > 10) throw new ApiRequestError(422, 'validation', 'a message can have at most 10 attachments')
    return ids.map((id) => {
      const s = store.get(id)
      if (!s) throw new ApiRequestError(404, 'not_found', `attachment ${id} not found`)
      if (s.owner !== ctx.meId) throw new ApiRequestError(403, 'denied', 'only the uploader can attach an upload')
      if (s.claimed) throw new ApiRequestError(409, 'conflict', `attachment ${id} is already on a message`)
      s.claimed = true
      return s.attachment
    })
  }
  /** A message was deleted: its images go with it. */
  const drop = (list: ChatAttachment[] | undefined) => {
    for (const a of list ?? []) store.delete(a.id)
  }
  return { api, take, drop }
}
