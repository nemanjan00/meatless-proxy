import {
  ApiRequestError,
  type ApiRevision,
  type ProcedureDetail,
  type ProcedureListItem,
  type ProcedureRecordData,
  type ProcedureRun,
  type ProcedureStart,
  type ProcedureTrigger,
  START_LABELS,
} from '@mp/api'
import {
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Copy,
  History,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Archive,
  ArchiveRestore,
  Trash2,
  User,
  Zap,
} from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Markdown } from '@/components/markdown.tsx'
import {
  type ApproverDraft,
  ApproversEditor,
  NewProcedureDialog,
  PickedChip,
  approvalsOf,
} from '@/components/new-procedure-dialog.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { SplitView } from '@/components/split-view.tsx'
import { StartForm, StartIcon, selectClass } from '@/components/start-form.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { stripTitle } from '@/components/doc-editor.tsx'
import { StepsEditor } from '@/components/steps-editor.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi, useLiveReload, useLoad } from '@/lib/api.tsx'
import { Can, useAuth } from '@/lib/auth.tsx'
import { hrefFor } from '@/lib/doclinks.ts'
import { useEmployees } from '@/lib/employees.tsx'
import { agoPhrase, duration, formatDateTime, pluralize, timeAgo } from '@/lib/format.ts'
import { useNames } from '@/lib/names.ts'
import { CONTEXT_STATE, newKey } from '@/lib/procedures.ts'
import { STATUS } from '@/lib/status.ts'
import { changedFields } from '@/lib/schema-form.ts'
import { cn } from '@/lib/utils.ts'

const LIVE = ['records:procedure', 'records:run', 'records:session', 'records:trigger'] as const

/** Capitalises the first letter. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** How long a run took: `34m`, `1h 5m`, `40s`. */
function took(from: string, to: string): string {
  const d = duration(from, to)
  return d.replace(/^(\d+m) 0s$/, '$1').replace(/^(\d+h) 0m$/, '$1')
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A small coloured dot and label for a context state. */
function ContextBadge({ state, className }: { state: keyof typeof CONTEXT_STATE; className?: string }) {
  const s = CONTEXT_STATE[state]
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-mini text-fg-secondary', className)} data-context={state}>
      <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  )
}

/** Someone: an avatar and a name, linked to their page. */
function Who({
  person,
  className,
}: {
  person: { contactId: string; name: string; kind: string; employeeId?: string }
  className?: string
}) {
  const href = person.employeeId ? `/employees/${person.employeeId}` : hrefFor('contact', person.contactId)
  return (
    <Link to={href} className={cn('inline-flex min-w-0 items-center gap-1.5 text-fg-secondary hover:text-foreground', className)}>
      {person.kind === 'ai' ? (
        <EmployeeAvatar name={person.name} className="size-4" />
      ) : (
        <PersonAvatar name={person.name} className="size-4" />
      )}
      <span className="truncate">{person.name}</span>
    </Link>
  )
}

function RunState({ state }: { state: ProcedureRun['state'] }) {
  return <StatusIcon status={state ?? 'idle'} />
}

// ─── List ───────────────────────────────────────────────────────────────────

function StartsCell({ starts }: { starts: ProcedureListItem['starts'] }) {
  const first = starts[0]!
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-fg-secondary" title={starts.map((s) => s.description).join('\n')}>
      <StartIcon kind={first.kind} className="text-fg-tertiary" />
      <span className="truncate">
        {first.kind === 'manual' ? 'Manual only' : sentence(first.description.replace(/^When /, ''))}
      </span>
      {starts.length > 1 && (
        <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary">+{starts.length - 1}</span>
      )}
    </span>
  )
}

const COLS = 'lg:grid-cols-[minmax(0,1fr)_minmax(0,15rem)_9rem_5.5rem_4.5rem_7rem_7.5rem]'

function ListHeader() {
  return (
    <div className={cn('hidden h-8 items-center gap-3 border-b px-6 text-micro text-fg-tertiary lg:grid', COLS)} aria-hidden>
      <span>Procedure</span>
      <span>How it starts</span>
      <span>Owner</span>
      <span>Approvals</span>
      <span className="text-right">30 days</span>
      <span>Last run</span>
      <span>Context</span>
    </div>
  )
}

