import type { Channel, ChatActivityDone, ChatActivityItem, Message } from '@mp/api'

/**
 * Pure state for "who is working on this thread" under chat messages: the live items from the
 * server (`chat.activity`), the notices an ending leaves for a while (`chat.activity.done`), and
 * the "delivering…" rows of messages you just sent, until the first activity or outcome arrives.
 */

/** How long a notice or a "delivering…" row stays, in ms. */
export const NOTICE_MS = { handed_off: 4000, no_reply: 10_000 } as const
/** A "delivering…" row goes away quietly if nothing is heard in this time. */
export const DELIVERING_MS = 30_000

export interface ActivityNotice {
  key: string
  threadId: string
  messageId?: string
  outcome: 'handed_off' | 'no_reply' | 'failed' | 'unrouted'
  text: string
  hint?: string
  /** Where a click goes (the session or run). */
  href?: string
  employee?: ChatActivityItem['employee']
  /** Epoch ms when it goes away; unset: it stays. */
  until?: number
}

export interface PendingSend {
  messageId: string
  threadId: string
  at: number
}

export interface ActivityState {
  items: Record<string, ChatActivityItem>
  notices: ActivityNotice[]
  pending: PendingSend[]
}

export const emptyActivity = (): ActivityState => ({ items: {}, notices: [], pending: [] })

/** What one thread shows: its workers (oldest first), notices and "delivering…" rows. */
export interface ThreadActivity {
  items: ChatActivityItem[]
  notices: ActivityNotice[]
  pending: PendingSend[]
}

/** Whether a "delivering…" row is still unanswered after news about a thread: any news about its thread answers it. */
const unanswered = (p: PendingSend, threadId: string, messageId?: string) => p.messageId !== messageId && p.threadId !== threadId

/** Replaces the items with the server's list (on load), keeping notices and pending sends it hasn't answered. */
export function loadItems(state: ActivityState, items: ChatActivityItem[]): ActivityState {
  let next: ActivityState = { ...state, items: {} }
  for (const i of items) next = applyItem(next, i)
  return next
}

/** A worker started, or changed state or step. It answers any "delivering…" row of its thread. */
export function applyItem(state: ActivityState, item: ChatActivityItem): ActivityState {
  return {
    items: { ...state.items, [item.runId]: item },
    notices: state.notices.filter((n) => n.outcome !== 'unrouted' || n.threadId !== item.threadId),
    pending: state.pending.filter((p) => unanswered(p, item.threadId, item.messageId)),
  }
}

/** A worker ended (or a message went unrouted): drop its item and leave the notice its outcome calls for. */
export function applyDone(state: ActivityState, d: ChatActivityDone, now: number): ActivityState {
  const items = { ...state.items }
  if (d.runId) delete items[d.runId]
  const pending = state.pending.filter((p) => unanswered(p, d.threadId, d.messageId))
  const name = d.employee?.name ?? 'It'
  const base = {
    key: `${d.outcome}:${d.runId ?? d.messageId ?? d.threadId}`,
    threadId: d.threadId,
    ...(d.messageId ? { messageId: d.messageId } : {}),
    ...(d.employee ? { employee: d.employee } : {}),
  }
  let notice: ActivityNotice | null = null
  if (d.outcome === 'handed_off' && d.handedTo)
    notice = {
      ...base,
      outcome: 'handed_off',
      text: `Handed to ${d.handedTo.sessionLabel}`,
      href: `/sessions/${d.handedTo.sessionId}`,
      until: now + NOTICE_MS.handed_off,
    }
  // A subscribed session's run that another cause woke says nothing when it had nothing to say.
  else if (d.outcome === 'no_reply' && d.messageId)
    notice = { ...base, outcome: 'no_reply', text: `${name} looked, no reply needed`, until: now + NOTICE_MS.no_reply }
  else if (d.outcome === 'failed')
    notice = {
      ...base,
      outcome: 'failed',
      text: `${name} couldn't finish${d.reason ? `: ${d.reason}` : ''}`,
      ...(d.sessionId ? { href: `/sessions/${d.sessionId}?tab=runs` } : {}),
    }
  else if (d.outcome === 'unrouted')
    notice = { ...base, outcome: 'unrouted', text: 'Nobody picked this up', hint: 'Tag someone, or post in #requests' }
  const notices = state.notices.filter(
    (n) => n.key !== notice?.key && !(d.outcome === 'failed' && n.threadId === d.threadId && n.outcome === 'no_reply'),
  )
  return { items, notices: notice ? [...notices, notice] : notices, pending }
}

