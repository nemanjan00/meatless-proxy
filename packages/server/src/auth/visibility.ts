import { NotFoundError, type Json } from '@mp/core'
import type { ChannelData, MessageData } from '@mp/chat'
import type { EventData } from '@mp/events'
import type { Run, Session } from '@mp/sessions'
import type { Entry, StoredRecord } from '@mp/store'
import type { Records } from '@mp/records'
import type { Services } from '../services.ts'

/**
 * The marker on work that came from a direct message: a session, a run or an
 * integration event carries it as its `private` field. Set when it happens
 * (see src/private-work.ts), so reading it is cheap. The people who may read
 * it: the `contacts` listed, and whoever is a member of one of the harness DM
 * `channels` now.
 */
export interface PrivateMark {
  contacts: string[]
  channels: string[]
}

/** Who is looking: a contact (plus the agents acting for them, over MCP), and whether they are an admin. */
export interface Viewer {
  contactId: string
  admin?: boolean
  /** Other contact ids that read as this viewer (a local agent's own DMs). */
  also?: string[]
}

/** How much of a private session a viewer gets: all of it, that it exists (admins), or nothing. */
export type SessionAccess = 'full' | 'redacted' | 'none'

/** The title a private session shows to an admin who isn't one of its DM's members. */
export const PRIVATE_TITLE = 'Private session (a direct message)'
const PRIVATE_TEXT = '(private: this came from a direct message)'

/** The `private` marker of a session, run or event record, if it has one. */
export function markOf(r: { data: Record<string, unknown> } | null | undefined): PrivateMark | null {
  const m = r?.data.private as { contacts?: unknown; channels?: unknown } | undefined
  if (!m || typeof m !== 'object') return null
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return { contacts: list(m.contacts), channels: list(m.channels) }
}

/** Two markers as one (both DMs' members may read). */
export function mergeMarks(a: PrivateMark | null, b: PrivateMark | null): PrivateMark | null {
  if (!a) return b
  if (!b) return a
  return { contacts: [...new Set([...a.contacts, ...b.contacts])], channels: [...new Set([...a.channels, ...b.channels])] }
}

/** Whether `a` already covers everything in `b` (so marking again changes nothing). */
export function covers(a: PrivateMark | null, b: PrivateMark): boolean {
  if (!a) return false
  return b.contacts.every((c) => a.contacts.includes(c)) && b.channels.every((c) => a.channels.includes(c))
}

/**
 * Whether an integration event is a direct message, from its payload: Slack's `im`
 * and `mpim` channels (reactions carry no channel type: DM channel ids start with D),
 * a `*.direct` type, or a `dm: true` flag.
 */
export function isIntegrationDm(data: Pick<EventData, 'source' | 'type' | 'payload'>): boolean {
  if (data.source === 'chat') return false
  const p = (data.payload ?? {}) as Record<string, Json>
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return data.type.endsWith('.direct')
  if (p.channel_type === 'im' || p.channel_type === 'mpim') return true
  if (p.dm === true || p.isDm === true || p.is_dm === true) return true
  if (data.type.endsWith('.direct')) return true
  return data.source === 'slack' && p.channel_type === undefined && typeof p.channel === 'string' && p.channel.startsWith('D')
}

/**
 * The private marker an event gives the work it causes, or null when it isn't a DM:
 * a message in a harness DM (its members), or an integration DM (the person who wrote it).
 * An event already marked at ingest keeps its marker.
 */
export async function dmMarkOfEvent(
  deps: { records: Records },
  e: { data: Record<string, unknown> } | null | undefined,
): Promise<PrivateMark | null> {
  if (!e) return null
  const own = markOf(e)
  if (own) return own
  const data = e.data as unknown as EventData
  if (data.source === 'chat') {
    const channelId = (data.payload as { channelId?: unknown } | null | undefined)?.channelId
    if (typeof channelId !== 'string') return null
    const ch = await deps.records.get<ChannelData>('channel', channelId)
    if (ch?.data.dm !== true) return null
    const members = await deps.records.links({ from: { kind: 'channel', id: channelId }, role: 'member' })
    return { contacts: members.filter((l) => l.to.kind === 'contact').map((l) => l.to.id), channels: [channelId] }
  }
  if (!isIntegrationDm(data)) return null
  return { contacts: data.actorContactId ? [data.actorContactId] : [], channels: [] }
}

/** A private session as an admin who isn't in its DM sees it: that it exists, and nothing it holds. */
export function redactSession<S extends Session>(session: S): S {
  const d = session.data
  return {
    ...session,
    data: {
      title: PRIVATE_TITLE,
      slug: d.slug,
      employeeId: d.employeeId,
      status: d.status,
      head: null,
      rootId: d.rootId,
      ...(d.parent ? { parent: { sessionId: d.parent.sessionId, entryId: null } } : {}),
      depth: d.depth,
      toolset: [],
      document: '',
      meta: { redacted: true },
      private: { contacts: [], channels: [] },
    },
  } as S
}

