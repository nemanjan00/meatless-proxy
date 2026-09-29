import * as Api from '@mp/api'
import type { Procedure } from '@mp/directory'
import type { MpEvent, Trigger } from '@mp/events'
import type { Run, Session } from '@mp/sessions'
import { TERMINAL_RUN_STATES } from '@mp/sessions'
import { Views, routingOf } from '../http/views.ts'
import type { Services } from '../services.ts'
import { startOf } from './starts.ts'

/** How far back "runs in the last 30 days" looks. */
export const RECENT_MS = 30 * 24 * 3600 * 1000
/** The most instances a procedure page lists. */
export const MAX_RUNS = 100

const CONTEXT_OF = 'context_of'
const RUNS_PROCEDURE = 'runs_procedure'

const clip = (text: string, max = 200) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** Builds the procedure API's views (`@mp/api` procedures.ts) from the directory, triggers and sessions. */
export class ProcedureViews {
  private readonly v: Views
  private readonly channelNames = new Map<string, string | undefined>()

  constructor(private readonly s: Services) {
    this.v = new Views(s)
  }

  /** Every context the procedure has had: its current one first, then older ones (rebuilt). */
  async contexts(p: Procedure): Promise<Session[]> {
    const out = new Map<string, Session>()
    if (p.data.contextSessionId) {
      const current = await this.s.sessions.get(p.data.contextSessionId)
      if (current) out.set(current.id, current)
    }
    const linked = await this.s.records.linked(
      { kind: 'procedure', id: p.id },
      { direction: 'in', kind: 'session', role: CONTEXT_OF },
    )
    for (const l of linked)
      if (!out.has(l.record.id) && l.record.data.status !== 'abandoned') out.set(l.record.id, l.record as Session)
    return [...out.values()]
  }

  /** Triggers that target the procedure, or one of its contexts directly. */
  async triggers(p: Procedure, contextIds: string[]): Promise<Trigger[]> {
    return (await this.s.events.triggers.list()).filter((t) => {
      const target = t.data.target
      return (
        (target.type === 'procedure' && target.procedureId === p.id) ||
        (target.type === 'session' && contextIds.includes(target.sessionId))
      )
    })
  }

  async channelName(id: string): Promise<string | undefined> {
    if (!this.channelNames.has(id)) this.channelNames.set(id, (await this.s.chat.getChannel(id))?.data.name)
    return this.channelNames.get(id)
  }

  async trigger(t: Trigger): Promise<Api.ProcedureTrigger> {
    const start = startOf(t)
    const names = start.kind === 'channel' ? new Map([[start.channelId, await this.channelName(start.channelId)]]) : new Map()
    return {
      id: t.id,
      name: t.data.name,
      employee: await this.v.employeeSummary(t.data.employeeId),
      enabled: t.data.enabled,
      start,
      description: Api.describeStart(start, (id) => names.get(id)),
      raw: {
        match: (t.data.match ?? {}) as Record<string, Api.Json>,
        ...(t.data.schedule
          ? {
              schedule: {
                cron: t.data.schedule.cron,
                ...(t.data.schedule.timezone ? { timezone: t.data.schedule.timezone } : {}),
              },
            }
          : {}),
      },
      fired: t.data.fired ?? 0,
      lastFiredAt: t.data.lastFiredAt ?? null,
    }
  }

  async person(contactId: string | undefined): Promise<Api.ProcedurePerson | null> {
    if (!contactId) return null
    const c = await this.s.directory.contacts.get(contactId)
    if (!c) return { contactId, name: contactId, kind: 'person' }
    const e = c.data.kind === 'ai' ? await this.s.directory.employees.byContact(c.id) : null
    return { contactId, name: c.data.name, kind: c.data.kind ?? 'person', ...(e ? { employeeId: e.id } : {}) }
  }

  async context(p: Procedure): Promise<Api.ProcedureContextInfo> {
    const pc = this.s.procedureContexts
    if (!pc) {
      const session = p.data.contextSessionId ? await this.s.sessions.get(p.data.contextSessionId) : null
      return session
        ? { state: 'ready', sessionId: session.id, slug: session.data.slug, builtAt: session.createdAt, builtFromVersion: null }
        : { state: 'missing', sessionId: null, builtAt: null, builtFromVersion: null }
    }
    const st = await pc.state(p)
    return {
      state: st.state,
      sessionId: st.session?.id ?? null,
      ...(st.session ? { slug: st.session.data.slug, employee: await this.v.employeeSummary(st.session.data.employeeId) } : {}),
      builtAt: st.builtAt,
      builtFromVersion: st.builtFromVersion,
      ...(st.reason ? { reason: st.reason } : {}),
    }
  }

