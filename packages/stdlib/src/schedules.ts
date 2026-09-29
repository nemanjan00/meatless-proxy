import { NotFoundError, ValidationError, errorMessage, type Json } from '@mp/core'
import {
  SCHEDULED_TASK_FIRED,
  checkReport,
  checkTimeZone,
  createScheduledTasks,
  describeWhen,
  formatLocal,
  parseAt,
  parseDuration,
  parseEvery,
  scheduledTaskEvent,
  type ReportTarget,
  type ScheduledTask,
  type ScheduledTaskPatch,
  type ScheduledTasks,
  type TaskSessionMode,
  type TaskWhen,
} from '@mp/events'
import type { Run, Session } from '@mp/sessions'
import type { Actor } from '@mp/store'
import { Roles, line, promptForEmployee } from './kit.ts'
import { subscriptionScope } from './subscription-presets.ts'
import { DEFAULT_TOOLSET } from './toolsets.ts'
import type { StdlibDeps } from './types.ts'

/**
 * Scheduled tasks and follow-ups for the employee's tools and the server's API
 * (docs/spec.md#scheduled-tasks). The records and the scheduling math are `@mp/events`; this adds
 * what needs the rest of the harness: a task's own session (with the employee prompt and its full
 * toolset), where "here" is for a report, and running a task now.
 */

/** When, as a person or the model says it: exactly one of these. */
export interface WhenInput {
  /** A one-off time: ISO with an offset, or a wall-clock time in the time zone ("2026-10-02 16:00", "friday 16:00"). */
  at?: string
  /** A one-off delay: "2 hours", "30 minutes". */
  in?: string
  /** Recurring, in words: "weekday at 09:00". */
  every?: string
  /** Recurring, as cron (5 fields, minute first). */
  cron?: string
}

export interface CreateTaskRequest {
  employeeId: string
  instruction: string
  when: TaskWhen
  timezone: string
  requesterId?: string
  report?: ReportTarget
  sessionMode?: TaskSessionMode
  graceSeconds?: number
}

export interface ScheduleService {
  readonly tasks: ScheduledTasks
  /** The company time zone (the `timezone` setting), or UTC. */
  defaultTimezone(): Promise<string>
  /** Resolves `at | in | every | cron` against now in `timezone`. `ValidationError` unless exactly one is given and valid. */
  resolveWhen(input: WhenInput, timezone: string): TaskWhen
  /** Creates a task and its session: the employee prompt, the employee's full toolset, a `requested_by` link. */
  create(req: CreateTaskRequest, actor: Actor): Promise<ScheduledTask>
  /** Leaves a note for `sessionId`, delivered back into it at `when`. */
  followUp(
    req: { employeeId: string; sessionId: string; note: string; when: TaskWhen; timezone: string; requesterId?: string },
    actor: Actor,
  ): Promise<ScheduledTask>
  update(id: string, patch: ScheduledTaskPatch, actor: Actor): Promise<ScheduledTask>
  /** Deletes it; a task's own session is marked done and its subscriptions end. */
  cancel(id: string, actor: Actor): Promise<void>
  /** Fires it now, outside its schedule. `key` makes a retry fire once. */
  runNow(id: string, opts: { key: string; byName?: string }): Promise<{ task: ScheduledTask; eventId: string }>
  /** The report target for "here": the conversation a run was asked in, or the thread its session owns. */
  here(runId: string | undefined, sessionId: string): Promise<ReportTarget | undefined>
  /** Resolves a report as the tools take it: `here`, `none`, `{ threadId }`, `{ channel }` or `{ subject }`. */
  parseReport(input: unknown, runId: string | undefined, sessionId: string): Promise<ReportTarget | undefined>
}

const services = new WeakMap<StdlibDeps, ScheduleService>()

/** The schedule service of a set of stdlib deps (one per deps object). */
export function scheduleService(deps: StdlibDeps): ScheduleService {
  let s = services.get(deps)
  if (!s) {
    s = createScheduleService(deps)
    services.set(deps, s)
  }
  return s
}

/** One-line view of a schedule, for tools and lists: words, time zone, next run in local time. */
export function scheduleSummary(tasks: ScheduledTasks, t: ScheduledTask, now: number): Record<string, Json> {
  const next = tasks.nextRun(t, now)
  const d = t.data
  return {
    id: t.id,
    kind: d.kind,
    instruction: line(d.instruction, 300),
    schedule: describeWhen(d.when, d.timezone),
    enabled: d.enabled,
    ...(d.done ? { done: true } : {}),
    ...(next ? { nextRun: next, nextRunLocal: `${formatLocal(Date.parse(next), d.timezone)} ${d.timezone}` } : {}),
    ...(d.lastRun ? { lastRun: d.lastRun as unknown as Json } : {}),
    fired: d.fired,
    ...(d.report ? { report: (d.report.label ?? reportName(d.report)) as Json } : {}),
    ...(d.sessionId ? { sessionId: d.sessionId } : {}),
    ...(d.requesterId ? { requesterId: d.requesterId } : {}),
  }
}

