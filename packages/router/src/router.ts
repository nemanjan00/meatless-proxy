import { defineHook, errorMessage, isMpError, silentLogger, type EventBus, type Hooks, type Json, type Logger } from '@mp/core'
import type { Events, MpEvent, Subject, Trigger } from '@mp/events'
import type { Queue } from '@mp/queue'
import type { EntryKind, EventContent, RunMode, Session, Sessions } from '@mp/sessions'

/** Queue names shared by the router, the runner and the server. */
export const QUEUES = {
  events: 'events',
  runs: 'runs',
} as const

/** Why a session receives an event. The first matching rule wins for each session. */
export type DeliveryReason =
  | 'session_tag'
  | 'subscription'
  | 'member'
  | 'employee_tag'
  | 'thread_participant'
  | 'trigger'
  | 'fallback'

export interface Delivery {
  sessionId: string
  reason: DeliveryReason
  /** Tagged, primary subscriber, or the context a trigger assigned. Others get it as context only. */
  expectedToAct: boolean
  /**
   * The session expected this input (subscription, direct tag, membership).
   * Input that arrives through triggers or the fallback is untrusted and is
   * judged critically by the receiving context.
   */
  trusted: boolean
  /** Route to a fork of the session instead of the session itself. */
  fork: boolean
  mode?: RunMode
  triggerId?: string
  subscriptionId?: string
  priority: number
}

export type DeliveryOutcome =
  | { type: 'run'; runId: string; sessionId: string }
  | { type: 'inbox'; inboxId: string; sessionId: string; runId: string }
  | { type: 'woke'; runId: string; sessionId: string; inboxId: string }
  | { type: 'skipped'; sessionId: string; reason: string }

export interface RouteResult {
  eventId: string
  deliveries: (Delivery & { outcome: DeliveryOutcome })[]
}

/**
 * Something the router can't know by itself: extra recipients for an event,
 * e.g. the sessions that are members of a chat channel. Registered by higher
 * layers, so the router stays generic.
 */
export type RecipientResolver = (event: MpEvent) => Promise<Omit<Delivery, 'priority'>[]>

/** Decides whether a delivery goes ahead: `{ skip }` drops it, `{ pause }` creates the run paused. */
export const beforeDeliver = defineHook<{ event: MpEvent; delivery: Delivery }, { skip: string } | { pause: string }>(
  'router.beforeDeliver',
)

/** An entry to add to a run's input. */
export interface InputEntry {
  kind: EntryKind
  content: Json
  meta?: Record<string, Json>
}

/** Payload of `runInput`: `entries` go into the new run, after the session's history and before the event. */
export interface RunInputPayload {
  event: MpEvent
  delivery: Delivery
  /** The session the delivery was for (the context, when it was forked). */
  context: Session
  /** The session the new run runs in: the fork when the context was forked, else the context itself. */
  session: Session
  /** Set when the context was forked for this delivery. */
  fork?: Session
  entries: InputEntry[]
}

/**
 * Runs before the router starts a new run for a delivery (in the context
 * itself or in a fork of it). A transform hook: handlers may add `entries`
 * (e.g. recalled memories), which go into the run after the session's history
 * and before the event, so the session keeps its cached prefix. Deliveries
 * into a running session's inbox don't pass through it.
 */
export const runInput = defineHook<RunInputPayload>('router.runInput')

export interface RouterOptions {
  events: Events
  sessions: Sessions
  queue: Queue
  hooks?: Hooks
  bus?: EventBus
  logger?: Logger
  /** The router session of an employee (or the default router when no employee is given). */
  routerSessionFor: (employeeId?: string) => Promise<string | null>
  /** The context session of a procedure. */
  procedureContext: (procedureId: string) => Promise<string | null>
  /** Resolves `@employee` tags in an event to employee ids. Defaults to reading chat-style tags from the payload. */
  tagsOf?: (event: MpEvent) => EventTags
  resolvers?: RecipientResolver[]
  /**
   * Employees taking part in the conversation an event belongs to, e.g. those
   * whose sessions already posted in a chat thread. A person's untagged reply
   * there goes to that employee's router, unless one of its sessions already
   * acts on it: a follow-up doesn't need a new tag.
   */
  participantsOf?: (event: MpEvent) => Promise<string[]>
  /** Priority for runs caused by a person (`actorContactId` of a non-AI contact). */
  humanPriority?: number
  /** Whether an event's actor is a person (as opposed to an AI employee or a system). */
  isHuman?: (event: MpEvent) => Promise<boolean>
}