  /** What started an instance, from its first run. */
  private async cause(session: Session, first: Run | undefined, triggers: Map<string, Trigger>): Promise<Api.ProcedureRunCause> {
    const cause = first?.data.cause
    if (!cause) return { type: 'system', label: 'the harness' }
    if (cause.type === 'event' && cause.eventId) {
      const e = (await this.s.rawEvents.get(cause.eventId)) as MpEvent | null
      const d = e ? routingOf(e)?.deliveries.find((x) => x.outcome.sessionId === session.id && x.triggerId) : undefined
      const t = d?.triggerId ? triggers.get(d.triggerId) : undefined
      if (t) return { type: 'trigger', label: t.data.name, id: t.id }
      return {
        type: 'event',
        label: e ? clip(e.data.text ?? `${e.data.source} ${e.data.type}`, 80) : 'an event',
        id: cause.eventId,
      }
    }
    if (cause.type === 'fork' && cause.parentRunId) {
      const parent = await this.s.sessions.getRun(cause.parentRunId)
      const caller = parent ? await this.s.sessions.get(parent.data.sessionId) : null
      if (caller) return { type: 'session', label: caller.data.title, id: caller.id }
    }
    if (first.data.requesterId) {
      const who = await this.person(first.data.requesterId)
      if (who) return { type: 'person', label: who.name, id: who.contactId }
    }
    return { type: 'system', label: cause.note ?? cause.type }
  }

  /** The procedure's instances (forks of its contexts, and sessions linked by `procedures.run`), newest first. */
  async runs(p: Procedure, contexts: Session[], triggers: Trigger[], limit = MAX_RUNS): Promise<Api.ProcedureRun[]> {
    const sessions = new Map<string, Session>()
    for (const c of contexts) for (const ch of await this.s.sessions.children(c.id)) sessions.set(ch.id, ch)
    const linked = await this.s.records.linked(
      { kind: 'procedure', id: p.id },
      { direction: 'in', kind: 'session', role: RUNS_PROCEDURE },
    )
    for (const l of linked) sessions.set(l.record.id, l.record as Session)
    const byTrigger = new Map(triggers.map((t) => [t.id, t]))
    const newest = [...sessions.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit)
    const out: Api.ProcedureRun[] = []
    for (const session of newest) {
      const runs = await this.s.sessions.runs({ sessionId: session.id })
      const first = runs[0]
      const last = runs.at(-1)
      const result = last?.data.result
      const outcome = result?.error ?? result?.output
      out.push({
        sessionId: session.id,
        title: session.data.title,
        slug: session.data.slug,
        employee: await this.v.employeeSummary(session.data.employeeId),
        runId: last?.id ?? null,
        state: last?.data.state ?? null,
        startedAt: first?.createdAt ?? session.createdAt,
        endedAt: last && TERMINAL_RUN_STATES.includes(last.data.state) ? (last.data.endedAt ?? last.updatedAt) : null,
        startedBy: await this.cause(session, first, byTrigger),
        ...(outcome ? { outcome: clip(outcome) } : {}),
        runs: runs.length,
      })
    }
    return out
  }

  private async parts(p: Procedure, limit: number) {
    const contexts = await this.contexts(p)
    const triggers = await this.triggers(
      p,
      contexts.map((c) => c.id),
    )
    const views = await Promise.all(triggers.map((t) => this.trigger(t)))
    const runs = await this.runs(p, contexts, triggers, limit)
    return { contexts, triggers, views, runs }
  }

  private async item(p: Procedure, parts: Awaited<ReturnType<ProcedureViews['parts']>>): Promise<Api.ProcedureListItem> {
    const since = new Date(this.s.clock.now() - RECENT_MS).toISOString()
    const enabled = parts.views.filter((t) => t.enabled)
    const last = parts.runs[0]
    return {
      procedure: p as unknown as Api.ApiRecord<Api.ProcedureRecordData>,
      owner: await this.person(p.data.ownerId),
      starts: enabled.length
        ? enabled.map((t) => ({ kind: t.start.kind, description: t.description }))
        : [{ kind: 'manual', description: Api.describeStart({ kind: 'manual' }) }],
      approvals: p.data.approvals?.length ?? 0,
      runs30d: parts.runs.filter((r) => r.startedAt >= since).length,
      lastRun: last ? { sessionId: last.sessionId, state: last.state, at: last.startedAt } : null,
      context: await this.context(p),
    }
  }

  async listItem(p: Procedure): Promise<Api.ProcedureListItem> {
    return this.item(p, await this.parts(p, 1000))
  }

  async detail(p: Procedure): Promise<Api.ProcedureDetail> {
    const parts = await this.parts(p, MAX_RUNS)
    const approvers = await Promise.all(
      (p.data.approvals ?? []).map(async (a) => {
        const who = a.contactId ? await this.person(a.contactId) : null
        return { ...a, ...(who ? { name: who.name } : {}) }
      }),
    )
    return { ...(await this.item(p, parts)), triggers: parts.views, approvers, runs: parts.runs }
  }
}
