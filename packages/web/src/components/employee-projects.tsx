import { FolderKanban, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { NewProjectButton } from '@/components/new-project-dialog.tsx'
import { SectionTitle } from '@/components/page.tsx'
import { RoleBadges, RoleSelect } from '@/components/project-people.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useApi, useLiveReload, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'

/**
 * The projects an employee works on (its project links), with its roles, each project's owner
 * and repository. Members and admins add a project with a typeahead and a role, remove one, or
 * create a new one it owns. The employee gets the current list with each new piece of work.
 */
export function EmployeeProjects({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const api = useApi()
  const { can } = useAuth()
  const canEdit = can('member')
  const data = useLoad((a) => a.employeeProjects(employeeId), [employeeId])
  useLiveReload(['records:project'], data.reload)
  const [role, setRole] = useState('member')
  const [busy, setBusy] = useState(false)
  const projects = data.data?.projects ?? []
  const contactId = data.data?.contactId

  const change = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast(done)
      data.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="projects-title" data-testid="employee-projects">
      <SectionTitle
        actions={
          canEdit ? (
            <NewProjectButton variant="ghost" owner={{ employeeId, name: employeeName }} onCreated={() => data.reload()} />
          ) : null
        }
      >
        <span id="projects-title">Projects</span>
      </SectionTitle>
      <p className="text-fg-tertiary">
        What {employeeName} works on. It sees this list, with its role, the repositories and each owner, at the start of every
        piece of work, so a change here reaches it without a restart.
      </p>
      {data.error && !data.data ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : !data.data ? (
        <LoadingRows rows={2} />
      ) : projects.length === 0 ? (
        <div className="rounded-xl border bg-level-1 px-3 py-3 text-fg-tertiary" data-testid="employee-projects-empty">
          No projects yet, so it will say it isn’t assigned to any. {canEdit ? 'Add one below, or create a new one.' : ''}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-level-1">
          {projects.map((p) => {
            const repo = p.project.data.repositories?.[0]?.url
            return (
              <div
                key={p.project.id}
                className="group flex h-9 items-center gap-2 border-b px-3 last:border-b-0"
                data-testid="employee-project"
              >
                <FolderKanban className="size-4 shrink-0 text-fg-tertiary" />
                <Link to={`/projects/${p.project.id}`} className="shrink-0 truncate text-fg-secondary hover:text-foreground">
                  {p.project.data.name}
                </Link>
                <RoleBadges roles={p.roles} />
                <span className="min-w-0 flex-1 truncate font-mono text-micro text-fg-quaternary" title={repo}>
                  {repo ?? ''}
                </span>
                {p.owner && !p.roles.includes('owner') && (
                  <span className="hidden shrink-0 text-micro text-fg-tertiary sm:inline">owner {p.owner.name}</span>
                )}
                {canEdit && contactId && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-fg-quaternary opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Remove from ${p.project.data.name}`}
                    disabled={busy}
                    onClick={() =>
                      change(
                        () => api.removeProjectPerson(p.project.id, contactId),
                        `${employeeName} is off ${p.project.data.name}`,
                      )
                    }
                  >
                    <X />
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {canEdit && data.data && (
        <div className="flex items-center gap-2" data-testid="employee-projects-add">
          <RecordPicker
            kinds={['project']}
            exclude={projects.map((p) => p.project.id)}
            placeholder="Add a project…"
            className="min-w-0 flex-1"
            onPick={(o) =>
              change(() => api.addProjectPerson(o.id, { employeeId, role }), `${employeeName} added to ${o.label} as ${role}`)
            }
          />
          <RoleSelect value={role} onChange={setRole} />
        </div>
      )}
    </section>
  )
}
