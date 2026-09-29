/**
 * The private-session rule (src/auth/visibility.ts) applied to what the HTTP API
 * returns: record queries, lineage graphs, session trees, the events list and
 * usage labels. Kept apart from the handlers so every route asks the same thing.
 */
import type * as Api from '@mp/api'
import type { MpEvent } from '@mp/events'
import type { Session } from '@mp/sessions'
import type { Condition, StoredRecord } from '@mp/store'
import { NotFoundError } from '@mp/core'
import { type ChatVisibility, PRIVATE_TITLE, type Viewer, markOf } from '../auth/visibility.ts'
import type { Services } from '../services.ts'

/** Record kinds that belong to a session through their `sessionId` field. */
export const SESSION_OWNED_KINDS = new Set(['run', 'inbox', 'subscription', 'checklist', 'usage', 'scheduled_task'])

/** Extra conditions for a records query of `kind` that leave out private work the viewer may not read. */
export async function privateWorkFilter(vis: ChatVisibility, viewer: Viewer, kind: string): Promise<Condition[]> {
  if (kind === 'event') return [{ field: 'private', op: 'exists', value: false }]
  if (kind !== 'session' && !SESSION_OWNED_KINDS.has(kind)) return []
  const hidden = await vis.hiddenWork(viewer)
  const out: Condition[] = []
  if (kind === 'session' && hidden.sessions.size) out.push({ field: 'id', op: 'nin', value: [...hidden.sessions] })
  if (kind !== 'session' && hidden.sessions.size) out.push({ field: 'sessionId', op: 'nin', value: [...hidden.sessions] })
  // A shared context's private runs (and what they used).
  const runField = kind === 'run' ? 'id' : kind === 'usage' || kind === 'inbox' ? 'runId' : null
  if (runField && hidden.runs.size) out.push({ field: runField, op: 'nin', value: [...hidden.runs] })
  return out
}

/** Whether the viewer may read a record as private work goes: sessions, what belongs to one, runs and events. */
export async function canReadWorkRecord(
  s: Services,
  vis: ChatVisibility,
  viewer: Viewer,
  r: StoredRecord | null | undefined,
): Promise<boolean> {
  if (!r) return true
  if (r.kind === 'session') return vis.canReadSession(viewer, r as Session)
  if (r.kind === 'event') return vis.canSeeEvent(viewer, r)
  if (r.kind === 'run') return vis.canReadRun(viewer, r as never)
  if (SESSION_OWNED_KINDS.has(r.kind) && typeof r.data.sessionId === 'string') {
    if (typeof r.data.runId === 'string' && !(await vis.canReadMark(viewer, markOf(await s.sessions.getRun(r.data.runId)))))
      return false
    return vis.canReadSession(viewer, await s.sessions.get(r.data.sessionId))
  }
  return true
}

/**
 * A lineage graph without what the viewer may not see: private sessions (shown to admins
 * with a redacted title), private runs and DM events are left out with their edges.
 * 404 when the graph is about one of them (for admins too).
 */
export async function visibleLineage(
  s: Services,
  vis: ChatVisibility,
  viewer: Viewer,
  g: Api.LineageGraph,
): Promise<Api.LineageGraph> {
  const drop = new Set<string>()
  const nodes: Api.LineageNode[] = []
  for (const n of g.nodes) {
    if (n.type === 'session') {
      const access = await vis.sessionAccess(viewer, await s.sessions.get(n.id))
      // The graph of a private session itself is its members' only; elsewhere admins see it exists.
      if (access === 'none' || (access === 'redacted' && n.id === g.focus)) drop.add(n.id)
      else nodes.push(access === 'redacted' ? { ...n, label: PRIVATE_TITLE, detail: '' } : n)
    } else if (n.type === 'run') {
      if (await vis.canReadRun(viewer, await s.sessions.getRun(n.id))) nodes.push(n)
      else drop.add(n.id)
    } else if (n.type === 'event') {
      if (await vis.canSeeEvent(viewer, await s.rawEvents.get(n.id))) nodes.push(n)
      else drop.add(n.id)
    } else nodes.push(n)
  }
  if (drop.has(g.focus)) throw new NotFoundError('record', g.focus)
  return { focus: g.focus, nodes, edges: g.edges.filter((e) => !drop.has(e.from) && !drop.has(e.to)) }
}

/**
 * A session tree as the viewer may see it: private sessions they can't read are left out
 * (with their forks, which are private too), or shown to admins with a redacted title.
 */
export async function visibleTree(
  s: Services,
  vis: ChatVisibility,
  viewer: Viewer,
  node: Api.SessionTreeNode,
): Promise<Api.SessionTreeNode | null> {
  const access = await vis.sessionAccess(viewer, await s.sessions.get(node.id))
  if (access === 'none') return null
  const children: Api.SessionTreeNode[] = []
  for (const ch of node.children) {
    const v = await visibleTree(s, vis, viewer, ch)
    if (v) children.push(v)
  }
  return { ...node, ...(access === 'redacted' ? { title: PRIVATE_TITLE } : {}), children }
}

/**
 * One page of events the viewer may see. DM events from integrations carry a `private` marker
 * and are for the people it lists; the store has no "or", so the page is merged from two
 * queries (unmarked events, and marked ones listing the viewer), newest first.
 */
export async function visibleEventsPage(
  s: Services,
  viewer: Viewer,
  where: Condition[],
  limit: number,
  offset: number,
): Promise<{ items: MpEvent[]; total: number }> {
  const q = (extra: Condition[]) =>
    s.records.query<MpEvent['data']>('event', {
      where: [...where, ...extra],
      orderBy: { field: 'receivedAt', dir: 'desc' },
      limit: offset + limit,
    })
  const ids = [viewer.contactId, ...(viewer.also ?? [])]
  const [open, ...mine] = await Promise.all([
    q([{ field: 'private', op: 'exists', value: false }]),
    ...ids.map((id) => q([{ field: 'private.contacts', op: 'contains', value: id }])),
  ])
  const seen = new Set<string>()
  const merged: MpEvent[] = []
  for (const e of [...open!.items, ...mine.flatMap((m) => m.items)] as MpEvent[]) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    merged.push(e)
  }
  merged.sort((a, b) =>
    a.data.receivedAt < b.data.receivedAt ? 1 : a.data.receivedAt > b.data.receivedAt ? -1 : a.id < b.id ? 1 : -1,
  )
  const total = open!.total + mine.reduce((n, m) => n + m.total, 0)
  return { items: merged.slice(offset, offset + limit), total }
}
