import type { ScheduledTask, ScheduleKind, SchedulePreview, ScheduleWhenInput } from '@mp/api'
import { CalendarClock, Pause, Pencil, Play, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { selectClass } from '@/components/start-form.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLiveReload, useLoad } from '@/lib/api.tsx'
import { Can } from '@/lib/auth.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { timeAgo } from '@/lib/format.ts'
import {
  GROUP_TITLES,
  PRESETS,
  type RecurringForm,
  type RecurringPreset,
  type ScheduleGroup,
  WEEKDAY_NAMES,
  browserTimezone,
  cronOf,
  formOfCron,
  formatIn,
  groupOf,
  lastRunStatus,
  localInputOf,
  untilPhrase,
} from '@/lib/schedules.ts'
import { cn } from '@/lib/utils.ts'

type Filter = 'all' | ScheduleKind

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'task', label: 'Tasks' },
  { value: 'follow_up', label: 'Follow-ups' },
]

function IconAction({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string
  onClick(): void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className="text-fg-tertiary"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function KindIcon({ task }: { task: ScheduledTask }) {
  const Icon = task.kind === 'follow_up' ? Undo2 : CalendarClock
  return (
    <Icon
      aria-label={task.kind === 'follow_up' ? 'Follow-up' : 'Scheduled task'}
      className={cn('size-4 shrink-0', !task.enabled && !task.done ? 'text-[var(--status-paused)]' : 'text-fg-tertiary')}
      strokeWidth={1.75}
    />
  )
}

function LastRun({ task, now }: { task: ScheduledTask; now: number }) {
  const status = lastRunStatus(task)
  const r = task.lastRun
  if (!r || !status) return <span className="text-fg-quaternary">never ran</span>
  const label = r.state === 'missed' ? 'missed' : timeAgo(r.at, now)
  const sessionId = r.sessionId ?? task.session?.id
  const body = (
    <span className="inline-flex min-w-0 items-center gap-1" title={r.output ?? undefined}>
      <StatusIcon status={status} className="size-3.5" tooltip={false} />
      <span className="shrink-0">{label}</span>
      {r.output && <span className="min-w-0 truncate text-fg-quaternary">{r.output}</span>}
    </span>
  )
  return sessionId ? (
    <Link to={`/sessions/${sessionId}`} className="min-w-0 hover:text-foreground" data-testid="last-run">
      {body}
    </Link>
  ) : (
    <span data-testid="last-run">{body}</span>
  )
}

function ScheduleRow({
  task,
  now,
  onRun,
  onToggle,
  onEdit,
  onDelete,
  busy,
}: {
  task: ScheduledTask
  now: number
  onRun(): void
  onToggle(): void
  onEdit(): void
  onDelete(): void
  busy: boolean
}) {
  return (
    <div
      data-testid="schedule-row"
      className="flex flex-col gap-1 border-b px-4 py-2 last:border-b-0 md:px-6 lg:min-h-9 lg:flex-row lg:items-center lg:gap-3 lg:py-1"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <KindIcon task={task} />
        <span className="min-w-0 truncate text-fg-secondary" title={task.instruction}>
          {task.instruction}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-micro text-fg-tertiary lg:shrink-0 lg:flex-nowrap lg:pl-0">
        <span className="whitespace-nowrap lg:w-52 lg:truncate" data-testid="schedule-when" title={task.description}>
          {task.description}
        </span>
        <span
          className="whitespace-nowrap tabular-nums lg:w-20"
          title={task.nextRunAt ? formatIn(task.nextRunAt, task.timezone) : undefined}
        >
          {task.nextRunAt ? `next ${untilPhrase(task.nextRunAt, now)}` : task.done ? 'done' : 'paused'}
        </span>
        <span className="min-w-0 max-w-56 truncate lg:w-40">
          <LastRun task={task} now={now} />
        </span>
        {task.report ? (
          <span className="whitespace-nowrap text-fg-quaternary lg:hidden xl:block xl:w-28 xl:truncate" title={task.report.label}>
            → {task.report.label}
          </span>
        ) : (
          <span className="hidden xl:block xl:w-28" />
        )}
        <span className="flex items-center gap-1 whitespace-nowrap lg:w-28">
          <EmployeeAvatar name={task.employee.name} className="size-3.5" />
          {task.employee.name}
        </span>
        {task.canManage && (
          <span className="-my-1 ml-auto flex items-center lg:ml-0 lg:w-28 lg:justify-end" data-testid="schedule-actions">
            {task.kind === 'task' && (
              <IconAction label="Run now" onClick={onRun} disabled={busy}>
                <Play />
              </IconAction>
            )}
            {task.done ? null : (
              <IconAction label={task.enabled ? 'Pause' : 'Resume'} onClick={onToggle} disabled={busy}>
                {task.enabled ? <Pause /> : <RotateCcw />}
              </IconAction>
            )}
            <IconAction label="Edit" onClick={onEdit} disabled={busy}>
              <Pencil />
            </IconAction>
            <IconAction label="Delete" onClick={onDelete} disabled={busy}>
              <Trash2 />
            </IconAction>
          </span>
        )}
      </div>
    </div>
  )
}

function Row({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="flex items-baseline gap-2 text-micro">
        <span className="font-medium text-fg-secondary">{label}</span>
        {hint && <span className="truncate text-fg-quaternary">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

/** The form's state: what, who, and when. */
interface FormState {
  employeeId: string
  instruction: string
  mode: 'once' | 'recurring'
  /** `YYYY-MM-DDTHH:MM`, read in `timezone`. */
  at: string
  recurring: RecurringForm
  timezone: string
  channelId: string
  fresh: boolean
}

function initialForm(task: ScheduledTask | null, employeeId: string, now: number): FormState {
  const tz = task?.timezone ?? browserTimezone()
  const inAnHour = new Date(Math.ceil((now + 3_600_000) / 900_000) * 900_000).toISOString()
  const base: FormState = {
    employeeId: task?.employee.id ?? employeeId,
    instruction: task?.instruction ?? '',
    mode: task?.when.type === 'cron' ? 'recurring' : 'once',
    at: localInputOf(task?.when.type === 'once' ? task.when.at : inAnHour, tz),
    recurring:
      task?.when.type === 'cron'
        ? formOfCron(task.when.cron)
        : { preset: 'weekday', time: '09:00', weekday: 1, monthDay: 1, cron: '0 9 * * 1-5' },
    timezone: tz,
    channelId: task?.report?.channelId && !task.report.threadId ? task.report.channelId : '',
    fresh: task?.sessionMode === 'fresh',
  }
  return base
}

/** The `when` a form sends: a wall-clock time (in the form's time zone), or cron. */
function whenOf(f: FormState): ScheduleWhenInput | null {
  if (f.mode === 'once') return f.at ? { at: f.at.replace('T', ' ') } : null
  const cron = cronOf(f.recurring)
  return cron ? { cron } : null
}

export function ScheduleDialog({
  open,
  onOpenChange,
  task,
  onSaved,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** Edit this task; null creates one. */
  task: ScheduledTask | null
  onSaved(): void
}) {
  const api = useApi()
  const { employees, currentId } = useEmployees()
  const [form, setForm] = useState<FormState>(() => initialForm(task, currentId ?? employees[0]?.id ?? '', Date.now()))
  const [preview, setPreview] = useState<SchedulePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const channels = useLoad((a) => a.channels(), [])
  const followUp = task?.kind === 'follow_up'

  useEffect(() => {
    if (open) {
      setForm(initialForm(task, currentId ?? employees[0]?.id ?? '', Date.now()))
      setError(null)
    }
  }, [open, task, currentId, employees])

  const when = whenOf(form)
  // The preview asks again only when what it would show changes.
  const previewKey = when ? JSON.stringify({ ...when, timezone: form.timezone }) : null
  useEffect(() => {
    if (!open || !previewKey) {
      setPreview(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      api
        .previewSchedule(JSON.parse(previewKey) as ScheduleWhenInput & { timezone: string })
        .then((p) => {
          if (!live) return
          setPreview(p)
          setPreviewError(null)
        })
        .catch((err: unknown) => {
          if (!live) return
          setPreview(null)
          setPreviewError(err instanceof Error ? err.message : String(err))
        })
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [open, previewKey, api])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setRec = <K extends keyof RecurringForm>(k: K, v: RecurringForm[K]) =>
    setForm((f) => ({ ...f, recurring: { ...f.recurring, [k]: v } }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.instruction.trim()) return setError(followUp ? 'Write the note.' : 'Write what the employee should do.')
    if (!when) return setError('Say when.')
    if (!task && !form.employeeId) return setError('Pick an employee.')
    setSaving(true)
    setError(null)
    try {
      if (task) {
        await api.updateSchedule(task.id, {
          instruction: form.instruction,
          when,
          timezone: form.timezone,
          ...(followUp ? {} : { sessionMode: form.fresh ? 'fresh' : 'continue' }),
        })
        toast('Schedule saved')
      } else {
        await api.createSchedule({
          employeeId: form.employeeId,
          instruction: form.instruction,
          when,
          timezone: form.timezone,
          ...(form.channelId ? { report: { channelId: form.channelId } } : {}),
          ...(form.mode === 'recurring' && form.fresh ? { sessionMode: 'fresh' } : {}),
        })
        toast('Task scheduled')
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const channelItems = (channels.data ?? []).filter((c) => !c.channel.data.dm)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] gap-4 overflow-y-auto sm:max-w-[560px]" data-testid="schedule-dialog">
        <DialogHeader>
          <DialogTitle>{task ? (followUp ? 'Edit follow-up' : 'Edit scheduled task') : 'New scheduled task'}</DialogTitle>
          <DialogDescription>
            {followUp
              ? 'The note comes back to its session at the time you set.'
              : 'At each time, the employee starts a run with this instruction in the task’s own session.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          {!task && (
            <Row id="sched-employee" label="Employee">
              <select
                id="sched-employee"
                className={selectClass}
                value={form.employeeId}
                onChange={(e) => set('employeeId', e.target.value)}
              >
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.data.name}
                  </option>
                ))}
              </select>
            </Row>
          )}
          <Row
            id="sched-instruction"
            label={followUp ? 'Note' : 'Instruction'}
            hint="self-contained: the run starts without this page"
          >
            <Textarea
              id="sched-instruction"
              value={form.instruction}
              onChange={(e) => set('instruction', e.target.value)}
              placeholder="Post the weekly invoice summary in #billing"
              rows={3}
            />
          </Row>
          {!followUp && (
            <fieldset className="flex gap-1 rounded-md bg-level-2 p-0.5 text-mini" aria-label="When">
              {(['once', 'recurring'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={form.mode === m}
                  onClick={() => set('mode', m)}
                  className={cn(
                    'flex-1 rounded-sm px-2 py-1 transition-quick',
                    form.mode === m ? 'bg-secondary text-foreground shadow-xs' : 'text-fg-tertiary hover:text-foreground',
                  )}
                >
                  {m === 'once' ? 'Once' : 'Recurring'}
                </button>
              ))}
            </fieldset>
          )}
          {form.mode === 'once' ? (
            <Row id="sched-at" label="At">
              <Input id="sched-at" type="datetime-local" value={form.at} onChange={(e) => set('at', e.target.value)} />
            </Row>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Row id="sched-preset" label="Repeat">
                <select
                  id="sched-preset"
                  className={selectClass}
                  value={form.recurring.preset}
                  onChange={(e) => setRec('preset', e.target.value as RecurringPreset)}
                >
                  {PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Row>
              {form.recurring.preset === 'cron' ? (
                <Row id="sched-cron" label="Cron" hint="minute hour day month weekday">
                  <Input
                    id="sched-cron"
                    className="font-mono"
                    value={form.recurring.cron}
                    onChange={(e) => setRec('cron', e.target.value)}
                    placeholder="0 9 * * 1-5"
                  />
                </Row>
              ) : form.recurring.preset === 'hour' ? null : (
                <Row id="sched-time" label="Time">
                  <Input
                    id="sched-time"
                    type="time"
                    value={form.recurring.time}
                    onChange={(e) => setRec('time', e.target.value)}
                  />
                </Row>
              )}
              {form.recurring.preset === 'week' && (
                <Row id="sched-weekday" label="Day">
                  <select
                    id="sched-weekday"
                    className={selectClass}
                    value={form.recurring.weekday}
                    onChange={(e) => setRec('weekday', Number(e.target.value))}
                  >
                    {WEEKDAY_NAMES.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </Row>
              )}
              {form.recurring.preset === 'month' && (
                <Row id="sched-monthday" label="Day of the month" hint="1 to 28">
                  <Input
                    id="sched-monthday"
                    type="number"
                    min={1}
                    max={28}
                    value={form.recurring.monthDay}
                    onChange={(e) => setRec('monthDay', Math.min(28, Math.max(1, Number(e.target.value) || 1)))}
                  />
                </Row>
              )}
            </div>
          )}
          <Row id="sched-tz" label="Time zone" hint="IANA name">
            <Input
              id="sched-tz"
              value={form.timezone}
              onChange={(e) => set('timezone', e.target.value)}
              placeholder="Europe/Belgrade"
            />
          </Row>
          <div className="rounded-md border bg-level-1 px-3 py-2 text-micro" data-testid="schedule-preview" aria-live="polite">
            {preview ? (
              <>
                <div className="font-medium text-fg-secondary">{preview.description}</div>
                {preview.next.length > 0 && (
                  <div className="mt-0.5 text-fg-tertiary">
                    {preview.next.length === 1 ? 'Runs ' : 'Next: '}
                    {preview.next
                      .slice(0, 3)
                      .map((n) => formatIn(n, preview.timezone))
                      .join(' · ')}
                  </div>
                )}
              </>
            ) : previewError ? (
              <span className="text-[var(--red)]">{previewError}</span>
            ) : (
              <span className="text-fg-quaternary">Pick a time to see when it runs.</span>
            )}
          </div>
          {!task && (
            <Row id="sched-report" label="Report in" hint="optional">
              <select
                id="sched-report"
                className={selectClass}
                value={form.channelId}
                onChange={(e) => set('channelId', e.target.value)}
              >
                <option value="">Nowhere: keep the result on the task</option>
                {channelItems.map((c) => (
                  <option key={c.channel.id} value={c.channel.id}>
                    #{c.channel.data.name}
                  </option>
                ))}
              </select>
            </Row>
          )}
          {!followUp && form.mode === 'recurring' && (
            <label className="flex items-center gap-2 text-micro text-fg-secondary">
              <input type="checkbox" checked={form.fresh} onChange={(e) => set('fresh', e.target.checked)} />A fresh session for
              every run (by default each run continues the last one and remembers it)
            </label>
          )}
          {error && (
            <p role="alert" className="text-micro text-[var(--red)]">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {task ? 'Save' : 'Schedule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ConfirmDelete({ task, onClose, onDone }: { task: ScheduledTask | null; onClose(): void; onDone(): void }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={!!task} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Delete this {task?.kind === 'follow_up' ? 'follow-up' : 'scheduled task'}?</DialogTitle>
          <DialogDescription className="line-clamp-3">{task?.instruction}</DialogDescription>
        </DialogHeader>
        <p className="text-micro text-fg-tertiary">It never runs again. Runs already going aren’t stopped.</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (!task) return
              setBusy(true)
              try {
                await api.deleteSchedule(task.id)
                toast('Deleted')
                onDone()
                onClose()
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SchedulesPage() {
  const api = useApi()
  const { currentId } = useEmployees()
  const [filter, setFilter] = useState<Filter>('all')
  const list = useLoad((a) => a.schedules(currentId ? { employeeId: currentId } : {}), [currentId])
  useLiveReload(['records:scheduled_task'], list.reload, undefined, 500)
  const [dialog, setDialog] = useState<{ task: ScheduledTask | null } | null>(null)
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const now = Date.now()

  const shown = useMemo(() => (list.data?.items ?? []).filter((t) => filter === 'all' || t.kind === filter), [list.data, filter])
  const groups = useMemo(() => {
    const out: Record<ScheduleGroup, ScheduledTask[]> = { upcoming: [], paused: [], finished: [] }
    for (const t of shown) out[groupOf(t)].push(t)
    return out
  }, [shown])

  const act = async (t: ScheduledTask, what: () => Promise<unknown>, done: string) => {
    setBusy(t.id)
    try {
      await what()
      toast(done)
      list.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const newButton = (variant: 'default' | 'secondary' = 'secondary') => (
    <Can>
      <Button size="sm" variant={variant} aria-label="New scheduled task" onClick={() => setDialog({ task: null })}>
        <Plus />
        New<span className="max-sm:hidden"> scheduled task</span>
      </Button>
    </Can>
  )

  return (
    <Page
      title="Schedules"
      icon={<CalendarClock />}
      actions={newButton()}
      filters={
        <>
          <div className="flex gap-1" role="tablist" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'h-7 rounded-md px-2.5 text-mini transition-quick',
                  filter === f.value ? 'bg-secondary text-foreground' : 'text-fg-tertiary hover:text-foreground',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="ml-auto text-micro text-fg-tertiary">{list.data ? shown.length : ''}</span>
        </>
      }
    >
      <p className="border-b px-4 py-3 text-mini text-fg-tertiary md:px-6">
        Work the employees do later: tasks at a time or on a schedule, and follow-ups they left for themselves. Admins and the
        person who asked can run, pause, edit and delete them.
      </p>
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : shown.length === 0 ? (
        <EmptyState
          text={filter === 'follow_up' ? 'No follow-ups pending.' : 'Nothing scheduled yet.'}
          action={filter === 'follow_up' ? undefined : newButton('default')}
        />
      ) : (
        <div className="pb-6">
          {(['upcoming', 'paused', 'finished'] as const).map((g) =>
            groups[g].length ? (
              <section key={g} data-testid={`schedule-group-${g}`}>
                <SectionTitle className="border-b bg-level-1 px-4 py-1.5 md:px-6">
                  {GROUP_TITLES[g]} · {groups[g].length}
                </SectionTitle>
                {groups[g].map((t) => (
                  <ScheduleRow
                    key={t.id}
                    task={t}
                    now={now}
                    busy={busy === t.id}
                    onRun={() => act(t, () => api.runSchedule(t.id), 'Started')}
                    onToggle={() =>
                      act(t, () => api.updateSchedule(t.id, { enabled: !t.enabled }), t.enabled ? 'Paused' : 'Resumed')
                    }
                    onEdit={() => setDialog({ task: t })}
                    onDelete={() => setDeleting(t)}
                  />
                ))}
              </section>
            ) : null,
          )}
        </div>
      )}
      <ScheduleDialog
        open={!!dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        task={dialog?.task ?? null}
        onSaved={list.reload}
      />
      <ConfirmDelete task={deleting} onClose={() => setDeleting(null)} onDone={list.reload} />
    </Page>
  )
}