/** An entry whose content is private: its kind, id, place in the tree and when, but no content. */
export function redactEntry<E extends Entry>(e: E): E {
  const text = PRIVATE_TEXT
  const content: Json =
    e.kind === 'assistant'
      ? { text }
      : e.kind === 'tool_result'
        ? { toolCallId: '', name: 'private', output: text }
        : e.kind === 'event'
          ? { eventId: '', source: 'private', type: 'private', text, trusted: false, expectedToAct: false }
          : e.kind === 'summary'
            ? { text, rewoundTo: '', replacesTip: '' }
            : e.kind === 'pointer'
              ? { text, original: '' }
              : { text }
  const meta: Record<string, Json> = { redacted: true }
  for (const k of ['sessionId', 'employeeId', 'runId']) if (typeof e.meta[k] === 'string') meta[k] = e.meta[k]
  return { ...e, content, meta }
}

/**
 * Who may see which chat: direct messages are visible only to their members,
 * admins included (an admin can't read other people's DMs). Named channels
 * are visible to everyone signed in.
 */
export class ChatVisibility {
  constructor(private s: Pick<Services, 'records' | 'chat' | 'store' | 'sessions'>) {}

  /** The ids of DMs this contact is not a member of. */
  async hiddenChannels(contactId: string): Promise<Set<string>> {
    return (await this.dmChannels(contactId)).hidden
  }

  /** The ids of DMs, split into the ones this contact is a member of and the ones hidden from them. */
  async dmChannels(contactId: string): Promise<{ member: Set<string>; hidden: Set<string> }> {
    const dms = await this.s.records.query<ChannelData>('channel', { where: { dm: true }, limit: 100_000 })
    if (!dms.items.length) return { member: new Set(), hidden: new Set() }
    const mine = await this.s.store.links.query({ to: { kind: 'contact', id: contactId }, role: 'member' })
    const linked = new Set(mine.filter((l) => l.from.kind === 'channel').map((l) => l.from.id))
    const member = new Set<string>()
    const hidden = new Set<string>()
    for (const c of dms.items) (linked.has(c.id) ? member : hidden).add(c.id)
    return { member, hidden }
  }

  /** Whether the contact may see the channel (unknown channels: true, so the caller answers 404). */
  async canSeeChannel(contactId: string, channelId: string): Promise<boolean> {
    const ch = await this.s.records.get<ChannelData>('channel', channelId)
    if (ch?.data.dm !== true) return true
    return (await this.s.chat.members(channelId)).some((m) => m.kind === 'contact' && m.id === contactId)
  }

  /** Throws 404 (not 403: a DM's existence is private too) unless the contact may see the channel. */
  async requireChannel(contactId: string, channelId: string): Promise<void> {
    if (!(await this.canSeeChannel(contactId, channelId))) throw new NotFoundError('channel', channelId)
  }

  /** Throws 404 unless the contact may see the message's channel. */
  async requireMessage(contactId: string, messageId: string): Promise<void> {
    const m = await this.s.records.get<MessageData>('message', messageId)
    if (m && !(await this.canSeeChannel(contactId, m.data.channelId))) throw new NotFoundError('message', messageId)
  }

  /** The chat channel a record is about, if any: a channel itself, a message, or a chat event. */
  async channelOfRecord(r: StoredRecord | null | undefined): Promise<string | null> {
    if (!r) return null
    if (r.kind === 'channel') return r.id
    if (r.kind === 'message' || r.kind === 'agent_delivery') return typeof r.data.channelId === 'string' ? r.data.channelId : null
    if (r.kind === 'event') {
      const p = r.data.payload as { channelId?: unknown } | null | undefined
      return r.data.source === 'chat' && typeof p?.channelId === 'string' ? p.channelId : null
    }
    return null
  }

  /** Whether the contact may see a record (DM channels, their messages, chat events and agent deliveries are private to members). */
  async canSeeRecord(contactId: string, r: StoredRecord | null | undefined): Promise<boolean> {
    const ch = await this.channelOfRecord(r)
    return ch ? this.canSeeChannel(contactId, ch) : true
  }

  // ── Private sessions: work that came from a DM (docs/spec.md "Sign-in and roles") ──

  /** Whether any of the viewer's contacts may read something with this marker: listed, or in one of its DMs now. */
  async canReadMark(viewer: Viewer | string, mark: PrivateMark | null): Promise<boolean> {
    if (!mark) return true
    const ids = typeof viewer === 'string' ? [viewer] : [viewer.contactId, ...(viewer.also ?? [])]
    if (ids.some((id) => mark.contacts.includes(id))) return true
    for (const ch of mark.channels) for (const id of ids) if (await this.canSeeChannel(id, ch)) return true
    return false
  }

