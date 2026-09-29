import { INTEGRATION_EVENTS, type Json, type ProcedureStart, type ProcedureStartKind, describeStart } from '@mp/api'
import { CalendarClock, ChevronRight, Hand, Hash, AtSign, Plug } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Input } from '@/components/ui/input.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useLoad } from '@/lib/api.tsx'
import { SCHEDULE_PRESETS, START_KINDS, emptyStart } from '@/lib/procedures.ts'
import { cn } from '@/lib/utils.ts'

/** The icon of a way to start. */
export function StartIcon({ kind, className }: { kind: ProcedureStartKind; className?: string }) {
  const c = cn('size-3.5 shrink-0', className)
  switch (kind) {
    case 'manual':
      return <Hand className={c} />
    case 'channel':
      return <Hash className={c} />
    case 'tag':
      return <AtSign className={c} />
    case 'schedule':
      return <CalendarClock className={c} />
    default:
      return <Plug className={c} />
  }
}

export const selectClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-small outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30'

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
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

/** Why a start can't be saved yet, in words; null when it can. */
export function startProblem(start: ProcedureStart | null): string | null {
  if (!start) return null
  switch (start.kind) {
    case 'channel':
      return start.channelId ? null : 'Pick a channel.'
    case 'tag':
      return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(start.tag)
        ? null
        : 'A tag is letters, digits and dashes, e.g. access-request.'
    case 'schedule':
      return start.cron.trim().split(/\s+/).length === 5 ? null : 'A schedule needs five cron fields, e.g. 0 9 * * 1.'
    case 'integration':
      return start.source && start.type ? null : 'Pick an event.'
    case 'custom':
      return null
  }
}

/**
 * Builds "how a procedure starts" (a trigger) from choices instead of JSON: manually, a chat
 * channel, an @tag, a schedule or an integration event, with the raw filter under Advanced.
 * `value: null` is manual. The sentence under the form says what was built, in plain words.
 */
