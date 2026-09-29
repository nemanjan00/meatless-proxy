// ─── Chat activity: who is working on a chat thread right now ───────────────
//
// Served by packages/server/src/chat-activity.ts. Under a chat message the web UI shows who a
// message set to work: a run caused by the message (the router's ephemeral run included), the
// runs of sessions those runs handed the thread to, and the live runs of sessions subscribed to
// the thread. Changes arrive live on the channel's `chat:<channelId>` topic: `chat.activity`
// when a run starts or changes state or step, `chat.activity.done` when it ends (or when a
// message nobody picked up finished routing).

/** What a worker is doing: queued, running, waiting (on a reply, a child, a timer) or paused (needs someone). */
export type ChatActivityState = 'queued' | 'running' | 'waiting' | 'paused'

/** One run working on a chat thread. */
export interface ChatActivityItem {
  channelId: string
  /** The thread's root message id. */
  threadId: string
  /** The message that set it to work, when known (a subscribed session's run may have another cause). */
  messageId?: string
  sessionId: string
  employee: { id: string; name: string; handle?: string }
  /** `@meatless` for an employee's router context, `@meatless#pay-refund` for any other session. */
  sessionLabel: string
  /** Whether the session is the employee's router context (it speaks as the employee). */
  router?: boolean
  runId: string
  state: ChatActivityState
  /** When it entered this state. */
  since: string
  /** What it's doing now in plain words, from its latest tool call, e.g. "reading the thread". */
  step?: string
  /** Why it's paused, e.g. "needs approval" or a limit. */
  pauseReason?: string
  /** What it waits on while `waiting`: a reply (any message to it), other work (runs it started), or a time. */
  waitingOn?: 'reply' | 'work' | 'time'
}

/**
 * How a worker's run ended, or what happened to a message nobody picked up:
 * - `replied`: it posted in the thread (the reply itself shows);
 * - `handed_off`: it started or messaged another session (`handedTo`), which takes over the thread;
 * - `no_reply`: it looked and decided nothing was needed (NO_REPLY, or nothing posted);
 * - `failed`: the run failed or was cancelled (`reason`);
 * - `unrouted`: routing finished and nobody picked the message up, though it tagged someone or
 *   was posted where a trigger listens.
 */
export type ChatActivityOutcome = 'replied' | 'handed_off' | 'no_reply' | 'failed' | 'unrouted'

/** Payload of `chat.activity.done`. */
export interface ChatActivityDone {
  channelId: string
  threadId: string
  messageId?: string
  /** The run that ended (absent for `unrouted`). */
  runId?: string
  sessionId?: string
  employee?: ChatActivityItem['employee']
  sessionLabel?: string
  outcome: ChatActivityOutcome
  /** A short reason, for `failed`. */
  reason?: string
  /** The session it handed the thread to, for `handed_off`; its run shows as a new activity item. */
  handedTo?: { sessionId: string; sessionLabel: string; runId?: string }
}

/** The routes of this section (merged into `ROUTES`). */
export const CHAT_ACTIVITY_ROUTES = {
  channelActivity: ['GET', '/api/chat/channels/:id/activity'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface ChatActivityApi {
  /**
   * `GET /api/chat/channels/:id/activity` → who is working on the channel's threads right now, oldest
   * first. 404 for a channel you can't see (a DM you're not in).
   */
  channelActivity(channelId: string): Promise<ChatActivityItem[]>
}

type Call = <T>(
  route: keyof typeof CHAT_ACTIVITY_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `ChatActivityApi` half of `createApiClient`. */
export function chatActivityMethods(call: Call): ChatActivityApi {
  return {
    channelActivity: (id) => call('channelActivity', { id }),
  }
}
