import type { ChatAttachment } from '@mp/api'
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { useApi, useOptionalApi } from '@/lib/api.tsx'
import { cn } from '@/lib/utils.ts'

/** Image types the composer offers (the server checks the bytes again). */
export const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'
export const ATTACHMENT_TYPES = ATTACHMENT_ACCEPT.split(',')

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

const sizeOf = (a: ChatAttachment) => (a.width && a.height ? `${a.width}×${a.height}` : '')

/**
 * A message's images as a grid of thumbnails (one image shows larger). The browser scales them;
 * clicking one opens the lightbox.
 */
export function AttachmentGrid({ attachments, className }: { attachments: ChatAttachment[]; className?: string }) {
  const api = useApi()
  const [open, setOpen] = useState<number | null>(null)
  if (!attachments.length) return null
  const single = attachments.length === 1
  return (
    <>
      <div className={cn('mt-1.5 flex flex-wrap gap-1.5', className)} data-testid="attachments">
        {attachments.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setOpen(i)}
            className={cn(
              'group/att relative overflow-hidden rounded-md border bg-level-2 transition-quick hover:border-[var(--fg-quaternary)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              single ? 'max-h-72 max-w-sm' : 'h-24',
            )}
            aria-label={`Open ${a.name}`}
            data-testid="attachment-thumb"
          >
            <Thumb attachment={a} src={api.attachmentUrl(a.id)} fit={single ? 'contain' : 'cover'} />
          </button>
        ))}
      </div>
      {open !== null && <Lightbox attachments={attachments} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  )
}

function Thumb({ attachment, src, fit }: { attachment: ChatAttachment; src: string; fit: 'contain' | 'cover' }) {
  const [broken, setBroken] = useState(false)
  if (broken)
    return (
      <span className="flex size-28 flex-col items-center justify-center gap-1 text-micro text-fg-quaternary">
        <ImageOff className="size-4" />
        unavailable
      </span>
    )
  // Thumbnails keep the image's shape (a wide chart stays wide), within bounds.
  const ratio =
    attachment.width && attachment.height
      ? `${fit === 'cover' ? Math.min(Math.max(attachment.width / attachment.height, 0.6), 1.4) : attachment.width / attachment.height}`
      : undefined
  return (
    <img
      src={src}
      alt={attachment.name}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      style={{ aspectRatio: ratio ?? (fit === 'cover' ? '1' : undefined) }}
      className={cn('block', fit === 'cover' ? 'h-24 object-cover' : 'max-h-72 max-w-full object-contain')}
    />
  )
}

/** Full-size viewer: Esc closes, ← and → move between the message's images, with a download link. */
export function Lightbox({
  attachments,
  index,
  onIndex,
  onClose,
}: {
  attachments: ChatAttachment[]
  index: number
  onIndex(i: number): void
  onClose(): void
}) {
  const api = useApi()
  const a = attachments[index]!
  const many = attachments.length > 1
  const move = useCallback(
    (d: number) => onIndex((index + d + attachments.length) % attachments.length),
    [index, attachments.length, onIndex],
  )
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' && many) {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowLeft' && many) {
      e.preventDefault()
      move(-1)
    }
  }
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
          onKeyDown={onKeyDown}
          aria-describedby={undefined}
          data-testid="lightbox"
        >
          <div className="flex h-12 shrink-0 items-center gap-3 border-white/10 border-b bg-black/40 px-4 text-mini text-[#d0d6e0]">
            <DialogPrimitive.Title className="min-w-0 truncate font-medium text-[#f7f8f8]">{a.name}</DialogPrimitive.Title>
            <span className="shrink-0 text-micro text-[#8a8f98] tabular-nums">
              {[sizeOf(a), formatBytes(a.size), many ? `${index + 1} of ${attachments.length}` : ''].filter(Boolean).join(' · ')}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="text-[#d0d6e0] hover:bg-white/10 hover:text-[#f7f8f8] dark:hover:bg-white/10"
              >
                <a href={api.attachmentUrl(a.id, { download: true })} download={a.name}>
                  <Download /> Download
                </a>
              </Button>
              <DialogPrimitive.Close asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className="text-[#d0d6e0] hover:bg-white/10 hover:text-[#f7f8f8] dark:hover:bg-white/10"
                >
                  <X />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a click outside the image closes, like the overlay */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes (the dialog handles it) */}
          <div
            className="relative flex min-h-0 flex-1 items-center justify-center px-14 pb-10"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose()
            }}
          >
            <img
              key={a.id}
              src={api.attachmentUrl(a.id)}
              alt={a.name}
              className="max-h-full max-w-full rounded-md object-contain shadow-high"
              data-testid="lightbox-image"
            />
            {many && (
              <>
                <NavButton side="left" onClick={() => move(-1)} />
                <NavButton side="right" onClick={() => move(1)} />
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function NavButton({ side, onClick }: { side: 'left' | 'right'; onClick(): void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous image' : 'Next image'}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 text-[#f7f8f8] hover:bg-black/60 hover:text-white dark:hover:bg-black/60',
        side === 'left' ? 'left-3' : 'right-3',
      )}
    >
      {side === 'left' ? <ChevronLeft /> : <ChevronRight />}
    </Button>
  )
}

