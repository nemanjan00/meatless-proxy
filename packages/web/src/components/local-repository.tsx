import { ApiRequestError, type AttachedRemote, type LocalBranchInfo, type LocalComparison, type LocalProject } from '@mp/api'
import { ChevronRight, File, Folder, GitBranch, GitMerge, Trash2, Upload, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { SectionTitle } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { timeAgo } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

/** Whether a project's repositories include one the harness hosts (`local:<slug>`). */
export const hasLocalRepository = (data: Record<string, unknown>): boolean =>
  Array.isArray(data.repositories) &&
  (data.repositories as { url?: unknown }[]).some((r) => typeof r?.url === 'string' && r.url.startsWith('local:'))

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** "3 ahead · 1 behind", or "merged" when the default branch has all of it. */
function aheadBehind(b: { ahead: number; behind: number }) {
  if (b.ahead === 0) return 'merged'
  return b.behind ? `${b.ahead} ahead · ${b.behind} behind` : `${b.ahead} ahead`
}

/** A unified diff, coloured by line. */
export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  if (!diff.trim()) return <p className="py-2 text-fg-tertiary">No changes.</p>
  const lines = diff.split('\n')
  return (
    <div className="max-h-[560px] overflow-auto rounded-lg border bg-level-1" data-testid="local-diff">
      <pre className="min-w-fit p-2 font-mono text-micro leading-5">
        {lines.map((l, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines are positional
            key={i}
            className={cn(
              'whitespace-pre px-1',
              l.startsWith('diff --git') && 'mt-2 font-medium text-foreground first:mt-0',
              (l.startsWith('+++') || l.startsWith('---') || l.startsWith('index ')) && 'text-fg-tertiary',
              l.startsWith('@@') && 'text-[#4ea7fc]',
              l.startsWith('+') && !l.startsWith('+++') && 'bg-[#27a644]/10 text-[#27a644]',
              l.startsWith('-') && !l.startsWith('---') && 'bg-[#eb5757]/10 text-[#eb5757]',
            )}
          >
            {l || ' '}
          </div>
        ))}
      </pre>
      {truncated && (
        <p className="border-t px-3 py-2 text-micro text-fg-tertiary">The diff is too big to show whole: it was cut here.</p>
      )}
    </div>
  )
}

