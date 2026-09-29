import type * as Api from '@mp/api'
import type { ChannelData, MessageData } from '@mp/chat'
import { ConflictError, type KindSchema } from '@mp/core'
import type { Run } from '@mp/sessions'
import type { Condition, StoredRecord } from '@mp/store'
import { ALERTS_CHANNEL } from './alerts.ts'
import type { ChatVisibility } from './auth/visibility.ts'
import type { Views } from './http/views.ts'
import type { Services } from './services.ts'

/** How many read item ids a person's inbox state keeps (older ones are covered by `clearedAt` in practice). */
const READ_KEEP = 1000

/** Bus topic published when a person marks items read or clears the inbox (payload: `LiveTopics['inbox.read']`). */
export const INBOX_READ_TOPIC = 'inbox.read'

/** A person's inbox state: items they read, and when they last cleared it. The record key is the contact id. */
export const inboxStateSchema: KindSchema = {
  kind: 'inbox_state',
  prefix: 'ibx',
  description: "A person's inbox state: item ids they have read, and when they last cleared the inbox.",
  core: [
    { name: 'contactId', type: 'ref', ref: 'contact', required: true },
    { name: 'read', type: 'list', of: { type: 'string' }, required: true },
    { name: 'clearedAt', type: 'timestamp', description: 'Items from before this time are cleared.' },
  ],
}

interface InboxStateData extends Record<string, unknown> {
  contactId: string
  read: string[]
  clearedAt?: string
}

type Msg = StoredRecord<MessageData>

/** The inbox item types a chat message can be. */
export type MessageItemType = 'mention' | 'alert' | 'dm' | 'reply'

/** What decides whether a message is an item for a person, besides the message itself. */
export interface MessageContext {
  /** They may see the channel (it isn't a DM they're out of). */
  visible: boolean
  /** The channel is a DM they're in. */
  dm: boolean
  /** The channel is `#alerts`. */
  alerts: boolean
  /** When they first posted in, or were tagged in, the message's thread. Unset: they aren't in it. */
  inThreadSince?: string
}

/** Who the inbox is for: their contact, and whether they are an admin (admins also get paused runs nobody asked for). */
export interface InboxViewer {
  contactId: string
  admin?: boolean
}

const isMine = (m: Msg, contactId: string) => m.data.author.kind === 'contact' && m.data.author.id === contactId
const tagsMe = (m: Msg, contactId: string) => m.data.tags.some((t) => t.type === 'person' && t.contactId === contactId)

/**
 * The rule for messages, shared by the inbox list and the live stream so they never disagree:
 * never their own messages, deleted ones or DMs they aren't in; then a tag (an `alert` in
 * `#alerts`), a message in a DM they're in, or a reply in a thread they're in, after they joined it.
 */
export function messageItemType(m: Msg, contactId: string, ctx: MessageContext): MessageItemType | null {
  if (!ctx.visible || m.data.deleted || isMine(m, contactId)) return null
  if (tagsMe(m, contactId)) return ctx.alerts ? 'alert' : 'mention'
  if (ctx.dm) return 'dm'
  if (m.data.threadId && ctx.inThreadSince && m.data.createdAt >= ctx.inThreadSince) return 'reply'
  return null
}

/**
 * The rule for runs: paused runs they asked for (admins also get the ones nobody asked for), and
 * runs they asked for that wait on a reply.
 */
export function runItemType(run: Run, viewer: InboxViewer): Api.InboxItem['type'] | null {
  const d = run.data
  const mine = !!d.requesterId && d.requesterId === viewer.contactId
  if (d.state === 'paused' && (mine || (!d.requesterId && viewer.admin)))
    return /budget|limit|token|cost/i.test(d.pauseReason ?? '') ? 'limit' : 'paused_run'
  if (d.state === 'suspended' && d.wait?.type === 'delivery' && mine) return 'waiting'
  return null
}

/**
 * The web UI's inbox for one person (docs/spec.md#web-ui): messages that tag them, DMs they're
 * in, replies in threads they are in (started, posted in or were tagged in), alerts that tag them,
 * and runs they asked for that paused or wait on them; minus their own messages and DMs they
 * can't see. Items can be marked read, and the inbox cleared. `itemForMessage` and `itemForRun`
 * answer the same question for one new message or run, for the live stream.
 */
export class PersonInbox {
  constructor(
    private s: Services,
    private vis: ChatVisibility,
  ) {
    if (!s.records.kinds.has('inbox_state')) s.records.kinds.define(inboxStateSchema)
  }