export interface EventTags {
  sessions: string[]
  employees: string[]
  /** Sessions that authored the event (their own messages aren't delivered back to them). */
  authorSessionId?: string
}

/** Reads chat tags (`@mp/chat` payloads) from an event. */
export function chatTags(event: MpEvent): EventTags {
  const p = event.data.payload as any
  const tags: any[] = Array.isArray(p?.tags) ? p.tags : []
  return {
    sessions: tags.filter((t) => t?.type === 'session' && typeof t.sessionId === 'string').map((t) => t.sessionId),
    employees: tags.filter((t) => t?.type === 'employee' && typeof t.employeeId === 'string').map((t) => t.employeeId),
    // Who acted: the reactor for a reaction (`by`), else the message's author.
    ...(actorSession(p) ? { authorSessionId: actorSession(p)! } : {}),
  }
}

function actorSession(p: any): string | undefined {
  const who = p?.by ?? p?.author
  return who?.kind === 'session' && typeof who.id === 'string' ? who.id : undefined
}

/** The text a session sees for an event. */
export function renderEvent(event: MpEvent, maxChars = 4000): string {
  const d = event.data
  const subject = d.subject
    ? d.subject.system === 'mp'
      ? ` thread ${d.subject.id}`
      : ` ${d.subject.system}:${d.subject.id}`
    : ''
  // Who it's from, so the receiving session can decide whether a reply is needed.
  const author = (d.payload as any)?.by ?? (d.payload as any)?.author
  const from =
    author?.kind === 'session'
      ? '; from another AI session'
      : author?.contactKind === 'agent'
        ? `; from another AI agent (${author.name ?? author.id}${author.onBehalfOf ? `, on behalf of ${author.onBehalfOf}` : ''})`
        : author?.kind === 'contact'
          ? '; from a person'
          : ''
  // When it arrived, so the session knows what time it is (new content only: the cached prefix is untouched).
  const at = eventTime(d.receivedAt)
  const head = `[${d.source} ${d.type}${subject}${from}${at ? `; ${at}` : ''}]`
  const body =
    d.text ?? (typeof d.payload === 'string' ? d.payload : d.payload === undefined ? '' : JSON.stringify(d.payload, null, 2))
  const text = `${head}\n${body}`
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated, ${text.length - maxChars} more characters)` : text
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** An event's time for the model: `Tue 2026-09-29 12:07 UTC`. Empty for a missing or unparsable time. */
export function eventTime(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`
}

/** A readable title for a fork that handles one event: the start of its text, else its type. */
export function forkTitle(contextTitle: string, event: MpEvent): string {
  const p = event.data.payload as any
  const raw = (typeof event.data.text === 'string' && event.data.text) || (typeof p?.text === 'string' && p.text) || ''
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return `${contextTitle}: ${event.data.type}`
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text
}

export interface Router {
  /** Works out who gets an event, without delivering anything. */
  plan(event: MpEvent): Promise<Delivery[]>
  /** Plans and delivers an event, marks it routed, and returns what happened. Safe to call twice for the same event. */
  route(eventId: string): Promise<RouteResult>
  /** Delivers directly to a session (used by the UI, `sessions.message`, and tests). */
  deliver(event: MpEvent, delivery: Delivery): Promise<DeliveryOutcome>
}