/** You sent a message that should set someone to work: "delivering…" until something is heard. */
export function addPending(state: ActivityState, m: Message, now: number): ActivityState {
  const threadId = m.data.threadId ?? m.id
  return {
    ...state,
    notices: state.notices.filter((n) => !(n.threadId === threadId && n.outcome === 'unrouted')),
    pending: [...state.pending.filter((p) => p.messageId !== m.id), { messageId: m.id, threadId, at: now }],
  }
}

/** Drops notices and "delivering…" rows whose time is up. Returns the same state when nothing changed. */
export function pruneActivity(state: ActivityState, now: number): ActivityState {
  const notices = state.notices.filter((n) => n.until === undefined || n.until > now)
  const pending = state.pending.filter((p) => now - p.at < DELIVERING_MS)
  if (notices.length === state.notices.length && pending.length === state.pending.length) return state
  return { ...state, notices, pending }
}

/** When the next notice or "delivering…" row expires (epoch ms), if any. */
export function nextExpiry(state: ActivityState): number | undefined {
  const times = [
    ...state.notices.flatMap((n) => (n.until === undefined ? [] : [n.until])),
    ...state.pending.map((p) => p.at + DELIVERING_MS),
  ]
  return times.length ? Math.min(...times) : undefined
}

export function threadActivity(state: ActivityState, threadId: string): ThreadActivity {
  return {
    items: Object.values(state.items)
      .filter((i) => i.threadId === threadId)
      .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0)),
    notices: state.notices.filter((n) => n.threadId === threadId),
    pending: state.pending.filter((p) => p.threadId === threadId),
  }
}

/**
 * Whether a message you post should set someone to work, so its row says "delivering…" until
 * routing answers: it tags an employee or a session, it's in a DM with an employee or a channel
 * routed to a context, or it's a reply in a thread an AI takes part in. Plain chat between people
 * shows nothing.
 */
export function expectsWork(m: Message, channel: Channel | undefined, thread?: { aiInThread: boolean }): boolean {
  if (m.data.tags.some((t) => t.type === 'employee' || t.type === 'session')) return true
  if (m.data.threadId) return !!thread?.aiInThread
  if (!channel) return false
  if (channel.data.contextId) return true
  return !!channel.data.dm && channel.data.members.some((x) => x.type === 'employee' || x.type === 'session')
}

/** A worker's state in words: "is working…", "is queued", "is waiting on a reply", "paused: needs approval". */
export function stateText(i: ChatActivityItem): string {
  switch (i.state) {
    case 'queued':
      return 'is queued'
    case 'waiting':
      return i.waitingOn === 'work'
        ? 'is waiting on other work'
        : i.waitingOn === 'time'
          ? 'is waiting until later'
          : 'is waiting on a reply'
    case 'paused':
      return `paused: ${i.pauseReason || 'needs someone to look'}`
    default:
      return 'is working…'
  }
}

/** The `#slug` of a session label, for a non-router session (`@meatless#pay-refund` → `#pay-refund`). */
export function slugOf(i: ChatActivityItem): string | undefined {
  if (i.router) return undefined
  const at = i.sessionLabel.indexOf('#')
  return at >= 0 ? i.sessionLabel.slice(at) : undefined
}
