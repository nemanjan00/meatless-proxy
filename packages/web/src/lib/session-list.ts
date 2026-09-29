import type { SessionListItem, SessionSort, SessionStartedFrom } from '@mp/api'
import { STATUS, STATUS_ORDER, type StatusKey, sessionStatusKey } from '@/lib/status.ts'

/** The Sessions page's sort orders, in the order the menu shows them. */
export const SORTS: { value: SessionSort; label: string }[] = [
  { value: 'activity', label: 'Recent activity' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title', label: 'Title A–Z' },
]

/** "Started from" choices, in menu order. */
export const STARTED_FROM: { value: SessionStartedFrom; label: string }[] = [
  { value: 'chat', label: 'Chat thread' },
  { value: 'procedure', label: 'Procedure' },
  { value: 'trigger', label: 'Trigger or integration' },
  { value: 'handoff', label: 'Router hand-off' },
  { value: 'session', label: 'Another session' },
  { value: 'manual', label: 'Manual' },
  { value: 'router', label: 'Router contexts' },
]

export const isSort = (v: string | null): v is SessionSort => SORTS.some((s) => s.value === v)
export const isStartedFrom = (v: string | null): v is SessionStartedFrom => STARTED_FROM.some((s) => s.value === v)

const byte = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Compares two rows by a sort order (ties: newest first, then id, so the order is stable). */
export function compareSessions(sort: SessionSort): (a: SessionListItem, b: SessionListItem) => number {
  const key: Record<SessionSort, (a: SessionListItem, b: SessionListItem) => number> = {
    activity: (a, b) => byte(b.lastActivityAt, a.lastActivityAt),
    newest: (a, b) => byte(b.session.createdAt, a.session.createdAt),
    oldest: (a, b) => byte(a.session.createdAt, b.session.createdAt),
    title: (a, b) => a.session.data.title.localeCompare(b.session.data.title, undefined, { sensitivity: 'base' }),
  }
  return (a, b) => key[sort](a, b) || byte(b.session.createdAt, a.session.createdAt) || byte(a.session.id, b.session.id)
}

export type GroupBy = 'status' | 'employee' | 'tree'

export interface SessionGroup {
  key: string
  label: string
  status?: StatusKey
  rows: SessionListItem[]
}

/**
 * Groups rows and sorts them. Groups keep their order (status order, employee name); rows
 * inside a group follow `sort`. Trees are ordered by their latest activity, and rows inside a
 * tree by depth, then `sort`.
 */
export function groupSessions(rows: SessionListItem[], by: GroupBy, sort: SessionSort = 'activity'): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const r of rows) {
    // A suspended run and a waiting session read the same ("Waiting"), so they share a group.
    const shown = sessionStatusKey(r.session.data.status, r.runState)
    const status: StatusKey = shown === 'suspended' ? 'waiting' : shown
    const key = by === 'status' ? status : by === 'employee' ? r.employee.id : r.session.data.rootId
    const label =
      by === 'status'
        ? STATUS[status].label
        : by === 'employee'
          ? r.employee.name
          : (rows.find((x) => x.session.id === key)?.session.data.title ?? 'Tree')
    if (!groups.has(key)) groups.set(key, { key, label, ...(by === 'status' ? { status } : {}), rows: [] })
    groups.get(key)!.rows.push(r)
  }
  const list = [...groups.values()]
  const cmp = compareSessions(sort)
  if (by === 'tree') {
    const latest = (g: SessionGroup) => g.rows.reduce((m, r) => (r.lastActivityAt > m ? r.lastActivityAt : m), '')
    list.sort((a, b) => byte(latest(b), latest(a)) || a.label.localeCompare(b.label))
    for (const g of list) g.rows.sort((a, b) => a.session.data.depth - b.session.data.depth || cmp(a, b))
    return list
  }
  if (by === 'status') list.sort((a, b) => STATUS_ORDER.indexOf(a.status!) - STATUS_ORDER.indexOf(b.status!))
  else list.sort((a, b) => a.label.localeCompare(b.label))
  for (const g of list) g.rows.sort(cmp)
  return list
}