export function createRouter(opts: RouterOptions): Router {
  const logger = opts.logger ?? silentLogger
  const tagsOf = opts.tagsOf ?? chatTags
  const humanPriority = opts.humanPriority ?? 10

  const byPerson = async (event: MpEvent) => (opts.isHuman ? await opts.isHuman(event) : !!event.data.actorContactId)

  const plan = async (event: MpEvent): Promise<Delivery[]> => {
    const human = await byPerson(event)
    const priority = human ? humanPriority : 0
    const out = new Map<string, Delivery>()
    const tags = tagsOf(event)
    const add = (d: Omit<Delivery, 'priority'>) => {
      // Never deliver a session's own message back to it.
      if (d.sessionId === tags.authorSessionId) return
      if (!out.has(d.sessionId)) out.set(d.sessionId, { ...d, priority })
    }
    const subject: Subject | undefined = event.data.subject

    // 1. Direct session tags.
    for (const sessionId of tags.sessions) {
      add({ sessionId, reason: 'session_tag', expectedToAct: true, trusted: true, fork: false })
    }

    // 2. Subscriptions to the subject. Tags decide who acts; without tags, the primary subscriber does.
    if (subject) {
      const subs = await opts.events.subscriptions.forEvent(event.data)
      const anyTags = tags.sessions.length > 0 || tags.employees.length > 0
      for (const s of subs) {
        const session = await opts.sessions.get(s.data.sessionId)
        if (!session) continue
        const tagged = tags.employees.includes(session.data.employeeId)
        add({
          sessionId: s.data.sessionId,
          reason: 'subscription',
          expectedToAct: anyTags ? tagged : s.data.primary,
          trusted: true,
          fork: false,
          subscriptionId: s.id,
        })
      }
    }

    // 2b. Extra recipients from higher layers (e.g. channel members).
    for (const resolve of opts.resolvers ?? []) {
      for (const d of await resolve(event)) add(d)
    }

    const claimed = () => [...out.values()].some((d) => d.expectedToAct)

    // 3. Employee tags go to that employee's router, unless one of its sessions already acts on it.
    for (const employeeId of tags.employees) {
      let handled = false
      for (const d of out.values()) {
        if (!d.expectedToAct) continue
        if ((await opts.sessions.get(d.sessionId))?.data.employeeId === employeeId) handled = true
      }
      if (handled) continue
      const routerSession = await opts.routerSessionFor(employeeId)
      if (routerSession)
        add({ sessionId: routerSession, reason: 'employee_tag', expectedToAct: true, trusted: true, fork: false })
    }

    // 4. Triggers, only for work nobody has claimed yet.
    if (!claimed()) {
      const triggers = await opts.events.triggers.match(event)
      const t = triggers[0]
      if (t) {
        const target = await triggerTarget(t)
        if (target) {
          add({
            sessionId: target,
            reason: 'trigger',
            expectedToAct: true,
            trusted: false,
            fork: t.data.fork || t.data.target.type === 'procedure',
            mode: t.data.mode,
            triggerId: t.id,
          })
        }
      }
    }

    // 4b. Untagged follow-ups from a person go to the employees already in the conversation (when no trigger took them).
    const untagged = tags.sessions.length === 0 && tags.employees.length === 0
    if (!claimed() && untagged && !tags.authorSessionId && opts.participantsOf && human) {
      for (const employeeId of await opts.participantsOf(event)) {
        let handled = false
        for (const d of out.values()) {
          if (!d.expectedToAct) continue
          if ((await opts.sessions.get(d.sessionId))?.data.employeeId === employeeId) handled = true
        }
        if (handled) continue
        const routerSession = await opts.routerSessionFor(employeeId)
        if (routerSession)
          add({ sessionId: routerSession, reason: 'thread_participant', expectedToAct: true, trusted: true, fork: false })
      }
    }

    // 5. Fallback: the router session of the employee (or the default router).
    // Not for a session's own message, and not for plain conversation in chat: a message
    // that tags nobody, in a channel no trigger listens to, is people talking to each other.
    const plainChat = event.data.source === 'chat' && tags.sessions.length === 0 && tags.employees.length === 0
    if (!claimed() && !tags.authorSessionId && !plainChat) {
      const fallback = await opts.routerSessionFor(event.data.employeeId)
      if (fallback) add({ sessionId: fallback, reason: 'fallback', expectedToAct: true, trusted: false, fork: false })
    }

    return [...out.values()]
  }

  const triggerTarget = async (t: Trigger): Promise<string | null> => {
    const target = t.data.target
    switch (target.type) {
      case 'session':
        return target.sessionId
      case 'procedure':
        return opts.procedureContext(target.procedureId)
      case 'router':
        return opts.routerSessionFor(t.data.employeeId)
    }
  }

  const eventEntry = (event: MpEvent, d: Delivery): { kind: 'event'; content: Json; meta: Record<string, Json> } => ({
    kind: 'event',
    content: {
      eventId: event.id,
      source: event.data.source,
      type: event.data.type,
      text: renderEvent(event),
      trusted: d.trusted,
      expectedToAct: d.expectedToAct,
    } satisfies EventContent as unknown as Json,
    meta: { eventId: event.id, reason: d.reason, ...(d.triggerId ? { triggerId: d.triggerId } : {}) },
  })

  const enqueue = (runId: string, priority: number) => opts.queue.add(QUEUES.runs, { runId }, { jobId: runId, priority })
  let seq = 0
  /** A woken run's previous job may still be active; a fresh job id makes sure it's picked up. */
  const requeue = (runId: string, priority: number) =>
    opts.queue.add(QUEUES.runs, { runId }, { jobId: `wake:${runId}:${Date.now()}:${++seq}`, priority })

  const deliver = async (event: MpEvent, d: Delivery): Promise<DeliveryOutcome> => {
    const decision = opts.hooks ? await opts.hooks.decide(beforeDeliver, { event, delivery: d }) : undefined
    if (decision && 'skip' in decision) return { type: 'skipped', sessionId: d.sessionId, reason: decision.skip }

    let sessionId = d.sessionId
    const session = await opts.sessions.get(sessionId)
    if (!session) return { type: 'skipped', sessionId, reason: 'session not found' }

    // Forks: a fresh fork of the context handles this one event.
    let runSession = session
    let fork: Session | undefined
    if (d.fork) {
      fork = await opts.sessions.fork(sessionId, { title: forkTitle(session.data.title, event) })
      sessionId = fork.id
      runSession = fork
    }
    const inputFor = async (): Promise<InputEntry[]> =>
      opts.hooks
        ? (
            await opts.hooks.transform(runInput, {
              event,
              delivery: d,
              context: session,
              session: runSession,
              ...(fork ? { fork } : {}),
              entries: [],
            })
          ).entries
        : []

    const mode: RunMode = d.mode ?? (d.reason === 'trigger' || d.reason === 'fallback' ? 'ephemeral' : 'continuing')

    // A continuing run in progress: the delivery waits in the inbox and is seen at the next step.
    if (mode === 'continuing' && !d.fork) {
      const active = await opts.sessions.activeContinuingRun(sessionId)
      if (active) {
        const item = await opts.sessions.addToInbox({
          sessionId,
          eventId: event.id,
          expectedToAct: d.expectedToAct,
          trusted: d.trusted,
          text: renderEvent(event),
          source: event.data.source,
          type: event.data.type,
        })
        if (decision && 'pause' in decision && (active.data.state === 'suspended' || active.data.state === 'queued')) {
          // e.g. the AI-to-AI streak limit: stop the conversation until a person looks at it.
          try {
            await opts.sessions.transition(active.id, active.data.state, 'paused', { pauseReason: decision.pause })
          } catch (err) {
            if (!isMpError(err, 'conflict')) throw err
          }
          return { type: 'inbox', inboxId: item.id, sessionId, runId: active.id }
        }
        if (active.data.state === 'suspended' && active.data.wait?.type === 'delivery') {
          try {
            await opts.sessions.transition(active.id, 'suspended', 'queued')
            await requeue(active.id, Math.max(d.priority, active.data.priority))
            return { type: 'woke', runId: active.id, sessionId, inboxId: item.id }
          } catch (err) {
            if (!isMpError(err, 'conflict')) throw err
          }
        }
        return { type: 'inbox', inboxId: item.id, sessionId, runId: active.id }
      }
    }

    const run = await opts.sessions.createRun({
      sessionId,
      mode,
      cause: { type: 'event', eventId: event.id, note: d.reason },
      ...(event.data.actorContactId ? { requesterId: event.data.actorContactId } : {}),
      priority: d.priority,
      input: [...(await inputFor()), eventEntry(event, d)],
    })
    if (decision && 'pause' in decision) {
      await opts.sessions.transition(run.id, 'queued', 'paused', { pauseReason: decision.pause })
      return { type: 'run', runId: run.id, sessionId }
    }
    await enqueue(run.id, d.priority)
    return { type: 'run', runId: run.id, sessionId }
  }

  return {
    plan,
    deliver,
    async route(eventId) {
      const event = await opts.events.require(eventId)
      if (event.data.routed) return { eventId, deliveries: [] }
      const deliveries = await plan(event)
      const results: RouteResult['deliveries'] = []
      for (const d of deliveries) {
        try {
          results.push({ ...d, outcome: await deliver(event, d) })
          if (d.triggerId) await opts.events.triggers.recordFired(d.triggerId)
        } catch (err) {
          logger.error('delivery failed', { eventId, sessionId: d.sessionId, err: errorMessage(err) })
          results.push({ ...d, outcome: { type: 'skipped', sessionId: d.sessionId, reason: errorMessage(err) } })
        }
      }
      await opts.events.markRouted(eventId)
      opts.bus?.publish('event.routed', {
        eventId,
        deliveries: results.map((r) => ({ sessionId: r.sessionId, reason: r.reason, outcome: r.outcome.type })),
      })
      logger.info('event routed', { eventId, deliveries: results.length })
      return { eventId, deliveries: results }
    },
  }
}