  private state(contactId: string) {
    return this.s.records.getByKey<InboxStateData>('inbox_state', contactId)
  }

  /** Adds `read`, or drops the item when it is from before the inbox was cleared. */
  private withState(i: Omit<Api.InboxItem, 'read'>, st: StoredRecord<InboxStateData> | null): Api.InboxItem | null {
    if (st?.data.clearedAt && i.at <= st.data.clearedAt) return null
    return { ...i, read: (st?.data.read ?? []).includes(i.id) }
  }

  async items(who: string | InboxViewer, v: Views): Promise<Api.InboxItem[]> {
    const viewer = typeof who === 'string' ? { contactId: who } : who
    const { contactId } = viewer
    const s = this.s
    const st = await this.state(contactId)
    const items: Api.InboxItem[] = []
    const push = (i: Omit<Api.InboxItem, 'read'>) => {
      const x = this.withState(i, st)
      if (x) items.push(x)
    }

    const runs = [
      ...(await s.sessions.runs({ state: 'paused' })).reverse().slice(0, 100),
      ...(await s.sessions.runs({ state: 'suspended' }))
        .filter((r) => r.data.wait?.type === 'delivery')
        .reverse()
        .slice(0, 100),
    ]
    for (const run of runs) {
      const type = runItemType(run, viewer)
      if (type) push(await this.runItem(run, type, v))
    }

    const dms = await this.vis.dmChannels(contactId)
    const hidden = [...dms.hidden]
    const visible: Condition[] = [
      { field: 'deleted', op: 'ne', value: true },
      ...(hidden.length ? [{ field: 'channelId', op: 'nin' as const, value: hidden }] : []),
    ]
    const query = async (where: Condition[], limit: number) =>
      (
        await s.records.query<MessageData>('message', {
          where: [...where, ...visible],
          orderBy: { field: 'createdAt', dir: 'desc' },
          limit,
        })
      ).items

    const byMe = await query([{ field: 'author', op: 'eq', value: { kind: 'contact', id: contactId } }], 200)
    const mentions = (await query([{ field: 'tags', op: 'contains', value: { type: 'person', contactId } }], 100)).filter(
      (m) => !isMine(m, contactId) && tagsMe(m, contactId),
    )
    const inDms = dms.member.size ? await query([{ field: 'channelId', op: 'in', value: [...dms.member] }], 100) : []

    // Threads I'm in: roots of what I posted, and of what tagged me, since my first message there.
    const firstMine = new Map<string, string>()
    for (const m of [...byMe, ...mentions]) {
      const root = m.data.threadId ?? m.id
      const cur = firstMine.get(root)
      if (!cur || m.data.createdAt < cur) firstMine.set(root, m.data.createdAt)
    }
    const replies = firstMine.size ? await query([{ field: 'threadId', op: 'in', value: [...firstMine.keys()] }], 200) : []

    const alerts = await s.chat.channelByName(ALERTS_CHANNEL)
    const seen = new Set<string>()
    for (const m of [...mentions, ...inDms, ...replies]) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      const type = messageItemType(m, contactId, {
        visible: true,
        dm: dms.member.has(m.data.channelId),
        alerts: !!alerts && m.data.channelId === alerts.id,
        ...(m.data.threadId && firstMine.has(m.data.threadId) ? { inThreadSince: firstMine.get(m.data.threadId)! } : {}),
      })
      if (type) push(await this.messageItem(m, type, v))
    }
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    return items
  }

  /** The item a new message is for this person, or null (the same rule as `items`). Read and cleared state apply. */
  async itemForMessage(m: Msg, viewer: InboxViewer, v: Views): Promise<Api.InboxItem | null> {
    const { contactId } = viewer
    if (m.data.deleted || isMine(m, contactId)) return null
    const ch = await this.s.records.get<ChannelData>('channel', m.data.channelId)
    if (!ch) return null
    const member = ch.data.dm === true && (await this.vis.canSeeChannel(contactId, ch.id))
    const ctx: MessageContext = {
      visible: ch.data.dm !== true || member,
      dm: member,
      alerts: ch.data.name === ALERTS_CHANNEL,
    }
    if (ctx.visible && !ctx.dm && !tagsMe(m, contactId) && m.data.threadId) {
      const since = await this.joinedThread(m.data.threadId, contactId)
      if (since) ctx.inThreadSince = since
    }
    const type = messageItemType(m, contactId, ctx)
    if (!type) return null
    return this.withState(await this.messageItem(m, type, v, ch), await this.state(contactId))
  }

  /** The item a run's new state is for this person, or null (the same rule as `items`). */
  async itemForRun(run: Run, viewer: InboxViewer, v: Views): Promise<Api.InboxItem | null> {
    const type = runItemType(run, viewer)
    if (!type) return null
    return this.withState(await this.runItem(run, type, v), await this.state(viewer.contactId))
  }

  /** When the person first posted in, or was tagged in, a thread (its root counts), or null. */
  private async joinedThread(rootId: string, contactId: string): Promise<string | null> {
    const root = await this.s.records.get<MessageData>('message', rootId)
    const replies = await this.s.records.query<MessageData>('message', {
      where: { threadId: rootId },
      orderBy: { field: 'createdAt', dir: 'asc' },
      limit: 1000,
    })
    for (const m of [...(root ? [root] : []), ...replies.items])
      if (isMine(m, contactId) || tagsMe(m, contactId)) return m.data.createdAt
    return null
  }

  private async runItem(run: Run, type: Api.InboxItem['type'], v: Views): Promise<Omit<Api.InboxItem, 'read'>> {
    const session = await this.s.sessions.get(run.data.sessionId)
    const title = session?.data.title ?? run.data.sessionId
    const waiting = type === 'waiting'
    return {
      id: `${waiting ? 'waiting' : 'paused'}:${run.id}`,
      type,
      title: waiting ? `Waiting on you: ${title}` : `Paused: ${title}`,
      detail: waiting ? 'It continues when you reply' : (run.data.pauseReason ?? 'paused'),
      at: run.updatedAt,
      sessionId: run.data.sessionId,
      runId: run.id,
      employee: await v.employeeSummary(run.data.employeeId),
    }
  }

  private async messageItem(
    m: Msg,
    type: MessageItemType,
    v: Views,
    channel?: StoredRecord<ChannelData> | null,
  ): Promise<Omit<Api.InboxItem, 'read'>> {
    const author = await v.author(m.data.author)
    let employee: Api.EmployeeSummary | undefined
    if (m.data.author.kind === 'session') {
      const x = await this.s.sessions.get(m.data.author.id)
      if (x) employee = await v.employeeSummary(x.data.employeeId)
    } else if (author.type === 'employee') employee = { id: author.id, name: author.name }
    const ch = channel ?? (await this.s.records.get<ChannelData>('channel', m.data.channelId))
    const name = employee?.name ?? author.name
    const title = {
      mention: `${name} mentioned you`,
      alert: `${name} alerted you`,
      dm: `${name} sent you a message`,
      reply: `${name} replied in a thread`,
    }[type]
    return {
      id: `${type}:${m.id}`,
      type,
      title,
      detail: m.data.text.slice(0, 200),
      at: m.data.createdAt,
      channelId: m.data.channelId,
      threadId: m.data.threadId ?? m.id,
      author,
      ...(ch ? { channel: { id: ch.id, name: ch.data.name, dm: ch.data.dm === true } } : {}),
      ...(employee ? { employee } : {}),
    }
  }

  /** Marks items read, or clears the inbox (`clear`: everything up to now is gone). Every tab of theirs hears it. */
  async mark(contactId: string, q: { ids?: string[]; clear?: boolean }): Promise<void> {
    for (let i = 0; ; i++) {
      const cur = await this.state(contactId)
      const read = [...new Set([...(cur?.data.read ?? []), ...(q.ids ?? [])])].slice(-READ_KEEP)
      const data: InboxStateData = {
        contactId,
        read: q.clear ? [] : read,
        ...(q.clear ? { clearedAt: this.s.clock.iso() } : cur?.data.clearedAt ? { clearedAt: cur.data.clearedAt } : {}),
      }
      try {
        if (!cur) await this.s.records.create<InboxStateData>('inbox_state', data, { key: contactId })
        else
          await this.s.records.update<InboxStateData>('inbox_state', cur.id, data, {
            replace: true,
            expectedVersion: cur.version,
          })
        this.s.bus.publish<Api.LiveTopics['inbox.read']>(INBOX_READ_TOPIC, {
          contactId,
          ...(q.ids ? { ids: q.ids } : {}),
          ...(q.clear ? { clear: true } : {}),
        })
        return
      } catch (err) {
        if (!(err instanceof ConflictError) || i >= 5) throw err
      }
    }
  }
}
