import sift from 'sift'
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  globMatch,
  isMpError,
  systemClock,
  validateRecord,
  type Clock,
  type EventBus,
  type Json,
} from '@mp/core'
import type { Records } from '@mp/records'
import { contentHash, deepMatch, fieldValue, type Actor, type Condition, type StoredRecord } from '@mp/store'
import { checkSchedule, dueFiring, type TriggerSchedule } from './schedule.ts'
import { eventSchema, subscriptionSchema, triggerSchema } from './schemas.ts'

// ─── Types ──────────────────────────────────────────────────────────────────

/** What an event or subscription is about. `system: 'mp'` means a record of the harness itself. */
export interface Subject {
  system: string
  id: string
}

export interface EventData extends Record<string, unknown> {
  source: string
  type: string
  subject?: Subject
  /** `system:id` of the subject, derived. */
  subjectKey?: string
  actorContactId?: string
  employeeId?: string
  /** Raw content, untrusted. */
  payload?: Json
  text?: string
  routed: boolean
  routedAt?: string
  receivedAt: string
}
export type MpEvent = StoredRecord<EventData>

export interface IngestInput {
  source: string
  type: string
  /**
   * Unique per event. When missing, the key is `source:type:<sha256 of {subject, payload, text}>`,
   * so the exact same content from the same source and type is stored only once.
   * Sources with external ids should always pass `source:externalId` or similar.
   */
  dedupeKey?: string
  subject?: Subject
  actorContactId?: string
  employeeId?: string
  payload?: Json
  text?: string
}

export type TriggerTarget =
  | { type: 'session'; sessionId: string }
  | { type: 'procedure'; procedureId: string }
  | { type: 'router' }

export interface TriggerMatch {
  /** Glob on the event's source. */
  source?: string
  /** Glob on the event's type, e.g. `task.*`. */
  type?: string
  /** Globs on the subject's system and id. */
  subject?: { system?: string; id?: string }
  /**
   * Dot path into the event (`payload.channelId`, `subject.id`, `actorContactId`) -> expected value.
   * Scalars compare equal, objects match partially, arrays match exactly (see `deepMatch` in @mp/store).
   */
  where?: Record<string, Json>
  /**
   * A MongoDB-style query (evaluated with sift) over the event, e.g.
   * `{ "payload.priority": { "$gte": 2 }, "payload.labels": { "$in": ["bug"] } }`.
   * Stored as JSON, so triggers stay data.
   */
  filter?: Json
}

export interface TriggerData extends Record<string, unknown> {
  name: string
  employeeId: string
  enabled: boolean
  priority: number
  match: TriggerMatch
  target: TriggerTarget
  fork: boolean
  mode: 'continuing' | 'ephemeral'
  fired: number
  lastFiredAt?: string
  /** Fires on a schedule instead of matching events. Such a trigger has an empty `match`. */
  schedule?: TriggerSchedule
  /** The last scheduled firing handled (ISO), or when the schedule was set or last enabled. */
  lastScheduledAt?: string
}
export type Trigger = StoredRecord<TriggerData>

export interface CreateTriggerInput {
  name: string
  employeeId: string
  /** Required unless `schedule` is given; a schedule trigger has no event match. */
  match?: TriggerMatch
  target: TriggerTarget
  /** Fire on this schedule (cron, time zone, grace period) instead of on matching events. */
  schedule?: TriggerSchedule
  enabled?: boolean
  priority?: number
  fork?: boolean
  mode?: 'continuing' | 'ephemeral'
}

export interface SubscriptionData extends Record<string, unknown> {
  sessionId: string
  subject: Subject
  subjectKey: string
  primary: boolean
  types?: string[]
  /** MongoDB-style query (sift) the event must match, e.g. `{ "payload.author.kind": "contact" }`. */
  filter?: Json
  active: boolean
  endedReason?: string
}
export type Subscription = StoredRecord<SubscriptionData>

export interface EventQuery {
  source?: string
  type?: string
  routed?: boolean
  subjectKey?: string
  /** ISO timestamp: events received at or after it. */
  since?: string
  limit?: number
}

/** A trigger patch. `schedule: null` turns a schedule trigger back into an event trigger. */
export type TriggerPatch = Partial<Omit<TriggerData, 'fired' | 'lastFiredAt' | 'lastScheduledAt' | 'schedule'>> & {
  schedule?: TriggerSchedule | null
}

/** A scheduled firing that is due: the trigger and the firing time (ISO). */
export interface DueSchedule {
  trigger: Trigger
  at: string
}

