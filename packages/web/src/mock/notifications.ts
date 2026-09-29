import { DEFAULT_NOTIFICATION_PREFS, type InboxItem, type NotificationPrefs, type NotificationsApi } from '@mp/api'
import type { Emit } from './api.ts'
import { CHN, CON, EMP, type MockDb, mockId, RUN, SES } from './data.ts'

/** How often `start()` pushes a new item by default, in dev:mock. */
export const MOCK_NOTIFY_EVERY_MS = 45_000

/** Examples the notifier cycles through: a mention, a reply, a DM, a paused run and an alert. */
const EXAMPLES: Omit<InboxItem, 'id' | 'at' | 'read'>[] = [
  {
    type: 'mention',
    title: 'Infra Bot mentioned you',
    detail:
      'Disk on staging-eu-1 is back to 61% after the log rotation. Can you confirm the retention change before I close this?',
    channelId: CHN.inc42,
    threadId: mockId('msg', 20),
    channel: { id: CHN.inc42, name: 'inc-42-staging-disk', dm: false },
    author: { type: 'employee', id: EMP.infra, name: 'Infra Bot' },
    employee: { id: EMP.infra, name: 'Infra Bot' },
  },
  {
    type: 'reply',
    title: 'Bob Smith replied in a thread',
    detail: 'Looks right to me. The customer already confirmed the duplicate on their side.',
    channelId: CHN.billing,
    threadId: mockId('msg', 1),
    channel: { id: CHN.billing, name: 'billing', dm: false },
    author: { type: 'person', id: CON.bob, name: 'Bob Smith' },
  },
  {
    type: 'dm',
    title: 'Billing Bot sent you a message',
    detail: 'The refund for PAY-123 went through: $412.00 back to the card ending 4242.',
    channelId: CHN.dmAna,
    threadId: mockId('msg', 90),
    channel: { id: CHN.dmAna, name: 'Billing Bot', dm: true },
    author: { type: 'employee', id: EMP.billing, name: 'Billing Bot' },
    employee: { id: EMP.billing, name: 'Billing Bot' },
  },
  {
    type: 'paused_run',
    title: 'Paused: PAY-140: webhook retries',
    detail: 'Paused by an admin while the provider is down',
    sessionId: SES.pay140,
    runId: RUN.r8,
    employee: { id: EMP.billing, name: 'Billing Bot' },
  },
  {
    type: 'alert',
    title: 'Meatless alerted you',
    detail: 'Run failed: PAY-131 (model provider unavailable, 3 retries)',
    sessionId: SES.pay131,
    author: { type: 'employee', id: EMP.support, name: 'Meatless' },
    employee: { id: EMP.support, name: 'Meatless' },
  },
]

/** Simulated incoming inbox items, the way the server sends them on `person:<contactId>`. */
export interface MockNotifier {
  /** Adds an item for the signed-in person (the next example, with `over` on top) and sends it live. */
  push(over?: Partial<InboxItem>): InboxItem
  /** Pushes an item every `everyMs` until stopped. Returns `stop`. */
  start(everyMs?: number): () => void
  stop(): void
}

export function createMockNotifier(db: MockDb, emit: Emit, contactId: string = CON.ana): MockNotifier {
  let n = 0
  let timer: ReturnType<typeof setInterval> | null = null
  const notifier: MockNotifier = {
    push(over = {}) {
      const example = EXAMPLES[n % EXAMPLES.length]!
      n++
      const item: InboxItem = {
        ...example,
        id: `mock:${n}:${db.now()}`,
        at: new Date(db.now()).toISOString(),
        read: false,
        ...over,
      }
      db.inbox = [item, ...db.inbox.filter((i) => i.id !== item.id)]
      emit('inbox.item', { contactId, item })
      return item
    },
    start(everyMs = MOCK_NOTIFY_EVERY_MS) {
      notifier.stop()
      timer = setInterval(() => notifier.push(), everyMs)
      return notifier.stop
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
  return notifier
}

/** `GET/PUT /api/me/notifications` over one in-memory record. */
export function createMockNotificationsApi(ctx: { delay: <T>(v: T) => Promise<T> }): NotificationsApi {
  let prefs: NotificationPrefs = structuredClone(DEFAULT_NOTIFICATION_PREFS)
  return {
    notificationPrefs: () => ctx.delay(prefs),
    setNotificationPrefs: (patch) => {
      prefs = { ...prefs, ...patch, mutedChannels: [...new Set(patch.mutedChannels ?? prefs.mutedChannels)] }
      return ctx.delay(prefs)
    },
  }
}
