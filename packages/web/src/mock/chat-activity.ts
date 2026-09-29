import type {
  ApiRecord,
  ChannelData,
  ChatActivityApi,
  ChatActivityDone,
  ChatActivityItem,
  EmployeeData,
  Message,
  MessageData,
  SessionData,
} from '@mp/api'
import type { Emit } from './api.ts'
import { CHN, EMP, type MockDb, mockId, RUN, SES } from './data.ts'

/** What the chat activity mock borrows from the mock API. */
export interface MockChatActivityHelpers {
  db: MockDb
  iso(): string
  delay<T>(v: T): Promise<T>
  emit: Emit
  write<T extends Record<string, unknown>>(kind: string, id: string, data: T): ApiRecord<T>
  get<T>(kind: string, id: string): ApiRecord<T> | undefined
  all<T>(kind: string): ApiRecord<T>[]
  /** Timers for the simulated work (tests pass fake ones or turn it off). */
  schedule?: (fn: () => void, ms: number) => void
}

/** When the simulated router picks a message up, hands it off (or decides nothing is needed), and the session answers. */
export const MOCK_ACTIVITY_MS = { pickUp: 700, decide: 2800, answer: 9000 } as const

/** "Thanks", "ok" and the like need no answer: the router looks and says nothing. */
const NOTHING_NEEDED = /^\s*(?:@[\w-]+(?:#[\w-]+)?\s*)*(thanks|thank you|thx|ok|okay|great|cool|👍|🙏)/i

const handleOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const slugFrom = (text: string) =>
  handleOf(text.replace(/@[\w-]+(#[\w-]+)?/g, ''))
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
    .join('-') || 'request'

/**
 * The chat activity of the mock: a few threads with someone working on them, and a small
 * simulation when you post. Tag an employee (or post in a channel routed to a context) and its
 * router picks the message up, then hands it to a new session that answers in the thread; a
 * "thanks" gets a look and no reply.
 */
export function createMockChatActivity(h: MockChatActivityHelpers): ChatActivityApi & { onPosted(m: Message): void } {
  const items = new Map<string, ChatActivityItem>()
  const at = (minutesAgo: number) => new Date(h.db.now() - minutesAgo * 60_000).toISOString()
  const schedule = h.schedule ?? ((fn, ms) => void setTimeout(fn, ms))
  const employee = (id: string) => {
    const e = h.get<EmployeeData>('employee', id)
    const name = e?.data.name ?? id
    return { id, name, handle: handleOf(name) }
  }
  const labelOf = (s: ApiRecord<SessionData>) => `@${handleOf(employee(s.data.employeeId).name)}#${s.data.slug}`

  const seed: ChatActivityItem[] = [
    {
      channelId: CHN.billing,
      threadId: mockId('msg', 1),
      sessionId: SES.pay123,
      employee: employee(EMP.billing),
      sessionLabel: '@billing-bot#pay-123-refund',
      runId: RUN.r2,
      state: 'running',
      since: at(12),
      step: 'writing docs',
    },
    {
      channelId: CHN.inc42,
      threadId: mockId('msg', 20),
      sessionId: SES.inc42,
      employee: employee(EMP.infra),
      sessionLabel: '@infra-bot#inc-42-disk',
      runId: RUN.r21,
      state: 'running',
      since: at(1),
      step: 'running a command',
    },
    {
      channelId: CHN.deploys,
      threadId: mockId('msg', 10),
      sessionId: SES.deploy214,
      employee: employee(EMP.infra),
      sessionLabel: '@infra-bot#deploy-payments-2-14',
      runId: RUN.r23,
      state: 'waiting',
      waitingOn: 'work',
      since: at(13),
    },
  ]
  for (const i of seed) items.set(i.runId, i)

  const show = (item: ChatActivityItem) => {
    items.set(item.runId, item)
    h.emit('chat.activity', { channelId: item.channelId, item })
  }
  const end = (item: ChatActivityItem, d: Omit<ChatActivityDone, 'channelId' | 'threadId'>) => {
    items.delete(item.runId)
    h.emit('chat.activity.done', {
      channelId: item.channelId,
      threadId: item.threadId,
      ...(item.messageId ? { messageId: item.messageId } : {}),
      runId: item.runId,
      sessionId: item.sessionId,
      employee: item.employee,
      sessionLabel: item.sessionLabel,
      ...d,
    })
  }

  /** The employee a message asks: the first tagged one, else the one whose context the channel is routed to. */
  const askedEmployee = (m: Message): string | undefined => {
    const tag = m.data.tags.find((t) => t.type === 'employee' || t.type === 'session')
    if (tag?.type === 'employee') return tag.id
    if (tag?.type === 'session') return h.get<SessionData>('session', tag.id)?.data.employeeId
    if (m.data.threadId) return undefined
    const ch = h.get<ChannelData>('channel', m.data.channelId)
    const ctx = ch?.data.contextId ? h.get<SessionData>('session', ch.data.contextId) : undefined
    return ctx?.data.employeeId ?? (ch?.data.dm ? ch.data.members.find((x) => x.type === 'employee')?.id : undefined)
  }

  const routerOf = (employeeId: string) =>
    h
      .all<SessionData>('session')
      .find(
        (s) =>
          s.data.employeeId === employeeId &&
          ((s.data.meta as { role?: unknown })?.role === 'router' || s.data.slug === 'router'),
      )

  const reply = (threadId: string, channelId: string, text: string, author: MessageData['author']) => {
    const id = mockId('msg', ++h.db.seq)
    const message = h.write<MessageData>('message', id, { channelId, threadId, author, text, tags: [], mentions: [] }) as Message
    const root = h.get<MessageData>('message', threadId)
    if (root)
      h.write<MessageData>('message', threadId, {
        ...root.data,
        replyCount: (root.data.replyCount ?? 0) + 1,
        lastReplyAt: h.iso(),
      })
    h.emit('chat.message', { channelId, message })
  }

  const simulate = (m: Message, employeeId: string) => {
    const who = employee(employeeId)
    const threadId = m.data.threadId ?? m.id
    const router = routerOf(employeeId)
    const base = { channelId: m.data.channelId, threadId, messageId: m.id, employee: who }
    const routerItem: ChatActivityItem = {
      ...base,
      sessionId: router?.id ?? employeeId,
      sessionLabel: `@${who.handle}`,
      router: true,
      runId: mockId('run', ++h.db.seq),
      state: 'running',
      since: h.iso(),
      step: 'reading the thread',
    }
    schedule(() => show(routerItem), MOCK_ACTIVITY_MS.pickUp)
    if (NOTHING_NEEDED.test(m.data.text)) {
      schedule(() => end(routerItem, { outcome: 'no_reply' }), MOCK_ACTIVITY_MS.decide)
      return
    }
    schedule(() => show({ ...routerItem, step: 'starting a session' }), MOCK_ACTIVITY_MS.decide - 900)
    schedule(() => {
      // The router hands the thread to a new session, which starts working on it.
      const id = mockId('ses', ++h.db.seq)
      const slug = slugFrom(m.data.text)
      const session = h.write<SessionData>('session', id, {
        title: m.data.text.slice(0, 60),
        slug,
        employeeId,
        status: 'active',
        head: null,
        rootId: id,
        depth: 0,
        toolset: [],
        document: '',
      })
      const child: ChatActivityItem = {
        ...base,
        sessionId: id,
        sessionLabel: labelOf(session),
        runId: mockId('run', ++h.db.seq),
        state: 'running',
        since: h.iso(),
        step: 'reading docs',
      }
      end(routerItem, {
        outcome: 'handed_off',
        handedTo: { sessionId: id, sessionLabel: child.sessionLabel, runId: child.runId },
      })
      show(child)
      schedule(() => show({ ...child, step: 'running code' }), (MOCK_ACTIVITY_MS.answer - MOCK_ACTIVITY_MS.decide) / 2)
      schedule(() => {
        reply(threadId, m.data.channelId, 'On it: I looked into this and posted what I found in the session document.', {
          type: 'session',
          id,
          name: child.sessionLabel,
        })
        end(child, { outcome: 'replied' })
      }, MOCK_ACTIVITY_MS.answer - MOCK_ACTIVITY_MS.decide)
    }, MOCK_ACTIVITY_MS.decide)
  }

  const followUp = (m: Message, session: ApiRecord<SessionData>) => {
    const item: ChatActivityItem = {
      channelId: m.data.channelId,
      threadId: m.data.threadId ?? m.id,
      messageId: m.id,
      sessionId: session.id,
      employee: employee(session.data.employeeId),
      sessionLabel: labelOf(session),
      runId: mockId('run', ++h.db.seq),
      state: 'running',
      since: h.iso(),
      step: 'reading the thread',
    }
    schedule(() => show(item), MOCK_ACTIVITY_MS.pickUp)
    schedule(() => {
      if (NOTHING_NEEDED.test(m.data.text)) return end(item, { outcome: 'no_reply' })
      reply(item.threadId, item.channelId, 'Noted. I will keep this thread posted.', {
        type: 'session',
        id: session.id,
        name: item.sessionLabel,
      })
      end(item, { outcome: 'replied' })
    }, MOCK_ACTIVITY_MS.decide)
  }

  return {
    channelActivity: (channelId) => h.delay([...items.values()].filter((i) => i.channelId === channelId)),
    onPosted(m) {
      if (m.data.author.type !== 'person') return
      const employeeId = askedEmployee(m)
      if (employeeId) return simulate(m, employeeId)
      // An untagged reply in a thread a session owns goes straight to that session.
      const root = m.data.threadId ? h.get<MessageData>('message', m.data.threadId) : undefined
      const owner = root?.data.sessionId ? h.get<SessionData>('session', root.data.sessionId) : undefined
      if (owner) followUp(m, owner)
    },
  }
}
