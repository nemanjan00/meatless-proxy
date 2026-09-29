import type { ApiRecord, LimitBudgetView, LimitCapField, LimitData, LimitPeriod, LimitScopeView, LimitsOverview } from '@mp/api'
import { LIMIT_CAP_FIELDS } from '@mp/api'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router'
import { toast } from 'sonner'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { SectionTitle } from '@/components/page.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { formatCost, formatTokens } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

// ─── Plain-language labels ──────────────────────────────────────────────────

const MIN = 60_000

/** One cap, in plain words: "Max 8 runs at once per employee". `null` is "no limit". */
export function capLabel(field: LimitCapField, value: number | undefined): string {
  const n = value === undefined ? null : value
  switch (field) {
    case 'maxConcurrentSessions':
      return n === null ? 'No limit on runs at once per employee' : `Max ${n} runs at once per employee (more wait in the queue)`
    case 'maxDepth':
      return n === null ? 'No limit on fork depth' : `Forks go at most ${n} levels deep`
    case 'maxFanOut':
      return n === null ? 'No limit on children per loop' : `Max ${n} children per loop`
    case 'maxSteps':
      return n === null ? 'No limit on model calls per run' : `Max ${n} model calls per run`
    case 'maxWallMs':
      return n === null ? 'No limit on how long a run works' : `A run pauses after ${Math.round(n / MIN)} minutes of work`
    case 'maxAiStreak':
      return n === null
        ? 'No limit on messages between employees'
        : `Max ${n} messages between employees in a thread without a person`
  }
}

const PER: Record<LimitPeriod, string> = {
  run: 'per run',
  session: 'per session',
  tree: 'per session tree',
  day: 'per day',
  month: 'per month',
}

const WHO: Record<string, string> = {
  employee: 'per employee',
  contact: 'per requester',
  global: 'for the whole deployment',
  template: 'per template',
  procedure: 'per procedure',
  session: 'per session',
  tree: 'per session tree',
}

/** "5M tokens per employee per day", "$20 for the whole deployment per day". */
export function budgetLabel(b: Pick<LimitBudgetView, 'period' | 'scope'>, field: 'maxTokens' | 'maxCostUsd', max: number) {
  const amount = field === 'maxTokens' ? `${formatTokens(max)} tokens` : formatCost(max)
  const periodic = b.period === 'day' || b.period === 'month'
  return periodic ? `${amount} ${WHO[b.scope ?? 'global']} ${PER[b.period]}` : `${amount} ${PER[b.period]}`
}

