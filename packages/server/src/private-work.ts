import { errorMessage, type EventBus, type Json, type Logger } from '@mp/core'
import type { ChannelData, MessageData } from '@mp/chat'
import type { Events } from '@mp/events'
import type { Records } from '@mp/records'
import type { Run, Session, Sessions } from '@mp/sessions'
import type { LinkChanged, RecordChanged } from '@mp/store'
import { covers, dmMarkOfEvent, isIntegrationDm, markOf, mergeMarks, type PrivateMark } from './auth/visibility.ts'

/**
 * Work that came from a direct message is private (docs/spec.md "Sign-in and roles").
 * This marks it when it happens, so reading the rule (src/auth/visibility.ts) is cheap:
 *
 * - an integration event that is a DM gets a `private` marker at ingest (harness chat
 *   DMs are known by their channel);
 * - a run caused by a DM event, or started by a private run, is marked, and so is its
 *   session, unless the session is a shared context (a router context, a procedure
 *   context or a trigger's context): there only the run and the entries it writes are
 *   private, so the context stays readable with those entries redacted;
 * - a delivery of a DM event to a session's inbox marks the session;
 * - forks and loop children of a private session are private too;
 * - a session subscribing to, or linked to, a harness DM thread becomes private.
 *
 * Markers only ever grow: a session never becomes public again.
 */
export interface PrivateWorkDeps {
  records: Records
  logger: Logger
}

const toJson = (m: PrivateMark): Json => ({ contacts: m.contacts, channels: m.channels })

/** `meta.role`s of shared contexts. */
const CONTEXT_ROLES = new Set(['router', 'router-retired'])

/** Whether a session is shared by many requests: its DM work is marked per run, not as a whole. */
export async function isSharedContext(records: Records, session: Session): Promise<boolean> {
  const meta = session.data.meta ?? {}
  if (CONTEXT_ROLES.has(String(meta.role ?? ''))) return true
  if (meta.procedureContext === true) return true
  const triggers = await records.query('trigger', { where: { contextId: session.id }, limit: 1 })
  return triggers.total > 0
}

/** Adds `mark` to a record's `private` marker, unless it already has it. */
async function addMark<R extends { id: string; data: Record<string, unknown> }>(
  records: Records,
  kind: string,
  r: R,
  mark: PrivateMark,
): Promise<R> {
  const current = markOf(r)
  if (covers(current, mark)) return r
  return (await records.update(kind, r.id, { private: mergeMarks(current, mark) })) as unknown as R
}

/** Wraps the sessions service so runs, forks and inbox deliveries mark private work. */
export function privateSessions(inner: Sessions, deps: PrivateWorkDeps): Sessions {
  const { records } = deps

  const markSession = async (sessionId: string, mark: PrivateMark | null) => {
    if (!mark) return
    const session = await inner.get(sessionId)
    if (!session || (await isSharedContext(records, session))) return
    await addMark(records, 'session', session, mark)
  }

  /** The marker a new run gets: from the event that caused it, and from the run that started it. */
  const markForRun = async (cause: Run['data']['cause']): Promise<PrivateMark | null> => {
    let mark: PrivateMark | null = null
    if (cause.eventId) mark = await dmMarkOfEvent(deps, await records.get('event', cause.eventId))
    if (cause.parentRunId) {
      const parent = await inner.getRun(cause.parentRunId)
      if (parent) {
        mark = mergeMarks(mark, markOf(parent))
        mark = mergeMarks(mark, markOf(await inner.get(parent.data.sessionId)))
      }
    }
    return mark
  }

  const inherit = async (fork: Session, parentId: string): Promise<Session> => {
    const mark = markOf(await inner.get(parentId))
    return mark ? addMark(records, 'session', fork, mark) : fork
  }

  return {
    ...inner,
    async createRun(input) {
      const mark = await markForRun(input.cause)
      // The session first: nothing of the run is visible before its session is private.
      await markSession(input.sessionId, mark)
      // The entries it starts with carry the marker too: they exist before the run record is marked.
      const marked = mark
        ? { ...input, input: (input.input ?? []).map((e) => ({ ...e, meta: { ...(e.meta ?? {}), private: toJson(mark) } })) }
        : input
      const run = await inner.createRun(marked)
      return mark ? addMark(records, 'run', run, mark) : run
    },
    async fork(sessionId, o) {
      return inherit(await inner.fork(sessionId, o), sessionId)
    },
    async loop(sessionId, items, o) {
      const children = await inner.loop(sessionId, items, o)
      return Promise.all(children.map((c) => inherit(c, sessionId)))
    },
    async addToInbox(input) {
      const { sessionId, eventId } = input as { sessionId: string; eventId?: string }
      if (eventId) await markSession(sessionId, await dmMarkOfEvent(deps, await records.get('event', eventId)))
      return inner.addToInbox(input)
    },
  }
}

