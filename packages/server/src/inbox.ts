import type * as Api from '@mp/api'
import type { MessageData } from '@mp/chat'
import { ConflictError, type KindSchema } from '@mp/core'
import type { Condition, StoredRecord } from '@mp/store'
import type { ChatVisibility } from './auth/visibility.ts'
import type { Views } from './http/views.ts'
import type { Services } from './services.ts'

/** How many read item ids a person's inbox state keeps (older ones are covered by `clearedAt` in practice). */
const READ_KEEP = 1000

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

/**
 * The web UI's inbox for one person (docs/spec.md#web-ui): paused runs, messages that tag
 * them, and replies in threads they are in (started, posted in or were tagged in), minus
 * their own messages and DMs they can't see. Items can be marked read, and the inbox cleared.
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

  async items(contactId: string, v: Views): Promise<Api.InboxItem[]> {
    const s = this.s
    const st = await this.state(contactId)
    const read = new Set(st?.data.read ?? [])
    const cleared = st?.data.clearedAt
    const items: Api.InboxItem[] = []
    const push = (i: Omit<Api.InboxItem, 'read'>) => {
      if (cleared && i.at <= cleared) return
      items.push({ ...i, read: read.has(i.id) })
    }

    for (const run of (await s.sessions.runs({ state: 'paused' })).reverse().slice(0, 100)) {
      const session = await s.sessions.get(run.data.sessionId)
      const reason = run.data.pauseReason ?? 'paused'
      push({
        id: `paused:${run.id}`,
        type: /budget|limit|token|cost/i.test(reason) ? 'limit' : 'paused_run',
        title: `Paused: ${session?.data.title ?? run.data.sessionId}`,
        detail: reason,
        at: run.updatedAt,
        sessionId: run.data.sessionId,
        runId: run.id,
        employee: await v.employeeSummary(run.data.employeeId),
      })
    }

    const hidden = [...(await this.vis.hiddenChannels(contactId))]
    const visible: Condition[] = [
      { field: 'deleted', op: 'ne', value: true },
      ...(hidden.length ? [{ field: 'channelId', op: 'nin' as const, value: hidden }] : []),
    ]
    const notMine = (m: Msg) => !(m.data.author.kind === 'contact' && m.data.author.id === contactId)
    const tagsMe = (m: Msg) => m.data.tags.some((t) => t.type === 'person' && t.contactId === contactId)

    const byMe = await s.records.query<MessageData>('message', {
      where: [{ field: 'author', op: 'eq', value: { kind: 'contact', id: contactId } }, ...visible],
      orderBy: { field: 'createdAt', dir: 'desc' },
      limit: 200,
    })
    const mentions = (
      await s.records.query<MessageData>('message', {
        where: [{ field: 'tags', op: 'contains', value: { type: 'person', contactId } }, ...visible],
        orderBy: { field: 'createdAt', dir: 'desc' },
        limit: 100,
      })
    ).items.filter((m) => notMine(m) && tagsMe(m))

    // Threads I'm in: roots of what I posted, and of what tagged me.
    const roots = new Set<string>()
    for (const m of [...byMe.items, ...mentions]) roots.add(m.data.threadId ?? m.id)
    const replies = roots.size
      ? (
          await s.records.query<MessageData>('message', {
            where: [{ field: 'threadId', op: 'in', value: [...roots] }, ...visible],
            orderBy: { field: 'createdAt', dir: 'desc' },
            limit: 200,
          })
        ).items.filter(notMine)
      : []

    const employeeOf = async (m: Msg): Promise<Api.EmployeeSummary | undefined> => {
      if (m.data.author.kind === 'session') {
        const x = await s.sessions.get(m.data.author.id)
        return x ? v.employeeSummary(x.data.employeeId) : undefined
      }
      const a = await v.author(m.data.author)
      return a.type === 'employee' ? { id: a.id, name: a.name } : undefined
    }
    const seen = new Set<string>()
    for (const m of mentions) {
      seen.add(m.id)
      const author = await v.author(m.data.author)
      const employee = await employeeOf(m)
      push({
        id: `mention:${m.id}`,
        type: 'mention',
        title: `${employee?.name ?? author.name} mentioned you`,
        detail: m.data.text.slice(0, 200),
        at: m.data.createdAt,
        channelId: m.data.channelId,
        threadId: m.data.threadId ?? m.id,
        ...(employee ? { employee } : {}),
      })
    }
    // A reply in a thread I'm in, after my first message there (earlier ones are old news to me).
    const firstMine = new Map<string, string>()
    for (const m of [...byMe.items, ...mentions]) {
      const root = m.data.threadId ?? m.id
      const cur = firstMine.get(root)
      if (!cur || m.data.createdAt < cur) firstMine.set(root, m.data.createdAt)
    }
    for (const m of replies) {
      if (seen.has(m.id) || !m.data.threadId) continue
      const since = firstMine.get(m.data.threadId)
      if (since && m.data.createdAt < since) continue
      const author = await v.author(m.data.author)
      const employee = await employeeOf(m)
      push({
        id: `reply:${m.id}`,
        type: 'reply',
        title: `${employee?.name ?? author.name} replied in a thread`,
        detail: m.data.text.slice(0, 200),
        at: m.data.createdAt,
        channelId: m.data.channelId,
        threadId: m.data.threadId,
        ...(employee ? { employee } : {}),
      })
    }
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    return items
  }

  /** Marks items read, or clears the inbox (`clear`: everything up to now is gone). */
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
        return
      } catch (err) {
        if (!(err instanceof ConflictError) || i >= 5) throw err
      }
    }
  }
}