/** The merge conflict a 409 reported: which files, and what to do. */
function ConflictNote({ message, files, onClose }: { message: string; files: string[]; onClose(): void }) {
  return (
    <div role="alert" className="mb-3 rounded-lg border border-[#eb5757]/40 bg-[#eb5757]/10 p-3" data-testid="local-conflict">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-mini text-fg-secondary">{message}</p>
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onClose}>
          <X />
        </Button>
      </div>
      {files.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 font-mono text-micro text-[#eb5757]">
          {files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One branch opened for review: its commits, files and diff, with Merge and Delete. */
function BranchReview({
  projectId,
  branch,
  base,
  canMerge,
  onChanged,
}: {
  projectId: string
  branch: LocalBranchInfo
  base: string
  canMerge: boolean
  onChanged(next?: LocalProject): void
}) {
  const api = useApi()
  const cmp = useLoad((a) => a.compareLocalBranch(projectId, branch.name), [projectId, branch.name, branch.sha])
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<{ message: string; files: string[] } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const merge = async () => {
    setBusy(true)
    setConflict(null)
    try {
      const r = await api.mergeLocalBranch(projectId, branch.name)
      toast(`${r.branch} merged into ${r.into}`, {
        description: r.mode === 'fast-forward' ? 'Fast-forward.' : `Merge commit ${r.sha.slice(0, 12)}.`,
      })
      onChanged()
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        const files = ((err.details as { files?: unknown } | undefined)?.files ?? []) as string[]
        setConflict({ message: err.message, files: Array.isArray(files) ? files : [] })
      } else toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      const next = await api.deleteLocalBranch(projectId, branch.name)
      toast(`${branch.name} deleted`)
      setConfirmDelete(false)
      onChanged(next)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const c: LocalComparison | undefined = cmp.data
  return (
    <div className="mt-1 mb-3 rounded-xl border bg-level-1 p-3" data-testid="local-branch-review">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-micro text-fg-secondary">{branch.name}</span>
        <span className="text-micro text-fg-quaternary">into {base}</span>
        {c && (
          <span className="text-micro text-fg-tertiary">
            {c.ahead === 0 ? 'nothing to merge' : c.fastForward ? 'fast-forward' : 'needs a merge commit'}
          </span>
        )}
        <span className="ml-auto" />
        {canMerge ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
              <Trash2 />
              Delete branch
            </Button>
            <Button size="sm" onClick={merge} disabled={busy || !c || c.ahead === 0} data-testid="local-merge">
              <GitMerge />
              {busy ? 'Merging…' : 'Merge'}
            </Button>
          </>
        ) : (
          <span className="text-micro text-fg-quaternary">Admins and the project's owners and reviewers merge.</span>
        )}
      </div>
      {conflict && <ConflictNote {...conflict} onClose={() => setConflict(null)} />}
      {cmp.error && !c ? (
        <ErrorState error={cmp.error} retry={cmp.reload} />
      ) : !c ? (
        <LoadingRows rows={3} />
      ) : (
        <>
          <SectionTitle className="mb-1">
            {c.commits.length} commit{c.commits.length === 1 ? '' : 's'}
          </SectionTitle>
          <div className="mb-3 flex flex-col">
            {c.commits.map((x) => (
              <div key={x.sha} className="flex h-8 min-w-0 items-center gap-2">
                <span className="shrink-0 font-mono text-micro text-fg-quaternary">{x.sha.slice(0, 8)}</span>
                <span className="min-w-0 flex-1 truncate text-fg-secondary">{x.subject}</span>
                <span className="hidden shrink-0 truncate text-micro text-fg-tertiary sm:inline">
                  {x.author.replace(/ <.*>$/, '')}
                </span>
                <span className="shrink-0 text-micro text-fg-quaternary">{timeAgo(x.date)}</span>
              </div>
            ))}
          </div>
          <SectionTitle className="mb-1">
            {c.files.length} file{c.files.length === 1 ? '' : 's'} changed
          </SectionTitle>
          <div className="mb-3 flex flex-col font-mono text-micro">
            {c.files.map((f) => (
              <div key={f.path} className="flex h-6 items-center gap-2">
                <span
                  className={cn(
                    'w-3 shrink-0',
                    f.status === 'A' && 'text-[#27a644]',
                    f.status === 'D' && 'text-[#eb5757]',
                    f.status === 'M' && 'text-[#f0bf00]',
                  )}
                >
                  {f.status}
                </span>
                <span className="min-w-0 truncate text-fg-secondary">{f.path}</span>
              </div>
            ))}
          </div>
          <DiffView diff={c.diff} truncated={c.truncated} />
        </>
      )}
      <Dialog open={confirmDelete} onOpenChange={(o) => !busy && setConfirmDelete(o)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-title1">Delete {branch.name}?</DialogTitle>
            <DialogDescription className="text-mini text-fg-tertiary">
              {branch.ahead > 0
                ? `It has ${branch.ahead} commit${branch.ahead === 1 ? '' : 's'} that ${base} doesn't: they are gone from this repository. The employee's session is told.`
                : `${base} already has everything on it. The employee's session is told.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={remove} disabled={busy}>
              Delete branch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** A read-only file browser of the default branch. */
function FileBrowser({ projectId, head }: { projectId: string; head: string }) {
  const [dir, setDir] = useState('')
  const [file, setFile] = useState<string | null>(null)
  const tree = useLoad((a) => a.localTree(projectId, dir || undefined), [projectId, dir, head])
  const blob = useLoad((a) => (file ? a.localFile(projectId, file) : Promise.resolve(null)), [projectId, file, head])
  const parts = dir ? dir.split('/') : []
  const open = (path: string) => {
    setFile(null)
    setDir(path)
  }
  return (
    <div data-testid="local-files">
      <div className="mb-2 flex flex-wrap items-center gap-1 font-mono text-micro text-fg-tertiary">
        <button type="button" className="hover:text-foreground" onClick={() => open('')}>
          /
        </button>
        {parts.map((p, i) => (
          <span key={parts.slice(0, i + 1).join('/')} className="flex items-center gap-1">
            <ChevronRight className="size-3" />
            <button type="button" className="hover:text-foreground" onClick={() => open(parts.slice(0, i + 1).join('/'))}>
              {p}
            </button>
          </span>
        ))}
        {file && (
          <span className="flex items-center gap-1 text-fg-secondary">
            <ChevronRight className="size-3" />
            {file.split('/').pop()}
          </span>
        )}
      </div>
      {file ? (
        blob.error ? (
          <ErrorState error={blob.error} retry={blob.reload} />
        ) : !blob.data ? (
          <LoadingRows rows={3} />
        ) : blob.data.content === null ? (
          <p className="py-2 text-fg-tertiary">
            {blob.data.binary ? 'A binary file' : 'Too big to show'} ({blob.data.size.toLocaleString('en-US')} bytes).
          </p>
        ) : (
          <pre className="max-h-[560px] overflow-auto rounded-lg border bg-level-1 p-3 font-mono text-micro leading-5">
            {blob.data.content}
          </pre>
        )
      ) : tree.error ? (
        <ErrorState error={tree.error} retry={tree.reload} />
      ) : !tree.data ? (
        <LoadingRows rows={3} />
      ) : tree.data.entries.length === 0 ? (
        <p className="py-2 text-fg-tertiary">Empty: nothing is merged into it yet.</p>
      ) : (
        <div className="flex flex-col">
          {tree.data.entries.map((e) => {
            const path = dir ? `${dir}/${e.name}` : e.name
            return (
              <button
                key={e.name}
                type="button"
                onClick={() => (e.type === 'dir' ? open(path) : setFile(path))}
                className="flex h-8 min-w-0 items-center gap-2 text-left text-fg-secondary hover:text-foreground"
              >
                {e.type === 'dir' ? (
                  <Folder className="size-4 shrink-0 text-fg-tertiary" />
                ) : (
                  <File className="size-4 shrink-0 text-fg-tertiary" />
                )}
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {e.size !== undefined && (
                  <span className="shrink-0 text-micro text-fg-quaternary">{e.size.toLocaleString('en-US')} B</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** "Attach a remote" (admins): push everything to a new, empty remote and make it the repository. */
function AttachRemoteDialog({
  projectId,
  open,
  onOpenChange,
  onAttached,
}: {
  projectId: string
  open: boolean
  onOpenChange(open: boolean): void
  onAttached(r: AttachedRemote): void
}) {
  const api = useApi()
  const [url, setUrl] = useState('')
  const [httpUrl, setHttpUrl] = useState('')
  const [as, setAs] = useState<{ employeeId: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!url.trim()) return setError('Give the remote URL.')
    setBusy(true)
    setError(null)
    try {
      const r = await api.attachRemote(projectId, {
        url: url.trim(),
        ...(httpUrl.trim() ? { httpUrl: httpUrl.trim() } : {}),
        ...(as ? { employeeId: as.employeeId } : {}),
      })
      toast(`Pushed ${r.branches.length} branch${r.branches.length === 1 ? '' : 'es'}`, {
        description: `${r.project.data.name} now uses ${url.trim()}${r.pushedAs ? ` (pushed with ${r.pushedAs.name}'s key)` : ''}.`,
      })
      onOpenChange(false)
      onAttached(r)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="gap-4 sm:max-w-[520px]" data-testid="attach-remote-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">Attach a remote</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            Every branch is pushed to a new, empty repository on your git host, and the project switches to it: checkouts fetch
            from it and reviews move to merge requests there. The local repository is kept.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1 text-micro">
            <label htmlFor="ar-url" className="font-medium text-fg-secondary">
              Remote URL
            </label>
            <Input
              id="ar-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
              className="font-mono text-micro"
              placeholder="git@gitlab.example.com:acme/parser.git"
            />
          </div>
          <div className="flex flex-col gap-1 text-micro">
            <label htmlFor="ar-http" className="font-medium text-fg-secondary">
              https URL <span className="font-normal text-fg-quaternary">Optional, when the remote URL is ssh</span>
            </label>
            <Input
              id="ar-http"
              value={httpUrl}
              onChange={(e) => setHttpUrl(e.target.value)}
              className="font-mono text-micro"
              placeholder="https://gitlab.example.com/acme/parser"
            />
          </div>
          <div className="flex flex-col gap-1 text-micro">
            <span className="font-medium text-fg-secondary">
              Push with{' '}
              <span className="font-normal text-fg-quaternary">An employee's SSH key; default: the project's owner</span>
            </span>
            {as ? (
              <div className="flex h-8 items-center gap-2 rounded-md border px-2">
                <EmployeeAvatar name={as.name} className="size-4" />
                <span className="min-w-0 flex-1 truncate text-mini text-fg-secondary">{as.name}</span>
                <Button type="button" size="icon-xs" variant="ghost" aria-label="Clear" onClick={() => setAs(null)}>
                  <X />
                </Button>
              </div>
            ) : (
              <RecordPicker
                kinds={['employee']}
                placeholder="Search employees…"
                onPick={(o) => setAs({ employeeId: o.id, name: o.label })}
              />
            )}
          </div>
          {error && (
            <p role="alert" className="text-micro text-[var(--red)]">
              {error}
            </p>
          )}
          <DialogFooter className="pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Pushing…' : 'Push and switch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A local project's repository on its page (docs/spec.md#local-projects): the branches employees
 * pushed, each opened for review with its commits and diff, Merge and Delete for admins and the
 * project's owners and reviewers; the default branch's files; and, for admins, attaching a remote.
 */
export function LocalRepositorySection({
  projectId,
  className,
  onRemoteAttached,
}: {
  projectId: string
  className?: string
  onRemoteAttached?(): void
}) {
  const local = useLoad((a) => a.localProject(projectId), [projectId])
  // `?branch=` (a link to a branch, e.g. a session's subscription) opens that branch's review.
  const [params] = useSearchParams()
  const wanted = params.get('branch')
  const [open, setOpen] = useState<string | null>(wanted)
  const section = useRef<HTMLElement>(null)
  const loaded = !!local.data
  useEffect(() => {
    if (wanted && loaded) section.current?.scrollIntoView?.({ block: 'start' })
  }, [wanted, loaded])
  const [attach, setAttach] = useState(false)
  const data = local.data
  const changed = (next?: LocalProject) => (next ? local.setData(next) : local.reload())
  const pending = data?.branches.filter((b) => b.ahead > 0) ?? []
  const merged = data?.branches.filter((b) => b.ahead === 0) ?? []
  const head = data ? `${data.defaultBranch}:${merged.map((b) => b.sha).join(',')}:${pending.length}` : ''
  const row = (b: LocalBranchInfo) => (
    <div key={b.name}>
      <button
        type="button"
        onClick={() => setOpen(open === b.name ? null : b.name)}
        className="group flex h-9 w-full min-w-0 items-center gap-2 text-left"
        aria-expanded={open === b.name}
        data-testid="local-branch"
      >
        <GitBranch className={cn('size-4 shrink-0', b.ahead > 0 ? 'text-[#828fff]' : 'text-fg-quaternary')} />
        <span className="min-w-0 shrink truncate font-mono text-micro text-fg-secondary group-hover:text-foreground">
          {b.name}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg-tertiary">{b.subject}</span>
        <span className="shrink-0 text-micro text-fg-tertiary">{aheadBehind(b)}</span>
        <span className="hidden w-16 shrink-0 text-right text-micro text-fg-quaternary sm:inline" title={b.date}>
          {timeAgo(b.date)}
        </span>
      </button>
      {open === b.name && data && (
        <BranchReview projectId={projectId} branch={b} base={data.defaultBranch} canMerge={data.canMerge} onChanged={changed} />
      )}
    </div>
  )
  return (
    <section
      ref={section}
      className={cn('flex flex-col', className)}
      aria-labelledby="local-repo-title"
      data-testid="local-repository"
    >
      <SectionTitle
        className="mb-1"
        actions={
          data?.canAttachRemote ? (
            <Button size="xs" variant="ghost" onClick={() => setAttach(true)}>
              <Upload />
              Attach a remote
            </Button>
          ) : undefined
        }
      >
        <span id="local-repo-title">Repository</span>
        {data && (
          <span className="ml-2 font-mono font-normal text-fg-quaternary">
            {data.url} · {data.defaultBranch}
          </span>
        )}
      </SectionTitle>
      {local.error && !data ? (
        <ErrorState error={local.error} retry={local.reload} />
      ) : !data ? (
        <LoadingRows rows={2} />
      ) : (
        <Tabs defaultValue="branches">
          <TabsList variant="line" className="h-8 w-full justify-start gap-3 border-b pb-0">
            <TabsTrigger value="branches" className="flex-none px-0">
              To review <span className="text-fg-quaternary">{pending.length}</span>
            </TabsTrigger>
            <TabsTrigger value="files" className="flex-none px-0">
              Files
            </TabsTrigger>
          </TabsList>
          <TabsContent value="branches" className="pt-1">
            {pending.length === 0 ? (
              <EmptyState
                className="py-6"
                text={
                  merged.length
                    ? `Nothing to review: ${data.defaultBranch} has every branch.`
                    : 'No branches yet. Employees push their work here, and it shows up for review.'
                }
              />
            ) : (
              <div className="flex flex-col">{pending.map(row)}</div>
            )}
            {merged.length > 0 && (
              <details className="mt-2" open={merged.some((b) => b.name === wanted) || undefined}>
                <summary className="cursor-pointer text-micro text-fg-tertiary">
                  {merged.length} merged branch{merged.length === 1 ? '' : 'es'}
                </summary>
                <div className="flex flex-col">{merged.map(row)}</div>
              </details>
            )}
            <p className="mt-2 text-micro text-fg-quaternary">
              {data.canMerge
                ? 'You can merge: open a branch to review it.'
                : "Admins and the project's owners, backups and reviewers merge."}
            </p>
          </TabsContent>
          <TabsContent value="files" className="pt-2">
            <FileBrowser projectId={projectId} head={head} />
          </TabsContent>
        </Tabs>
      )}
      <AttachRemoteDialog projectId={projectId} open={attach} onOpenChange={setAttach} onAttached={() => onRemoteAttached?.()} />
    </section>
  )
}
