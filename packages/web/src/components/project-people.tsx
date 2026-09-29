import type { ProjectPeople, ProjectPerson } from '@mp/api'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { SectionTitle } from '@/components/page.tsx'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { cn } from '@/lib/utils.ts'

/** The roles offered when assigning someone to a project. */
export const PROJECT_ROLES = [
  { value: 'member', label: 'Member' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'owner', label: 'Owner' },
] as const

/** Owner, reviewer or member. Owner replaces the project's current owner; reviewers merge into local projects. */
export function RoleSelect({
  value,
  onChange,
  id,
  className,
}: {
  value: string
  onChange(role: string): void
  id?: string
  className?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" id={id} aria-label="Role" className={cn('h-7 w-28 text-mini data-[size=sm]:h-7', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROJECT_ROLES.map((r) => (
          <SelectItem key={r.value} value={r.value}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Roles as small badges; `owner` stands out a little. */
export function RoleBadges({ roles }: { roles: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {roles.map((r) => (
        <span
          key={r}
          className={cn(
            'rounded-sm border px-1 text-tiny',
            r === 'owner' ? 'border-transparent bg-accent-tint text-[#828fff]' : 'text-fg-tertiary',
          )}
        >
          {r}
        </span>
      ))}
    </span>
  )
}

function PersonRow({ p, canEdit, onRemove }: { p: ProjectPerson; canEdit: boolean; onRemove(): void }) {
  const ai = p.kind === 'ai'
  const href = ai && p.employeeId ? `/employees/${p.employeeId}` : `/contacts/${p.contactId}`
  return (
    <div className="group flex h-9 items-center gap-2" data-testid="project-person">
      {ai ? <EmployeeAvatar name={p.name} className="size-5" /> : <PersonAvatar name={p.name} className="size-5" />}
      <Link to={href} className="min-w-0 truncate text-fg-secondary hover:text-foreground">
        {p.name}
      </Link>
      {ai && p.handle && <span className="shrink-0 font-mono text-micro text-fg-quaternary">@{p.handle}</span>}
      {ai && <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary">AI</span>}
      <span className="ml-auto" />
      <RoleBadges roles={p.roles} />
      {canEdit && (
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-fg-quaternary opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Remove ${p.name}`}
          onClick={onRemove}
        >
          <X />
        </Button>
      )}
    </div>
  )
}

/**
 * The employees and people on a project, with their roles (owner first). Members and admins add
 * someone with a typeahead and a role, or remove them; assigning an employee is how it learns it
 * works on the project.
 */
export function ProjectPeopleSection({ projectId, className }: { projectId: string; className?: string }) {
  const api = useApi()
  const { can } = useAuth()
  const canEdit = can('member')
  const people = useLoad((a) => a.projectPeople(projectId), [projectId])
  const [role, setRole] = useState('member')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<ProjectPeople>, done: string) => {
    setBusy(true)
    try {
      people.setData(await fn())
      toast(done)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const list = people.data?.people ?? []
  return (
    <section className={cn('flex flex-col', className)} aria-labelledby="project-people-title" data-testid="project-people">
      <SectionTitle className="mb-1">
        <span id="project-people-title">People and employees</span>
      </SectionTitle>
      {people.error && !people.data ? (
        <ErrorState error={people.error} retry={people.reload} />
      ) : !people.data ? (
        <LoadingRows rows={2} />
      ) : list.length === 0 ? (
        <p className="py-2 text-fg-tertiary">No one is on this project yet. Assign an employee so it knows it works on it.</p>
      ) : (
        <div className="flex flex-col">
          {list.map((p) => (
            <PersonRow
              key={p.contactId}
              p={p}
              canEdit={canEdit && !busy}
              onRemove={() => run(() => api.removeProjectPerson(projectId, p.contactId), `${p.name} removed`)}
            />
          ))}
        </div>
      )}
      {canEdit && (
        <div className="mt-2 flex items-center gap-2" data-testid="project-people-add">
          <RecordPicker
            kinds={['employee', 'contact']}
            exclude={list.flatMap((p) => [p.contactId, ...(p.employeeId ? [p.employeeId] : [])])}
            filter={(r) => r.kind !== 'contact' || (r.data.kind !== 'ai' && r.data.ai !== true)}
            placeholder="Add an employee or person…"
            className="min-w-0 flex-1"
            onPick={(o) =>
              run(
                () =>
                  api.addProjectPerson(projectId, o.kind === 'employee' ? { employeeId: o.id, role } : { contactId: o.id, role }),
                `${o.label} added as ${role}`,
              )
            }
          />
          <RoleSelect value={role} onChange={setRole} />
        </div>
      )}
    </section>
  )
}
