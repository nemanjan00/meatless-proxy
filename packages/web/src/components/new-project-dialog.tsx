import type { CreatedProject } from '@mp/api'
import { FolderPlus, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { EmployeeAvatar } from '@/components/people.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'

function Row({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-baseline gap-2 text-micro">
        <span className="font-medium text-fg-secondary">{label}</span>
        {hint && <span className="text-fg-quaternary">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

/** One entry per line (or comma), trimmed, empty ones dropped. */
export const lines = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((l) => l.trim())
    .filter(Boolean)

/** The employee picked as owner. */
export interface OwnerChoice {
  employeeId: string
  name: string
}

/**
 * "New project": name, description, repository URLs, optional docs links, and an employee as its
 * owner. The server creates the project and links the owner in one step (`POST /api/projects`),
 * which is what tells the employee it works on it. Admins can pick **Local repository** instead of
 * URLs: the harness hosts a new repository for it (`POST /api/projects/local`, docs/spec.md#local-projects).
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  owner: initialOwner = null,
  onCreated,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** Preselected owner, e.g. the employee whose page this is. */
  owner?: OwnerChoice | null
  onCreated?(r: CreatedProject): void
}) {
  const api = useApi()
  const { can } = useAuth()
  const canLocal = can('admin')
  const [local, setLocal] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [repos, setRepos] = useState('')
  const [docs, setDocs] = useState('')
  const [owner, setOwner] = useState<OwnerChoice | null>(initialOwner)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reset = () => {
    setName('')
    setDescription('')
    setRepos('')
    setDocs('')
    setOwner(initialOwner)
    setLocal(false)
    setError(null)
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!name.trim()) return setError('Give it a name.')
    setBusy(true)
    setError(null)
    try {
      const common = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(owner ? { owner: { employeeId: owner.employeeId } } : {}),
      }
      const r =
        local && canLocal
          ? await api.createLocalProject(common)
          : await api.createProject({
              ...common,
              ...(lines(repos).length ? { repositories: lines(repos) } : {}),
              ...(lines(docs).length ? { docs: lines(docs) } : {}),
            })
      toast(`${r.project.data.name} created`, {
        description: owner ? `${owner.name} owns it and sees it in its projects from its next piece of work.` : undefined,
      })
      reset()
      onOpenChange(false)
      onCreated?.(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-h-[90svh] gap-4 overflow-y-auto sm:max-w-[520px]" data-testid="new-project-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">New project</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            A project the harness knows about: its repositories, docs and who works on it. Its owner and members see it in their
            projects, and GitLab webhooks register on its repositories.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <Row id="np-name" label="Name">
            <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Payments" />
          </Row>
          <Row id="np-desc" label="Description" hint="One paragraph">
            <Textarea
              id="np-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Card payments, refunds and payouts."
            />
          </Row>
          {canLocal && (
            <div className="flex flex-col gap-1">
              <span className="text-micro font-medium text-fg-secondary">Repository</span>
              <div role="radiogroup" aria-label="Repository" className="flex w-fit gap-1">
                {[
                  { value: false, label: 'On a git host' },
                  { value: true, label: 'Local repository' },
                ].map((o) => (
                  <Button
                    key={o.label}
                    type="button"
                    size="xs"
                    role="radio"
                    aria-checked={local === o.value}
                    variant={local === o.value ? 'secondary' : 'ghost'}
                    onClick={() => setLocal(o.value)}
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {local && canLocal ? (
            <p className="text-micro text-fg-tertiary" data-testid="np-local-hint">
              The harness hosts a new git repository for it, with an empty first commit on main. Employees push their branches
              there; people review and merge them on the project's page. You can attach a remote later.
            </p>
          ) : (
            <>
              <Row id="np-repos" label="Repositories" hint="One URL per line, https or ssh">
                <Textarea
                  id="np-repos"
                  value={repos}
                  onChange={(e) => setRepos(e.target.value)}
                  rows={2}
                  className="font-mono text-micro"
                  placeholder="git@gitlab.example.com:acme/payments.git"
                />
              </Row>
              <Row id="np-docs" label="Docs links" hint="Optional, one per line">
                <Textarea
                  id="np-docs"
                  value={docs}
                  onChange={(e) => setDocs(e.target.value)}
                  rows={1}
                  className="font-mono text-micro"
                  placeholder="https://docs.example.com/payments"
                />
              </Row>
            </>
          )}
          <Row id="np-owner" label="Owner" hint="The employee accountable for it">
            {owner ? (
              <div className="flex h-8 items-center gap-2 rounded-md border px-2" data-testid="np-owner">
                <EmployeeAvatar name={owner.name} className="size-4" />
                <span className="min-w-0 flex-1 truncate text-fg-secondary">{owner.name}</span>
                <Button type="button" size="icon-xs" variant="ghost" aria-label="Clear the owner" onClick={() => setOwner(null)}>
                  <X />
                </Button>
              </div>
            ) : (
              <RecordPicker
                id="np-owner"
                kinds={['employee']}
                placeholder="Search employees…"
                onPick={(o) => setOwner({ employeeId: o.id, name: o.label })}
              />
            )}
          </Row>
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
              {busy ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The "New project" button and its dialog. */
export function NewProjectButton({
  owner,
  onCreated,
  variant = 'outline',
}: {
  owner?: OwnerChoice | null
  onCreated?(r: CreatedProject): void
  variant?: 'outline' | 'default' | 'ghost'
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        <FolderPlus />
        New project
      </Button>
      <NewProjectDialog open={open} onOpenChange={setOpen} owner={owner ?? null} {...(onCreated ? { onCreated } : {})} />
    </>
  )
}
