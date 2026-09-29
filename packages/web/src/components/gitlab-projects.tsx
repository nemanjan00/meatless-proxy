import type { IntegrationSetupStatus, SetupStep } from '@mp/api'
import { CircleAlert, CircleCheck, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link as RouterLink } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { useApi } from '@/lib/api.tsx'

/** One GitLab project of the "Projects" step, as the server checked it. */
export interface GitlabProjectRow {
  id: number
  path: string
  webUrl: string | null
  role: string
  defaultBranch: string | null
  protected: boolean | null
  warnings: string[]
  /** The harness project with its repository, and whether the employee is on it; null when there is none. */
  added?: { projectId: string; name: string; linked: boolean } | null
}

/**
 * The GitLab projects the employee's account reaches: access, branch protection, and whether
 * each is one of its harness projects yet. Admins add one ("Add as project") or several at once
 * ("Add selected"): a harness project with its repository, with the employee as a member. One
 * the harness already has is only linked.
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
  const api = useApi()
  const rows = (Array.isArray(step.data?.projects) ? step.data.projects : []) as unknown as GitlabProjectRow[]
  const [picked, setPicked] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  if (!rows.length) return null
  const open = rows.filter((p) => !p.added?.linked)
  const editable = admin && canAdd
  const add = async (ids: number[]) => {
    setBusy(true)
    try {
      const r = await api.integrationAction(employeeId, 'gitlab', 'add-projects', { projects: ids })
      toast(r.message)
      setPicked([])
      onChange(r.integration)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-md border" data-testid="gitlab-projects">
        {rows.map((p) => {
          const done = !!p.added?.linked
          return (
            <div key={p.id} className="border-b px-2.5 py-1.5 last:border-b-0" data-testid="gitlab-project" data-added={done}>
              <div className="flex min-h-6 items-center gap-2">
                {editable && !done ? (
                  <Checkbox
                    aria-label={`Select ${p.path}`}
                    checked={picked.includes(p.id)}
                    onCheckedChange={(on) => setPicked((l) => (on ? [...l, p.id] : l.filter((x) => x !== p.id)))}
                  />
                ) : p.warnings.length ? (
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
                <span className="shrink-0 text-micro text-fg-tertiary">{p.role}</span>
                {p.defaultBranch && (
                  <span className="hidden shrink-0 text-micro text-fg-quaternary sm:inline">
                    {p.defaultBranch}
                    {p.protected === true ? ' · protected' : p.protected === false ? ' · unprotected' : ''}
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
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => add([p.id])}>
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
              {p.warnings.map((w) => (
                <p key={w} className="mt-0.5 pl-6 text-micro text-[var(--orange)]">
                  {w}
                </p>
              ))}
            </div>
          )
        })}
      </div>
      {editable && open.length > 1 && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy || !picked.length} onClick={() => add(picked)}>
            {busy ? 'Adding…' : `Add selected${picked.length ? ` (${picked.length})` : ''}`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-fg-tertiary"
            disabled={busy}
            onClick={() => setPicked(picked.length === open.length ? [] : open.map((p) => p.id))}
          >
            {picked.length === open.length ? 'Select none' : 'Select all'}
          </Button>
        </div>
      )}
    </div>
  )
}
