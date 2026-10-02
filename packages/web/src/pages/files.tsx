import type { FileContent, FileEntry } from '@mp/api'
import { ChevronRight, Download, File, FileImage, FileText, Folder, Share2, Upload } from 'lucide-react'
import { type DragEvent, type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { DocumentEditor } from '@/components/doc-editor.tsx'
import { EmptyState, LoadingRows } from '@/components/empty.tsx'
import { base64ToBytes, parentDir, useFileUploads } from '@/components/file-upload.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { formatBytes } from '@/lib/environments.ts'
import { useEmployees } from '@/lib/employees.tsx'
import { formatDateTime } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

type Permission = 'read' | 'write'

/** Types shown inline (by the bytes, as the server sniffs them). SVG is not one: it is a document that can carry scripts. */
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** Names that may be images: the list shows a thumbnail, which the server serves only if the bytes are one. */
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i
/** Bigger images get an icon in the list, not a thumbnail (the original is loaded: there are no server-made thumbnails). */
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024

/** A file row's icon: a lazy thumbnail for a small image, else by kind. */
function FileIcon({ employeeId, file }: { employeeId: string; file: FileEntry }) {
  const api = useApi()
  const [broken, setBroken] = useState(false)
  if (IMAGE_NAME.test(file.name)) {
    const src = file.size <= THUMBNAIL_MAX_BYTES && !broken ? api.fileUrl(employeeId, file.path, versionOpt(file.version)) : ''
    return src ? (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        width={16}
        height={16}
        onError={() => setBroken(true)}
        className="size-4 shrink-0 rounded-sm border object-cover"
        data-testid="file-thumbnail"
      />
    ) : (
      <FileImage className="size-3.5 shrink-0 text-fg-tertiary" data-testid="file-image-icon" />
    )
  }
  return file.name.endsWith('.md') ? (
    <FileText className="size-3.5 shrink-0 text-fg-tertiary" />
  ) : (
    <File className="size-3.5 shrink-0 text-fg-tertiary" />
  )
}

const versionOpt = (version: number | undefined) => (version !== undefined ? { version } : {})

/** The directory uploads go to, with your permission there (people who aren't admins have only what was shared). */
interface Cwd {
  path: string
  permission?: Permission
}

function Dir({
  employeeId,
  dir,
  permission,
  depth,
  selected,
  refresh,
  onSelect,
  onDir,
}: {
  employeeId: string
  dir: string
  /** Your permission on this directory, when it was shared with you. */
  permission?: Permission
  depth: number
  selected: string | null
  /** Changes to reload the listing (after an upload). */
  refresh: number
  /** With the permission of a file shared with you, and of its directory. */
  onSelect(p: string, permission?: Permission, dirPermission?: Permission): void
  /** A folder was opened (it is the current directory now) or closed (its parent is). */
  onDir(cwd: Cwd): void
}) {
  const list = useLoad((a) => a.listFiles(employeeId, dir), [employeeId, dir, refresh])
  const [open, setOpen] = useState<Set<string>>(new Set(depth === 0 ? ['/notes'] : []))
  if (!list.data) return depth === 0 ? <LoadingRows rows={4} /> : null
  return (
    <div>
      {list.data.map((f: FileEntry) => (
        <div key={f.path}>
          <button
            type="button"
            onClick={() => {
              if (f.type === 'dir') {
                const n = new Set(open)
                if (n.has(f.path)) {
                  n.delete(f.path)
                  onDir({ path: dir, ...(permission ? { permission } : {}) })
                } else {
                  n.add(f.path)
                  onDir({ path: f.path, ...(f.shared ? { permission: f.shared.permission } : {}) })
                }
                setOpen(n)
              } else onSelect(f.path, f.shared?.permission, permission)
            }}
            data-dir={f.type === 'dir' ? f.path : dir}
            data-permission={(f.type === 'dir' ? f.shared?.permission : permission) ?? ''}
            className={cn(
              'flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left hover:bg-secondary',
              selected === f.path && 'bg-secondary text-foreground',
            )}
            style={{ paddingLeft: 6 + depth * 14 }}
          >
            {f.type === 'dir' ? (
              <>
                <ChevronRight className={cn('size-3 text-fg-quaternary transition-quick', open.has(f.path) && 'rotate-90')} />
                <Folder className="size-3.5 text-fg-tertiary" />
              </>
            ) : (
              <>
                <span className="w-3" />
                <FileIcon employeeId={employeeId} file={f} />
              </>
            )}
            <span className="min-w-0 truncate text-fg-secondary">{f.name}</span>
            {f.shared && (
              <Share2 className="ml-auto size-3 shrink-0 text-fg-quaternary" aria-label={`shared, ${f.shared.permission}`} />
            )}
          </button>
          {f.type === 'dir' && open.has(f.path) && (
            <Dir
              employeeId={employeeId}
              dir={f.path}
              {...(f.shared ? { permission: f.shared.permission } : {})}
              depth={depth + 1}
              selected={selected}
              refresh={refresh}
              onSelect={onSelect}
              onDir={onDir}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function Editor({ employeeId, path, permission }: { employeeId: string; path: string; permission?: 'read' | 'write' }) {
  const api = useApi()
  const file = useLoad((a) => a.readFile(employeeId, path), [employeeId, path])
  const [draft, setDraft] = useState<string | null>(null)
  if (!file.data) return <LoadingRows rows={4} />
  const f = file.data
  const readOnly = path.startsWith('/shared/') || permission === 'read'
  const binary = f.encoding === 'base64'
  const image = binary && !!f.mime && IMAGE_MIMES.includes(f.mime)
  const svg = f.mime === 'image/svg+xml'
  const save = async (content: string) => {
    const next = await api.writeFile(employeeId, path, content, f.version)
    file.setData(next)
    setDraft(null)
    toast('Saved', { description: path })
  }
  return (
    <div className="mx-auto max-w-[760px] px-6 py-6">
      <div className="mb-4 flex items-center gap-2 text-micro text-fg-tertiary">
        <span className="font-mono text-fg-secondary">{path}</span>
        <span>
          · v{f.version} · {formatDateTime(f.updatedAt)}
        </span>
        {readOnly && <span className="rounded-sm border px-1 text-tiny">shared · read-only</span>}
        {permission === 'write' && <span className="rounded-sm border px-1 text-tiny">shared with you</span>}
      </div>
      {image ? (
        <ImageFile employeeId={employeeId} path={path} file={f} />
      ) : binary ? (
        <BinaryFile path={path} content={f.content} size={f.size} />
      ) : path.endsWith('.md') ? (
        <DocumentEditor value={f.content} onSave={readOnly ? undefined : save} />
      ) : (
        <div className="flex flex-col gap-2">
          {svg && (
            <FileBar
              icon={<FileImage className="size-4 text-fg-tertiary" />}
              label={`SVG image · ${formatBytes(f.size ?? new TextEncoder().encode(f.content).length)} · shown as text, since an SVG can carry scripts`}
              name={fileName(path)}
              bytes={() => new TextEncoder().encode(f.content)}
              testId="svg-file"
            />
          )}
          <Textarea
            value={draft ?? f.content}
            readOnly={readOnly}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-96 font-mono text-micro"
            aria-label="File content"
          />
          {draft !== null && (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Discard
              </Button>
              <Button size="sm" onClick={() => save(draft)}>
                Save
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Saves bytes as a file. */
function saveBytes(bytes: Uint8Array<ArrayBuffer>, name: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** A line about a file with a Download button. */
function FileBar({
  icon,
  label,
  name,
  bytes,
  testId,
}: {
  icon: ReactNode
  label: ReactNode
  name: string
  bytes: () => Uint8Array<ArrayBuffer>
  testId: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-level-1 px-4 py-3" data-testid={testId}>
      {icon}
      <span className="min-w-0 flex-1 text-fg-secondary">{label}</span>
      <Button variant="secondary" size="sm" onClick={() => saveBytes(bytes(), name)}>
        <Download />
        Download
      </Button>
    </div>
  )
}

/** A file that isn't text: its size and a download, no editor. */
function BinaryFile({ path, content, size }: { path: string; content: string; size?: number }) {
  return (
    <FileBar
      icon={<File className="size-4 text-fg-tertiary" />}
      label={`Binary file · ${formatBytes(size ?? Math.floor((content.length * 3) / 4))}`}
      name={fileName(path)}
      bytes={() => base64ToBytes(content)}
      testId="binary-file"
    />
  )
}

/** A PNG, JPEG, GIF or WebP (by its bytes): shown scaled to fit, with its dimensions and size, and a download. */
function ImageFile({ employeeId, path, file }: { employeeId: string; path: string; file: FileContent }) {
  const api = useApi()
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const width = file.width ?? natural?.width
  const height = file.height ?? natural?.height
  const size = formatBytes(file.size ?? Math.floor((file.content.length * 3) / 4))
  return (
    <div className="flex flex-col gap-3" data-testid="image-file">
      <FileBar
        icon={<FileImage className="size-4 text-fg-tertiary" />}
        label={
          <>
            {file.mime?.replace('image/', '').toUpperCase()} image
            {width && height ? ` · ${width} × ${height}` : ''} · {size}
          </>
        }
        name={fileName(path)}
        bytes={() => base64ToBytes(file.content)}
        testId="image-info"
      />
      <div className="flex justify-center rounded-xl border bg-level-1 p-4">
        <img
          src={api.fileUrl(employeeId, path, versionOpt(file.version))}
          alt={fileName(path)}
          decoding="async"
          onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          className="max-h-[70vh] max-w-full object-contain"
          data-testid="image-preview"
        />
      </div>
    </div>
  )
}

/** Each employee's own filesystem: browse, read and edit (markdown rendered), and upload into it. */
export function FilesPage() {
  const { employees, current } = useEmployees()
  const [params, setParams] = useSearchParams()
  const employeeId = params.get('employee') ?? current?.id ?? employees[0]?.id ?? null
  const path = params.get('path')
  const [permission, setPermission] = useState<Permission | undefined>()
  const [cwd, setCwd] = useState<Cwd>(() => ({ path: path ? parentDir(path) : '/' }))
  const [refresh, setRefresh] = useState(0)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const { can } = useAuth()
  const emp = employees.find((e) => e.id === employeeId)
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    n.set(k, v)
    if (k === 'employee') n.delete('path')
    setParams(n, { replace: true })
  }
  // Admins write anywhere but /shared (other employees' files); members where a write share covers it.
  const canWrite = useCallback(
    (c: Cwd) =>
      can('admin') ? !(c.path === '/shared' || c.path.startsWith('/shared/')) : can('member') && c.permission === 'write',
    [can],
  )
  const onUploaded = useCallback(() => setRefresh((n) => n + 1), [])
  const uploads = useFileUploads(employeeId ?? '', onUploaded)
  const writable = useMemo(() => canWrite(cwd), [canWrite, cwd])

  /** Where a drag is over: the folder row under the pointer (a file row: its folder), else the current directory. */
  const targetOf = (e: DragEvent): Cwd => {
    const row = (e.target as HTMLElement).closest?.('[data-dir]') as HTMLElement | null
    if (!row) return cwd
    const perm = row.dataset.permission as Permission | ''
    return { path: row.dataset.dir ?? cwd.path, ...(perm ? { permission: perm } : {}) }
  }
  const isFileDrag = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  const dragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    const t = targetOf(e)
    if (!canWrite(t)) {
      setDropTarget(null)
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDropTarget(t.path)
  }
  const drop = (e: DragEvent) => {
    setDropTarget(null)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    const t = targetOf(e)
    if (!canWrite(t)) return
    e.preventDefault()
    void uploads.upload([...files], t.path)
  }
  return (
    <Page title="Files" icon={<FileText />} className="flex flex-col overflow-auto md:flex-row md:overflow-hidden">
      {!employeeId ? (
        <LoadingRows />
      ) : (
        <>
          <nav
            className={cn(
              'flex shrink-0 flex-col gap-2 overflow-auto border-b bg-level-1 p-2 transition-quick max-md:max-h-72 md:w-64 md:border-r md:border-b-0',
              dropTarget && 'bg-accent-tint ring-2 ring-ring ring-inset',
            )}
            aria-label="Files"
            data-testid="file-list"
            onDragOver={dragOver}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null)
            }}
            onDrop={drop}
          >
            <div className="flex flex-wrap gap-1">
              {employees.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => {
                    setCwd({ path: '/' })
                    set('employee', e.id)
                  }}
                  className={cn(
                    'flex h-6 items-center gap-1 rounded-md border border-transparent px-1.5 text-micro text-fg-tertiary hover:text-foreground',
                    e.id === employeeId && 'border-border bg-secondary text-foreground',
                  )}
                >
                  <EmployeeAvatar name={e.data.name} className="size-3.5" />
                  {e.data.name}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 px-1">
              <span className="min-w-0 flex-1 truncate text-micro text-fg-tertiary" data-testid="upload-target">
                {dropTarget ? 'Drop to upload to ' : 'In '}
                <span className="font-mono text-fg-secondary">{dropTarget ?? cwd.path}</span>
              </span>
              {writable && (
                <>
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={uploads.busy}
                    onClick={() => picker.current?.click()}
                    title={`Upload files to ${cwd.path} (or drop them here)`}
                  >
                    <Upload />
                    Upload
                  </Button>
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    className="hidden"
                    data-testid="upload-input"
                    aria-label={`Upload files to ${cwd.path}`}
                    onChange={(e) => {
                      const files = [...(e.target.files ?? [])]
                      e.target.value = ''
                      void uploads.upload(files, cwd.path)
                    }}
                  />
                </>
              )}
            </div>
            {uploads.view}
            <Dir
              key={employeeId}
              employeeId={employeeId}
              dir="/"
              depth={0}
              selected={path}
              refresh={refresh}
              onSelect={(p, perm, dirPerm) => {
                setPermission(perm)
                setCwd({ path: parentDir(p), ...(dirPerm ? { permission: dirPerm } : {}) })
                set('path', p)
              }}
              onDir={setCwd}
            />
            <p className="mt-auto px-1 text-tiny text-fg-quaternary">
              Private to {emp?.data.name ?? 'this employee'}'s sessions and admins. You see what it shared with you; files others
              shared with it appear under /shared (admins only).
            </p>
          </nav>
          <section className="min-w-0 flex-1 overflow-auto">
            {path ? (
              <Editor key={`${employeeId}${path}`} employeeId={employeeId} path={path} permission={permission} />
            ) : (
              <EmptyState text="Pick a file to read or edit." />
            )}
          </section>
        </>
      )}
    </Page>
  )
}
