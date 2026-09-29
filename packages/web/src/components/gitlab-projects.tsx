import type { GitlabBranchProtection, GitlabProjectRow, IntegrationSetupStatus, SetupStep } from '@mp/api'
import { CircleAlert, CircleCheck, Plus, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link as RouterLink } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Input } from '@/components/ui/input.tsx'
import { useApi } from '@/lib/api.tsx'
import { cn } from '@/lib/utils.ts'

export type { GitlabProjectRow } from '@mp/api'

/** How long typing pauses before the search goes to the server. */
export const GITLAB_SEARCH_DEBOUNCE_MS = 300
/** Rows per page. */
const PER_PAGE = 50
/** The server adds at most this many per request; bigger selections go in batches. */
const ADD_BATCH = 50
/** Default branch checks in flight at once. */
const CHECKS_IN_FLIGHT = 4

type Filter = 'all' | 'open' | 'added'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Not added' },
  { id: 'added', label: 'Added' },
]

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The GitLab projects the employee's account reaches: access, branch protection, and whether each
 * is one of its harness projects yet. Admins search and page through all of them (server-side, from
 * GitLab), and add one ("Add as project") or several at once ("Add selected", kept across pages and
 * searches): a harness project with its repository, with the employee as a member. One the harness
 * already has is only linked. Members see the status check's first page, read-only.
 */
export function GitlabProjects({
  employeeId,
  step,
  admin,
  canAdd,
  onChange,
}: {
  employeeId: string
  step: SetupStep
  admin: boolean
  /** Whether the server offers `add-projects` now. */
  canAdd: boolean
  onChange(next: IntegrationSetupStatus): void
}) {
  if (admin && canAdd) return <GitlabProjectBrowser employeeId={employeeId} onChange={onChange} />
  const rows = (Array.isArray(step.data?.projects) ? step.data.projects : []) as unknown as GitlabProjectRow[]
  if (!rows.length) return null
  return (
    <div className="overflow-hidden rounded-md border" data-testid="gitlab-projects">
      {rows.map((p) => (
        <ProjectRow key={p.id} p={p} />
      ))}
    </div>
  )
}

interface Listing {
  rows: GitlabProjectRow[]
  nextPage: number | null
  total: number | null
  /** Pages loaded so far. */
  pages: number
  /** The search these rows answer. */
  search: string
}

