import { FILE_WRITE_MAX_BYTES, type FileEntry } from '@mp/api'
import { CircleCheck, CircleDashed, CircleDot, CircleSlash, CircleX, X } from 'lucide-react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Progress } from '@/components/ui/progress.tsx'
import { useApi } from '@/lib/api.tsx'
import { formatBytes } from '@/lib/environments.ts'
import { cn } from '@/lib/utils.ts'

/** `/notes` + `a.md` → `/notes/a.md`. */
export const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`)

/** The directory a path is in: `/notes/a.md` → `/notes`, `/a.md` → `/`. */
export const parentDir = (path: string) => {
  const i = path.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** Bytes as base64, in chunks (a spread of megabytes would overflow the call stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let s = ''
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A picked or dropped file's bytes, as base64. */
export async function fileToBase64(file: Blob): Promise<string> {
  if (typeof file.arrayBuffer === 'function') return bytesToBase64(new Uint8Array(await file.arrayBuffer()))
  // Older engines (and some test DOMs) have only FileReader.
  const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as ArrayBuffer)
    r.onerror = () => reject(r.error ?? new Error('could not read the file'))
    r.readAsArrayBuffer(file)
  })
  return bytesToBase64(new Uint8Array(buf))
}

type UploadState = 'queued' | 'uploading' | 'done' | 'error' | 'skipped'

interface UploadItem {
  key: string
  file: File
  path: string
  state: UploadState
  /** Whether it replaces a file that is there. */
  replace: boolean
  error?: string
}

interface Pending {
  dir: string
  items: UploadItem[]
  conflicts: string[]
  resolve(choice: 'replace' | 'skip' | 'cancel'): void
}

const STATE_ICON: Record<UploadState, { icon: typeof CircleDot; color: string; label: string; animated?: boolean }> = {
  queued: { icon: CircleDashed, color: 'var(--fg-quaternary)', label: 'Queued' },
  uploading: { icon: CircleDot, color: 'var(--status-running)', label: 'Uploading', animated: true },
  done: { icon: CircleCheck, color: 'var(--status-completed)', label: 'Uploaded' },
  error: { icon: CircleX, color: 'var(--status-failed)', label: 'Failed' },
  skipped: { icon: CircleSlash, color: 'var(--fg-tertiary)', label: 'Skipped' },
}

const errorText = (e: unknown): string => {
  const err = e as { status?: number; message?: string }
  if (err?.status === 409) return 'someone created it meanwhile: upload it again to replace it'
  if (err?.status === 403) return 'you can’t write here'
  return err?.message || 'upload failed'
}

/**
 * Uploads files into an employee's directory: asks before replacing files that are there, then sends
 * them one at a time (as base64), with progress and errors. `view` is the dialog and the progress panel.
 */
export function useFileUploads(
  employeeId: string,
  onUploaded: () => void,
): {
  upload(files: Iterable<File>, dir: string): Promise<void>
  busy: boolean
  view: ReactNode
} {
  const api = useApi()
  const [items, setItems] = useState<UploadItem[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)

  const update = useCallback(
    (key: string, patch: Partial<UploadItem>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x))),
    [],
  )

  const upload = useCallback(
    async (files: Iterable<File>, dir: string) => {
      const list = [...files]
      if (!list.length || running.current) return
      running.current = true
      setBusy(true)
      try {
        // Only the last of two picked files with one name counts.
        const byName = new Map(list.map((f) => [f.name, f]))
        let existing: FileEntry[] = []
        try {
          existing = await api.listFiles(employeeId, dir)
        } catch {
          // A directory that isn't there yet: nothing to replace.
        }
        const there = new Map(existing.map((e) => [e.name, e.type]))
        const batch: UploadItem[] = [...byName.values()].map((file) => {
          const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`
          const base = { key, file, path: joinPath(dir, file.name), replace: there.get(file.name) === 'file' }
          if (file.size > FILE_WRITE_MAX_BYTES)
            return { ...base, state: 'error', error: `over ${formatBytes(FILE_WRITE_MAX_BYTES)}` } as UploadItem
          if (there.get(file.name) === 'dir') return { ...base, state: 'error', error: 'a folder has this name' } as UploadItem
          return { ...base, state: 'queued' } as UploadItem
        })
        const conflicts = batch.filter((i) => i.state === 'queued' && i.replace).map((i) => i.file.name)
        let choice: 'replace' | 'skip' | 'cancel' = 'replace'
        if (conflicts.length) choice = await new Promise((resolve) => setPending({ dir, items: batch, conflicts, resolve }))
        setPending(null)
        if (choice === 'cancel') return
        const run = batch.map((i) =>
          i.state === 'queued' && i.replace && choice === 'skip' ? { ...i, state: 'skipped' as const } : i,
        )
        setItems(run)
        let done = 0
        for (const item of run) {
          if (item.state !== 'queued') continue
          update(item.key, { state: 'uploading' })
          try {
            const content = await fileToBase64(item.file)
            // Version 0 for a new file: the server refuses it if one appeared meanwhile.
            await api.writeFile(employeeId, item.path, content, item.replace ? undefined : 0, { encoding: 'base64' })
            update(item.key, { state: 'done' })
            done++
          } catch (e) {
            update(item.key, { state: 'error', error: errorText(e) })
          }
        }
        if (done) {
          onUploaded()
          toast(done === 1 ? 'Uploaded 1 file' : `Uploaded ${done} files`, { description: dir })
        }
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [api, employeeId, onUploaded, update],
  )

  const finished = items.filter((i) => i.state !== 'queued' && i.state !== 'uploading')
  const total = items.reduce((n, i) => n + i.file.size, 0)
  const sent = finished.reduce((n, i) => n + i.file.size, 0)
  const view = (
    <>
      <Dialog open={!!pending} onOpenChange={(o) => !o && pending?.resolve('cancel')}>
        <DialogContent className="gap-4 sm:max-w-[440px]" data-testid="replace-dialog">
          <DialogHeader>
            <DialogTitle className="text-title1">
              {pending?.conflicts.length === 1 ? 'Replace a file?' : `Replace ${pending?.conflicts.length} files?`}
            </DialogTitle>
            <DialogDescription className="text-mini text-fg-tertiary">
              {pending?.conflicts.length === 1 ? 'This file is' : 'These files are'} already in{' '}
              <span className="font-mono text-fg-secondary">{pending?.dir}</span>. Replacing can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex max-h-48 flex-col gap-0.5 overflow-auto font-mono text-micro text-fg-secondary">
            {pending?.conflicts.map((n) => (
              <li key={n} className="truncate">
                {n}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => pending?.resolve('cancel')}>
              Cancel
            </Button>
            {pending?.items.some((i) => i.state === 'queued' && !i.replace) && (
              <Button variant="secondary" size="sm" onClick={() => pending?.resolve('skip')}>
                Skip existing
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={() => pending?.resolve('replace')}>
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {items.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md border bg-level-2 p-2" data-testid="upload-panel" aria-live="polite">
          <div className="flex items-center gap-2 text-micro text-fg-tertiary">
            <span className="flex-1">
              {busy ? 'Uploading' : 'Uploaded'} {finished.length} of {items.length} · {formatBytes(sent)} of {formatBytes(total)}
            </span>
            {!busy && (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss uploads" onClick={() => setItems([])}>
                <X />
              </Button>
            )}
          </div>
          <Progress value={total ? (sent / total) * 100 : 100} className="h-1" aria-label="Upload progress" />
          <ul className="flex max-h-40 flex-col overflow-auto">
            {items.map((i) => {
              const s = STATE_ICON[i.state]
              const Icon = s.icon
              return (
                <li
                  key={i.key}
                  className="flex min-h-6 items-center gap-1.5 text-micro"
                  data-testid="upload-item"
                  data-state={i.state}
                >
                  <Icon
                    role="img"
                    aria-label={s.label}
                    className={cn('size-3.5 shrink-0', s.animated && 'animate-status')}
                    style={{ color: s.color }}
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate text-fg-secondary" title={i.path}>
                    {i.file.name}
                  </span>
                  {i.error ? (
                    <span className="max-w-[55%] truncate text-destructive" title={i.error}>
                      {i.error}
                    </span>
                  ) : (
                    <span className="shrink-0 text-fg-quaternary">{formatBytes(i.file.size)}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </>
  )
  return { upload, busy, view }
}
