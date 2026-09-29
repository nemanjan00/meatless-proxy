/**
 * Who is working on a chat thread right now (docs/spec.md, "Web UI › Chat"): under a message, the
 * web UI shows the runs it set to work, what each is doing, and how each ended.
 *
 * A run works on a thread when
 * - its cause is an event of one of the thread's messages (the router's ephemeral run included),
 *   or routing put the message in the inbox of a run that's already going;
 * - it was started by such a run (`cause.parentRunId`: the router handing the thread to a new
 *   session), or it answers a `sessions.message` such a run sent;
 * - its session is subscribed to the thread (`mp:<threadId>`).
 *
 * `ChatActivity` follows the bus (new run records, `run.state`, `tool.called`, `event.routed`) and
 * keeps the live ones in memory, indexed by run: nothing scans runs per request. It publishes
 * `chat.activity` and `chat.activity.done` (see `@mp/api`), which the live hub sends on the
 * channel's `chat:<channelId>` topic, to people who may see the channel.
 */
import type { ChatActivityDone, ChatActivityItem, ChatActivityState } from '@mp/api'
import type { ChatEventPayload } from '@mp/chat'
import { errorMessage, NotFoundError, type BusMessage } from '@mp/core'
import type { MpEvent } from '@mp/events'
import { TERMINAL_RUN_STATES, type Run, type RunData } from '@mp/sessions'
import { NO_REPLY_RE } from '@mp/stdlib'
import { Hono } from 'hono'
import { principalOf } from './auth/guard.ts'
import type { ChatVisibility } from './auth/visibility.ts'
import { Views } from './http/views.ts'
import type { Services } from './services.ts'

/** Bus topics published here (and forwarded by the live hub). */
export const CHAT_ACTIVITY_TOPIC = 'chat.activity'
export const CHAT_ACTIVITY_DONE_TOPIC = 'chat.activity.done'

/** Tools that answer in chat. */
const ANSWER_TOOLS = new Set(['chat.post', 'chat.reply', 'chat.invite'])
/** Chat events that are a message someone posted (reactions and edits aren't requests). */
const POSTED = new Set(['message.posted', 'message.replied'])
/** How long a `sessions.message` hand-off waits for its event to be routed. */
const FORWARD_TTL_MS = 5 * 60_000
/** Run ids remembered as "not about a chat thread" or "already ended". */
const MAX_REMEMBERED = 5000
/** Parent runs followed when working out where a run came from after a restart. */
const MAX_DEPTH = 4

/** Where a run's work shows: a thread of a channel, and the message that caused it if known. */
interface ThreadRef {
  channelId: string
  threadId: string
  messageId?: string
}

interface Tracked {
  item: ChatActivityItem
  /** Tool names it called, in order (for the outcome). */
  tools: string[]
  /** It was asked by a chat message, so a final answer is posted in the thread for it. */
  chatCaused: boolean
  /** The `to` of its last `sessions.message`. */
  messaged?: string
}

/** A tool call in plain words, for "Meatless is working… reading the thread". */
export function describeStep(tool: string): string {
  const name = tool.replace(/__/g, '.')
  const exact: Record<string, string> = {
    'chat.read': 'reading the thread',
    'chat.search': 'searching chat',
    'chat.post': 'writing a message',
    'chat.reply': 'writing a reply',
    'chat.react': 'reacting',
    'chat.create_channel': 'creating a channel',
    'chat.invite': 'inviting someone',
    'code.run': 'running code',
    'code.reset': 'resetting the code sandbox',
    'env.up': 'starting an environment',
    'env.exec': 'running a command',
    'env.logs': 'reading logs',
    'env.down': 'stopping an environment',
    'env.preview': 'opening a preview',
    'env.screenshot': 'looking at the desktop',
    'sessions.create': 'starting a session',
    'sessions.fork': 'starting a session',
    'sessions.loop': 'starting sessions',
    'sessions.message': 'passing it on',
    'sessions.wait': 'waiting on a session',
    'sessions.commit': 'noting its decision',
    'procedures.run': 'starting a procedure',
    'image.view': 'looking at an image',
    'time.now': 'checking the time',
    'git.push': 'pushing a branch',
    'git.commit': 'committing',
  }
  if (exact[name]) return exact[name]
  const [group] = name.split('.')
  const byGroup: Record<string, string> = {
    chat: 'reading chat',
    docs: name.includes('write') ? 'writing docs' : 'reading docs',
    memory: 'checking its memory',
    directory: 'looking things up',
    sessions: 'checking its sessions',
    git: 'working in the repository',
    fs: 'working with files',
    checklist: 'updating its checklist',
    skills: 'loading a skill',
    triggers: 'updating triggers',
    subscriptions: 'updating subscriptions',
    env: 'working in an environment',
  }
  if (group && byGroup[group]) return byGroup[group]
  // An MCP tool, e.g. `gitlab.create_merge_request`: say which integration.
  return group && group !== name ? `using ${group}` : `using ${name}`
}

