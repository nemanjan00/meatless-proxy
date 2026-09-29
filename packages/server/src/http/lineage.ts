import type { LineageEdge, LineageEdgeType, LineageGraph, LineageNode } from '@mp/api'
import { NotFoundError, idPrefix } from '@mp/core'
import type { MpEvent } from '@mp/events'
import type { Run, RunData, Session } from '@mp/sessions'
import type { Services } from '../services.ts'
import { routingOf } from './views.ts'

const MAX_NODES = 400
const MAX_DEPTH = 6

/**
 * The lineage graph around an event, session or run (docs/spec.md#visualisation):
 * upstream is where it came from (event → trigger or subscription → context
 * session → fork parents), downstream is everything it caused (deliveries →
 * runs → sessions → forks and child runs). Edges point from cause to effect.
 */
export async function lineage(s: Services, id: string): Promise<LineageGraph> {
  const nodes = new Map<string, LineageNode>()
  const edges = new Map<string, LineageEdge>()
  const runCache = new Map<string, Run | null>()
  const sessionCache = new Map<string, Session | null>()

  const getRun = async (rid: string) => {
    if (!runCache.has(rid)) runCache.set(rid, await s.sessions.getRun(rid))
    return runCache.get(rid)!
  }
  const getSession = async (sid: string) => {
    if (!sessionCache.has(sid)) sessionCache.set(sid, await s.sessions.get(sid))
    return sessionCache.get(sid)!
  }
  const full = () => nodes.size >= MAX_NODES
  const edge = (from: string, to: string, type: LineageEdgeType) => {
    if (from !== to) edges.set(`${from}>${to}>${type}`, { from, to, type })
  }

  const addEvent = (e: MpEvent) =>
    nodes.set(e.id, {
      id: e.id,
      type: 'event',
      label: e.data.subject ? `${e.data.type} ${e.data.subject.id}` : e.data.type,
      detail: `${e.data.source} · ${e.data.type}`,
      at: e.data.receivedAt,
    })
  const addRun = (r: Run) =>
    nodes.set(r.id, {
      id: r.id,
      type: 'run',
      label: `${r.data.mode} run`,
      detail: r.data.cause.type,
      status: r.data.state,
      at: r.createdAt,
    })
  const addSession = (x: Session) =>
    nodes.set(x.id, {
      id: x.id,
      type: 'session',
      label: x.data.title,
      detail: x.data.slug,
      status: x.data.status,
      at: x.createdAt,
    })
  const addTrigger = async (tid: string) => {
    if (nodes.has(tid)) return
    const t = await s.events.triggers.get(tid)
    nodes.set(tid, {
      id: tid,
      type: 'trigger',
      label: t?.data.name ?? tid,
      ...(t ? { detail: `${t.data.match.source ?? '*'} · ${t.data.match.type ?? '*'}` } : {}),
    })
  }
  const addSubscription = async (sid: string) => {
    if (nodes.has(sid)) return
    const sub = await s.records.get<{ subject: { system: string; id: string } }>('subscription', sid)
    nodes.set(sid, { id: sid, type: 'subscription', label: sub ? `${sub.data.subject.system}:${sub.data.subject.id}` : sid })
  }

  /** The routing step that led from an event to a run: trigger/subscription/session nodes and edges. */
  const linkEventToRun = async (e: MpEvent, run: Run) => {
    const routing = routingOf(e)
    const d =
      routing?.deliveries.find((x) => x.outcome.runId === run.id) ??
      routing?.deliveries.find((x) => x.outcome.sessionId === run.data.sessionId)
    const session = await getSession(run.data.sessionId)
    if (session) addSession(session)
    edge(run.data.sessionId, run.id, 'ran')
    if (d?.triggerId) {
      await addTrigger(d.triggerId)
      edge(e.id, d.triggerId, 'matched')
      edge(d.triggerId, run.id, 'delivered')
    } else if (d?.subscriptionId) {
      await addSubscription(d.subscriptionId)
      edge(e.id, d.subscriptionId, 'matched')
      edge(d.subscriptionId, run.id, 'delivered')
    } else {
      edge(e.id, run.data.sessionId, 'matched')
    }
    // A procedure context (or a forking trigger): the context session was forked for this event.
    if (d && d.sessionId !== run.data.sessionId) {
      const ctx = await getSession(d.sessionId)
      if (ctx) {
        addSession(ctx)
        edge(ctx.id, run.data.sessionId, 'forked')
      }
    }
  }

  // ── Upstream ──────────────────────────────────────────────────────────────

  const upstreamRun = async (run: Run, depth: number): Promise<void> => {
    addRun(run)
    const session = await getSession(run.data.sessionId)
    if (session) addSession(session)
    edge(run.data.sessionId, run.id, 'ran')
    if (depth > MAX_DEPTH || full()) return
    const cause = run.data.cause
    if (cause.eventId) {
      const e = await s.rawEvents.get(cause.eventId)
      if (e) {
        addEvent(e)
        await linkEventToRun(e, run)
      }
    }
    if (cause.parentRunId) {
      const parent = await getRun(cause.parentRunId)
      if (parent) {
        edge(parent.id, run.data.sessionId, cause.type === 'loop' ? 'looped' : 'forked')
        await upstreamRun(parent, depth + 1)
      }
    }
    if (session) await upstreamSession(session, depth + 1, false)
  }

  const upstreamSession = async (session: Session, depth: number, withRuns: boolean): Promise<void> => {
    addSession(session)
    if (depth > MAX_DEPTH || full()) return
    const parent = session.data.parent?.sessionId
    if (parent) {
      const p = await getSession(parent)
      if (p) {
        addSession(p)
        // The run that forked it, when known; otherwise the parent session itself.
        const runs = await s.sessions.runs({ sessionId: session.id, limit: 1 })
        const parentRunId = runs[0]?.data.cause.parentRunId
        const parentRun = parentRunId ? await getRun(parentRunId) : null
        if (parentRun) {
          addRun(parentRun)
          edge(parent, parentRun.id, 'ran')
          edge(parentRun.id, session.id, session.data.meta?.loop ? 'looped' : 'forked')
          await upstreamRun(parentRun, depth + 1)
        } else {
          edge(parent, session.id, session.data.meta?.loop ? 'looped' : 'forked')
          await upstreamSession(p, depth + 1, true)
        }
      }
    }
    if (withRuns) {
      const runs = await s.sessions.runs({ sessionId: session.id })
      for (const r of runs.filter((x) => x.data.cause.eventId).slice(-10)) {
        if (full()) break
        addRun(r)
        const e = await s.rawEvents.get(r.data.cause.eventId!)
        if (e) {
          addEvent(e)
          await linkEventToRun(e, r)
        }
      }
    }
  }

  // ── Downstream ────────────────────────────────────────────────────────────

  const downstreamRun = async (run: Run, depth: number): Promise<void> => {
    addRun(run)
    if (depth > MAX_DEPTH || full()) return
    const children = await s.records.query<RunData>('run', {
      where: { 'cause.parentRunId': run.id },
      orderBy: { field: 'createdAt' },
    })
    for (const child of children.items as Run[]) {
      if (full()) break
      const cs = await getSession(child.data.sessionId)
      if (!cs) continue
      edge(run.id, cs.id, child.data.cause.type === 'loop' ? 'looped' : 'forked')
      await downstreamSession(cs, depth + 1)
    }
  }

  const downstreamSession = async (session: Session, depth: number): Promise<void> => {
    addSession(session)
    if (depth > MAX_DEPTH || full()) return
    for (const r of await s.sessions.runs({ sessionId: session.id })) {
      if (full()) break
      edge(session.id, r.id, 'ran')
      await downstreamRun(r, depth + 1)
    }
    for (const child of await s.sessions.children(session.id)) {
      if (full()) break
      if (!nodes.has(child.id)) {
        edge(session.id, child.id, child.data.meta?.loop ? 'looped' : 'forked')
        await downstreamSession(child, depth + 1)
      }
    }
  }

  const downstreamEvent = async (e: MpEvent): Promise<void> => {
    addEvent(e)
    const runs = await s.records.query<RunData>('run', { where: { 'cause.eventId': e.id }, orderBy: { field: 'createdAt' } })
    for (const r of runs.items as Run[]) {
      if (full()) break
      addRun(r)
      await linkEventToRun(e, r)
      await downstreamRun(r, 1)
    }
    // Deliveries that went into an inbox or were skipped still show where the event went.
    for (const d of routingOf(e)?.deliveries ?? []) {
      if (d.outcome.runId && !nodes.has(d.outcome.runId)) {
        const r = await getRun(d.outcome.runId)
        if (r) {
          addRun(r)
          await linkEventToRun(e, r)
        }
      }
    }
  }

  const prefix = idPrefix(id)
  if (prefix === 'evt') {
    const e = await s.rawEvents.get(id)
    if (!e) throw new NotFoundError('event', id)
    await downstreamEvent(e)
  } else if (prefix === 'run') {
    const r = await getRun(id)
    if (!r) throw new NotFoundError('run', id)
    await upstreamRun(r, 0)
    await downstreamRun(r, 0)
  } else if (prefix === 'ses') {
    const x = await getSession(id)
    if (!x) throw new NotFoundError('session', id)
    await upstreamSession(x, 0, true)
    await downstreamSession(x, 0)
  } else {
    throw new NotFoundError('event, session or run', id)
  }
  return { focus: id, nodes: [...nodes.values()], edges: [...edges.values()] }
}