/** A report target in a few words. */
export function reportName(r: ReportTarget): string {
  if (r.type === 'chat') return r.threadId ? `chat thread ${r.threadId}` : `chat channel ${r.channelId}`
  return `${r.subject.system}:${r.subject.id}`
}

export function createScheduleService(deps: StdlibDeps): ScheduleService {
  const { sessions, records, events, chat, clock } = deps
  const tasks = deps.scheduledTasks ?? createScheduledTasks({ records, clock })

  const threadSubject = (r: ReportTarget | undefined) => {
    if (!r) return null
    if (r.type === 'chat') return r.threadId ? { system: 'mp', id: r.threadId } : null
    // A Slack thread is `C123/1700.1`; a channel alone isn't a conversation to follow.
    if (r.subject.system === 'slack' && !r.subject.id.includes('/')) return null
    return r.subject.system === 'mp' ? null : r.subject
  }

  const chatTarget = async (channelId: string, threadId?: string): Promise<ReportTarget> => {
    const ch = await chat.getChannel(channelId)
    return {
      type: 'chat',
      channelId,
      ...(threadId ? { threadId } : {}),
      ...(ch ? { label: threadId ? `thread in #${ch.data.name}` : `#${ch.data.name}` } : {}),
    }
  }

  const service: ScheduleService = {
    tasks,

    async defaultTimezone() {
      const tz = (await deps.defaultTimezone?.())?.trim()
      if (!tz) return 'UTC'
      try {
        return checkTimeZone(tz)
      } catch {
        return 'UTC'
      }
    },

    resolveWhen(input, timezone) {
      const given = (['at', 'in', 'every', 'cron'] as const).filter(
        (k) => input[k] !== undefined && input[k] !== null && input[k] !== '',
      )
      if (given.length !== 1)
        throw new ValidationError(
          given.length
            ? `give only one of at, in, every or cron (got ${given.join(' and ')})`
            : 'say when: at (a time), in (a delay), every (e.g. "weekday at 09:00") or cron',
        )
      const now = clock.now()
      const k = given[0]!
      if (k === 'at') return { type: 'once', at: new Date(parseAt(input.at, timezone, now)).toISOString() }
      if (k === 'in') return { type: 'once', at: new Date(now + parseDuration(input.in)).toISOString() }
      if (k === 'every') return { type: 'cron', cron: parseEvery(input.every) }
      if (typeof input.cron !== 'string') throw new ValidationError('cron must be a string such as "0 9 * * 1-5"')
      return { type: 'cron', cron: input.cron }
    },

    async create(req, actor) {
      const emp = await deps.directory.employees.get(req.employeeId)
      if (!emp) throw new NotFoundError('employee', req.employeeId)
      const task = await tasks.create(
        {
          kind: 'task',
          instruction: req.instruction,
          when: req.when,
          timezone: req.timezone,
          employeeId: req.employeeId,
          ...(req.requesterId ? { requesterId: req.requesterId } : {}),
          ...(req.report ? { report: req.report } : {}),
          ...(req.sessionMode ? { sessionMode: req.sessionMode } : {}),
          ...(req.graceSeconds !== undefined ? { graceSeconds: req.graceSeconds } : {}),
        },
        actor,
      )
      try {
        const prompt = await promptForEmployee(deps, req.employeeId)
        const toolset = deps.toolsetFor ? await deps.toolsetFor(req.employeeId) : [...DEFAULT_TOOLSET]
        const requester = req.requesterId ? await records.get('contact', req.requesterId) : null
        const session = await sessions.create({
          employeeId: req.employeeId,
          title: `Scheduled: ${line(task.data.instruction, 60)}`,
          toolset,
          entries: [{ kind: 'system', content: { text: prompt } }],
          ...(requester ? { links: [{ ref: { kind: 'contact', id: requester.id }, role: Roles.requestedBy }] } : {}),
          meta: { scheduledTaskId: task.id },
          actor,
        })
        // A report thread is this task's conversation: replies there come back to it (when it keeps one session).
        const subject = threadSubject(task.data.report)
        if (subject && task.data.sessionMode === 'continue') {
          const owned = (await events.subscriptions.forSubject(subject)).some((x) => x.data.primary)
          await events.subscriptions.subscribe(session.id, subject, {
            primary: !owned,
            ...subscriptionScope(subject.system),
            actor,
          })
        }
        return await tasks.update(task.id, { sessionId: session.id }, actor)
      } catch (err) {
        await tasks.remove(task.id).catch(() => {})
        throw err
      }
    },

    async followUp(req, actor) {
      const session = await sessions.get(req.sessionId)
      if (!session || session.data.employeeId !== req.employeeId) throw new NotFoundError('session', req.sessionId)
      if (req.when.type !== 'once') throw new ValidationError('a follow-up happens once: give in or at')
      return tasks.create(
        {
          kind: 'follow_up',
          instruction: req.note,
          when: req.when,
          timezone: req.timezone,
          employeeId: req.employeeId,
          sessionId: req.sessionId,
          ...(req.requesterId ? { requesterId: req.requesterId } : {}),
        },
        actor,
      )
    },

    update: (id, patch, actor) => tasks.update(id, patch, actor),

    async cancel(id, actor) {
      const t = await tasks.require(id)
      await tasks.remove(id, actor)
      if (t.data.kind !== 'task' || !t.data.sessionId) return
      try {
        const s = await sessions.get(t.data.sessionId)
        if (s?.data.meta?.scheduledTaskId === id) {
          await events.subscriptions.endForSession(s.id, 'scheduled task cancelled')
          if (s.data.status !== 'done') await sessions.update(s.id, { status: 'done' }, actor)
        }
      } catch (err) {
        deps.logger.warn('scheduled task: could not close its session', { taskId: id, err: errorMessage(err) })
      }
    },

    async runNow(id, opts) {
      const task = await tasks.require(id)
      if (!task.data.sessionId) throw new ValidationError('this task has no session yet: try again in a moment')
      const requester = task.data.requesterId ? await deps.directory.contacts.get(task.data.requesterId) : null
      const input = scheduledTaskEvent(task, clock.iso(), {
        dedupeKey: `scheduled_task:${id}:now:${opts.key}`,
        manual: true,
        ...(requester ? { requesterName: requester.data.name } : {}),
        ...(opts.byName ? { byName: opts.byName } : {}),
      })
      const { event } = await events.ingest(input)
      return { task: await tasks.markRunNow(id, event.id), eventId: event.id }
    },

    async here(runId, sessionId) {
      const run = runId ? await sessions.getRun(runId) : null
      const eventId = run?.data.cause.eventId
      const event = eventId ? await events.get(eventId) : null
      if (event) {
        const p = event.data.payload as { channelId?: unknown; messageId?: unknown; threadId?: unknown } | undefined
        if (event.data.source === 'chat' && typeof p?.channelId === 'string' && typeof p.messageId === 'string')
          return chatTarget(p.channelId, typeof p.threadId === 'string' && p.threadId ? p.threadId : p.messageId)
        const subject = event.data.subject
        // A firing of another task reports where that one does.
        if (event.data.source === 'schedule' && event.data.type === SCHEDULED_TASK_FIRED) {
          const r = (event.data.payload as { report?: unknown } | undefined)?.report
          if (r) return checkReport(r)
        } else if (subject && subject.system !== 'mp') return { type: 'subject', subject }
      }
      // Work handed over by a router (no event of its own): the conversation this session owns.
      for (const sub of await events.subscriptions.forSession(sessionId)) {
        if (!sub.data.primary) continue
        const s = sub.data.subject
        if (s.system === 'mp') {
          const m = await chat.getMessage(s.id)
          if (m) return chatTarget(m.data.channelId, m.data.threadId ?? m.id)
        } else return { type: 'subject', subject: s }
      }
      return undefined
    },

    async parseReport(input, runId, sessionId) {
      if (input === undefined || input === null || input === 'here') return service.here(runId, sessionId)
      if (input === 'none' || input === false) return undefined
      const r = input as { threadId?: unknown; channel?: unknown; subject?: unknown; type?: unknown }
      if (typeof r !== 'object') throw new ValidationError('report must be "here", "none", {threadId}, {channel} or {subject}')
      if (r.type) return checkReport(r)
      if (typeof r.threadId === 'string' && r.threadId.trim()) {
        const id = r.threadId.trim().replace(/^mp:/, '')
        const m = await chat.getMessage(id)
        if (!m) throw new NotFoundError('chat thread', id)
        return chatTarget(m.data.channelId, m.data.threadId ?? m.id)
      }
      if (typeof r.channel === 'string' && r.channel.trim()) {
        const v = r.channel.trim()
        const ch = /^chn_/.test(v) ? await chat.getChannel(v) : await chat.channelByName(v)
        if (!ch) throw new NotFoundError('channel', v)
        return chatTarget(ch.id)
      }
      if (r.subject) return checkReport({ type: 'subject', subject: r.subject })
      throw new ValidationError('report must be "here", "none", {threadId}, {channel} or {subject: {system, id}}')
    },
  }
  return service
}

/** The report target of a run started by a task firing, if it has one in harness chat. */
export async function chatReportOf(
  deps: Pick<StdlibDeps, 'events'>,
  run: Run,
): Promise<Extract<ReportTarget, { type: 'chat' }> | null> {
  const eventId = run.data.cause.eventId
  if (!eventId) return null
  const event = await deps.events.get(eventId)
  if (event?.data.source !== 'schedule' || event.data.type !== SCHEDULED_TASK_FIRED) return null
  const r = (event.data.payload as { report?: ReportTarget } | undefined)?.report
  return r?.type === 'chat' ? r : null
}

/** Sessions that belong to a scheduled task (its own session). */
export const isTaskSession = (s: Session) => typeof s.data.meta?.scheduledTaskId === 'string'
