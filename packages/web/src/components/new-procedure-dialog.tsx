import { ApiRequestError, type ProcedureApproval, type ProcedureStart } from '@mp/api'
import { Plus, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { type PickOption, RecordPicker } from '@/components/record-picker.tsx'
import { StartForm, selectClass } from '@/components/start-form.tsx'
import { StepsEditor } from '@/components/steps-editor.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { useApi } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { STEPS_TEMPLATE, newKey } from '@/lib/procedures.ts'

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t pt-4 first:border-t-0 first:pt-0">
      <h3 className="flex items-baseline gap-2 text-mini font-medium text-foreground">
        <span className="font-mono text-micro text-fg-quaternary">{n}</span>
        {title}
        {hint && <span className="text-micro font-normal text-fg-quaternary">{hint}</span>}
      </h3>
      {children}
    </section>
  )
}

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
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="flex items-baseline gap-2 text-micro">
        <span className="font-medium text-fg-secondary">{label}</span>
        {hint && <span className="truncate text-fg-quaternary">{hint}</span>}
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

/** A picked contact, with a button to clear it. */
export function PickedChip({ label, onClear, clearLabel }: { label: string; onClear(): void; clearLabel: string }) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border bg-secondary pr-1 pl-2 text-mini text-fg-secondary">
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={clearLabel}
        className="rounded-sm p-0.5 text-fg-tertiary hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </span>
  )
}

export type ApproverDraft = ProcedureApproval & { label?: string }