const stateOf = (r: Run): ChatActivityState =>
  r.data.state === 'suspended'
    ? 'waiting'
    : r.data.state === 'paused'
      ? 'paused'
      : r.data.state === 'queued'
        ? 'queued'
        : 'running'

const WAITING_ON: Record<string, ChatActivityItem['waitingOn']> = { delivery: 'reply', runs: 'work', timer: 'time' }

/** Why a run is paused, or what it waits on. */
const details = (r: Run): Pick<ChatActivityItem, 'pauseReason' | 'waitingOn'> => {
  if (r.data.state === 'paused' && r.data.pauseReason) return { pauseReason: r.data.pauseReason }
  const on = r.data.state === 'suspended' && r.data.wait ? WAITING_ON[r.data.wait.type] : undefined
  return on ? { waitingOn: on } : {}
}

const clip = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

/** The thread a chat event is about, or null for anything else. */
function threadOf(e: MpEvent | null): ThreadRef | null {
  if (e?.data.source !== 'chat' || e.data.subject?.system !== 'mp') return null
  const p = e.data.payload as Partial<ChatEventPayload> | undefined
  if (typeof p?.channelId !== 'string') return null
  return {
    channelId: p.channelId,
    threadId: e.data.subject.id,
    ...(typeof p.messageId === 'string' ? { messageId: p.messageId } : {}),
  }
}

/** A bounded set: the oldest entries go first. */
class Remembered {
  private ids = new Set<string>()
  has(id: string) {
    return this.ids.has(id)
  }
  add(id: string) {
    this.ids.add(id)
    if (this.ids.size > MAX_REMEMBERED) this.ids.delete(this.ids.values().next().value!)
  }
}

export class ChatActivity {
  private runs = new Map<string, Tracked>()
  private ignored = new Remembered()
  private ended = new Remembered()
  /** Session → the thread its `sessions.message` was about, until the message's event is routed. */
  private forwards = new Map<string, { ref: ThreadRef; at: number }>()
  private offs: (() => void)[] = []
  private chain: Promise<void> = Promise.resolve()

  constructor(private s: Services) {
    const on = (topic: string, fn: (m: BusMessage) => Promise<void>) =>
      this.offs.push(
        s.bus.subscribe(topic, (m) => {
          this.chain = this.chain.then(() =>
            fn(m).catch((err) => s.logger.warn('chat activity: event dropped', { topic, err: errorMessage(err) })),
          )
        }),
      )
    on('record.changed', async (m) => {
      const p = m.payload as { kind?: string; op?: string; id?: string }
      if (p.kind !== 'run' || p.op !== 'create' || typeof p.id !== 'string') return
      const run = await s.sessions.getRun(p.id)
      if (run) await this.consider(run)
    })
    on('run.state', (m) => this.onState(m.payload as { runId: string; to: string }))
    on('tool.called', (m) => this.onTool(m.payload as { runId: string; sessionId: string; name: string; args?: unknown }))
    on('event.routed', (m) =>
      this.onRouted(m.payload as { eventId: string; deliveries: { sessionId: string; outcome: string; runId?: string }[] }),
    )
    // Runs that were going before a restart.
    this.chain = this.chain.then(() =>
      this.bootstrap().catch((err) => s.logger.warn('chat activity: bootstrap failed', { err: errorMessage(err) })),
    )
  }

