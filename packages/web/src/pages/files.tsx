import type { FileEntry } from '@mp/api'
import { ChevronRight, File, FileText, Folder, Share2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { DocumentEditor } from '@/components/doc-editor.tsx'
import { EmptyState, LoadingRows } from '@/components/empty.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { formatDateTime } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

function Dir({
  employeeId,
  dir,
  depth,
  selected,
  onSelect,
}: {
  employeeId: string
  dir: string
  depth: number
  selected: string | null
  onSelect(p: string): void
}) {
  const list = useLoad((a) => a.listFiles(employeeId, dir), [employeeId, dir])
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
                if (n.has(f.path)) n.delete(f.path)
                else n.add(f.path)
                setOpen(n)
              } else onSelect(f.path)
            }}
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
                {f.name.endsWith('.md') ? (
                  <FileText className="size-3.5 text-fg-tertiary" />
                ) : (
                  <File className="size-3.5 text-fg-tertiary" />
                )}
              </>
            )}
            <span className="min-w-0 truncate text-fg-secondary">{f.name}</span>
            {f.shared && (
              <Share2 className="ml-auto size-3 shrink-0 text-fg-quaternary" aria-label={`shared, ${f.shared.permission}`} />
            )}
          </button>
          {f.type === 'dir' && open.has(f.path) && (
            <Dir employeeId={employeeId} dir={f.path} depth={depth + 1} selected={selected} onSelect={onSelect} />
          )}
        </div>
      ))}
    </div>
  )
}

function Editor({ employeeId, path }: { employeeId: string; path: string }) {
  const api = useApi()
  const file = useLoad((a) => a.readFile(employeeId, path), [employeeId, path])
  const [draft, setDraft] = useState<string | null>(null)
  if (!file.data) return <LoadingRows rows={4} />
  const f = file.data
  const readOnly = path.startsWith('/shared/')
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
      </div>
      {path.endsWith('.md') ? (
        <DocumentEditor value={f.content} onSave={readOnly ? undefined : save} />
      ) : (
        <div className="flex flex-col gap-2">
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

/** Each employee's own filesystem: browse, read and edit (markdown rendered). */
export function FilesPage() {
  const { employees, current } = useEmployees()
  const [params, setParams] = useSearchParams()
  const employeeId = params.get('employee') ?? current?.id ?? employees[0]?.id ?? null
  const path = params.get('path')
  const emp = employees.find((e) => e.id === employeeId)
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    n.set(k, v)
    if (k === 'employee') n.delete('path')
    setParams(n, { replace: true })
  }
  return (
    <Page title="Files" icon={<FileText />} className="flex flex-col overflow-auto md:flex-row md:overflow-hidden">
      {!employeeId ? (
        <LoadingRows />
      ) : (
        <>
          <nav
            className="flex shrink-0 flex-col gap-2 overflow-auto border-b bg-level-1 p-2 max-md:max-h-72 md:w-64 md:border-r md:border-b-0"
            aria-label="Files"
          >
            <div className="flex flex-wrap gap-1">
              {employees.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => set('employee', e.id)}
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
            <Dir key={employeeId} employeeId={employeeId} dir="/" depth={0} selected={path} onSelect={(p) => set('path', p)} />
            <p className="mt-auto px-1 text-tiny text-fg-quaternary">
              Private to {emp?.data.name ?? 'this employee'}'s sessions unless shared. Shared files appear under /shared.
            </p>
          </nav>
          <section className="min-w-0 flex-1 overflow-auto">
            {path ? (
              <Editor key={`${employeeId}${path}`} employeeId={employeeId} path={path} />
            ) : (
              <EmptyState text="Pick a file to read or edit." />
            )}
          </section>
        </>
      )}
    </Page>
  )
}
