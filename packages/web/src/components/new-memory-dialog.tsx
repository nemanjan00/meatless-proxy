import { type KnowledgeRef, MEMORY_KINDS, type MemoryKind, type MemoryScope } from '@mp/api'
import { Lock } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Field, RefChip, Segmented, errorText } from '@/components/knowledge-ui.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { selectClass } from '@/components/start-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi } from '@/lib/api.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { MEMORY_KIND } from '@/lib/knowledge.ts'

/** What the memory form edits. */
export interface MemoryDraft {
  summary: string
  kind: MemoryKind
  content: string
  /** '' = every employee shares it. */
  employeeId: string
  about: KnowledgeRef[]
  /** `company`, or the id of one of `about`. */
  scopeId: string
  note: string
}

export const emptyDraft = (employeeId = ''): MemoryDraft => ({
  summary: '',
  kind: 'fact',
  content: '',
  employeeId,
  about: [],
  scopeId: 'company',
  note: '',
})

/** The scope a draft says: the company, or one of the things it's about. */
export function scopeOf(d: MemoryDraft): MemoryScope {
  const r = d.about.find((a) => a.id === d.scopeId)
  if (!r) return { type: 'company' }
  return { type: r.kind === 'project' ? 'project' : 'contact', id: r.id }
}

/** People and projects a memory is about: chips, and a picker to add one. */
export function AboutPicker({
  value,
  onChange,
  id,
}: {
  value: KnowledgeRef[]
  onChange(next: KnowledgeRef[]): void
  id?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="about-picker">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((r) => (
            <RefChip key={r.id} r={r} onRemove={() => onChange(value.filter((x) => x.id !== r.id))} />
          ))}
        </div>
      )}
      <RecordPicker
        id={id}
        kinds={['contact', 'project']}
        exclude={value.map((v) => v.id)}
        // AI employees and agents aren't what memories are "about": people and projects are.
        filter={(r) => r.kind !== 'contact' || ((r.data as { kind?: string }).kind ?? 'person') === 'person'}
        placeholder="A person or a project"
        onPick={(o) =>
          onChange([
            ...value,
            { kind: o.kind, id: o.id, name: o.label, ...(o.kind === 'contact' ? { contactKind: 'person' as const } : {}) },
          ])
        }
      />
    </div>
  )
}

/**
 * The memory form: what to remember, which employee remembers it, what it's about and who may
 * recall it. With `correcting`, it also asks what was wrong (the note that goes in the history).
 */
