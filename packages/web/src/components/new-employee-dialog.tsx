import type { ProjectData } from '@mp/api'
import { ApiRequestError } from '@mp/api'
import { ChevronRight, UserPlus } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { employeeHandle, useEmployees } from '@/lib/employees.tsx'
import { cn } from '@/lib/utils.ts'

function Row({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string | null
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-baseline gap-2 text-micro">
        <span className="font-medium text-fg-secondary">{label}</span>
        {hint && <span className="text-fg-quaternary">{hint}</span>}
      </label>
      {children}
      {error && (
        <p role="alert" className="text-micro text-[var(--red)]">
          {error}
        </p>
      )}
    </div>
  )
}

/** A toggle chip for picking projects and channels. */
function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'h-6 rounded-md border px-2 text-micro transition-colors duration-100',
        on
          ? 'border-transparent bg-accent-tint text-foreground ring-1 ring-[var(--ring)]'
          : 'text-fg-tertiary hover:bg-secondary',
      )}
    >
      {children}
    </button>
  )
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

/**
 * The "New employee" dialog (admins): a name with its handle, a role and description, and
 * optionally personality, instructions, model, projects and channels. The server provisions it
 * like the first employee (router session, #requests-<handle>, SSH key), and the page moves on
 * to its integrations.
 */
export function NewEmployeeDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const api = useApi()
  const navigate = useNavigate()
  const { reload } = useEmployees()
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [handleEdited, setHandleEdited] = useState(false)
  const [role, setRole] = useState('')
  const [description, setDescription] = useState('')
  const [personality, setPersonality] = useState('')
  const [instructions, setInstructions] = useState('')
  const [model, setModel] = useState('')
  const [projects, setProjects] = useState<string[]>([])
  const [channels, setChannels] = useState<string[]>([])
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: 'name' | 'handle' | 'form'; message: string } | null>(null)
  const projectList = useLoad(
    (a) => (open ? a.listRecords<ProjectData>('project', { orderBy: 'name', dir: 'asc', limit: 100 }) : Promise.resolve(null)),
    [open],
  )
  const channelList = useLoad((a) => (open ? a.channels() : Promise.resolve(null)), [open])

  const effectiveHandle = handleEdited ? handle : employeeHandle(name)
  const reset = () => {
    setName('')
    setHandle('')
    setHandleEdited(false)
    setRole('')
    setDescription('')
    setPersonality('')
    setInstructions('')
    setModel('')
    setProjects([])
    setChannels([])
    setMore(false)
    setError(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!name.trim()) return setError({ field: 'name', message: 'Give it a name.' })
    if (!effectiveHandle) return setError({ field: 'handle', message: 'The handle needs letters or digits.' })
    setBusy(true)
    setError(null)
    try {
      const r = await api.createEmployee({
        name: name.trim(),
        handle: effectiveHandle,
        ...(role.trim() ? { role: role.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(personality.trim() ? { personality: personality.trim() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(projects.length ? { projects } : {}),
        ...(channels.length ? { channels } : {}),
      })
      toast(`${r.employee.data.name} is ready`, { description: 'Next: connect its integrations.' })
      reload()
      reset()
      onOpenChange(false)
      navigate(`/employees/${r.employee.id}?new=1`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof ApiRequestError && err.status === 409)
        setError({ field: 'handle', message: `@${effectiveHandle} is taken: pick another handle.` })
      else setError({ field: 'form', message })
    } finally {
      setBusy(false)
    }
  }

  const channelItems = (channelList.data ?? []).filter((c) => !c.channel.data.dm && !c.channel.data.archived)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-h-[90svh] gap-4 overflow-y-auto sm:max-w-[520px]" data-testid="new-employee-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">New employee</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            An AI employee with its own identity. It gets a router session, its own requests channel and an SSH key; you connect
            Slack, GitLab and Linear next.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <Row
            id="ne-name"
            label="Name"
            hint="Say it’s an AI, e.g. “Billing Bot”"
            error={error?.field === 'name' ? error.message : null}
          >
            <Input id="ne-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Billing Bot" />
          </Row>
          <Row
            id="ne-handle"
            label="Handle"
            hint="How people @mention it"
            error={error?.field === 'handle' ? error.message : null}
          >
            <div className="flex items-center rounded-md border bg-transparent focus-within:ring-2 focus-within:ring-ring/50 dark:bg-input/30">
              <span className="pl-2.5 font-mono text-micro text-fg-quaternary">@</span>
              <input
                id="ne-handle"
                value={effectiveHandle}
                onChange={(e) => {
                  setHandleEdited(true)
                  setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                }}
                placeholder="billing-bot"
                className="h-8 min-w-0 flex-1 bg-transparent pr-2.5 pl-0.5 font-mono text-micro outline-none"
              />
            </div>
          </Row>
          <Row id="ne-role" label="Role" hint="Its job title">
            <Input id="ne-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Billing engineer" />
          </Row>
          <Row id="ne-desc" label="What it does" hint="One paragraph">
            <Textarea
              id="ne-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Refunds, billing bugs and invoice questions for the payments team."
            />
          </Row>
          <button
            type="button"
            onClick={() => setMore((m) => !m)}
            aria-expanded={more}
            className="flex items-center gap-1 self-start text-micro text-fg-tertiary hover:text-foreground"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', more && 'rotate-90')} />
            Personality, instructions, model and access
          </button>
          {more && (
            <div className="flex flex-col gap-3">
              <Row id="ne-personality" label="Personality" hint="Tone only; never overrides the rules">
                <Textarea
                  id="ne-personality"
                  value={personality}
                  onChange={(e) => setPersonality(e.target.value)}
                  rows={2}
                  placeholder="Dry humour, tidy commit messages."
                />
              </Row>
              <Row id="ne-instructions" label="Instructions" hint="For every session">
                <Textarea id="ne-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} />
              </Row>
              <Row id="ne-model" label="Model">
                <Input
                  id="ne-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="The deployment default"
                  className="font-mono text-micro"
                />
              </Row>
              <Row id="ne-projects" label="Projects" hint="Its scope">
                <div id="ne-projects" className="flex flex-wrap gap-1">
                  {(projectList.data?.items ?? []).map((p) => (
                    <Chip key={p.id} on={projects.includes(p.id)} onClick={() => setProjects((l) => toggle(l, p.id))}>
                      {p.data.name}
                    </Chip>
                  ))}
                  {projectList.data && !projectList.data.items.length && (
                    <span className="text-micro text-fg-quaternary">No projects yet.</span>
                  )}
                </div>
              </Row>
              <Row id="ne-channels" label="Channels" hint="It always joins #general">
                <div id="ne-channels" className="flex flex-wrap gap-1">
                  {channelItems
                    .filter((c) => c.channel.data.name !== 'general')
                    .map((c) => (
                      <Chip
                        key={c.channel.id}
                        on={channels.includes(c.channel.id)}
                        onClick={() => setChannels((l) => toggle(l, c.channel.id))}
                      >
                        #{c.channel.data.name}
                      </Chip>
                    ))}
                </div>
              </Row>
            </div>
          )}
          {error?.field === 'form' && (
            <p role="alert" className="text-micro text-[var(--red)]">
              {error.message}
            </p>
          )}
          <DialogFooter className="pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Creating…' : 'Create employee'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The "New employee" button and its dialog. Render it for admins only. */
export function NewEmployeeButton({ variant = 'outline' }: { variant?: 'outline' | 'default' | 'ghost' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        <UserPlus />
        New employee
      </Button>
      <NewEmployeeDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