function ProcedureRow({ item }: { item: ProcedureListItem }) {
  const p = item.procedure
  return (
    <Link
      to={`/procedures/${p.id}`}
      data-testid="procedure-row"
      className={cn('group grid min-h-9 items-center gap-x-3 gap-y-0.5 px-4 py-2 hover:bg-secondary sm:px-6 lg:py-0', COLS)}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 truncate text-fg-secondary group-hover:text-foreground">{p.data.name}</span>
        <span className="hidden min-w-0 truncate text-fg-tertiary sm:inline">{p.data.applies}</span>
        {p.data.archived && <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary">archived</span>}
      </span>
      <span className="min-w-0 truncate text-micro text-fg-tertiary sm:hidden">{p.data.applies}</span>
      {/* Wide screens: columns. Narrow ones: one line of facts. */}
      <span className="hidden min-w-0 lg:flex">
        <StartsCell starts={item.starts} />
      </span>
      <span className="hidden min-w-0 lg:flex">
        {item.owner ? (
          <span className="flex min-w-0 items-center gap-1.5 text-fg-secondary">
            {item.owner.kind === 'ai' ? (
              <EmployeeAvatar name={item.owner.name} className="size-4" />
            ) : (
              <PersonAvatar name={item.owner.name} className="size-4" />
            )}
            <span className="truncate">{item.owner.name}</span>
          </span>
        ) : (
          <span className="text-fg-quaternary">No owner</span>
        )}
      </span>
      <span className="hidden text-fg-secondary lg:block">
        {item.approvals ? (
          <span className="inline-flex items-center gap-1">
            <Check className="size-3.5 text-[var(--green)]" /> {item.approvals === 1 ? 'Yes' : `Yes, ${item.approvals}`}
          </span>
        ) : (
          <span className="text-fg-quaternary">None</span>
        )}
      </span>
      <span className="hidden text-right text-fg-secondary tabular-nums lg:block">
        {item.runs30d || <span className="text-fg-quaternary">0</span>}
      </span>
      <span className="hidden min-w-0 items-center gap-1.5 lg:flex">
        {item.lastRun ? (
          <>
            <RunState state={item.lastRun.state} />
            <span className="truncate text-fg-tertiary">{agoPhrase(item.lastRun.at)}</span>
          </>
        ) : (
          <span className="text-fg-quaternary">Never run</span>
        )}
      </span>
      <span className="hidden lg:block">
        <ContextBadge state={item.context.state} />
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-micro text-fg-tertiary lg:hidden">
        <StartsCell starts={item.starts} />
        {item.approvals > 0 && (
          <span className="inline-flex items-center gap-1">
            <Check className="size-3 text-[var(--green)]" /> approvals
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          {item.lastRun ? <RunState state={item.lastRun.state} /> : null}
          {pluralize(item.runs30d, 'run')} in 30 days
        </span>
        <ContextBadge state={item.context.state} className="text-micro" />
      </span>
    </Link>
  )
}

/** `/procedures`: every procedure, how it starts, who owns it, and how its runs and context are doing. */
export function ProceduresPage() {
  const [text, setText] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [archived, setArchived] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const list = useLoad((api) => api.procedures({ archived }), [archived])
  useLiveReload([...LIVE], list.reload)
  const owners = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of list.data ?? []) if (i.owner) m.set(i.owner.contactId, i.owner.name)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [list.data])
  const q = text.trim().toLowerCase()
  const shown = (list.data ?? []).filter(
    (i) =>
      (!ownerId || i.owner?.contactId === ownerId) &&
      (!q || `${i.procedure.data.name} ${i.procedure.data.applies}`.toLowerCase().includes(q)),
  )
  const newButton = (variant: 'outline' | 'default') => (
    <Can>
      <Button size="sm" variant={variant} onClick={() => setNewOpen(true)}>
        <Plus /> New procedure
      </Button>
    </Can>
  )
  return (
    <Page
      title="Procedures"
      icon={<BookOpen />}
      actions={newButton('outline')}
      filters={
        <>
          <div className="relative w-full min-w-0 sm:w-64">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-quaternary" />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search procedures"
              aria-label="Search procedures"
              className="h-7 pl-7 text-mini"
            />
          </div>
          <select
            aria-label="Owner"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className={cn(selectClass, 'h-7 w-auto max-w-48 text-mini')}
          >
            <option value="">Any owner</option>
            {owners.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <span className="flex items-center gap-1.5 text-micro text-fg-tertiary">
            <Switch id="show-archived" checked={archived} onCheckedChange={setArchived} />
            <label htmlFor="show-archived">Archived</label>
          </span>
          <span className="ml-auto text-micro text-fg-tertiary">{list.data ? shown.length : ''}</span>
        </>
      }
    >
      <p className="border-b px-4 py-3 text-mini text-fg-tertiary sm:px-6" data-testid="procedures-explainer">
        A procedure is a written, repeatable way of doing a task. The employee follows it in a fork of the procedure's context, so
        each run starts with the procedure already read.
      </p>
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : shown.length === 0 ? (
        <EmptyState
          text={
            q || ownerId
              ? 'No procedure matches. Try another search or owner.'
              : 'No procedures yet. Write down how a task is done here, and the employees follow it.'
          }
          action={!q && !ownerId ? newButton('default') : undefined}
        />
      ) : (
        <div className="pb-6">
          <ListHeader />
          {shown.map((i) => (
            <ProcedureRow key={i.procedure.id} item={i} />
          ))}
        </div>
      )}
      <NewProcedureDialog open={newOpen} onOpenChange={setNewOpen} />
    </Page>
  )
}

// ─── Detail: sections ───────────────────────────────────────────────────────

function Section({ title, actions, children, id }: { title: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="mb-10" aria-labelledby={id} data-testid={id}>
      <div className="mb-2 flex min-h-7 items-center gap-2 border-b pb-1.5">
        <h3 id={id} className="text-mini font-medium text-foreground">
          {title}
        </h3>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

function TriggerEditor({
  initial,
  onSave,
  onCancel,
  name,
  saveLabel,
}: {
  initial: ProcedureStart | null
  onSave(start: ProcedureStart): Promise<void>
  onCancel(): void
  name: string
  saveLabel: string
}) {
  const [start, setStart] = useState<ProcedureStart | null>(initial)
  const [problem, setProblem] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!start || problem || busy) return setError(problem ?? 'Pick how it starts.')
    setBusy(true)
    setError(null)
    try {
      await onSave(start)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-lg border bg-level-1 p-3" data-testid="trigger-editor">
      <StartForm
        value={start}
        allowManual={false}
        name={name}
        idPrefix="trg"
        onChange={(next, p) => {
          setStart(next)
          setProblem(p)
          setError(null)
        }}
      />
      {error && (
        <p role="alert" className="mt-2 text-micro text-[var(--red)]">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={busy || !start}>
          {busy ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </div>
  )
}

function TriggerRow({
  t,
  detail,
  onChanged,
}: {
  t: ProcedureTrigger
  detail: ProcedureDetail
  onChanged(d: ProcedureDetail): void
}) {
  const api = useApi()
  const { can } = useAuth()
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const id = detail.procedure.id
  const admin = can('admin')
  if (editing)
    return (
      <div className="py-2">
        <TriggerEditor
          initial={t.start}
          name={detail.procedure.data.name}
          saveLabel="Save"
          onCancel={() => setEditing(false)}
          onSave={async (start) => {
            onChanged(await api.updateProcedureTrigger(id, t.id, { start }))
            setEditing(false)
            toast('Trigger saved')
          }}
        />
        <details className="mt-2 text-micro text-fg-tertiary">
          <summary className="cursor-pointer hover:text-foreground">How it is stored</summary>
          <pre className="mt-1 overflow-x-auto rounded-md bg-level-2 p-2 font-mono text-micro">
            {JSON.stringify(t.raw, null, 2)}
          </pre>
        </details>
      </div>
    )
  return (
    <div className={cn('group flex min-h-9 items-center gap-2.5 py-1.5', !t.enabled && 'opacity-60')} data-testid="trigger-row">
      <StartIcon kind={t.start.kind} className="text-fg-tertiary" />
      <div className="min-w-0 flex-1">
        <div className="text-fg-secondary">
          {t.description}
          {!t.enabled && <span className="ml-2 rounded-sm border px-1 text-tiny text-fg-tertiary">off</span>}
        </div>
        <div className="truncate text-micro text-fg-quaternary">
          {START_LABELS[t.start.kind]} · runs as {t.employee.name} ·{' '}
          {t.fired
            ? `started ${pluralize(t.fired, 'run')}${t.lastFiredAt ? `, last ${agoPhrase(t.lastFiredAt)}` : ''}`
            : 'not fired yet'}
        </div>
      </div>
      {admin && (
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={t.enabled}
            aria-label={t.enabled ? 'Turn off' : 'Turn on'}
            onCheckedChange={async (on) => {
              try {
                onChanged(await api.updateProcedureTrigger(id, t.id, { enabled: on }))
              } catch (e) {
                toast(errorText(e))
              }
            }}
          />
          <Button variant="ghost" size="icon-sm" aria-label="Edit trigger" onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
          {confirm ? (
            <Button
              variant="destructive"
              size="xs"
              onClick={async () => {
                onChanged(await api.deleteProcedureTrigger(id, t.id))
                toast('Trigger removed')
              }}
            >
              Remove
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove trigger"
              onClick={() => setConfirm(true)}
              onBlur={() => setTimeout(() => setConfirm(false), 200)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function WhenItRuns({ detail, onChanged }: { detail: ProcedureDetail; onChanged(d: ProcedureDetail): void }) {
  const api = useApi()
  const [adding, setAdding] = useState(false)
  return (
    <Section
      title="When it runs"
      id="when-it-runs"
      actions={
        <Can need="admin">
          {!adding && (
            <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
              <Plus /> Add a trigger
            </Button>
          )}
        </Can>
      }
    >
      <div className="flex min-h-9 items-center gap-2.5 py-1.5">
        <StartIcon kind="manual" className="text-fg-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="text-fg-secondary">Whenever someone starts it</div>
          <div className="text-micro text-fg-quaternary">Run now on this page, or an employee running it from its own work.</div>
        </div>
      </div>
      {detail.triggers.map((t) => (
        <TriggerRow key={t.id} t={t} detail={detail} onChanged={onChanged} />
      ))}
      {adding && (
        <div className="py-2">
          <TriggerEditor
            initial={{ kind: 'channel', channelId: '' }}
            name={detail.procedure.data.name}
            saveLabel="Add trigger"
            onCancel={() => setAdding(false)}
            onSave={async (start) => {
              onChanged(await api.addProcedureTrigger(detail.procedure.id, { start }))
              setAdding(false)
              toast('Trigger added')
            }}
          />
        </div>
      )}
      <Can
        need="admin"
        fallback={<p className="pt-1 text-micro text-fg-quaternary">Only admins change when a procedure runs by itself.</p>}
      >
        {null}
      </Can>
    </Section>
  )
}

function StepsSection({
  detail,
  onSaved,
  resolve,
}: {
  detail: ProcedureDetail
  onSaved(): void
  resolve(kind: string, id: string): string | undefined
}) {
  const api = useApi()
  const p = detail.procedure
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.updateRecord<ProcedureRecordData>('procedure', p.id, { body: draft }, p.version)
      setEditing(false)
      toast(`Saved as version ${next.version}`, {
        description: detail.context.state === 'missing' ? undefined : 'Rebuild the context so new runs follow the new steps.',
      })
      onSaved()
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.status === 409
          ? 'Someone else changed it meanwhile: copy your text, reload and try again.'
          : errorText(e),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Steps"
      id="steps"
      actions={
        <>
          <Button variant="ghost" size="xs" onClick={() => setHistoryOpen(true)}>
            <History /> History <span className="text-fg-quaternary">v{p.version}</span>
          </Button>
          <Can>
            {!editing && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setDraft(p.data.body ?? '')
                  setEditing(true)
                }}
              >
                <Pencil /> Edit steps
              </Button>
            )}
          </Can>
        </>
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <StepsEditor
            value={draft}
            onChange={setDraft}
            onSubmit={save}
            onCancel={() => setEditing(false)}
            resolve={resolve}
            minHeight="min-h-80"
          />
          {error && (
            <p role="alert" className="text-micro text-[var(--red)]">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 text-micro text-fg-tertiary">
            <span className="mr-auto hidden sm:inline">Saving makes a new version; older ones stay in the history.</span>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save steps'}
            </Button>
          </div>
        </div>
      ) : p.data.body?.trim() ? (
        <Markdown text={stripTitle(p.data.body, p.data.name)} resolve={resolve} className="text-regular" />
      ) : (
        <p className="text-fg-tertiary">No steps written down yet: the employee will ask the owner.</p>
      )}
      <StepsHistory open={historyOpen} onOpenChange={setHistoryOpen} detail={detail} onRestored={onSaved} />
    </Section>
  )
}

function StepsHistory({
  open,
  onOpenChange,
  detail,
  onRestored,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  detail: ProcedureDetail
  onRestored(): void
}) {
  const api = useApi()
  const { can } = useAuth()
  const p = detail.procedure
  const revs = useLoad(
    (a) => (open ? a.recordRevisions('procedure', p.id) : Promise.resolve([] as ApiRevision[])),
    [open, p.version],
  )
  const list = [...(revs.data ?? [])].reverse()
  const [picked, setPicked] = useState<number | null>(null)
  const actors = useNames(
    [],
    list.filter((r) => r.actor.type !== 'system').map((r) => ({ kind: r.actor.type, id: r.actor.id })),
  )
  const who = (r: ApiRevision) => (r.actor.type === 'system' ? 'the harness' : (actors.get(r.actor.id) ?? r.actor.id))
  const shown = list.find((r) => r.version === picked) ?? list[0]
  const body = String((shown?.data as ProcedureRecordData | null)?.body ?? '')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] gap-3 overflow-y-auto sm:max-w-[820px]" data-testid="steps-history">
        <DialogHeader>
          <DialogTitle className="text-title1">History of {p.data.name}</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            Every save is a version. Pick one to read its steps.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="flex flex-col">
            {list.map((r, i) => {
              const prev = list[i + 1]
              const changed = prev?.data && r.data ? changedFields(prev.data, r.data) : []
              return (
                <button
                  key={r.version}
                  type="button"
                  onClick={() => setPicked(r.version)}
                  className={cn(
                    'flex flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-secondary',
                    shown?.version === r.version && 'bg-secondary',
                  )}
                >
                  <span className="text-mini text-fg-secondary">
                    v{r.version} ·{' '}
                    {r.op === 'create'
                      ? 'Created'
                      : `Changed ${changed.filter((f) => f !== 'contextSessionId').join(', ') || 'its context'}`}
                  </span>
                  <span className="text-micro text-fg-quaternary">
                    {who(r)} · {formatDateTime(r.at)}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="min-w-0 rounded-md border bg-level-1 px-4 py-3">
            {body.trim() ? <Markdown text={body} /> : <p className="text-fg-tertiary">No steps in this version.</p>}
          </div>
        </div>
        {shown && shown.version !== p.version && can('member') && (
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await api.updateRecord('procedure', p.id, { body }, p.version)
                toast(`Restored the steps of v${shown.version}`)
                onOpenChange(false)
                onRestored()
              }}
            >
              Restore these steps
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function causeIcon(type: ProcedureRun['startedBy']['type']) {
  if (type === 'trigger') return <Zap className="size-3 shrink-0" />
  if (type === 'person') return <User className="size-3 shrink-0" />
  if (type === 'session') return <Bot className="size-3 shrink-0" />
  return null
}

function RunsSection({ detail }: { detail: ProcedureDetail }) {
  return (
    <Section title={`Runs${detail.runs.length ? ` · ${detail.runs.length}` : ''}`} id="runs">
      {detail.runs.length === 0 ? (
        <p className="py-4 text-fg-tertiary">Not run yet. Run now to try it, or wait for its trigger.</p>
      ) : (
        <div className="flex flex-col">
          {detail.runs.map((r) => (
            <Link
              key={r.sessionId}
              to={`/sessions/${r.sessionId}`}
              data-testid="procedure-run"
              className="group -mx-2 flex min-h-10 items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-secondary"
            >
              <span className="pt-0.5">
                <RunState state={r.state} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-fg-secondary group-hover:text-foreground">{r.title}</span>
                  <span className="ml-auto shrink-0 text-micro text-fg-quaternary">{timeAgo(r.startedAt)}</span>
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-micro text-fg-tertiary">
                  <span className="inline-flex min-w-0 items-center gap-1">
                    {causeIcon(r.startedBy.type)}
                    <span className="truncate">
                      {r.startedBy.type === 'trigger'
                        ? r.startedBy.label
                        : r.startedBy.type === 'person'
                          ? `Run now by ${r.startedBy.label}`
                          : r.startedBy.type === 'session'
                            ? `From ${r.startedBy.label}`
                            : r.startedBy.label}
                    </span>
                  </span>
                  <span className="text-fg-quaternary">·</span>
                  <span>{r.endedAt ? took(r.startedAt, r.endedAt) : STATUS[r.state ?? 'idle'].label.toLowerCase()}</span>
                </span>
                {r.outcome && <span className="mt-0.5 block truncate text-micro text-fg-quaternary">{r.outcome}</span>}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Section>
  )
}

function Panel({
  title,
  children,
  actions,
  testId,
}: {
  title: string
  children: ReactNode
  actions?: ReactNode
  testId?: string
}) {
  return (
    <div className="border-b px-4 py-4" data-testid={testId}>
      <SectionTitle className="mb-2" actions={actions}>
        {title}
      </SectionTitle>
      {children}
    </div>
  )
}

function ContextPanel({ detail, onChanged }: { detail: ProcedureDetail; onChanged(d: ProcedureDetail): void }) {
  const api = useApi()
  const { employees } = useEmployees()
  const [busy, setBusy] = useState(false)
  const [employeeId, setEmployeeId] = useState('')
  const c = detail.context
  const s = CONTEXT_STATE[c.state]
  const rebuild = async () => {
    setBusy(true)
    try {
      const pick = employeeId || employees[0]?.id
      onChanged(await api.rebuildProcedureContext(detail.procedure.id, c.state === 'missing' && pick ? { employeeId: pick } : {}))
      toast(c.state === 'missing' ? 'Context built' : 'Context rebuilt', {
        description: 'New runs start from the current steps.',
      })
    } catch (e) {
      toast(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel title="Context" testId="context-panel">
      <ContextBadge state={c.state} className="text-small" />
      <p className="mt-1 text-micro text-fg-tertiary">
        {c.reason && c.state === 'stale' ? `${c.reason} New runs follow the old steps until you rebuild it.` : s.hint}
      </p>
      {c.sessionId && (
        <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-y-1 text-micro">
          <dt className="text-fg-tertiary">Built</dt>
          <dd className="text-fg-secondary">
            {c.builtAt ? agoPhrase(c.builtAt) : '—'}
            {c.builtFromVersion ? <span className="text-fg-quaternary"> from v{c.builtFromVersion}</span> : null}
          </dd>
          {c.employee && (
            <>
              <dt className="text-fg-tertiary">Runs as</dt>
              <dd className="truncate text-fg-secondary">{c.employee.name}</dd>
            </>
          )}
          <dt className="text-fg-tertiary">Session</dt>
          <dd className="truncate">
            <Link to={`/sessions/${c.sessionId}`} className="text-[#828fff] hover:underline">
              {c.slug ? `#${c.slug}` : 'Open'}
            </Link>
          </dd>
        </dl>
      )}
      <Can>
        <div className="mt-3 flex flex-col gap-2">
          {c.state === 'missing' && employees.length > 1 && (
            <select
              aria-label="Run by"
              value={employeeId || employees[0]?.id}
              onChange={(e) => setEmployeeId(e.target.value)}
              className={cn(selectClass, 'h-7 text-mini')}
            >
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  Run by {e.data.name}
                </option>
              ))}
            </select>
          )}
          <Button
            size="sm"
            variant={c.state === 'ready' ? 'outline' : 'default'}
            onClick={rebuild}
            disabled={busy}
            className="self-start"
          >
            <RefreshCw className={cn(busy && 'animate-spin')} />
            {c.state === 'missing' ? 'Build context' : 'Rebuild context'}
          </Button>
        </div>
      </Can>
    </Panel>
  )
}

function ApprovalsPanel({ detail, onSaved }: { detail: ProcedureDetail; onSaved(): void }) {
  const api = useApi()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ApproverDraft[]>([])
  const waiting = detail.runs.filter((r) => r.state === 'suspended' || r.state === 'paused')
  const save = async () => {
    try {
      await api.updateRecord('procedure', detail.procedure.id, { approvals: approvalsOf(draft) }, detail.procedure.version)
      setEditing(false)
      toast('Approvals saved')
      onSaved()
    } catch (e) {
      toast(errorText(e))
    }
  }
  return (
    <Panel
      title="Approvals"
      testId="approvals-panel"
      actions={
        <Can>
          {!editing && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Edit approvals"
              onClick={() => {
                setDraft(detail.approvers.map((a) => ({ ...a, label: a.name })))
                setEditing(true)
              }}
            >
              <Pencil />
            </Button>
          )}
        </Can>
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <ApproversEditor value={draft} onChange={setDraft} idPrefix="ed-appr" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : detail.approvers.length === 0 ? (
        <p className="text-micro text-fg-tertiary">None: the employee carries it out without asking anyone.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {detail.approvers.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: approvers have no id
            <li key={i} className="flex min-w-0 items-start gap-2">
              {a.contactId ? (
                <PersonAvatar name={a.name ?? a.contactId} className="mt-0.5 size-4" />
              ) : (
                <User className="mt-0.5 size-4 text-fg-tertiary" />
              )}
              <span className="min-w-0">
                {a.contactId ? (
                  <Link to={hrefFor('contact', a.contactId)} className="block truncate text-fg-secondary hover:text-foreground">
                    {a.name ?? a.contactId}
                  </Link>
                ) : (
                  <span className="block truncate text-fg-secondary">Someone with the role {a.role}</span>
                )}
                <span className="block text-micro text-fg-tertiary">
                  {a.step ? `Approves ${a.step}` : 'Approves before the work is done'}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {waiting.length > 0 && (
        <div className="mt-3 rounded-md bg-level-2 px-2.5 py-2" data-testid="waiting-runs">
          <p className="text-micro font-medium text-fg-secondary">Waiting now</p>
          {waiting.map((r) => (
            <Link
              key={r.sessionId}
              to={`/sessions/${r.sessionId}`}
              className="mt-1 flex min-w-0 items-center gap-1.5 text-micro text-fg-tertiary hover:text-foreground"
            >
              <RunState state={r.state} />
              <span className="truncate">{r.title}</span>
            </Link>
          ))}
          <p className="mt-1 text-micro text-fg-quaternary">Waiting for a reply in its thread, often an approval.</p>
        </div>
      )}
    </Panel>
  )
}

// ─── Detail: dialogs ────────────────────────────────────────────────────────

function RunNowDialog({
  open,
  onOpenChange,
  detail,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  detail: ProcedureDetail
}) {
  const api = useApi()
  const { employees } = useEmployees()
  const [work, setWork] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<{ sessionId: string } | null>(null)
  const key = useRef(newKey())
  const missing = detail.context.state === 'missing'
  const reset = () => {
    setWork('')
    setError(null)
    setStarted(null)
    key.current = newKey()
  }
  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.runProcedure(detail.procedure.id, {
        ...(work.trim() ? { work: work.trim() } : {}),
        ...(missing ? { employeeId: employeeId || employees[0]?.id } : {}),
        idempotencyKey: key.current,
      })
      setStarted({ sessionId: r.sessionId })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="gap-4 sm:max-w-[520px]" data-testid="run-now-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">Run {detail.procedure.data.name}</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            Starts a fork of the procedure's context, like a trigger would, with what you write here as its task.
          </DialogDescription>
        </DialogHeader>
        {started ? (
          <div className="flex flex-col gap-3" data-testid="run-started">
            <p className="flex items-center gap-2 text-fg-secondary">
              <Check className="size-4 text-[var(--green)]" /> Started. It shows up under Runs.
            </p>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button size="sm" asChild>
                <Link to={`/sessions/${started.sessionId}`}>Open the run</Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <label htmlFor="run-work" className="flex items-baseline gap-2 text-micro">
              <span className="font-medium text-fg-secondary">What to do</span>
              <span className="text-fg-quaternary">Optional: who it's for, the ticket, anything it needs</span>
            </label>
            <Textarea
              id="run-work"
              value={work}
              onChange={(e) => setWork(e.target.value)}
              rows={4}
              autoFocus
              placeholder="What this run is for: who asked, the ticket or thread, anything it needs."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run()
              }}
            />
            {missing && (
              <select
                aria-label="Run by"
                value={employeeId || employees[0]?.id}
                onChange={(e) => setEmployeeId(e.target.value)}
                className={selectClass}
              >
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    Run by {e.data.name} (builds its context first)
                  </option>
                ))}
              </select>
            )}
            {detail.context.state === 'stale' && (
              <p className="text-micro text-[var(--orange)]">
                Its context is out of date: this run follows the steps it was built from.
              </p>
            )}
            {error && (
              <p role="alert" className="text-micro text-[var(--red)]">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={run} disabled={busy}>
                <Play /> {busy ? 'Starting…' : 'Run now'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function EditDialog({
  open,
  onOpenChange,
  detail,
  onSaved,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  detail: ProcedureDetail
  onSaved(): void
}) {
  const api = useApi()
  const p = detail.procedure
  const [name, setName] = useState(p.data.name)
  const [applies, setApplies] = useState(p.data.applies)
  const [owner, setOwner] = useState<{ id: string; label: string } | null>(
    detail.owner ? { id: detail.owner.contactId, label: detail.owner.name } : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!name.trim() || !applies.trim()) return setError('A name and when it applies are both needed.')
    setBusy(true)
    try {
      await api.updateRecord(
        'procedure',
        p.id,
        { name: name.trim(), applies: applies.trim(), ownerId: owner?.id ?? null },
        p.version,
      )
      toast('Saved')
      onOpenChange(false)
      onSaved()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setName(p.data.name)
          setApplies(p.data.applies)
          setOwner(detail.owner ? { id: detail.owner.contactId, label: detail.owner.name } : null)
          setError(null)
        }
        onOpenChange(o)
      }}
    >
      <DialogContent className="gap-4 sm:max-w-[520px]" data-testid="edit-procedure-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">Edit procedure</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            Its name, when it applies and who owns it. Steps and approvals are edited on the page.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 text-micro">
            <label htmlFor="ep-name" className="font-medium text-fg-secondary">
              Name
            </label>
            <Input id="ep-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1 text-micro">
            <label htmlFor="ep-applies" className="font-medium text-fg-secondary">
              When it applies
            </label>
            <Input id="ep-applies" value={applies} onChange={(e) => setApplies(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1 text-micro">
            <span className="font-medium text-fg-secondary">Owner</span>
            {owner ? (
              <PickedChip label={owner.label} onClear={() => setOwner(null)} clearLabel="Change owner" />
            ) : (
              <RecordPicker
                kinds={['contact']}
                placeholder="A person or an employee"
                onPick={(o) => setOwner({ id: o.id, label: o.label })}
              />
            )}
          </div>
          {error && (
            <p role="alert" className="text-micro text-[var(--red)]">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ArchiveDialog({
  open,
  onOpenChange,
  detail,
  onDone,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  detail: ProcedureDetail
  onDone(d: ProcedureDetail): void
}) {
  const api = useApi()
  const on = detail.triggers.filter((t) => t.enabled).length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-title1">Archive {detail.procedure.data.name}?</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            It stops running{on ? `: its ${pluralize(on, 'trigger')} ${on === 1 ? 'is' : 'are'} turned off` : ''}, and employees
            no longer find it. Runs already going carry on. You can unarchive it later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={async () => {
              onDone(await api.archiveProcedure(detail.procedure.id, true))
              onOpenChange(false)
              toast('Archived')
            }}
          >
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Detail page ────────────────────────────────────────────────────────────

/** `/procedures/:id`: what the procedure is, when it runs, its steps, approvals, runs and context. */
export function ProcedurePage() {
  const { id = '' } = useParams()
  const api = useApi()
  const d = useLoad((a) => a.procedure(id), [id])
  useLiveReload([...LIVE], d.reload)
  const [runOpen, setRunOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [dupOpen, setDupOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const names = useNames([d.data?.procedure.data.body ?? ''])
  const resolve = (_k: string, rid: string) => names.get(rid)
  const back = (
    <span className="flex min-w-0 items-center gap-1.5">
      <Link to="/procedures" className="shrink-0 text-fg-tertiary hover:text-foreground">
        Procedures
      </Link>
      <ChevronRight className="size-3.5 shrink-0 text-fg-quaternary" />
      <span className="truncate">{d.data?.procedure.data.name ?? ''}</span>
    </span>
  )
  if (d.error && !d.data)
    return (
      <Page title={back} icon={<BookOpen />}>
        <ErrorState error={d.error} retry={d.reload} />
      </Page>
    )
  if (!d.data)
    return (
      <Page title={back} icon={<BookOpen />}>
        <LoadingRows />
      </Page>
    )
  const detail = d.data
  const p = detail.procedure
  const set = (next: ProcedureDetail) => d.setData(next)
  return (
    <Page
      title={back}
      icon={<BookOpen />}
      className="overflow-hidden"
      actions={
        <Can>
          {!p.data.archived && (
            <Button size="sm" onClick={() => setRunOpen(true)}>
              <Play /> Run now
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)} className="hidden sm:inline-flex">
            <Pencil /> Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditOpen(true)} className="sm:hidden">
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDupOpen(true)}>
                <Copy /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {p.data.archived ? (
                <DropdownMenuItem
                  onSelect={async () => {
                    set(await api.archiveProcedure(p.id, false))
                    toast('Unarchived', { description: 'Its triggers stay off until an admin turns them on.' })
                  }}
                >
                  <ArchiveRestore /> Unarchive
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => setArchiveOpen(true)}>
                  <Archive /> Archive
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </Can>
      }
    >
      <SplitView
        sideSize={320}
        sideMin={280}
        sideMax={420}
        main={
          <div className="mx-auto max-w-[720px] px-4 pt-8 pb-16 sm:px-6">
            {p.data.archived && (
              <p className="mb-4 rounded-md border px-3 py-2 text-mini text-fg-tertiary">
                Archived: it doesn't run, and employees don't find it.
              </p>
            )}
            <h2 className="mb-1 text-title3 font-semibold">{p.data.name}</h2>
            <p className="mb-3 text-regular text-fg-tertiary">{p.data.applies}</p>
            <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-1 text-mini text-fg-tertiary">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                Owner {detail.owner ? <Who person={detail.owner} /> : <span className="text-fg-quaternary">none</span>}
              </span>
              {detail.context.employee && (
                <span className="inline-flex items-center gap-1.5">
                  Runs as <EmployeeAvatar name={detail.context.employee.name} className="size-4" />
                  <span className="text-fg-secondary">{detail.context.employee.name}</span>
                </span>
              )}
              <span>{pluralize(detail.runs30d, 'run')} in 30 days</span>
              <span>Updated {agoPhrase(p.updatedAt)}</span>
            </div>
            <WhenItRuns detail={detail} onChanged={set} />
            <StepsSection detail={detail} onSaved={d.reload} resolve={resolve} />
            <RunsSection detail={detail} />
          </div>
        }
        side={
          <aside className="h-full overflow-auto bg-level-1" data-testid="procedure-side">
            <ContextPanel detail={detail} onChanged={set} />
            <ApprovalsPanel detail={detail} onSaved={d.reload} />
            <Panel title="Details">
              <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-y-1 text-micro">
                <dt className="text-fg-tertiary">Version</dt>
                <dd className="text-fg-secondary">v{p.version}</dd>
                <dt className="text-fg-tertiary">Created</dt>
                <dd className="text-fg-secondary">{formatDateTime(p.createdAt)}</dd>
                <dt className="text-fg-tertiary">Id</dt>
                <dd className="truncate font-mono text-fg-quaternary">{p.id}</dd>
              </dl>
            </Panel>
          </aside>
        }
      />
      <RunNowDialog open={runOpen} onOpenChange={setRunOpen} detail={detail} />
      <EditDialog open={editOpen} onOpenChange={setEditOpen} detail={detail} onSaved={d.reload} />
      <ArchiveDialog open={archiveOpen} onOpenChange={setArchiveOpen} detail={detail} onDone={set} />
      <NewProcedureDialog
        open={dupOpen}
        onOpenChange={setDupOpen}
        initial={{
          name: p.data.name,
          applies: p.data.applies,
          ...(p.data.body ? { body: p.data.body } : {}),
          ...(detail.owner ? { ownerId: detail.owner.contactId, ownerLabel: detail.owner.name } : {}),
          approvals: detail.approvers.map((a) => ({ ...a, label: a.name })),
          ...(detail.context.employee ? { employeeId: detail.context.employee.id } : {}),
        }}
      />
    </Page>
  )
}
