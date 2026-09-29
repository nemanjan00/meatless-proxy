/**
 * Maps domain records to the resource shapes of `@mp/api`. The API is the
 * contract the web UI codes against; the domain packages keep their own
 * shapes. `Views` memoises lookups (employee names, contacts, sessions)
 * for the lifetime of one request.
 */
import type * as Api from '@mp/api'
import type { ChatTag, Message as DomainMessage, ChannelData as DomainChannelData } from '@mp/chat'
import type { Checklist as DomainChecklist } from '@mp/checklists'
import type { Json } from '@mp/core'
import type { Contact, Employee } from '@mp/directory'
import type { MpEvent, Subscription as DomainSubscription, Trigger as DomainTrigger } from '@mp/events'
import type { Run, RunState, Session } from '@mp/sessions'
import type { Actor, Ref, StoredRecord } from '@mp/store'
import type { UsageFilter as DomainUsageFilter, UsageTotals } from '@mp/usage'
import type { Services } from '../services.ts'
import type { StoredRouting } from '../workers.ts'

export const emptyTotals = (): Api.TokenTotals => ({ input: 0, output: 0, cached: 0, reasoning: 0, total: 0, cost: 0, calls: 0 })

export function mapTotals(t: UsageTotals): Api.TokenTotals {
  return {
    input: t.promptTokens,
    output: t.completionTokens,
    cached: t.cachedTokens,
    reasoning: t.reasoningTokens,
    total: t.promptTokens + t.completionTokens,
    cost: t.costUsd,
    calls: t.calls,
  }
}

const ROUTING_RULE: Record<string, Api.RoutingRule> = {
  session_tag: 'session_tag',
  subscription: 'subscription',
  member: 'subscription',
  employee_tag: 'employee_tag',
  thread_participant: 'employee_tag',
  trigger: 'trigger',
  fallback: 'fallback',
}

export const routingRule = (reason: string): Api.RoutingRule => ROUTING_RULE[reason] ?? 'fallback'

export function routingOf(e: MpEvent): StoredRouting | undefined {
  const r = (e.data as { routing?: unknown }).routing
  return r && typeof r === 'object' ? (r as StoredRouting) : undefined
}

/**
 * Routed, but only a fallback router got it: nothing matched. An event with
 * no deliveries at all (e.g. a session's own message, which the router skips)
 * went nowhere and isn't unmatched.
 */
export function isUnmatched(e: MpEvent): boolean {
  const r = routingOf(e)
  return !!r && r.deliveries.length > 0 && r.deliveries.every((d) => d.reason === 'fallback')
}

export function mapEvent(e: MpEvent): Api.ApiEvent {
  const d = e.data
  const routing = routingOf(e)
  const matched = routing
    ? [...new Set(routing.deliveries.map((x) => routingRule(x.reason)).filter((r) => r !== 'fallback'))]
    : undefined
  const data: Api.EventData = {
    ...(d as Record<string, unknown>),
    source: d.source,
    type: d.type,
    dedupeKey: e.key ?? '',
    ...(d.subject ? { subject: { system: d.subject.system, ref: d.subject.id } } : {}),
    ...(d.actorContactId ? { actorId: d.actorContactId } : {}),
    payload: (d.payload ?? null) as Api.Json,
    receivedAt: d.receivedAt,
    routed: d.routed,
    ...(matched ? { matched } : {}),
    ...(routing ? { deliveries: routing.deliveries.length } : {}),
  }
  return { ...e, data }
}

export function mapSubscription(s: DomainSubscription): Api.Subscription {
  const d = s.data
  return {
    ...s,
    data: {
      ...(d as Record<string, unknown>),
      sessionId: d.sessionId,
      subject: { system: d.subject.system, ref: d.subject.id },
      primary: d.primary,
      active: d.active,
    },
  }
}

export function mapChecklist(c: DomainChecklist): Api.Checklist {
  return {
    ...c,
    data: {
      sessionId: c.data.sessionId,
      items: c.data.items.map((i) => ({
        id: i.id,
        text: i.text,
        required: i.required,
        checked: i.checked,
        evidence: i.evidence,
        ...(i.checkedAt ? { checkedAt: i.checkedAt } : {}),
        ...(i.needsReview && i.review !== 'none'
          ? {
              review: {
                state: i.review,
                ...(i.reviewerSessionId ? { reviewerSessionId: i.reviewerSessionId } : {}),
                ...(i.reviewNotes ? { note: i.reviewNotes } : {}),
              },
            }
          : {}),
      })),
    },
  }
}

export const checklistCounts = (c: DomainChecklist | null) => {
  if (!c?.data.items.length) return undefined
  const done = c.data.items.filter((i) => i.checked && (!i.needsReview || i.review === 'passed')).length
  return { done, total: c.data.items.length }
}