  /**
   * How much of a session the viewer gets. Private sessions are for their DM's members only:
   * admins learn that one exists (`redacted`), everyone else gets nothing. The employee's own
   * tools don't come through here.
   */
  async sessionAccess(viewer: Viewer, session: Session | null | undefined): Promise<SessionAccess> {
    if (!session) return 'none'
    if (await this.canReadMark(viewer, markOf(session))) return 'full'
    return viewer.admin ? 'redacted' : 'none'
  }

  /** Whether the viewer may read the whole session. */
  async canReadSession(viewer: Viewer, session: Session | null | undefined): Promise<boolean> {
    return (await this.sessionAccess(viewer, session)) === 'full'
  }

  /** The session, or 404 (a private session's existence is private too, except to admins with `redacted`). */
  async requireSession(viewer: Viewer, id: string, opts: { redacted?: boolean } = {}): Promise<Session> {
    const session = await this.s.sessions.get(id)
    const access = await this.sessionAccess(viewer, session)
    if (access === 'full') return session!
    if (access === 'redacted' && opts.redacted) return redactSession(session!)
    throw new NotFoundError('session', id)
  }

  /** Whether the viewer may read a run: its own marker (a DM request to a router context) and its session's. */
  async canReadRun(viewer: Viewer, run: Run | null | undefined): Promise<boolean> {
    if (!run) return false
    if (!(await this.canReadMark(viewer, markOf(run)))) return false
    return this.canReadSession(viewer, await this.s.sessions.get(run.data.sessionId))
  }

  /** The run, or 404. */
  async requireRun(viewer: Viewer, id: string): Promise<Run> {
    const run = await this.s.sessions.getRun(id)
    if (!run || !(await this.canReadRun(viewer, run))) throw new NotFoundError('run', id)
    return run
  }

  /**
   * A function that redacts the entries a viewer may not read: those of a private session,
   * and those a private run wrote (a router context's DM requests and their decision lines,
   * also where a fork copied them). Lookups are cached for the one request.
   */
  entryRedactor(viewer: Viewer): <E extends Entry>(e: E) => Promise<E> {
    const runs = new Map<string, Promise<boolean>>()
    const sessions = new Map<string, Promise<boolean>>()
    const readable = (id: string, cache: Map<string, Promise<boolean>>, load: () => Promise<boolean>) => {
      let hit = cache.get(id)
      if (!hit) {
        hit = load()
        cache.set(id, hit)
      }
      return hit
    }
    return async (e) => {
      // Entries a private run was started with carry the marker themselves.
      if (!(await this.canReadMark(viewer, markOf({ data: e.meta })))) return redactEntry(e)
      const sid = typeof e.meta.sessionId === 'string' ? e.meta.sessionId : null
      const rid = typeof e.meta.runId === 'string' ? e.meta.runId : null
      if (sid && !(await readable(sid, sessions, async () => this.canReadSession(viewer, await this.s.sessions.get(sid)))))
        return redactEntry(e)
      if (rid && !(await readable(rid, runs, async () => this.canReadMark(viewer, markOf(await this.s.sessions.getRun(rid))))))
        return redactEntry(e)
      return e
    }
  }

  /** Redacts a list of entries for the viewer. */
  async redactEntries<E extends Entry>(viewer: Viewer, entries: E[]): Promise<E[]> {
    const redact = this.entryRedactor(viewer)
    return Promise.all(entries.map(redact))
  }

  /** Private sessions and runs the viewer may not read in full (for query filters: `id nin …`). */
  async hiddenWork(viewer: Viewer): Promise<{ sessions: Set<string>; runs: Set<string> }> {
    const hidden = { sessions: new Set<string>(), runs: new Set<string>() }
    const privateOf = (kind: string) =>
      this.s.records.query(kind, { where: [{ field: 'private', op: 'exists', value: true }], limit: 100_000 })
    const [sessions, runs] = await Promise.all([privateOf('session'), privateOf('run')])
    for (const x of sessions.items) if (!(await this.canReadMark(viewer, markOf(x)))) hidden.sessions.add(x.id)
    for (const r of runs.items) if (!(await this.canReadMark(viewer, markOf(r)))) hidden.runs.add(r.id)
    return hidden
  }

  /** Whether the viewer may see an event: DM chat events for the DM's members, integration DMs for the person who wrote. */
  async canSeeEvent(viewer: Viewer, e: { data: Record<string, unknown> } | null | undefined): Promise<boolean> {
    if (!e) return true
    if (!(await this.canSeeRecord(viewer.contactId, e as StoredRecord))) return false
    const data = e.data as unknown as EventData
    if (data.source === 'chat') return true
    return this.canReadMark(viewer, await dmMarkOfEvent(this.s, e))
  }
}