/** A small bar of used against a budget: indigo, orange from the warning share, red when used up. */
export function BudgetBar({ used, max, warnAt = 0.8, label }: { used: number; max: number; warnAt?: number; label: string }) {
  const share = max > 0 ? used / max : 1
  const pct = Math.min(100, Math.round(share * 100))
  return (
    <div
      aria-hidden
      title={`${label}: ${pct}%`}
      data-testid="budget-bar"
      data-share={pct}
      className="h-1.5 w-28 overflow-hidden rounded-full bg-secondary"
    >
      <div
        className={cn(
          'h-full rounded-full transition-all',
          share >= 1 ? 'bg-[var(--red)]' : share >= warnAt ? 'bg-[var(--orange)]' : 'bg-primary',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ─── Targets ────────────────────────────────────────────────────────────────

type TargetChoice = 'global' | 'employees' | 'employee' | 'contacts' | 'contact'

const TARGET_LABELS: Record<TargetChoice, string> = {
  global: 'The whole deployment',
  employees: 'Every employee',
  employee: 'One employee',
  contacts: 'Every requester',
  contact: 'One requester (a person)',
}

const choiceOf = (t: LimitData['target']): TargetChoice =>
  t.type === 'global'
    ? 'global'
    : t.type === 'employee'
      ? t.id
        ? 'employee'
        : 'employees'
      : t.type === 'contact'
        ? t.id
          ? 'contact'
          : 'contacts'
        : 'global'

function targetText(t: LimitData['target'], names: Map<string, string>): string {
  const name = t.id ? (names.get(t.id) ?? t.id) : undefined
  switch (t.type) {
    case 'global':
      return 'The whole deployment'
    case 'employee':
      return name ? `Employee ${name}` : 'Every employee'
    case 'contact':
      return name ? `Requests by ${name}` : 'Every requester'
    default:
      return `${t.type}${name ? ` ${name}` : ''}`
  }
}

/** What an override sets, in plain words. */
export function overrideSummary(d: LimitData): string[] {
  const out: string[] = []
  for (const f of LIMIT_CAP_FIELDS) if (d[f] !== undefined) out.push(capLabel(f, d[f] ?? undefined))
  const period = d.period ?? (d.target.type === 'contact' ? 'day' : 'run')
  const b = { period, scope: d.target.type }
  for (const f of ['maxTokens', 'maxCostUsd'] as const) {
    const v = d[f]
    if (v === undefined) continue
    out.push(v === null ? `No ${f === 'maxTokens' ? 'token' : 'cost'} budget ${PER[period]}` : budgetLabel(b, f, v))
  }
  if (d.enabled === false) out.push('(off)')
  return out
}

// ─── The editor ─────────────────────────────────────────────────────────────

type FieldKey = LimitCapField | 'maxTokens' | 'maxCostUsd'

/** The editor's fields: label, unit, and how a typed value maps to the stored one. */
const FIELDS: { key: FieldKey; label: string; unit: string; integer: boolean; toStored?: number; min?: number }[] = [
  { key: 'maxConcurrentSessions', label: 'Runs at once', unit: 'per employee', integer: true, min: 1 },
  { key: 'maxDepth', label: 'Fork depth', unit: 'levels', integer: true },
  { key: 'maxFanOut', label: 'Children per loop', unit: 'children', integer: true, min: 1 },
  { key: 'maxSteps', label: 'Model calls per run', unit: 'calls', integer: true, min: 1 },
  { key: 'maxWallMs', label: 'Work time per run', unit: 'minutes', integer: false, toStored: MIN },
  { key: 'maxAiStreak', label: 'Messages between employees', unit: 'without a person', integer: true },
  { key: 'maxTokens', label: 'Token budget', unit: 'tokens', integer: true },
  { key: 'maxCostUsd', label: 'Cost budget', unit: 'USD', integer: false },
]

interface FieldState {
  text: string
  /** "No limit": stored as null, which lifts a default. */
  none: boolean
}

type Draft = Record<FieldKey, FieldState>

function draftOf(d: LimitData | null): Draft {
  const out = {} as Draft
  for (const f of FIELDS) {
    const v = d?.[f.key]
    out[f.key] = {
      text: v === undefined || v === null ? '' : String(f.toStored ? Math.round((v / f.toStored) * 100) / 100 : v),
      none: v === null,
    }
  }
  return out
}

/** Checks the draft and builds the record, or returns the problem. */
export function buildLimit(
  choice: TargetChoice,
  targetId: string | null,
  period: LimitPeriod,
  draft: Draft,
  enabled: boolean,
): { data: LimitData } | { error: string } {
  const type = choice === 'global' ? 'global' : choice.startsWith('employee') ? 'employee' : 'contact'
  if ((choice === 'employee' || choice === 'contact') && !targetId)
    return { error: `Pick ${choice === 'employee' ? 'an employee' : 'a person'}.` }
  const data: LimitData = { target: { type, ...(choice === 'employee' || choice === 'contact' ? { id: targetId! } : {}) } }
  for (const f of FIELDS) {
    const s = draft[f.key]
    if (s.none) {
      data[f.key] = null
      continue
    }
    const t = s.text.trim()
    if (!t) continue
    const n = Number(t)
    if (!Number.isFinite(n) || n < 0) return { error: `${f.label}: enter a number of 0 or more.` }
    if (f.integer && !Number.isInteger(n)) return { error: `${f.label}: enter a whole number.` }
    if (f.min !== undefined && n < f.min) return { error: `${f.label}: at least ${f.min}.` }
    data[f.key] = f.toStored ? Math.round(n * f.toStored) : n
  }
  const budget = data.maxTokens !== undefined || data.maxCostUsd !== undefined
  if (!budget && !LIMIT_CAP_FIELDS.some((f) => data[f] !== undefined)) return { error: 'Set at least one limit.' }
  if (budget) data.period = period
  if (!enabled) data.enabled = false
  return { data }
}

export function LimitEditor({
  open,
  onOpenChange,
  editing,
  defaults,
  names,
  onSaved,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** The override to edit, or null for a new one. */
  editing: ApiRecord<LimitData> | null
  defaults: LimitsOverview['defaults']
  names: Map<string, string>
  onSaved(): void
}) {
  const api = useApi()
  const d = editing?.data ?? null
  const [choice, setChoice] = useState<TargetChoice>(d ? choiceOf(d.target) : 'employee')
  const [target, setTarget] = useState<{ id: string; name: string } | null>(
    d?.target.id ? { id: d.target.id, name: names.get(d.target.id) ?? d.target.id } : null,
  )
  const [period, setPeriod] = useState<LimitPeriod>(d?.period ?? 'day')
  const [draft, setDraft] = useState<Draft>(() => draftOf(d))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: FieldKey, v: Partial<FieldState>) => setDraft((x) => ({ ...x, [k]: { ...x[k], ...v } }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const built = buildLimit(choice, target?.id ?? null, period, draft, d?.enabled !== false)
    if ('error' in built) {
      setError(built.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (editing) await api.updateLimit(editing.id, built.data)
      else await api.createLimit(built.data)
      toast(editing ? 'Limit saved' : 'Override added', { description: overrideSummary(built.data).join(' · ') })
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const placeholder = (k: FieldKey) => {
    if (k === 'maxTokens' || k === 'maxCostUsd') return 'none'
    const v = defaults[k]
    if (v === undefined) return 'no limit'
    return k === 'maxWallMs' ? `default ${Math.round(v / MIN)}` : `default ${v}`
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90svh] gap-4 overflow-y-auto sm:max-w-[560px]" data-testid="limit-editor">
        <DialogHeader>
          <DialogTitle className="text-title1">{editing ? 'Edit override' : 'New override'}</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            An override replaces the default for its target; a narrower target wins over a wider one. Leave a field empty to keep
            what applies now.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-3" noValidate>
          <div className="grid gap-1 sm:grid-cols-[150px_1fr] sm:items-center sm:gap-3">
            <label htmlFor="lim-target" className="text-fg-secondary">
              Applies to
            </label>
            <Select
              value={choice}
              onValueChange={(v) => {
                setChoice(v as TargetChoice)
                setTarget(null)
              }}
            >
              <SelectTrigger id="lim-target" size="sm" aria-label="Applies to" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TARGET_LABELS) as TargetChoice[]).map((c) => (
                  <SelectItem key={c} value={c}>
                    {TARGET_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(choice === 'employee' || choice === 'contact') && (
            <div className="grid gap-1 sm:grid-cols-[150px_1fr] sm:items-center sm:gap-3">
              <label htmlFor="lim-who" className="text-fg-secondary">
                {choice === 'employee' ? 'Employee' : 'Person'}
              </label>
              {target ? (
                <div className="flex h-8 items-center gap-2 rounded-md border px-2" data-testid="lim-who">
                  <span className="min-w-0 flex-1 truncate text-fg-secondary">{target.name}</span>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label="Clear" onClick={() => setTarget(null)}>
                    <X />
                  </Button>
                </div>
              ) : (
                <RecordPicker
                  id="lim-who"
                  kinds={[choice === 'employee' ? 'employee' : 'contact']}
                  placeholder={choice === 'employee' ? 'Search employees…' : 'Search people…'}
                  {...(choice === 'contact' ? { filter: (r: ApiRecord) => (r.data as { kind?: string }).kind === 'person' } : {})}
                  onPick={(o) => setTarget({ id: o.id, name: o.label })}
                />
              )}
            </div>
          )}
          <div className="flex flex-col rounded-lg border">
            {FIELDS.map((f) => {
              const s = draft[f.key]
              const id = `lim-${f.key}`
              return (
                <div
                  key={f.key}
                  className="grid items-center gap-2 border-b px-3 py-1.5 last:border-0 sm:grid-cols-[150px_1fr_auto]"
                >
                  <label htmlFor={id} className="text-fg-secondary">
                    {f.label}
                  </label>
                  <span className="flex items-center gap-2">
                    <Input
                      id={id}
                      inputMode="decimal"
                      className="h-7 w-32 text-mini tabular-nums"
                      value={s.none ? '' : s.text}
                      disabled={s.none}
                      placeholder={placeholder(f.key)}
                      onChange={(e) => set(f.key, { text: e.target.value })}
                    />
                    <span className="text-micro text-fg-quaternary">{f.unit}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-micro text-fg-tertiary">
                    <Checkbox
                      id={`${id}-none`}
                      checked={s.none}
                      aria-label={`No limit: ${f.label}`}
                      onCheckedChange={(v) => set(f.key, { none: v === true })}
                    />
                    <label htmlFor={`${id}-none`}>No limit</label>
                  </span>
                </div>
              )
            })}
          </div>
          <div className="grid gap-1 sm:grid-cols-[150px_1fr] sm:items-center sm:gap-3">
            <label htmlFor="lim-period" className="text-fg-secondary">
              Budgets count
            </label>
            <Select value={period} onValueChange={(v) => setPeriod(v as LimitPeriod)}>
              <SelectTrigger id="lim-period" size="sm" aria-label="Budgets count" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Per day (UTC)</SelectItem>
                <SelectItem value="month">Per month (UTC)</SelectItem>
                <SelectItem value="run">Per run</SelectItem>
                <SelectItem value="session">Per session</SelectItem>
                <SelectItem value="tree">Per session tree</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-micro text-fg-quaternary">
            A day or month budget counts the target&apos;s usage: each employee&apos;s, each requester&apos;s, or the whole
            deployment&apos;s. A cost budget only counts models that have a price.
          </p>
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
              {busy ? 'Saving…' : editing ? 'Save' : 'Add override'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── The page section ───────────────────────────────────────────────────────

function Source({ source, onEdit }: { source: string | undefined; onEdit?: () => void }) {
  if (!source || source === 'default')
    return (
      <Badge variant="outline" className="text-fg-quaternary">
        default
      </Badge>
    )
  return (
    <Badge asChild variant="secondary">
      <button type="button" onClick={onEdit} title="Edit this override">
        override
      </button>
    </Badge>
  )
}

function BudgetRow({ b, warnAt, onEdit }: { b: LimitBudgetView; warnAt?: number; onEdit(id: string): void }) {
  return (
    <>
      {(['maxTokens', 'maxCostUsd'] as const).map((f) => {
        const max = b[f]
        if (max === undefined) return null
        const label = budgetLabel(b, f, max)
        const used = b.used ? (f === 'maxTokens' ? b.used.tokens : b.used.costUsd) : undefined
        return (
          <div key={f} className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 last:border-0">
            <span className="min-w-[14rem] flex-1 text-fg-secondary">{label}</span>
            <span className="ml-auto flex items-center gap-3">
              {used !== undefined && (
                <span className="flex items-center gap-2 text-micro text-fg-tertiary tabular-nums">
                  <BudgetBar used={used} max={max} warnAt={warnAt} label={`${label}: used`} />
                  {f === 'maxTokens' ? formatTokens(used) : formatCost(used)} used
                  {b.period === 'day' ? ' today' : b.period === 'month' ? ' this month' : ''}
                </span>
              )}
              <Source source={b.sources[f]} onEdit={() => b.sources[f] && onEdit(b.sources[f]!)} />
            </span>
          </div>
        )
      })}
    </>
  )
}

function ScopeCard({
  scope,
  full,
  warnAt,
  onEdit,
}: {
  scope: LimitScopeView
  /** Show every cap; otherwise only the overridden ones. */
  full: boolean
  warnAt?: number
  onEdit(id: string): void
}) {
  const caps = LIMIT_CAP_FIELDS.filter((f) => (full ? f in scope.sources : scope.sources[f] && scope.sources[f] !== 'default'))
  const kind =
    scope.target.type === 'global'
      ? 'Defaults and overrides for everyone'
      : scope.target.type === 'employee'
        ? 'Employee'
        : 'Requester'
  return (
    <section className="rounded-xl border bg-card" data-testid={`limits-scope-${scope.target.id ?? 'all'}`}>
      <div className="flex items-baseline gap-2 border-b px-3 py-2">
        <span className="font-medium">{scope.name}</span>
        <span className="text-micro text-fg-quaternary">{kind}</span>
      </div>
      {caps.map((f) => (
        <div key={f} className="flex min-h-9 items-center gap-3 border-b px-3 py-1.5 last:border-0">
          <span className="min-w-0 flex-1 text-fg-secondary">{capLabel(f, scope.caps[f])}</span>
          <Source source={scope.sources[f]} onEdit={() => onEdit(scope.sources[f]!)} />
        </div>
      ))}
      {scope.budgets.map((b) => (
        <BudgetRow key={b.key} b={b} warnAt={warnAt} onEdit={onEdit} />
      ))}
      {!full && !caps.length && !scope.budgets.length && (
        <div className="px-3 py-2 text-micro text-fg-quaternary">As for every employee.</div>
      )}
    </section>
  )
}

/** Settings → Limits: the effective limits per scope, with the overrides to create, edit and delete. Admins only. */
export function LimitsSettings() {
  const api = useApi()
  const data = useLoad((a) => a.limits(), [])
  const [editor, setEditor] = useState<{ editing: ApiRecord<LimitData> | null } | null>(null)
  if (data.error && !data.data) return <ErrorState error={data.error} retry={data.reload} />
  if (!data.data) return <LoadingRows />
  const o = data.data
  const names = new Map(o.scopes.filter((s) => s.target.id).map((s) => [s.target.id!, s.name]))
  const edit = (id: string) => {
    const rec = o.overrides.find((l) => l.id === id)
    if (rec) setEditor({ editing: rec })
  }
  const remove = async (l: ApiRecord<LimitData>) => {
    await api.deleteLimit(l.id)
    toast('Override removed', { description: 'The default applies again.' })
    data.reload()
  }
  const [every, ...rest] = o.scopes
  return (
    <div className="flex max-w-[860px] flex-col gap-6" data-testid="limits-settings">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-fg-tertiary">
          Runaway protection. The defaults apply to everyone; an override replaces a default for its target. Work over a limit
          pauses with the reason and waits for someone to resume it. Nothing is silently dropped.
        </p>
        <Button size="sm" onClick={() => setEditor({ editing: null })}>
          <Plus /> Add override
        </Button>
      </div>
      {o.unpricedModels.length > 0 && (
        <p
          className="rounded-lg border border-[var(--orange)]/40 px-3 py-2 text-micro text-fg-secondary"
          data-testid="unpriced-note"
        >
          No pricing for{' '}
          {o.unpricedModels.map((m, i) => (
            <span key={m}>
              {i > 0 && ', '}
              <code className="font-mono">{m}</code>
            </span>
          ))}
          : their calls count as $0 in cost budgets.{' '}
          <NavLink to="/settings/pricing" className="text-[#828fff] hover:underline">
            Set prices
          </NavLink>
        </p>
      )}
      {every && <ScopeCard scope={every} full warnAt={o.defaults.warnAt} onEdit={edit} />}
      {rest.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionTitle>Per employee and requester</SectionTitle>
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {rest.map((s) => (
              <ScopeCard
                key={`${s.target.type}:${s.target.id}`}
                scope={s}
                full={false}
                warnAt={o.defaults.warnAt}
                onEdit={edit}
              />
            ))}
          </div>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <SectionTitle>Overrides</SectionTitle>
        {o.overrides.length === 0 ? (
          <p className="text-fg-tertiary">No overrides: the defaults apply everywhere.</p>
        ) : (
          <div className="rounded-xl border" data-testid="limit-overrides">
            {o.overrides.map((l) => (
              <div key={l.id} className="flex min-h-11 items-center gap-3 border-b px-3 py-1.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="text-fg-secondary">{targetText(l.data.target, names)}</div>
                  <div className="text-micro text-fg-tertiary">{overrideSummary(l.data).join(' · ')}</div>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit ${targetText(l.data.target, names)}`}
                  onClick={() => setEditor({ editing: l })}
                >
                  <Pencil />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete ${targetText(l.data.target, names)}`}
                  onClick={() => remove(l)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-micro text-fg-quaternary">
          Budgets are checked in this order: run, session, session tree, then each day or month budget from the requester to the
          employee and the whole deployment. #alerts gets a warning at {Math.round((o.defaults.warnAt ?? 0.8) * 100)}% of a daily
          or monthly budget and a note when it&apos;s used up.
        </p>
      </section>
      {editor && (
        <LimitEditor
          key={editor.editing?.id ?? 'new'}
          open
          onOpenChange={(v) => !v && setEditor(null)}
          editing={editor.editing}
          defaults={o.defaults}
          names={names}
          onSaved={data.reload}
        />
      )}
    </div>
  )
}
