import type { ApiEntry, AssistantContent, EventEntryContent, Run } from '@mp/api'
import { TERMINAL_RUN_STATES } from '@mp/api'
import { ChevronRight, Link2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Timeline } from '@/components/history.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.tsx'
import { useLoad } from '@/lib/api.tsx'
import { clockOrDate, formatTokens } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

/** How many recent ephemeral runs the History tab shows. */
export const RECENT_RUNS = 10

/** A run's own entries (after its base) and the facts its one-line summary needs. */
export interface RunSummary {
  run: Run
  entries: ApiEntry[]
  /** e.g. `trigger “#requests: new requests”` or `fallback`. */
  trigger: string | null
  /** The event it handled: `chat · message.posted` and the start of its text. */
  event: { label: string; text: string } | null
  output: string | null
  tokens: number
}

/**
 * Summarises a run from its history (as returned by `runHistory`: the
 * session's history up to the run's base, then the run's own entries).
 * `triggerName` names a trigger id.
 */
export function summarizeRun(
  run: Run,
  history: ApiEntry[],
  triggerName?: (id: string) => string | undefined,
  usedTokens?: number,
): RunSummary {
  const baseIdx = run.data.base ? history.findIndex((e) => e.id === run.data.base) : -1
  const entries = history.slice(baseIdx + 1)
  const ev = entries.find((e) => e.kind === 'event')
  const c = ev?.content as unknown as EventEntryContent | undefined
  const reason = typeof ev?.meta.reason === 'string' ? ev.meta.reason : null
  const triggerId = typeof ev?.meta.triggerId === 'string' ? ev.meta.triggerId : null
  const trigger = triggerId
    ? `trigger “${triggerName?.(triggerId) ?? triggerId}”`
    : reason
      ? reason.replace(/_/g, ' ')
      : run.data.cause.type
  // The event text starts with `[source type subject]` and, for chat, `#channel: `.
  const text =
    c?.text
      .replace(/^\[[^\]]*\]\s*/, '')
      .replace(/^#[\w-]+:\s*/, '')
      .trim() ?? ''
  const lastText = [...entries]
    .reverse()
    .map((e) => (e.kind === 'assistant' ? (e.content as unknown as AssistantContent).text : null))
    .find((t): t is string => !!t)
  // Recorded usage when known, else what the entries carry.
  const tokens =
    usedTokens ??
    entries.reduce((n, e) => {
      const u = e.meta.usage as { input?: number; output?: number } | undefined
      return n + (u?.input ?? 0) + (u?.output ?? 0)
    }, 0)
  return {
    run,
    entries,
    trigger,
    event: c ? { label: `${c.source} · ${c.type}`, text } : null,
    output: run.data.result?.output ?? run.data.result?.error ?? lastText ?? null,
    tokens,
  }
}

/** Runs whose work isn't part of the committed history: finished ephemeral runs, newest first. */
export function uncommittedRuns(runs: Run[]): Run[] {
  return runs
    .filter((r) => r.data.mode === 'ephemeral' && TERMINAL_RUN_STATES.includes(r.data.state) && !r.data.commit)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, RECENT_RUNS)
}

function RunItem({ s }: { s: RunSummary }) {
  const [open, setOpen] = useState(false)
  const r = s.run
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-level-1" data-testid="ephemeral-run">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-label={`Show run ${r.id}`}>
          <ChevronRight className={cn('size-3.5 shrink-0 text-fg-quaternary transition-quick', open && 'rotate-90')} />
          <StatusIcon status={r.data.state} tooltip={false} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-mini text-fg-secondary">
            {s.event?.text || s.event?.label || r.data.cause.type}
          </span>
        </CollapsibleTrigger>
        <span className="shrink-0 text-micro tabular-nums text-fg-tertiary">{formatTokens(s.tokens)} tok</span>
        <span className="w-12 shrink-0 text-right text-micro text-fg-quaternary">{clockOrDate(r.createdAt)}</span>
        <Link to={`/lineage/${r.id}`} className="shrink-0 text-fg-quaternary hover:text-foreground" aria-label="Run lineage">
          <Link2 className="size-3.5" />
        </Link>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pb-2 pl-[50px] text-micro text-fg-tertiary">
        <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-quaternary">not committed (ephemeral run)</span>
        {s.trigger && <span className="shrink-0">{s.trigger}</span>}
        {s.event && <span className="shrink-0 font-mono text-fg-quaternary">{s.event.label}</span>}
        {s.output && (
          <span className="min-w-0 basis-full truncate text-fg-quaternary">→ {s.output.replace(/\s+/g, ' ').slice(0, 200)}</span>
        )}
      </div>
      <CollapsibleContent className="border-t px-3 pt-1 pb-2">
        <Timeline entries={s.entries} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Recent ephemeral runs of a session, after its committed history: they were
 * discarded, so they aren't in it, but they are what the session did. Each run
 * is collapsed to a summary (trigger, event, output, tokens) and expands to
 * its own entries.
 */
export function RecentRuns({ runs }: { runs: Run[] }) {
  const list = uncommittedRuns(runs)
  const key = list.map((r) => `${r.id}:${r.version}`).join(',')
  const data = useLoad(
    async (api) => {
      const [histories, totals] = await Promise.all([
        Promise.all(list.map((r) => api.runHistory(r.id))),
        Promise.all(list.map((r) => api.usageTotals({ runId: r.id }).catch(() => null))),
      ])
      const ids = new Set<string>()
      for (const h of histories)
        for (const e of h) if (e.kind === 'event' && typeof e.meta.triggerId === 'string') ids.add(e.meta.triggerId)
      const names = new Map<string, string>()
      await Promise.all(
        [...ids].map((id) =>
          api.getRecord<{ name: string }>('trigger', id).then(
            (t) => names.set(id, t.data.name),
            () => undefined,
          ),
        ),
      )
      return list.map((r, i) => summarizeRun(r, histories[i]!, (id) => names.get(id), totals[i]?.total))
    },
    [key],
  )
  if (!list.length) return null
  return (
    <section className="mt-6" data-testid="recent-runs">
      <div className="mb-2 flex items-center gap-2 text-micro text-fg-tertiary">
        <span className="font-medium">Recent runs</span>
        <span className="text-fg-quaternary">discarded afterwards, so not in the history above</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-1.5">
        {(data.data ?? []).map((s) => (
          <RunItem key={s.run.id} s={s} />
        ))}
        {!data.data && <p className="text-micro text-fg-quaternary">Loading runs…</p>}
      </div>
    </section>
  )
}
