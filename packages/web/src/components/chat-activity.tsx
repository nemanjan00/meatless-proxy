import type { ChatActivityItem, Message } from '@mp/api'
import { CircleAlert, CircleX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { EmployeeAvatar } from '@/components/people.tsx'
import { useApi, useLive } from '@/lib/api.tsx'
import {
  type ActivityNotice,
  type ActivityState,
  addPending,
  applyDone,
  applyItem,
  emptyActivity,
  loadItems,
  nextExpiry,
  pruneActivity,
  slugOf,
  stateText,
  type ThreadActivity,
  threadActivity,
} from '@/lib/chat-activity.ts'
import { cn } from '@/lib/utils.ts'

/** Whether the person asked for less motion (spinners become a static dot). */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const mql = window.matchMedia?.(query)
    if (!mql) return
    const on = () => setReduced(mql.matches)
    mql.addEventListener?.('change', on)
    return () => mql.removeEventListener?.('change', on)
  }, [])
  return reduced
}

/** A small spinner in the current colour; with reduced motion, a static dot. */
export function Spinner({ className }: { className?: string }) {
  const reduced = useReducedMotion()
  return reduced ? (
    <span
      className={cn('inline-block size-1.5 shrink-0 rounded-full bg-current', className)}
      data-testid="activity-dot"
      aria-hidden
    />
  ) : (
    <span
      className={cn('mp-spinner inline-block size-3 shrink-0 rounded-full border-[1.5px] border-current', className)}
      data-testid="activity-spinner"
      aria-hidden
    />
  )
}

export interface ChatActivityView {
  /** What a thread shows (keyed by its root message id). */
  thread(threadId: string): ThreadActivity
  /** You sent `m` and expect someone to pick it up: shows "delivering…" until they do. */
  sent(m: Message): void
}

/**
 * Who is working on a channel's threads: loads `GET /api/chat/channels/:id/activity`, then follows
 * `chat.activity` and `chat.activity.done` on the channel's live topic. Notices expire on their own.
 */
export function useChatActivity(channelId: string | undefined): ChatActivityView {
  const api = useApi()
  const [state, setState] = useState<ActivityState>(emptyActivity)
  useEffect(() => {
    setState(emptyActivity())
    if (!channelId) return
    let stale = false
    api.channelActivity(channelId).then(
      (items) => {
        if (!stale) setState((s) => loadItems(s, items))
      },
      () => {},
    )
    return () => {
      stale = true
    }
  }, [api, channelId])
  useLive(
    channelId ? [`chat:${channelId}`] : [],
    (e) => {
      if (e.topic === 'chat.activity') setState((s) => applyItem(s, e.payload.item))
      else if (e.topic === 'chat.activity.done') setState((s) => applyDone(s, e.payload, Date.now()))
    },
    ['chat.activity', 'chat.activity.done'],
  )
  // Notices and "delivering…" rows go away on their own.
  const expiry = nextExpiry(state)
  useEffect(() => {
    if (expiry === undefined) return
    const t = setTimeout(() => setState((s) => pruneActivity(s, Date.now())), Math.max(0, expiry - Date.now()) + 20)
    return () => clearTimeout(t)
  }, [expiry])
  const sent = useCallback((m: Message) => setState((s) => addPending(s, m, Date.now())), [])
  return useMemo(() => ({ thread: (id: string) => threadActivity(state, id), sent }), [state, sent])
}

const row = 'flex h-5 min-w-0 items-center gap-1.5 text-micro text-fg-tertiary'

function WorkerRow({ item }: { item: ChatActivityItem }) {
  const paused = item.state === 'paused'
  const waiting = item.state === 'waiting'
  const slug = slugOf(item)
  return (
    <Link
      to={`/sessions/${item.sessionId}`}
      className={cn(row, 'w-fit max-w-full rounded-sm hover:text-foreground', paused && 'text-[var(--status-paused)]')}
      title={`${item.sessionLabel}: open the session`}
      data-testid="activity-row"
      data-state={item.state}
    >
      {paused ? (
        <CircleAlert className="size-3 shrink-0" />
      ) : waiting ? (
        <span className="inline-block size-1.5 shrink-0 rounded-full bg-[var(--status-waiting)]" aria-hidden />
      ) : (
        <Spinner className={item.state === 'queued' ? 'text-fg-quaternary' : undefined} />
      )}
      <EmployeeAvatar name={item.employee.name} className="size-4" />
      <span className="shrink-0 font-medium text-fg-secondary">{item.employee.name}</span>
      {slug && <span className="min-w-0 truncate font-mono text-fg-quaternary">{slug}</span>}
      <span className="shrink-0">{stateText(item)}</span>
      {item.step && !paused && <span className="min-w-0 truncate text-fg-quaternary">· {item.step}</span>}
    </Link>
  )
}

function NoticeRow({ n }: { n: ActivityNotice }) {
  const error = n.outcome === 'failed'
  const body = (
    <>
      {error ? (
        <CircleX className="size-3 shrink-0 text-[var(--status-failed)]" />
      ) : (
        n.employee && <EmployeeAvatar name={n.employee.name} className="size-4 opacity-70" />
      )}
      <span className={cn('min-w-0 truncate', error ? 'text-fg-secondary' : 'text-fg-quaternary')}>{n.text}</span>
      {n.hint && <span className="min-w-0 truncate text-fg-quaternary">· {n.hint}</span>}
    </>
  )
  return n.href ? (
    <Link
      to={n.href}
      className={cn(row, 'w-fit max-w-full rounded-sm hover:text-foreground')}
      data-testid="activity-notice"
      data-outcome={n.outcome}
    >
      {body}
    </Link>
  ) : (
    <div className={row} data-testid="activity-notice" data-outcome={n.outcome}>
      {body}
    </div>
  )
}

/**
 * The live rows under a message: who is working on its thread (a spinner, the employee and what
 * it's doing; paused in the warning colour), notices when a worker ends, and "delivering…" while a
 * message you sent waits for routing. Three or more workers collapse into "3 working".
 */
export function ActivityRows({ view, className }: { view: ThreadActivity; className?: string }) {
  const [open, setOpen] = useState(false)
  const { items, notices, pending } = view
  if (!items.length && !notices.length && !pending.length) return null
  const collapsed = items.length >= 3 && !open
  // "Handed to …" reads before the session that took over; the other notices come last.
  const handed = notices.filter((n) => n.outcome === 'handed_off')
  const rest = notices.filter((n) => n.outcome !== 'handed_off')
  return (
    <div className={cn('mt-1 flex flex-col gap-0.5', className)} data-testid="chat-activity" aria-live="polite">
      {handed.map((n) => (
        <NoticeRow key={n.key} n={n} />
      ))}
      {collapsed ? (
        <button
          type="button"
          className={cn(row, 'w-fit hover:text-foreground')}
          onClick={() => setOpen(true)}
          aria-expanded={false}
          data-testid="activity-collapsed"
        >
          <Spinner />
          <span className="flex -space-x-1">
            {items.slice(0, 3).map((i) => (
              <EmployeeAvatar key={i.runId} name={i.employee.name} className="size-4 ring-1 ring-background" />
            ))}
          </span>
          {items.length} working
        </button>
      ) : (
        items.map((i) => <WorkerRow key={i.runId} item={i} />)
      )}
      {!items.length && pending.length > 0 && (
        // One row for the thread, however many messages wait.
        <div className={row} data-testid="activity-delivering">
          <Spinner className="text-fg-quaternary" />
          <span>Delivering…</span>
        </div>
      )}
      {rest.map((n) => (
        <NoticeRow key={n.key} n={n} />
      ))}
    </div>
  )
}