export function apiActor(a: { kind?: string; type?: string; id: string }): Api.ApiActor {
  const t = a.kind ?? a.type
  return { type: t === 'contact' ? 'contact' : t === 'session' ? 'session' : 'system', id: a.id }
}

/** Converts the API usage filter to the usage service's. */
export function usageFilter(q: Record<string, string | undefined>): DomainUsageFilter {
  const f: DomainUsageFilter = {}
  const keys = [
    'runId',
    'employeeId',
    'sessionId',
    'rootSessionId',
    'projectId',
    'requesterId',
    'templateId',
    'model',
    'since',
    'until',
  ] as const
  for (const k of keys) if (q[k]) f[k] = q[k]
  return f
}

/** Per-request memoised lookups and the mappings that need them. */
export class Views {
  private emp = new Map<string, Promise<Employee | null>>()
  private empByContact = new Map<string, Promise<Employee | null>>()
  private con = new Map<string, Promise<Contact | null>>()
  private ses = new Map<string, Promise<Session | null>>()

  constructor(readonly s: Services) {}

  employee(id: string) {
    if (!this.emp.has(id)) this.emp.set(id, this.s.directory.employees.get(id))
    return this.emp.get(id)!
  }
  employeeOfContact(contactId: string) {
    if (!this.empByContact.has(contactId)) this.empByContact.set(contactId, this.s.directory.employees.byContact(contactId))
    return this.empByContact.get(contactId)!
  }
  contact(id: string) {
    if (!this.con.has(id)) this.con.set(id, this.s.directory.contacts.get(id))
    return this.con.get(id)!
  }
  session(id: string) {
    if (!this.ses.has(id)) this.ses.set(id, this.s.sessions.get(id))
    return this.ses.get(id)!
  }

  async employeeSummary(id: string): Promise<Api.EmployeeSummary> {
    const e = await this.employee(id)
    return { id, name: e?.data.name ?? id }
  }

  async tokens(filter: DomainUsageFilter): Promise<Api.TokenTotals> {
    return mapTotals(await this.s.usage.totals(filter))
  }

  /** Runs of a session, oldest first. */
  runsOf(sessionId: string): Promise<Run[]> {
    return this.s.sessions.runs({ sessionId })
  }

  async latestRunState(sessionId: string): Promise<RunState | null> {
    const runs = await this.runsOf(sessionId)
    return runs.at(-1)?.data.state ?? null
  }

  async sessionListItem(session: Session): Promise<Api.SessionListItem> {
    const [employee, runState, tokens, children, checklist] = await Promise.all([
      this.employeeSummary(session.data.employeeId),
      this.latestRunState(session.id),
      this.tokens({ sessionId: session.id }),
      this.s.records.store.records.count('session', { 'parent.sessionId': session.id }),
      this.s.records.getByKey<DomainChecklist['data']>('checklist', session.id),
    ])
    const counts = checklistCounts(checklist as DomainChecklist | null)
    return { session: session as Api.Session, employee, runState, tokens, children, ...(counts ? { checklist: counts } : {}) }
  }

  async sessionLabel(session: Session): Promise<string> {
    const e = await this.employee(session.data.employeeId)
    return `@${e?.key ?? e?.data.name ?? 'employee'}#${session.data.slug}`
  }

  async author(a: { kind: string; id: string }): Promise<Api.MessageData['author']> {
    if (a.kind === 'session') {
      const s = await this.session(a.id)
      return { type: 'session', id: a.id, name: s ? await this.sessionLabel(s) : a.id }
    }
    const c = await this.contact(a.id)
    if (c?.data.kind === 'ai') {
      const e = await this.employeeOfContact(c.id)
      if (e) return { type: 'employee', id: e.id, name: e.data.name }
    }
    return { type: 'person', id: a.id, name: c?.data.name ?? a.id }
  }

  mapTags(tags: ChatTag[]): Api.ChatTag[] {
    const out: Api.ChatTag[] = []
    for (const t of tags) {
      if (t.type === 'employee') out.push({ type: 'employee', id: t.employeeId, text: t.raw })
      else if (t.type === 'session') out.push({ type: 'session', id: t.sessionId, text: t.raw })
      else if (t.type === 'person') out.push({ type: 'person', id: t.contactId, text: t.raw })
    }
    return out
  }

  /** The session handling a thread: the primary subscriber, else the first. */
  async threadSession(rootId: string): Promise<string | undefined> {
    const subs = await this.s.events.subscriptions.forSubject({ system: 'mp', id: rootId })
    return (subs.find((x) => x.data.primary) ?? subs[0])?.data.sessionId
  }