/** Object URLs for local previews (jsdom has none). */
const objectUrl = (f: Blob) => {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : ''
  } catch {
    return ''
  }
}
const revoke = (url: string) => {
  if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

/** An image waiting in the composer: uploading, uploaded, or failed. */
export interface PendingAttachment {
  key: string
  file: File
  /** A local preview (an object URL). */
  preview: string
  progress: number
  attachment?: ChatAttachment
  error?: string
}

/** The composer's pending images, as thumbnails with upload progress and a remove button. */
export function PendingAttachments({ items, onRemove }: { items: PendingAttachment[]; onRemove(key: string): void }) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="pending-attachments">
      {items.map((p) => (
        <div
          key={p.key}
          className={cn(
            'group/pending relative size-16 overflow-hidden rounded-md border bg-level-2',
            p.error && 'border-destructive/70',
          )}
          title={p.error ?? `${p.file.name} · ${formatBytes(p.file.size)}`}
          data-testid="pending-attachment"
          data-state={p.error ? 'error' : p.attachment ? 'done' : 'uploading'}
        >
          <img
            src={p.preview || undefined}
            alt={p.file.name}
            className={cn('size-full object-cover', !p.attachment && 'opacity-60')}
          />
          {!p.attachment && !p.error && (
            <div className="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-full bg-black/40">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-100"
                style={{ width: `${Math.round(p.progress * 100)}%` }}
                role="progressbar"
                aria-label={`Uploading ${p.file.name}`}
                aria-valuenow={Math.round(p.progress * 100)}
              />
            </div>
          )}
          {p.error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/55 px-1 text-center text-tiny text-[#f7f8f8]">
              failed
            </div>
          )}
          <button
            type="button"
            onClick={() => onRemove(p.key)}
            className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-quick group-hover/pending:opacity-100 focus-visible:opacity-100"
            aria-label={`Remove ${p.file.name}`}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Uploads for the composer: add files (from the picker, a paste or a drop), each uploads right away
 * with progress; `ready` are the ids to send. Only images are taken, at most `max` at a time.
 */
export function usePendingAttachments(opts: { max?: number; maxBytes?: number } = {}) {
  const api = useOptionalApi()
  const max = opts.max ?? 10
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  // Previews still pending when the composer goes away.
  const live = useRef(items)
  live.current = items
  useEffect(
    () => () => {
      for (const p of live.current) revoke(p.preview)
    },
    [],
  )

  const update = (key: string, patch: Partial<PendingAttachment>) =>
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)))

  const add = (files: Iterable<File>) => {
    const list = [...files]
    const images = list.filter((f) => ATTACHMENT_TYPES.includes(f.type))
    const problems: string[] = []
    if (images.length < list.length) problems.push('only PNG, JPEG, GIF and WebP images can be attached')
    const fits = images.filter((f) => f.size <= maxBytes)
    if (fits.length < images.length) problems.push(`images can be at most ${formatBytes(maxBytes)}`)
    const room = Math.max(0, max - items.length)
    if (fits.length > room) problems.push(`at most ${max} images per message`)
    setNotice(problems.length ? `${problems.join('; ')}.` : null)
    const added = fits.slice(0, room).map((file) => ({
      key: `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`,
      file,
      preview: objectUrl(file),
      progress: 0,
    }))
    if (!added.length) return
    setItems((xs) => [...xs, ...added])
    for (const p of added) {
      if (!api) {
        update(p.key, { error: 'uploads need the data layer' })
        continue
      }
      api.uploadAttachment(p.file, { name: p.file.name, onProgress: (f) => update(p.key, { progress: f }) }).then(
        (r) => update(p.key, { attachment: r.attachment, progress: 1 }),
        (e: Error) => update(p.key, { error: e.message || 'upload failed' }),
      )
    }
  }

  const remove = (key: string) =>
    setItems((xs) => {
      const gone = xs.find((x) => x.key === key)
      if (gone) revoke(gone.preview)
      return xs.filter((x) => x.key !== key)
    })

  const clear = () =>
    setItems((xs) => {
      for (const x of xs) revoke(x.preview)
      return []
    })

  const ready = items.flatMap((p) => (p.attachment ? [p.attachment.id] : []))
  const uploading = items.some((p) => !p.attachment && !p.error)
  const failed = items.some((p) => p.error)
  return { items, add, remove, clear, ready, uploading, failed, notice, dismissNotice: () => setNotice(null) }
}