export interface Triggers {
  create(input: CreateTriggerInput, actor?: Actor): Promise<Trigger>
  get(id: string): Promise<Trigger | null>
  update(id: string, patch: TriggerPatch, actor?: Actor): Promise<Trigger>
  list(q?: { employeeId?: string; enabled?: boolean }): Promise<Trigger[]>
  remove(id: string, actor?: Actor): Promise<void>
  /**
   * Enabled triggers matching the event, best first (priority desc, then oldest first).
   * When the event names an `employeeId`, only that employee's triggers match.
   * Schedule triggers never match ordinary events: a `schedule.fired` event
   * with `payload.triggerId` matches exactly that trigger (if it is enabled).
   */
  match(event: MpEvent | EventData): Promise<Trigger[]>
  /**
   * Enabled schedule triggers with a firing due at `now` (default: the clock):
   * the latest firing since `lastScheduledAt` (or since the trigger was
   * created), if it is within the grace period. Read-only: fire it by
   * ingesting a `schedule.fired` event with `scheduleDedupeKey`, then call
   * `markScheduled`, so a crash in between or a second instance never fires twice.
   */
  dueSchedules(now?: number): Promise<DueSchedule[]>
  /** Records that the firing at `at` was handled. Only moves forward; safe under concurrency. */
  markScheduled(id: string, at: string): Promise<Trigger>
  /** Counts a firing. Safe under concurrency. */
  recordFired(id: string): Promise<Trigger>
}

export interface Subscriptions {
  /** Idempotent per session and subject: subscribing again reactivates and updates `primary`/`types`. */
  subscribe(
    sessionId: string,
    subject: Subject,
    opts?: { primary?: boolean; types?: string[]; filter?: Json; actor?: Actor },
  ): Promise<Subscription>
  /** Ends the subscription (kept as a record with `endedReason: 'unsubscribed'`). No-op if there is none. */
  unsubscribe(sessionId: string, subject: Subject): Promise<void>
  /** Active subscriptions to a subject, oldest first; with `eventType`, only those whose `types` match it. */
  forSubject(subject: Subject, eventType?: string): Promise<Subscription[]>
  /** Active subscriptions that should receive this event: same subject, matching `types` and `filter`. */
  forEvent(event: EventData): Promise<Subscription[]>
  /** Active subscriptions of a session. */
  forSession(sessionId: string): Promise<Subscription[]>
  /** Hands every active subscription of one session to another (e.g. when passing work on). Returns the new ones. */
  transfer(fromSessionId: string, toSessionId: string): Promise<Subscription[]>
  /** Ends every subscription to a subject (the ticket was resolved, the PR merged). Returns how many. */
  endForSubject(subject: Subject, reason: string): Promise<number>
  /** Ends every subscription of a session (the session ended). Returns how many. */
  endForSession(sessionId: string, reason: string): Promise<number>
}

export interface Events {
  ingest(input: IngestInput): Promise<{ event: MpEvent; created: boolean }>
  get(id: string): Promise<MpEvent | null>
  require(id: string): Promise<MpEvent>
  /** Marks an event routed. Idempotent: routing it again keeps the first `routedAt`. */
  markRouted(id: string): Promise<MpEvent>
  /** Oldest first. */
  query(q?: EventQuery): Promise<MpEvent[]>
  readonly triggers: Triggers
  readonly subscriptions: Subscriptions
}

export const EventTopics = {
  ingested: 'event.ingested',
} as const

/** Source and type of the events schedule triggers fire. */
export const SCHEDULE_SOURCE = 'schedule'
export const SCHEDULE_FIRED = 'schedule.fired'

/** The dedupe key of a scheduled firing: once per trigger and time, across restarts and instances. */
export function scheduleDedupeKey(triggerId: string, at: string | Date): string {
  return `schedule:${triggerId}:${new Date(at).toISOString()}`
}

/** The trigger a `schedule.fired` event (source `schedule`) is for, if it is one. */
export function scheduledTriggerId(event: Pick<EventData, 'source' | 'type' | 'payload'>): string | undefined {
  if (event.source !== SCHEDULE_SOURCE || event.type !== SCHEDULE_FIRED) return undefined
  const id = (event.payload as { triggerId?: unknown } | undefined)?.triggerId
  return typeof id === 'string' && id ? id : undefined
}

export interface EventIngested {
  eventId: string
  created: boolean
}