  async message(m: DomainMessage, opts: { summary?: boolean } = {}): Promise<Api.Message> {
    const d = m.data
    const data: Api.MessageData = {
      channelId: d.channelId,
      threadId: d.threadId ?? null,
      author: await this.author(d.author),
      text: d.text,
      tags: this.mapTags(d.tags ?? []),
      mentions: d.mentions ?? [],
      createdAt: d.createdAt,
      ...(d.editedAt ? { editedAt: d.editedAt } : {}),
      ...(d.deleted ? { deleted: true } : {}),
      ...(d.reactions && Object.keys(d.reactions).length ? { reactions: d.reactions } : {}),
    }
    if (!d.threadId && opts.summary !== false) {
      const replies = await this.s.records.query<DomainMessage['data']>('message', {
        where: { threadId: m.id },
        orderBy: { field: 'createdAt', dir: 'desc' },
        limit: 1,
      })
      data.replyCount = replies.total
      if (replies.items[0]) data.lastReplyAt = replies.items[0].data.createdAt
      const sessionId = await this.threadSession(m.id)
      if (sessionId) data.sessionId = sessionId
    }
    return { ...m, data }
  }

  async member(ref: Ref): Promise<Api.ChatMember> {
    if (ref.kind === 'session') {
      const s = await this.session(ref.id)
      return { type: 'session', id: ref.id, label: s ? await this.sessionLabel(s) : ref.id }
    }
    if (ref.kind === 'employee') {
      const e = await this.employee(ref.id)
      return { type: 'employee', id: ref.id, label: e?.data.name ?? ref.id }
    }
    const c = await this.contact(ref.id)
    if (c?.data.kind === 'ai') {
      const e = await this.employeeOfContact(c.id)
      if (e) return { type: 'employee', id: e.id, label: e.data.name }
    }
    if (c?.data.kind === 'agent') return { type: 'person', id: ref.id, label: c.data.name, online: c.data.online === true }
    return { type: 'person', id: ref.id, label: c?.data.name ?? ref.id }
  }

  async channel(ch: StoredRecord<DomainChannelData>): Promise<Api.Channel> {
    const members = await this.s.chat.members(ch.id)
    const d = ch.data
    return {
      ...ch,
      data: {
        ...(d as Record<string, unknown>),
        name: d.name,
        ...(d.topic ? { topic: d.topic } : {}),
        dm: (d as { dm?: boolean }).dm === true,
        archived: d.archived,
        ...(d.contextSessionId ? { contextId: d.contextSessionId } : {}),
        createdBy: apiActor(d.createdBy),
        members: await Promise.all(members.map((m) => this.member(m))),
      },
    }
  }

  async triggerContext(t: DomainTrigger): Promise<string | null> {
    const target = t.data.target
    if (target.type === 'session') return target.sessionId
    if (target.type === 'procedure')
      return (await this.s.directory.procedures.get(target.procedureId))?.data.contextSessionId ?? null
    return this.s.routerSessionFor(t.data.employeeId)
  }

  async trigger(t: DomainTrigger): Promise<Api.Trigger> {
    const d = t.data
    const contextId = await this.triggerContext(t)
    return {
      ...t,
      data: {
        ...(d as Record<string, unknown>),
        name: d.name,
        employeeId: d.employeeId,
        source: d.match.source ?? '*',
        type: d.match.type ?? '*',
        ...(d.match.where ? { filters: d.match.where as Record<string, Api.Json> } : {}),
        contextId: contextId ?? '',
        fork: d.fork || d.target.type === 'procedure',
        mode: d.mode,
        enabled: d.enabled,
      },
    }
  }

  /** Synthesised delivery records of an event, from its stored routing. */
  deliveries(e: MpEvent): Api.Delivery[] {
    const routing = routingOf(e)
    if (!routing) return []
    return routing.deliveries.map((d, i) => ({
      kind: 'delivery',
      id: `${e.id}.${i}`,
      version: 1,
      key: null,
      createdAt: routing.at,
      updatedAt: routing.at,
      data: {
        eventId: e.id,
        sessionId: d.outcome.sessionId ?? d.sessionId,
        rule: routingRule(d.reason),
        ...(d.triggerId ? { triggerId: d.triggerId } : {}),
        ...(d.subscriptionId ? { subscriptionId: d.subscriptionId } : {}),
        expectedToAct: d.expectedToAct,
        ...(d.outcome.runId ? { runId: d.outcome.runId } : {}),
        inbox: d.outcome.type === 'inbox' || d.outcome.type === 'woke',
        outcome: d.outcome.type,
        ...(d.outcome.reason ? { skipped: d.outcome.reason } : {}),
      },
    }))
  }
}

export const toJson = <T>(v: T): Json => v as unknown as Json

export const actorOf = (contactId: string): Actor => ({ type: 'contact', id: contactId })