export function MemoryForm({
  value,
  onChange,
  correcting = false,
  errors = {},
  idPrefix = 'mem',
  autoFocus = true,
}: {
  value: MemoryDraft
  onChange(next: MemoryDraft): void
  correcting?: boolean
  errors?: Partial<Record<'summary' | 'note', string>>
  idPrefix?: string
  autoFocus?: boolean
}) {
  const { employees } = useEmployees()
  const set = (patch: Partial<MemoryDraft>) => onChange({ ...value, ...patch })
  const people = value.about.filter((a) => a.kind === 'contact')
  return (
    <div className="flex flex-col gap-3.5">
      {correcting && (
        <Field id={`${idPrefix}-note`} label="What was wrong?" hint="Saved in its history" error={errors.note}>
          <Textarea
            id={`${idPrefix}-note`}
            value={value.note}
            onChange={(e) => set({ note: e.target.value })}
            rows={2}
            autoFocus={autoFocus}
            placeholder="e.g. The limit went up to $500 in September."
          />
        </Field>
      )}
      <Field
        id={`${idPrefix}-summary`}
        label="Summary"
        hint="One line: the employee reads this to decide if it's relevant"
        error={errors.summary}
      >
        <Input
          id={`${idPrefix}-summary`}
          value={value.summary}
          onChange={(e) => set({ summary: e.target.value })}
          autoFocus={autoFocus && !correcting}
          placeholder="Ana approves refunds above $250."
        />
      </Field>
      <Field label="Kind">
        <Segmented
          label="Kind"
          value={value.kind}
          onChange={(kind) => set({ kind })}
          options={MEMORY_KINDS.map((k) => {
            const info = MEMORY_KIND[k]
            const Icon = info.icon
            return {
              value: k,
              label: info.label,
              hint: info.hint,
              icon: <Icon className="size-3.5" style={{ color: info.color }} />,
            }
          })}
        />
      </Field>
      <Field id={`${idPrefix}-content`} label="Details" hint="Optional, markdown">
        <Textarea
          id={`${idPrefix}-content`}
          value={value.content}
          onChange={(e) => set({ content: e.target.value })}
          rows={4}
          placeholder="Where it comes from, exceptions, anything that helps apply it."
        />
      </Field>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field id={`${idPrefix}-employee`} label="Who remembers it">
          <select
            id={`${idPrefix}-employee`}
            value={value.employeeId}
            onChange={(e) => set({ employeeId: e.target.value })}
            className={selectClass}
          >
            <option value="">Every employee (shared)</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                Only {e.data.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${idPrefix}-scope`} label="When it comes up">
          <select
            id={`${idPrefix}-scope`}
            value={value.about.some((a) => a.id === value.scopeId) ? value.scopeId : 'company'}
            onChange={(e) => set({ scopeId: e.target.value })}
            className={selectClass}
          >
            <option value="company">In any work</option>
            {value.about.map((a) => (
              <option key={a.id} value={a.id}>
                {a.kind === 'project' ? `Only in work on ${a.name}` : `Only in work with ${a.name}`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field id={`${idPrefix}-about`} label="About" hint="People and projects it concerns">
        <AboutPicker id={`${idPrefix}-about`} value={value.about} onChange={(about) => set({ about })} />
      </Field>
      {people.length > 0 && (
        <p className="flex items-start gap-1.5 text-micro text-fg-tertiary" data-testid="privacy-note">
          <Lock className="mt-0.5 size-3 shrink-0" />
          It's about {people.map((p) => p.name).join(' and ')}, so only {people.map((p) => p.name.split(' ')[0]).join(' and ')}{' '}
          and admins see it on this page. Employees still recall it in their work.
        </p>
      )}
    </div>
  )
}

/** "Add memory": a person teaching an employee something. Opens the new memory when done. */
export function NewMemoryDialog({
  open,
  onOpenChange,
  onCreated,
  initial,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  onCreated(id: string): void
  initial?: Partial<MemoryDraft>
}) {
  const api = useApi()
  const { currentId } = useEmployees()
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: 'summary' | 'form'; message: string } | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when it opens
  useEffect(() => {
    if (!open) return
    setDraft({ ...emptyDraft(currentId ?? ''), ...initial })
    setError(null)
  }, [open])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    if (!draft.summary.trim()) return setError({ field: 'summary', message: 'Write what to remember, in one line.' })
    setBusy(true)
    setError(null)
    try {
      const r = await api.createMemory({
        summary: draft.summary.trim(),
        kind: draft.kind,
        ...(draft.content.trim() ? { content: draft.content.trim() } : {}),
        employeeId: draft.employeeId || null,
        about: draft.about.map((a) => ({ kind: a.kind as 'contact' | 'project', id: a.id })),
        scope: scopeOf(draft),
      })
      const people = draft.about.filter((a) => a.kind === 'contact')
      toast(r.created ? 'Remembered' : 'Updated the memory that already said this', {
        description: people.length
          ? `Only ${people.map((p) => p.name).join(' and ')} and admins can see it here.`
          : 'Employees recall it in their next sessions.',
      })
      onOpenChange(false)
      onCreated(r.memory.memory.id)
    } catch (err) {
      setError({ field: 'form', message: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92svh] gap-4 overflow-y-auto sm:max-w-[600px]" data-testid="new-memory-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">Add a memory</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            Teach the employees something they should know next time: a fact, how someone likes things done, or a decision.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4" noValidate>
          <MemoryForm
            value={draft}
            onChange={setDraft}
            idPrefix="nm"
            errors={error?.field === 'summary' ? { summary: error.message } : {}}
          />
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
              {busy ? 'Saving…' : 'Remember this'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