/** Approvers: a person (picked) or a role (typed), each with the step it applies to. */
export function ApproversEditor({
  value,
  onChange,
  idPrefix = 'appr',
}: {
  value: ApproverDraft[]
  onChange(next: ApproverDraft[]): void
  idPrefix?: string
}) {
  const set = (i: number, patch: Partial<ApproverDraft>) => onChange(value.map((a, j) => (j === i ? { ...a, ...patch } : a)))
  return (
    <div className="flex flex-col gap-2" data-testid="approvers-editor">
      {value.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows of a draft list
        <div key={i} className="grid grid-cols-[1fr_auto] items-start gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <div className="min-w-0">
            {a.contactId ? (
              <PickedChip
                label={a.label ?? a.contactId}
                onClear={() => set(i, { contactId: undefined, label: undefined })}
                clearLabel="Change approver"
              />
            ) : a.role !== undefined ? (
              <Input
                aria-label="Approver role"
                value={a.role}
                onChange={(e) => set(i, { role: e.target.value })}
                placeholder="A role, e.g. engineering manager"
                className="h-7"
              />
            ) : (
              <RecordPicker
                id={`${idPrefix}-${i}`}
                kinds={['contact']}
                placeholder="Who approves? Type a name"
                onPick={(o: PickOption) => set(i, { contactId: o.id, label: o.label })}
              />
            )}
          </div>
          <Input
            aria-label="At which step"
            value={a.step ?? ''}
            onChange={(e) => set(i, { step: e.target.value })}
            placeholder="At which step, e.g. before granting access"
            className="col-span-1 h-7 sm:col-span-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove approver"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={() => onChange([...value, {}])}>
          <Plus /> Add a person
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={() => onChange([...value, { role: '' }])}>
          <Plus /> Add a role
        </Button>
      </div>
    </div>
  )
}

/** Approvers from drafts, dropping empty rows. */
export function approvalsOf(drafts: ApproverDraft[]): ProcedureApproval[] {
  return drafts
    .map(({ label: _l, ...a }) => ({
      ...(a.contactId ? { contactId: a.contactId } : {}),
      ...(!a.contactId && a.role?.trim() ? { role: a.role.trim() } : {}),
      ...(a.step?.trim() ? { step: a.step.trim() } : {}),
    }))
    .filter((a) => a.contactId || a.role)
}

/**
 * The "New procedure" dialog: what it is, its steps (from a template), how it starts and who
 * approves. One call creates the procedure, its trigger and its context; a double submit
 * returns the same procedure. Then it opens the procedure's page.
 */
export function NewProcedureDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** Prefill (Duplicate). */
  initial?: {
    name: string
    applies: string
    body?: string
    ownerId?: string
    ownerLabel?: string
    approvals?: ApproverDraft[]
    employeeId?: string
  }
}) {
  const api = useApi()
  const navigate = useNavigate()
  const { can } = useAuth()
  const { employees, currentId } = useEmployees()
  const [name, setName] = useState('')
  const [applies, setApplies] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [owner, setOwner] = useState<{ id: string; label: string } | null>(null)
  const [body, setBody] = useState(STEPS_TEMPLATE)
  const [start, setStart] = useState<ProcedureStart | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [approvers, setApprovers] = useState<ApproverDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: 'name' | 'applies' | 'employee' | 'start' | 'form'; message: string } | null>(null)
  const key = useRef(newKey())
  const admin = can('admin')

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when it opens
  useEffect(() => {
    if (!open) return
    key.current = newKey()
    setName(initial ? `${initial.name} (copy)` : '')
    setApplies(initial?.applies ?? '')
    setBody(initial?.body ?? STEPS_TEMPLATE)
    setOwner(initial?.ownerId ? { id: initial.ownerId, label: initial.ownerLabel ?? initial.ownerId } : null)
    setApprovers(initial?.approvals ?? [])
    setStart(null)
    setStartError(null)
    setError(null)
    setEmployeeId(initial?.employeeId ?? currentId ?? employees[0]?.id ?? '')
  }, [open])
  useEffect(() => {
    if (!employeeId && employees[0]) setEmployeeId(currentId ?? employees[0].id)
  }, [employees, currentId, employeeId])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    if (!name.trim()) return setError({ field: 'name', message: 'Give it a name.' })
    if (!applies.trim()) return setError({ field: 'applies', message: 'Say in one line when it applies.' })
    if (!employeeId) return setError({ field: 'employee', message: 'Pick the employee that runs it.' })
    if (startError) return setError({ field: 'start', message: startError })
    setBusy(true)
    setError(null)
    try {
      const r = await api.createProcedure({
        name: name.trim(),
        applies: applies.trim(),
        employeeId,
        ...(body.trim() ? { body } : {}),
        ...(owner ? { ownerId: owner.id } : {}),
        ...(approvalsOf(approvers).length ? { approvals: approvalsOf(approvers) } : {}),
        ...(start ? { starts: [start] } : {}),
        idempotencyKey: key.current,
      })
      toast(`${r.procedure.procedure.data.name} is ready`, { description: 'Its context has read the steps.' })
      onOpenChange(false)
      navigate(`/procedures/${r.procedure.procedure.id}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof ApiRequestError && (err.status === 422 || err.status === 400) && start)
        setError({ field: 'start', message })
      else setError({ field: 'form', message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92svh] gap-4 overflow-y-auto sm:max-w-[760px]" data-testid="new-procedure-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">New procedure</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            A written, repeatable way of doing a task. The employee reads it once into the procedure's context; every run is a
            fork of that context, so it starts with the steps already read.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Section n={1} title="What it is">
            <Row id="np-name" label="Name" error={error?.field === 'name' ? error.message : null}>
              <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Access request" />
            </Row>
            <Row
              id="np-applies"
              label="When it applies"
              hint="One line"
              error={error?.field === 'applies' ? error.message : null}
            >
              <Input
                id="np-applies"
                value={applies}
                onChange={(e) => setApplies(e.target.value)}
                placeholder="Someone asks for access to a system, dashboard or repository."
              />
            </Row>
            <div className="grid gap-3 sm:grid-cols-2">
              <Row
                id="np-employee"
                label="Run by"
                hint="Its context is this employee's"
                error={error?.field === 'employee' ? error.message : null}
              >
                <select
                  id="np-employee"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  className={selectClass}
                >
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.data.name}
                    </option>
                  ))}
                </select>
              </Row>
              <Row id="np-owner" label="Owner" hint="Who to ask when it's unclear">
                {owner ? (
                  <PickedChip label={owner.label} onClear={() => setOwner(null)} clearLabel="Change owner" />
                ) : (
                  <RecordPicker
                    id="np-owner"
                    kinds={['contact']}
                    placeholder="A person or an employee"
                    onPick={(o) => setOwner({ id: o.id, label: o.label })}
                  />
                )}
              </Row>
            </div>
          </Section>

          <Section n={2} title="Steps" hint="Markdown; fill in the four sections">
            <StepsEditor value={body} onChange={setBody} onSubmit={() => submit()} minHeight="min-h-56" id="np-steps" />
          </Section>

          <Section n={3} title="How it starts" hint="You can always run it by hand">
            {admin ? (
              <>
                <StartForm
                  value={start}
                  name={name}
                  idPrefix="np-start"
                  onChange={(next, problem) => {
                    setStart(next)
                    setStartError(problem)
                    if (error?.field === 'start') setError(null)
                  }}
                />
                {error?.field === 'start' && (
                  <p role="alert" className="text-micro text-[var(--red)]">
                    {error.message}
                  </p>
                )}
              </>
            ) : (
              <p className="text-mini text-fg-tertiary">
                It starts manually: Run now, or an employee starting it from its work. Only admins make procedures start by
                themselves (from a channel, a tag, a schedule or an integration).
              </p>
            )}
          </Section>

          <Section n={4} title="Approvals" hint="Who has to say yes, and when">
            <ApproversEditor value={approvers} onChange={setApprovers} idPrefix="np-appr" />
            {!approvers.length && (
              <p className="text-micro text-fg-quaternary">No approvals: the employee carries it out on its own.</p>
            )}
          </Section>

          {error?.field === 'form' && (
            <p role="alert" className="text-micro text-[var(--red)]">
              {error.message}
            </p>
          )}
          <DialogFooter className="border-t pt-4">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Creating…' : 'Create procedure'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