export function StartForm({
  value,
  onChange,
  name = '',
  allowManual = true,
  idPrefix = 'start',
}: {
  value: ProcedureStart | null
  onChange(next: ProcedureStart | null, problem: string | null): void
  /** The procedure's name, for a suggested @tag. */
  name?: string
  allowManual?: boolean
  idPrefix?: string
}) {
  const kind: ProcedureStartKind = value?.kind ?? 'manual'
  const channels = useLoad((a) => a.channels(), [])
  const [advanced, setAdvanced] = useState(value?.filter !== undefined)
  const [filterText, setFilterText] = useState(value?.filter !== undefined ? JSON.stringify(value.filter, null, 2) : '')
  const [filterError, setFilterError] = useState<string | null>(null)
  const [customCron, setCustomCron] = useState(value?.kind === 'schedule' && !SCHEDULE_PRESETS.some((p) => p.cron === value.cron))
  const channelItems = (channels.data ?? []).filter((c) => !c.channel.data.dm && !c.channel.data.archived)
  const channelName = (id: string) => channelItems.find((c) => c.channel.id === id)?.channel.data.name

  const emit = (next: ProcedureStart | null, fErr = filterError) => onChange(next, fErr ?? startProblem(next))
  const set = (patch: Partial<ProcedureStart>) => value && emit({ ...value, ...patch } as ProcedureStart)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the channels arrive
  useEffect(() => {
    // The first channel is a good default once channels load.
    if (value?.kind === 'channel' && !value.channelId && channelItems[0]) set({ channelId: channelItems[0].channel.id })
  }, [channels.data])

  const pickKind = (k: ProcedureStartKind) => {
    const next = emptyStart(k, name)
    if (next?.kind === 'channel' && channelItems[0]) next.channelId = channelItems[0].channel.id
    setCustomCron(false)
    emit(next && value?.filter !== undefined ? { ...next, filter: value.filter } : next)
  }
  const onFilter = (text: string) => {
    setFilterText(text)
    if (!value) return
    if (!text.trim()) {
      setFilterError(null)
      const { filter: _f, ...rest } = value
      return emit(rest as ProcedureStart, null)
    }
    try {
      const parsed = JSON.parse(text) as Json
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      setFilterError(null)
      emit({ ...value, filter: parsed }, null)
    } catch {
      const err = 'The filter must be a JSON object, e.g. {"payload.labels": {"$in": ["refund"]}}.'
      setFilterError(err)
      onChange(value, err)
    }
  }

  const spec = value?.kind === 'integration' ? INTEGRATION_EVENTS.find((s) => s.source === value.source) : undefined
  const kinds = START_KINDS.filter((k) => allowManual || k.kind !== 'manual')
  const current = kinds.find((k) => k.kind === (kind === 'custom' ? 'integration' : kind))

  return (
    <div className="flex flex-col gap-3" data-testid="start-form">
      <fieldset aria-label="How it starts" className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
        {kinds.map((k) => {
          const on = k.kind === kind || (k.kind === 'integration' && kind === 'custom')
          return (
            <button
              key={k.kind}
              type="button"
              aria-pressed={on}
              onClick={() => pickKind(k.kind)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-mini transition-colors duration-100',
                on
                  ? 'border-transparent bg-accent-tint text-foreground ring-1 ring-[var(--ring)]'
                  : 'text-fg-tertiary hover:bg-secondary',
              )}
            >
              <StartIcon kind={k.kind} />
              {k.label}
            </button>
          )
        })}
      </fieldset>
      {current && <p className="-mt-1 text-micro text-fg-quaternary">{current.hint}</p>}

      {value?.kind === 'channel' && (
        <Field id={`${idPrefix}-channel`} label="Channel">
          <select
            id={`${idPrefix}-channel`}
            value={value.channelId}
            onChange={(e) => set({ channelId: e.target.value })}
            className={selectClass}
          >
            {!channelItems.length && <option value="">{channels.data ? 'No channels yet' : 'Loading…'}</option>}
            {channelItems.map((c) => (
              <option key={c.channel.id} value={c.channel.id}>
                #{c.channel.data.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {value?.kind === 'tag' && (
        <Field id={`${idPrefix}-tag`} label="Tag" hint="Not an employee's or a person's name">
          <div className="flex items-center rounded-md border border-input focus-within:ring-2 focus-within:ring-ring/50 dark:bg-input/30">
            <span className="pl-2.5 font-mono text-micro text-fg-quaternary">@</span>
            <input
              id={`${idPrefix}-tag`}
              value={value.tag}
              onChange={(e) => set({ tag: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '-') })}
              placeholder="access-request"
              className="h-8 min-w-0 flex-1 bg-transparent pr-2.5 pl-0.5 font-mono text-micro outline-none"
            />
          </div>
        </Field>
      )}

      {value?.kind === 'schedule' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${idPrefix}-when`} label="When">
            <select
              id={`${idPrefix}-when`}
              value={customCron ? 'custom' : value.cron}
              onChange={(e) => {
                if (e.target.value === 'custom') return setCustomCron(true)
                setCustomCron(false)
                set({ cron: e.target.value })
              }}
              className={selectClass}
            >
              {SCHEDULE_PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom (cron)…</option>
            </select>
          </Field>
          <Field id={`${idPrefix}-tz`} label="Time zone" hint="Default: the company's">
            <Input
              id={`${idPrefix}-tz`}
              value={value.timezone ?? ''}
              onChange={(e) => set({ timezone: e.target.value.trim() || undefined })}
              placeholder="Europe/Belgrade"
              className="h-8"
            />
          </Field>
          {customCron && (
            <Field id={`${idPrefix}-cron`} label="Cron" hint="minute hour day month weekday">
              <Input
                id={`${idPrefix}-cron`}
                value={value.cron}
                onChange={(e) => set({ cron: e.target.value })}
                className="h-8 font-mono text-micro"
              />
            </Field>
          )}
        </div>
      )}

      {(value?.kind === 'integration' || value?.kind === 'custom') && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${idPrefix}-system`} label="From">
            <select
              id={`${idPrefix}-system`}
              value={value.kind === 'custom' ? 'custom' : value.source}
              onChange={(e) => {
                if (e.target.value === 'custom')
                  return emit({ kind: 'custom', ...(value.filter ? { filter: value.filter } : {}) })
                const s = INTEGRATION_EVENTS.find((x) => x.source === e.target.value)!
                emit({
                  kind: 'integration',
                  source: s.source,
                  type: s.types[0]!.type,
                  ...(value.filter ? { filter: value.filter } : {}),
                })
              }}
              className={selectClass}
            >
              {INTEGRATION_EVENTS.map((s) => (
                <option key={s.source} value={s.source}>
                  {s.system}
                </option>
              ))}
              <option value="custom">Another source…</option>
            </select>
          </Field>
          {value.kind === 'integration' && spec ? (
            <>
              <Field id={`${idPrefix}-event`} label="When">
                <select
                  id={`${idPrefix}-event`}
                  value={value.type}
                  onChange={(e) => set({ type: e.target.value })}
                  className={selectClass}
                >
                  {spec.types.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              {spec.fields.map((f) => (
                <Field key={f.path} id={`${idPrefix}-${f.path}`} label={f.label} hint="Optional">
                  <Input
                    id={`${idPrefix}-${f.path}`}
                    value={String(value.where?.[f.path] ?? '')}
                    onChange={(e) => {
                      const where = { ...(value.where ?? {}) }
                      if (e.target.value.trim()) where[f.path] = e.target.value.trim()
                      else delete where[f.path]
                      set({ where: Object.keys(where).length ? where : undefined })
                    }}
                    placeholder={f.placeholder}
                    className="h-8"
                  />
                </Field>
              ))}
            </>
          ) : value.kind === 'custom' ? (
            <>
              <Field id={`${idPrefix}-source`} label="Source" hint="e.g. mcp:zendesk">
                <Input
                  id={`${idPrefix}-source`}
                  value={value.source ?? ''}
                  onChange={(e) => set({ source: e.target.value.trim() || undefined })}
                  className="h-8 font-mono text-micro"
                />
              </Field>
              <Field id={`${idPrefix}-type`} label="Event type" hint="e.g. ticket.created">
                <Input
                  id={`${idPrefix}-type`}
                  value={value.type ?? ''}
                  onChange={(e) => set({ type: e.target.value.trim() || undefined })}
                  className="h-8 font-mono text-micro"
                />
              </Field>
            </>
          ) : null}
        </div>
      )}

      {value && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setAdvanced((a) => !a)}
            aria-expanded={advanced}
            className="flex items-center gap-1 self-start text-micro text-fg-tertiary hover:text-foreground"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', advanced && 'rotate-90')} />
            Advanced: filter
          </button>
          {advanced && (
            <Field id={`${idPrefix}-filter`} label="Filter" hint="A MongoDB-style query over the event, JSON">
              <Textarea
                id={`${idPrefix}-filter`}
                value={filterText}
                onChange={(e) => onFilter(e.target.value)}
                rows={3}
                placeholder={'{"payload.labels": {"$in": ["refund"]}}'}
                className="font-mono text-micro"
              />
              {filterError && <p className="text-micro text-[var(--red)]">{filterError}</p>}
            </Field>
          )}
        </div>
      )}

      <p
        className="flex items-center gap-1.5 rounded-md bg-level-2 px-2.5 py-1.5 text-mini text-fg-secondary"
        data-testid="start-summary"
      >
        <StartIcon kind={kind} className="text-fg-tertiary" />
        {describeStart(value ?? { kind: 'manual' }, channelName)}
      </p>
    </div>
  )
}