export interface EventsOptions {
  records: Records
  clock?: Clock
  bus?: EventBus
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** `system:id`, the key used to find events and subscriptions by subject. */
export function subjectKey(subject: Subject): string {
  return `${subject.system}:${subject.id}`
}

/** The subject for a record of the harness itself (a thread, a session, a run). */
export function internalSubject(id: string): Subject {
  return { system: 'mp', id }
}

/** The default dedupe key when the caller gives none. */
export function defaultDedupeKey(input: Pick<IngestInput, 'source' | 'type' | 'subject' | 'payload' | 'text'>): string {
  return `${input.source}:${input.type}:${contentHash({ subject: input.subject ?? null, payload: input.payload ?? null, text: input.text ?? null })}`
}

const checkSubject = (s: unknown, what: string): Subject => {
  const v = s as Subject
  if (!v || typeof v !== 'object' || typeof v.system !== 'string' || typeof v.id !== 'string' || !v.system || !v.id)
    throw new ValidationError(`${what} must be { system, id } with non-empty strings`)
  return { system: v.system, id: v.id }
}

const checkTarget = (t: unknown): TriggerTarget => {
  const v = t as TriggerTarget
  if (v && typeof v === 'object') {
    if (v.type === 'router') return { type: 'router' }
    if (v.type === 'session' && typeof v.sessionId === 'string' && v.sessionId) return { type: 'session', sessionId: v.sessionId }
    if (v.type === 'procedure' && typeof v.procedureId === 'string' && v.procedureId)
      return { type: 'procedure', procedureId: v.procedureId }
  }
  throw new ValidationError(
    'trigger target must be {type:"session",sessionId}, {type:"procedure",procedureId} or {type:"router"}',
  )
}

/** Whether a trigger's `match` fits an event. Exported for the router and for tests. */
const filterCache = new Map<string, (event: EventData) => boolean>()

/**
 * Compiles a MongoDB-style JSON query (sift) into a predicate over events.
 * Invalid queries throw `ValidationError`.
 */
export function eventFilter(query: Json): (event: EventData) => boolean {
  const key = JSON.stringify(query)
  let f = filterCache.get(key)
  if (!f) {
    if (query === null || typeof query !== 'object' || Array.isArray(query))
      throw new ValidationError('filter must be a query object')
    try {
      const test = sift(query as any)
      f = (event) => test(event)
      f({ source: '', type: '', routed: false, receivedAt: '' })
    } catch (err) {
      throw new ValidationError(`invalid filter: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (filterCache.size > 1000) filterCache.clear()
    filterCache.set(key, f)
  }
  return f
}

export function triggerMatches(match: TriggerMatch, event: EventData): boolean {
  if (match.source !== undefined && !globMatch(match.source, event.source)) return false
  if (match.type !== undefined && !globMatch(match.type, event.type)) return false
  if (match.subject) {
    if (!event.subject) return false
    if (match.subject.system !== undefined && !globMatch(match.subject.system, event.subject.system)) return false
    if (match.subject.id !== undefined && !globMatch(match.subject.id, event.subject.id)) return false
  }
  if (match.filter !== undefined && !eventFilter(match.filter)(event)) return false
  if (match.where) {
    const asRecord = { data: event } as StoredRecord<any>
    for (const [path, expected] of Object.entries(match.where)) {
      if (!deepMatch(fieldValue(asRecord, path), expected)) return false
    }
  }
  return true
}

/** Whether a trigger match constrains anything (a schedule trigger must not). */
const hasMatch = (m: TriggerMatch) => Object.values(m).some((v) => v !== undefined)

const WILDCARD = new Set(['*', '**'])
const narrows = (glob: string | undefined) => glob !== undefined && glob !== '' && !WILDCARD.has(glob)
const nonEmpty = (v: unknown) => v !== undefined && v !== null && (typeof v !== 'object' || Object.keys(v as object).length > 0)

/**
 * Whether a match narrows anything down. A match-everything trigger (`{}`, or only wildcards) is
 * refused: catching everything nothing else claims is the fallback's job, and the fallback is the
 * employee's router.
 */
export function isCatchAll(m: TriggerMatch): boolean {
  return !(
    narrows(m.source) ||
    narrows(m.type) ||
    narrows(m.subject?.system) ||
    narrows(m.subject?.id) ||
    nonEmpty(m.where) ||
    nonEmpty(m.filter)
  )
}

export const CATCH_ALL_MESSAGE =
  "a trigger must match something specific (a source, an event type, a subject, or a filter). Events nothing else claims already go to the employee's router: that's the fallback."

const MAX_CAS_RETRIES = 50

// ─── Service ────────────────────────────────────────────────────────────────

export function createEvents(opts: EventsOptions): Events {
  const { records } = opts
  const clock = opts.clock ?? systemClock
  const bus = opts.bus
  for (const s of [eventSchema, triggerSchema, subscriptionSchema]) if (!records.kinds.has(s.kind)) records.kinds.define(s)

  /** Read-modify-write with compare-and-swap, retried on conflicts. */
  const casUpdate = async <T extends Record<string, unknown>>(
    kind: string,
    id: string,
    fn: (current: StoredRecord<T>) => Partial<T> | null,
  ): Promise<StoredRecord<T>> => {
    for (let i = 0; ; i++) {
      const current = await records.require<T>(kind, id)
      const patch = fn(current)
      if (!patch) return current
      try {
        return await records.update<T>(kind, id, patch, { expectedVersion: current.version })
      } catch (e) {
        if (!isMpError(e, 'conflict') || i >= MAX_CAS_RETRIES) throw e
      }
    }
  }

  const triggers: Triggers = {
    async create(input, actor) {
      if (!input.name) throw new ValidationError('trigger name is required')
      const schedule = input.schedule !== undefined ? checkSchedule(input.schedule) : undefined
      const match = input.match ?? {}
      if (schedule && hasMatch(match)) throw new ValidationError('a schedule trigger has no event match')
      if (!schedule && isCatchAll(match)) throw new ValidationError(CATCH_ALL_MESSAGE)
      if (match.filter !== undefined) eventFilter(match.filter)
      const data: TriggerData = {
        name: input.name,
        employeeId: input.employeeId,
        enabled: input.enabled ?? true,
        priority: input.priority ?? 0,
        match,
        target: checkTarget(input.target),
        fork: input.fork ?? false,
        mode: input.mode ?? 'ephemeral',
        fired: 0,
        ...(schedule ? { schedule, lastScheduledAt: clock.iso() } : {}),
      }
      return records.create('trigger', data, actor ? { actor } : {})
    },
    get: (id) => records.get<TriggerData>('trigger', id),
    async update(id, patch, actor) {
      const current = await records.require<TriggerData>('trigger', id)
      const { schedule: nextSchedule, ...rest } = patch
      const p = { ...rest } as Partial<TriggerData>
      delete p.fired
      delete p.lastFiredAt
      delete (p as Record<string, unknown>).lastScheduledAt
      if (p.target !== undefined) p.target = checkTarget(p.target)
      if (p.match?.filter !== undefined) eventFilter(p.match.filter)
      let schedule = current.data.schedule
      if (nextSchedule === null) {
        schedule = undefined
        p.schedule = undefined
        p.lastScheduledAt = undefined
      } else if (nextSchedule !== undefined) {
        schedule = checkSchedule(nextSchedule)
        p.schedule = schedule
        // A new schedule starts from now: slots before the change don't fire.
        if (JSON.stringify(schedule) !== JSON.stringify(current.data.schedule)) p.lastScheduledAt = clock.iso()
      }
      if (schedule && hasMatch(p.match ?? current.data.match ?? {}))
        throw new ValidationError('a schedule trigger has no event match')
      if (!schedule && isCatchAll(p.match ?? current.data.match ?? {})) throw new ValidationError(CATCH_ALL_MESSAGE)
      // Slots that passed while the trigger was disabled don't fire when it's enabled again.
      if (schedule && p.enabled === true && !current.data.enabled) p.lastScheduledAt = clock.iso()
      return records.update<TriggerData>('trigger', id, p, actor ? { actor } : {})
    },
    async list(q = {}) {
      const where: Record<string, Json> = {}
      if (q.employeeId !== undefined) where.employeeId = q.employeeId
      if (q.enabled !== undefined) where.enabled = q.enabled
      return (await records.query<TriggerData>('trigger', { where, orderBy: { field: 'createdAt' } })).items
    },
    remove: (id, actor) => records.delete('trigger', id, { cascade: true, ...(actor ? { actor } : {}) }),
    async match(event) {
      const data: EventData = 'data' in event && 'kind' in event ? (event as MpEvent).data : (event as EventData)
      const scheduled = scheduledTriggerId(data)
      if (scheduled) {
        const t = await records.get<TriggerData>('trigger', scheduled)
        if (!t?.data.enabled || !t.data.schedule) return []
        if (data.employeeId && t.data.employeeId !== data.employeeId) return []
        return [t]
      }
      const where: Record<string, Json> = { enabled: true }
      if (data.employeeId) where.employeeId = data.employeeId
      const all = (await records.query<TriggerData>('trigger', { where, orderBy: { field: 'createdAt' } })).items
      return all
        .filter((t) => !t.data.schedule && triggerMatches(t.data.match ?? {}, data))
        .sort(
          (a, b) =>
            b.data.priority - a.data.priority ||
            (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
            (a.id < b.id ? -1 : 1),
        )
    },
    recordFired: (id) =>
      casUpdate<TriggerData>('trigger', id, (t) => ({ fired: (t.data.fired ?? 0) + 1, lastFiredAt: clock.iso() })),
    async dueSchedules(now = clock.now()) {
      const out: DueSchedule[] = []
      for (const t of await triggers.list({ enabled: true })) {
        if (!t.data.schedule) continue
        let at: Date | null
        try {
          at = dueFiring(t.data.schedule, t.data.lastScheduledAt ?? t.createdAt, now)
        } catch {
          continue // a schedule stored without validation: never due
        }
        if (at) out.push({ trigger: t, at: at.toISOString() })
      }
      return out
    },
    async markScheduled(id, at) {
      const ms = Date.parse(at)
      if (Number.isNaN(ms)) throw new ValidationError('at must be an ISO timestamp')
      return casUpdate<TriggerData>('trigger', id, (t) =>
        t.data.lastScheduledAt && Date.parse(t.data.lastScheduledAt) >= ms
          ? null
          : { lastScheduledAt: new Date(ms).toISOString() },
      )
    },
  }

  const subKey = (sessionId: string, subject: Subject) => `${sessionId}|${subjectKey(subject)}`

  const endWhere = async (conds: Condition[], reason: string) => {
    const subs = (
      await records.query<SubscriptionData>('subscription', { where: [...conds, { field: 'active', op: 'eq', value: true }] })
    ).items
    let n = 0
    for (const s of subs) {
      let ended = false
      await casUpdate<SubscriptionData>('subscription', s.id, (cur) => {
        if (!cur.data.active) return null
        ended = true
        return { active: false, endedReason: reason }
      })
      if (ended) n++
    }
    return n
  }

  const subscriptions: Subscriptions = {
    async subscribe(sessionId, subject, o = {}) {
      if (!sessionId) throw new ValidationError('sessionId is required')
      const subj = checkSubject(subject, 'subject')
      if (o.types !== undefined && (!Array.isArray(o.types) || o.types.some((t) => typeof t !== 'string')))
        throw new ValidationError('types must be a list of strings')
      if (o.filter !== undefined) eventFilter(o.filter)
      const data: SubscriptionData = {
        sessionId,
        subject: subj,
        subjectKey: subjectKey(subj),
        primary: o.primary ?? false,
        ...(o.types ? { types: o.types } : {}),
        ...(o.filter !== undefined ? { filter: o.filter } : {}),
        active: true,
      }
      validateRecord(records.kinds.get('subscription'), data)
      const { record, created } = await records.store.records.createOrGet<SubscriptionData>(
        'subscription',
        subKey(sessionId, subj),
        data,
        {
          prefix: subscriptionSchema.prefix,
          ...(o.actor ? { actor: o.actor } : {}),
        },
      )
      if (created) return record
      return casUpdate<SubscriptionData>('subscription', record.id, (cur) => {
        const patch: Partial<SubscriptionData> = {}
        if (!cur.data.active) {
          patch.active = true
          patch.endedReason = undefined
        }
        if (o.primary !== undefined && o.primary !== cur.data.primary) patch.primary = o.primary
        if (o.filter !== undefined) patch.filter = o.filter
        if (o.types !== undefined && JSON.stringify(o.types) !== JSON.stringify(cur.data.types)) patch.types = o.types
        else if (o.types === undefined && !cur.data.active && cur.data.types !== undefined) patch.types = undefined
        return Object.keys(patch).length ? patch : null
      })
    },
    async unsubscribe(sessionId, subject) {
      const existing = await records.getByKey<SubscriptionData>(
        'subscription',
        subKey(sessionId, checkSubject(subject, 'subject')),
      )
      if (!existing) return
      await casUpdate<SubscriptionData>('subscription', existing.id, (cur) =>
        cur.data.active ? { active: false, endedReason: 'unsubscribed' } : null,
      )
    },
    async forSubject(subject, eventType) {
      const subs = (
        await records.query<SubscriptionData>('subscription', {
          where: { subjectKey: subjectKey(checkSubject(subject, 'subject')), active: true },
          orderBy: { field: 'createdAt' },
        })
      ).items
      if (eventType === undefined) return subs
      return subs.filter((s) => !s.data.types || s.data.types.some((g) => globMatch(g, eventType)))
    },

    async forEvent(event) {
      if (!event.subject) return []
      const subs = await subscriptions.forSubject(event.subject, event.type)
      return subs.filter((s) => s.data.filter === undefined || eventFilter(s.data.filter)(event))
    },
    async forSession(sessionId) {
      return (
        await records.query<SubscriptionData>('subscription', {
          where: { sessionId, active: true },
          orderBy: { field: 'createdAt' },
        })
      ).items
    },
    async transfer(fromSessionId, toSessionId) {
      if (fromSessionId === toSessionId) return subscriptions.forSession(toSessionId)
      const out: Subscription[] = []
      for (const s of await subscriptions.forSession(fromSessionId)) {
        out.push(
          await subscriptions.subscribe(toSessionId, s.data.subject, {
            primary: s.data.primary,
            ...(s.data.types ? { types: s.data.types } : {}),
          }),
        )
        await casUpdate<SubscriptionData>('subscription', s.id, (cur) =>
          cur.data.active ? { active: false, endedReason: `transferred to ${toSessionId}` } : null,
        )
      }
      return out
    },
    endForSubject: (subject, reason) =>
      endWhere([{ field: 'subjectKey', op: 'eq', value: subjectKey(checkSubject(subject, 'subject')) }], reason),
    endForSession: (sessionId, reason) => endWhere([{ field: 'sessionId', op: 'eq', value: sessionId }], reason),
  }

  const events: Events = {
    async ingest(input) {
      if (!input || typeof input.source !== 'string' || !input.source) throw new ValidationError('event source is required')
      if (typeof input.type !== 'string' || !input.type) throw new ValidationError('event type is required')
      const subject = input.subject ? checkSubject(input.subject, 'event subject') : undefined
      const key = input.dedupeKey ?? defaultDedupeKey({ ...input, ...(subject ? { subject } : {}) })
      if (!key) throw new ValidationError('dedupeKey must not be empty')
      const data: EventData = {
        source: input.source,
        type: input.type,
        ...(subject ? { subject, subjectKey: subjectKey(subject) } : {}),
        ...(input.actorContactId ? { actorContactId: input.actorContactId } : {}),
        ...(input.employeeId ? { employeeId: input.employeeId } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        routed: false,
        receivedAt: clock.iso(),
      }
      validateRecord(records.kinds.get('event'), data)
      let res: { record: MpEvent; created: boolean }
      try {
        res = await records.store.records.createOrGet<EventData>('event', key, data, { prefix: eventSchema.prefix })
      } catch (e) {
        // A racing writer created it between the check and the insert (possible in some adapters): read it back.
        if (!(e instanceof ConflictError)) throw e
        const existing = await records.getByKey<EventData>('event', key)
        if (!existing) throw e
        res = { record: existing, created: false }
      }
      bus?.publish<EventIngested>(EventTopics.ingested, { eventId: res.record.id, created: res.created })
      return { event: res.record, created: res.created }
    },
    get: (id) => records.get<EventData>('event', id),
    async require(id) {
      const e = await records.get<EventData>('event', id)
      if (!e) throw new NotFoundError('event', id)
      return e
    },
    markRouted: (id) =>
      casUpdate<EventData>('event', id, (e) => (e.data.routed ? null : { routed: true, routedAt: clock.iso() })),
    async query(q = {}) {
      const where: Condition[] = []
      if (q.source !== undefined) where.push({ field: 'source', op: 'eq', value: q.source })
      if (q.type !== undefined) where.push({ field: 'type', op: 'eq', value: q.type })
      if (q.routed !== undefined) where.push({ field: 'routed', op: 'eq', value: q.routed })
      if (q.subjectKey !== undefined) where.push({ field: 'subjectKey', op: 'eq', value: q.subjectKey })
      if (q.since !== undefined) where.push({ field: 'receivedAt', op: 'gte', value: q.since })
      return (
        await records.query<EventData>('event', {
          where,
          orderBy: { field: 'receivedAt' },
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
        })
      ).items
    },
    triggers,
    subscriptions,
  }
  return events
}