/** Wraps the events service so integration DMs are marked private at ingest. */
export function privateEvents(inner: Events, deps: PrivateWorkDeps): Events {
  return {
    ...inner,
    async ingest(input) {
      const res = await inner.ingest(input)
      if (!res.created || markOf(res.event) || !isIntegrationDm(res.event.data)) return res
      const mark: PrivateMark = { contacts: res.event.data.actorContactId ? [res.event.data.actorContactId] : [], channels: [] }
      try {
        return { ...res, event: await addMark(deps.records, 'event', res.event, mark) }
      } catch (err) {
        deps.logger.error('could not mark a DM event private', { eventId: res.event.id, err: errorMessage(err) })
        return res
      }
    },
  }
}

/**
 * Marks sessions that subscribe to, or are linked to, a harness DM (a DM channel, or a message
 * or thread in one). Returns the unsubscribe function.
 */
export function watchDmLinks(bus: EventBus, sessions: Sessions, deps: PrivateWorkDeps): () => void {
  const { records } = deps
  const dmMark = async (ref: { kind: string; id: string }): Promise<PrivateMark | null> => {
    let channelId: string | null = null
    if (ref.kind === 'channel') channelId = ref.id
    else if (ref.kind === 'message' || ref.id.startsWith('msg_'))
      channelId = (await records.get<MessageData>('message', ref.id))?.data.channelId ?? null
    if (!channelId) return null
    const ch = await records.get<ChannelData>('channel', channelId)
    if (ch?.data.dm !== true) return null
    const members = await records.links({ from: { kind: 'channel', id: channelId }, role: 'member' })
    return { contacts: members.filter((l) => l.to.kind === 'contact').map((l) => l.to.id), channels: [channelId] }
  }
  const mark = async (sessionId: string, m: PrivateMark | null) => {
    if (!m) return
    const session = await sessions.get(sessionId)
    if (!session || (await isSharedContext(records, session))) return
    await addMark(records, 'session', session, m)
  }
  const guarded =
    <T>(what: string, fn: (payload: T) => Promise<void>) =>
    async (m: { payload: T }) => {
      try {
        await fn(m.payload)
      } catch (err) {
        deps.logger.error(`could not mark ${what} private`, { err: errorMessage(err) })
      }
    }
  const offs = [
    bus.subscribe<RecordChanged>(
      'record.changed',
      guarded('a subscribed session', async (p) => {
        if (p.kind !== 'subscription' || p.op !== 'create') return
        const sub = await records.get<{ sessionId: string; subject: { system: string; id: string } }>('subscription', p.id)
        if (sub?.data.subject.system !== 'mp') return
        await mark(sub.data.sessionId, await dmMark({ kind: 'message', id: sub.data.subject.id }))
      }),
    ),
    bus.subscribe<LinkChanged>(
      'link.changed',
      guarded('a linked session', async ({ from, to, op }) => {
        if (op !== 'link') return
        const [session, other] = from.kind === 'session' ? [from, to] : to.kind === 'session' ? [to, from] : [null, null]
        if (!session || !other || (other.kind !== 'channel' && other.kind !== 'message')) return
        await mark(session.id, await dmMark(other))
      }),
    ),
  ]
  return () => {
    for (const off of offs) off()
  }
}