  /** The runs working on a channel's threads now, oldest first. */
  async items(channelId: string): Promise<ChatActivityItem[]> {
    await this.chain
    return [...this.runs.values()]
      .map((t) => t.item)
      .filter((i) => i.channelId === channelId)
      .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))
  }

  async channelExists(id: string): Promise<boolean> {
    return !!(await this.s.chat.getChannel(id))
  }

  /** Resolves once every bus message received so far was handled. */
  flush(): Promise<void> {
    return this.chain
  }

  close() {
    for (const off of this.offs) off()
  }

  private async bootstrap() {
    for (const run of await this.s.sessions.runs({ state: ['queued', 'running', 'suspended', 'paused'] }))
      await this.consider(run)
  }

  /** Works out whether a run is about a chat thread, and tracks it (or reports its end) if so. */
  private async consider(run: Run, known?: ThreadRef & { chatCaused?: boolean }) {
    if (this.runs.has(run.id) || this.ended.has(run.id) || this.ignored.has(run.id)) return
    const where = known ?? (await this.attribute(run, 0))
    if (!where) {
      this.ignored.add(run.id)
      return
    }
    const tracked = await this.track(run, where, !!where.chatCaused)
    if (TERMINAL_RUN_STATES.includes(run.data.state)) await this.finish(tracked, run)
    else this.publish(tracked)
  }

  private async attribute(run: Run, depth: number): Promise<(ThreadRef & { chatCaused?: boolean }) | null> {
    const cause = run.data.cause
    // A message a session only took note of (no model call) isn't work on the thread.
    if (cause.note?.endsWith(':noted')) return null
    if (cause.eventId) {
      const e = await this.s.rawEvents.get(cause.eventId)
      const ref = threadOf(e)
      if (ref) return { ...ref, chatCaused: true }
      // A session answering a `sessions.message` from a run that works on a thread.
      const from = (e?.data.payload as { fromSessionId?: unknown } | undefined)?.fromSessionId
      if (e?.data.type === 'session.message' && typeof from === 'string') {
        const f = this.forwards.get(from)
        if (f && this.s.clock.now() - f.at < FORWARD_TTL_MS) return f.ref
      }
    }
    if (cause.parentRunId) {
      const parent = this.runs.get(cause.parentRunId)
      if (parent) return this.refOf(parent.item)
      if (depth < MAX_DEPTH) {
        const p = await this.s.sessions.getRun(cause.parentRunId)
        const ref = p ? await this.attribute(p, depth + 1) : null
        if (ref) return this.refOf(ref)
      }
    }
    // A session subscribed to a thread: its live runs work on it, whatever woke them.
    for (const sub of await this.s.events.subscriptions.forSession(run.data.sessionId)) {
      const subject = sub.data.subject
      if (subject.system !== 'mp' || !subject.id.startsWith('msg_')) continue
      const root = await this.s.chat.getMessage(subject.id)
      if (root) return { channelId: root.data.channelId, threadId: root.data.threadId ?? root.id }
    }
    return null
  }

  private refOf(r: ThreadRef): ThreadRef {
    return { channelId: r.channelId, threadId: r.threadId, ...(r.messageId ? { messageId: r.messageId } : {}) }
  }

  private async track(run: Run, where: ThreadRef, chatCaused: boolean): Promise<Tracked> {
    const views = new Views(this.s)
    const session = await views.session(run.data.sessionId)
    const employee = await views.employee(run.data.employeeId)
    const router = !!session && views.isRouter(session)
    const handle = employee?.key ?? undefined
    const label = router
      ? `@${handle ?? employee?.data.name ?? 'employee'}`
      : session
        ? await views.sessionLabel(session)
        : run.data.sessionId
    const item: ChatActivityItem = {
      ...this.refOf(where),
      sessionId: run.data.sessionId,
      employee: { id: run.data.employeeId, name: employee?.data.name ?? run.data.employeeId, ...(handle ? { handle } : {}) },
      sessionLabel: label,
      ...(router ? { router: true } : {}),
      runId: run.id,
      state: stateOf(run),
      since: run.updatedAt,
      ...details(run),
    }
    const tracked: Tracked = { item, tools: [], chatCaused }
    this.runs.set(run.id, tracked)
    return tracked
  }

  private async onState(p: { runId: string; to: string }) {
    const tracked = this.runs.get(p.runId)
    const run = await this.s.sessions.getRun(p.runId)
    if (!run) return
    if (!tracked) {
      // A run we haven't seen created (e.g. from before a restart, or created in another process).
      if (!TERMINAL_RUN_STATES.includes(run.data.state)) await this.consider(run)
      return
    }
    if (TERMINAL_RUN_STATES.includes(run.data.state)) return this.finish(tracked, run)
    const { pauseReason: _p, waitingOn: _w, ...rest } = tracked.item
    tracked.item = { ...rest, state: stateOf(run), since: run.updatedAt, ...details(run) }
    this.publish(tracked)
  }

  private async onTool(p: { runId: string; sessionId: string; name: string; args?: unknown }) {
    const tracked = this.runs.get(p.runId)
    if (!tracked || typeof p.name !== 'string') return
    const name = p.name.replace(/__/g, '.')
    tracked.tools.push(name)
    if (name === 'sessions.message') {
      const to = (p.args as { to?: unknown } | null | undefined)?.to
      if (typeof to === 'string') tracked.messaged = to
      // The session it messages takes the thread over: its run shows here once the message is routed.
      this.forwards.set(p.sessionId, { ref: this.refOf(tracked.item), at: this.s.clock.now() })
      this.pruneForwards()
    }
    const step = describeStep(name)
    if (step === tracked.item.step) return
    tracked.item = { ...tracked.item, step }
    this.publish(tracked)
  }

  private pruneForwards() {
    const now = this.s.clock.now()
    for (const [k, v] of this.forwards) if (now - v.at > FORWARD_TTL_MS) this.forwards.delete(k)
  }

  private async onRouted(p: { eventId: string; deliveries: { sessionId: string; outcome: string; runId?: string }[] }) {
    const e = await this.s.rawEvents.get(p.eventId)
    const ref = threadOf(e)
    if (!e || !ref) return
    const withRun = (p.deliveries ?? []).filter((d) => typeof d.runId === 'string')
    for (const d of withRun) {
      const tracked = this.runs.get(d.runId!)
      if (tracked) {
        // A run already going got this message in its inbox: it shows under the newest message.
        if (ref.messageId && tracked.item.messageId !== ref.messageId && tracked.item.threadId === ref.threadId) {
          tracked.item = { ...tracked.item, messageId: ref.messageId }
          this.publish(tracked)
        }
        continue
      }
      const run = await this.s.sessions.getRun(d.runId!)
      if (run) await this.consider(run, { ...ref, chatCaused: true })
    }
    if (withRun.length || !POSTED.has(e.data.type)) return
    // Nobody picked it up. Worth saying only for a person's message that asked for someone.
    const payload = e.data.payload as Partial<ChatEventPayload> | undefined
    if (payload?.author?.kind !== 'contact') return
    const tagged = (payload.tags ?? []).some((t) => t.type === 'employee' || t.type === 'session')
    const expected = tagged || (p.deliveries ?? []).length > 0 || (await this.s.events.triggers.match(e)).length > 0
    if (!expected) return
    this.done({ ...ref, outcome: 'unrouted' })
  }

  /** Reports how a run ended, and stops tracking it. A hand-off starts tracking the session that took over. */
  private async finish(tracked: Tracked, run: Run) {
    this.runs.delete(run.id)
    this.ended.add(run.id)
    const item = tracked.item
    const base = {
      ...this.refOf(item),
      runId: run.id,
      sessionId: item.sessionId,
      employee: item.employee,
      sessionLabel: item.sessionLabel,
    }
    const d: RunData = run.data
    if (d.state !== 'completed') {
      const reason = d.state === 'cancelled' ? (d.result?.error ?? 'cancelled') : (d.result?.error ?? 'the run failed')
      return this.done({ ...base, outcome: 'failed', reason: clip(reason) })
    }
    // Handed off: a run it started in another session, or a session it messaged.
    const children = await this.s.records.query<RunData>('run', {
      where: [{ field: 'cause.parentRunId', op: 'eq', value: run.id }],
      orderBy: { field: 'createdAt' },
      limit: 10,
    })
    const child = children.items.find((c) => c.data.sessionId !== d.sessionId)
    if (child) {
      const views = new Views(this.s)
      const session = await views.session(child.data.sessionId)
      const label = session ? await views.sessionLabel(session) : child.data.sessionId
      this.done({
        ...base,
        outcome: 'handed_off',
        handedTo: { sessionId: child.data.sessionId, sessionLabel: label, runId: child.id },
      })
      await this.consider(child as Run, this.refOf(item))
      return
    }
    if (tracked.messaged) {
      const target = await this.resolveSession(tracked.messaged, d.employeeId)
      if (target) return this.done({ ...base, outcome: 'handed_off', handedTo: target })
    }
    const output = d.result?.output?.trim()
    const answered =
      tracked.tools.some((t) => ANSWER_TOOLS.has(t)) ||
      (tracked.chatCaused && !!output && !NO_REPLY_RE.test(output)) ||
      // Tracked after the fact (a restart): look for its message in the thread.
      (!tracked.tools.length && (await this.postedIn(item.threadId, d.sessionId, run.createdAt)))
    this.done({ ...base, outcome: answered ? 'replied' : 'no_reply' })
  }

  private async postedIn(threadId: string, sessionId: string, since: string): Promise<boolean> {
    const r = await this.s.records.query<{ threadId: string | null }>('message', {
      where: [
        { field: 'author', op: 'eq', value: { kind: 'session', id: sessionId } },
        { field: 'createdAt', op: 'gte', value: since },
      ],
      limit: 20,
    })
    return r.items.some((m) => m.data.threadId === threadId || m.id === threadId)
  }

  /** `ses_…`, `@handle#slug` or `#slug` (of the same employee), as `sessions.message` takes them. */
  private async resolveSession(to: string, employeeId: string): Promise<ChatActivityDone['handedTo'] | null> {
    const s = this.s
    const t = to.trim()
    let session = null
    const tag = /^@?([A-Za-z0-9][A-Za-z0-9._-]*)#([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(t)
    if (/^ses_/.test(t)) session = await s.sessions.get(t)
    else if (tag && t.startsWith('@')) {
      const emp = await s.directory.employees.byHandle(tag[1]!)
      session = emp ? await s.sessions.bySlug(emp.id, tag[2]!) : null
    } else session = await s.sessions.bySlug(employeeId, t.replace(/^#/, ''))
    if (!session) return null
    return { sessionId: session.id, sessionLabel: await new Views(s).sessionLabel(session) }
  }

  private publish(t: Tracked) {
    this.s.bus.publish(CHAT_ACTIVITY_TOPIC, { channelId: t.item.channelId, item: t.item })
  }

  private done(d: ChatActivityDone) {
    this.s.bus.publish(CHAT_ACTIVITY_DONE_TOPIC, d)
  }
}

/** `GET /api/chat/channels/:id/activity`: who is working on the channel's threads, for people who may see it. */
export function chatActivityRoutes(activity: ChatActivity, vis: ChatVisibility): Hono {
  const app = new Hono()
  app.get('/api/chat/channels/:id/activity', async (c) => {
    const id = c.req.param('id')
    if (!(await activity.channelExists(id))) throw new NotFoundError('channel', id)
    await vis.requireChannel(principalOf(c).contactId, id)
    return c.json(await activity.items(id))
  })
  return app
}