function GitlabProjectBrowser({ employeeId, onChange }: { employeeId: string; onChange(next: IntegrationSetupStatus): void }) {
  const api = useApi()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [list, setList] = useState<Listing | null>(null)
  const [loading, setLoading] = useState<'first' | 'more' | null>('first')
  const [error, setError] = useState<string | null>(null)
  /** Selected GitLab project ids with their paths, across pages and searches. */
  const [picked, setPicked] = useState<Map<number, string>>(() => new Map())
  const [busy, setBusy] = useState(false)
  const [checks, setChecks] = useState<Record<number, GitlabBranchProtection | 'failed'>>({})
  const seq = useRef(0)
  const requested = useRef(new Set<number>())

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), GITLAB_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [text])

  /** Loads pages 1..`pages` of `search` (a reload after adding keeps what was loaded), dropping stale answers. */
  const load = useCallback(
    async (search: string, pages = 1) => {
      const mine = ++seq.current
      setLoading('first')
      setError(null)
      try {
        const got = await Promise.all(
          Array.from({ length: pages }, (_, i) => api.gitlabProjects(employeeId, { search, page: i + 1, perPage: PER_PAGE })),
        )
        if (mine !== seq.current) return
        const last = got.at(-1)!
        const seen = new Set<number>()
        const rows = got.flatMap((g) => g.projects).filter((p) => !seen.has(p.id) && seen.add(p.id))
        setList({ rows, nextPage: last.nextPage, total: last.total, pages, search })
      } catch (err) {
        if (mine === seq.current) setError(errorText(err))
      } finally {
        if (mine === seq.current) setLoading(null)
      }
    },
    [api, employeeId],
  )

  useEffect(() => {
    void load(query)
  }, [load, query])

  const more = async () => {
    if (!list?.nextPage) return
    const mine = seq.current
    setLoading('more')
    try {
      const g = await api.gitlabProjects(employeeId, { search: list.search, page: list.nextPage, perPage: PER_PAGE })
      if (mine !== seq.current) return
      setList((l) => {
        if (!l) return l
        const have = new Set(l.rows.map((p) => p.id))
        return {
          rows: [...l.rows, ...g.projects.filter((p) => !have.has(p.id))],
          nextPage: g.nextPage,
          total: g.total,
          pages: l.pages + 1,
          search: l.search,
        }
      })
    } catch (err) {
      if (mine === seq.current) toast.error(errorText(err))
    } finally {
      if (mine === seq.current) setLoading(null)
    }
  }

  // The default branch check, per loaded row, a few at a time (a page stays fast).
  useEffect(() => {
    const todo = (list?.rows ?? []).filter((p) => p.defaultBranch && !requested.current.has(p.id))
    if (!todo.length) return
    for (const p of todo) requested.current.add(p.id)
    let i = 0
    const worker = async () => {
      while (i < todo.length) {
        const p = todo[i++]!
        const r = await api.gitlabProjectProtection(employeeId, p.id).catch(() => 'failed' as const)
        setChecks((c) => ({ ...c, [p.id]: r }))
      }
    }
    for (let k = 0; k < Math.min(CHECKS_IN_FLIGHT, todo.length); k++) void worker()
  }, [api, employeeId, list])

  const add = async (ids: number[]) => {
    setBusy(true)
    try {
      const messages: string[] = []
      let last: IntegrationSetupStatus | null = null
      for (let k = 0; k < ids.length; k += ADD_BATCH) {
        const r = await api.integrationAction(employeeId, 'gitlab', 'add-projects', { projects: ids.slice(k, k + ADD_BATCH) })
        messages.push(r.message)
        last = r.integration
      }
      toast(messages.join(' '))
      setPicked((m) => {
        const next = new Map(m)
        for (const id of ids) next.delete(id)
        return next
      })
      if (last) onChange(last)
      await load(query, list?.pages ?? 1)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (p: GitlabProjectRow, on: boolean) =>
    setPicked((m) => {
      const next = new Map(m)
      if (on) next.set(p.id, p.path)
      else next.delete(p.id)
      return next
    })

  const rows = list?.rows ?? []
  const shown = rows.filter((p) => (filter === 'all' ? true : filter === 'added' ? !!p.added?.linked : !p.added?.linked))
  const open = shown.filter((p) => !p.added?.linked)
  const allShownPicked = open.length > 0 && open.every((p) => picked.has(p.id))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-quaternary" />
          <Input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search projects"
            aria-label="Search GitLab projects"
            className="h-7 pl-8 text-mini"
          />
        </div>
        <fieldset className="m-0 flex items-center rounded-md border p-0.5">
          <legend className="sr-only">Filter projects</legend>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded-sm px-2 py-0.5 text-micro text-fg-tertiary transition-colors duration-100 hover:text-foreground',
                filter === f.id && 'bg-secondary text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </fieldset>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-micro" data-testid="gitlab-projects-error">
          <CircleAlert className="size-3.5 shrink-0" style={{ color: 'var(--red)' }} />
          <span className="min-w-0 flex-1 text-[var(--red)]">Couldn’t list the projects: {error}</span>
          <Button size="xs" variant="outline" onClick={() => load(query, list?.pages ?? 1)}>
            Retry
          </Button>
        </div>
      ) : !list && loading ? (
        <p className="text-micro text-fg-tertiary">Loading projects…</p>
      ) : !rows.length ? (
        <p className="text-micro text-fg-tertiary" data-testid="gitlab-projects-empty">
          {list?.search ? `No project matches “${list.search}”.` : 'The account isn’t a member of any project yet.'}
        </p>
      ) : !shown.length ? (
        <p className="text-micro text-fg-tertiary" data-testid="gitlab-projects-empty">
          {filter === 'added' ? 'None of the projects loaded so far is added.' : 'Every project loaded so far is added.'}
        </p>
      ) : (
        <div
          className={cn('overflow-hidden rounded-md border', loading === 'first' && 'opacity-60')}
          data-testid="gitlab-projects"
          aria-busy={loading === 'first'}
        >
          {shown.map((p) => (
            <ProjectRow
              key={p.id}
              p={p}
              check={checks[p.id]}
              picked={picked.has(p.id)}
              busy={busy}
              onPick={(on) => toggle(p, on)}
              onAdd={() => add([p.id])}
            />
          ))}
        </div>
      )}

      {list && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-micro text-fg-tertiary">
          <span data-testid="gitlab-projects-count">
            {list.total !== null ? `${rows.length} of ${list.total}` : `${rows.length}`} project
            {(list.total ?? rows.length) === 1 ? '' : 's'}
            {list.search ? ` matching “${list.search}”` : ''}
          </span>
          {list.nextPage !== null && (
            <Button size="xs" variant="ghost" disabled={loading !== null} onClick={more}>
              {loading === 'more' ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </div>
      )}

      {(open.length > 0 || picked.size > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || !picked.size} onClick={() => add([...picked.keys()])}>
            {busy ? 'Adding…' : `Add selected${picked.size ? ` (${picked.size})` : ''}`}
          </Button>
          {open.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              className="text-fg-tertiary"
              disabled={busy}
              onClick={() =>
                setPicked((m) => {
                  const next = new Map(m)
                  for (const p of open) {
                    if (allShownPicked) next.delete(p.id)
                    else next.set(p.id, p.path)
                  }
                  return next
                })
              }
            >
              {allShownPicked ? 'Select none' : 'Select all shown'}
            </Button>
          )}
          {picked.size > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="text-fg-tertiary"
              disabled={busy}
              title={[...picked.values()].join(', ')}
              onClick={() => setPicked(new Map())}
            >
              Clear selection
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** One GitLab project: its path, role, default branch, whether it's added, and its warnings. */
function ProjectRow({
  p,
  check,
  picked,
  busy,
  onPick,
  onAdd,
}: {
  p: GitlabProjectRow
  check?: GitlabBranchProtection | 'failed' | undefined
  picked?: boolean
  busy?: boolean
  /** Given when the row can be selected and added. */
  onPick?(on: boolean): void
  onAdd?(): void
}) {
  const done = !!p.added?.linked
  const editable = !!onPick && !!onAdd
  const result = check && check !== 'failed' ? check : null
  const isProtected = result ? result.protected : p.protected
  const warnings = [...p.warnings, ...(result?.warning && !p.warnings.includes(result.warning) ? [result.warning] : [])]
  return (
    <div className="border-b px-2.5 py-1.5 last:border-b-0" data-testid="gitlab-project" data-added={done}>
      <div className="flex min-h-6 items-center gap-2">
        {editable && !done ? (
          <Checkbox aria-label={`Select ${p.path}`} checked={!!picked} onCheckedChange={(on) => onPick!(on === true)} />
        ) : warnings.length ? (
          <CircleAlert className="size-3.5 shrink-0" style={{ color: 'var(--orange)' }} aria-label="Needs attention" />
        ) : (
          <CircleCheck className="size-3.5 shrink-0" style={{ color: 'var(--green)' }} aria-label="Done" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-micro text-fg-secondary">
          {p.webUrl ? (
            <a href={p.webUrl} target="_blank" rel="noreferrer noopener" className="text-[#828fff] hover:underline">
              {p.path}
            </a>
          ) : (
            p.path
          )}
        </span>
        {p.role && <span className="shrink-0 text-micro text-fg-tertiary">{p.role}</span>}
        {p.defaultBranch && (
          <span className="hidden shrink-0 text-micro text-fg-quaternary sm:inline">
            {p.defaultBranch}
            {isProtected === true ? ' · protected' : isProtected === false ? ' · unprotected' : ''}
          </span>
        )}
        {done ? (
          <RouterLink
            to={`/projects/${p.added!.projectId}`}
            className="shrink-0 text-micro text-fg-tertiary hover:text-foreground"
            title={`Harness project ${p.added!.name}`}
          >
            Added
          </RouterLink>
        ) : editable ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={onAdd}>
            <Plus />
            {p.added ? 'Link' : 'Add as project'}
          </Button>
        ) : (
          <span className="shrink-0 text-micro text-fg-quaternary">not added</span>
        )}
      </div>
      {p.added && !done && (
        <p className="mt-0.5 pl-6 text-micro text-fg-tertiary">
          The harness has it as {p.added.name}; linking puts the employee on it.
        </p>
      )}
      {warnings.map((w) => (
        <p key={w} className="mt-0.5 pl-6 text-micro text-[var(--orange)]">
          {w}
        </p>
      ))}
    </div>
  )
}
