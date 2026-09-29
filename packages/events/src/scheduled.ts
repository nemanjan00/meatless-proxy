import { NotFoundError, ValidationError, isMpError, systemClock, type Clock, type Json, type KindSchema } from '@mp/core'
import type { Records } from '@mp/records'
import type { Actor, StoredRecord } from '@mp/store'
import type { IngestInput, Subject } from './events.ts'
import { internalSubject } from './events.ts'
import { DEFAULT_GRACE_SECONDS, checkSchedule, dueFiring, nextFirings } from './schedule.ts'
import { checkTimeZone, describeCron, formatLocal } from './when.ts'

/**
 * Scheduled tasks (docs/spec.md#scheduled-tasks): an instruction an employee carries out at a time
 * or on a schedule, for someone, reporting somewhere. Follow-ups are scheduled tasks too: a note a
 * session leaves for itself, delivered back into that session later.
 *
 * Firing works like schedule triggers: `due(now)` is read-only; the scheduler ingests one event per
 * task and slot with `scheduledTaskDedupeKey`, then calls `markFired`, which only moves forward, so
 * racing ticks, restarts and a second instance never fire twice.
 */

export const SCHEDULED_TASK_KIND = 'scheduled_task'
/** The event a firing ingests (source `schedule`). */
export const SCHEDULED_TASK_FIRED = 'scheduled_task.fired'
/** How late a missed recurring firing may still fire. */
export const TASK_GRACE_SECONDS = DEFAULT_GRACE_SECONDS
/** How late a missed one-off (a reminder, a follow-up) may still fire: longer, since it never comes again. */
export const ONCE_GRACE_SECONDS = 3600
/** The most characters an instruction or note may have. */
export const MAX_INSTRUCTION = 4000

export type ScheduledTaskKind = 'task' | 'follow_up'
/** When: once at a time (ISO), or on a cron schedule read in the task's time zone. */
export type TaskWhen = { type: 'once'; at: string } | { type: 'cron'; cron: string }
/**
 * Where the task reports: a harness chat thread or channel, or an outside subject such as a Slack
 * thread (`slack:C123/1700000000.000100`) or channel (`slack:C123`). `label` is for people.
 */
export type ReportTarget =
  | { type: 'chat'; channelId: string; threadId?: string; label?: string }
  | { type: 'subject'; subject: Subject; label?: string }

/** How each firing runs: in the task's one session, which remembers earlier runs, or a fresh fork of it. */
export type TaskSessionMode = 'continue' | 'fresh'

export type TaskRunState = 'queued' | 'running' | 'suspended' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'missed'

/** A firing and what became of it. */
export interface TaskRun {
  /** When it fired (or was missed), ISO. */
  at: string
  eventId?: string
  runId?: string
  sessionId?: string
  state: TaskRunState
  /** The start of the run's final output or error. */
  output?: string
  /** Run now, by a person or the employee. */
  manual?: boolean
}

export interface ScheduledTaskData extends Record<string, unknown> {
  kind: ScheduledTaskKind
  instruction: string
  when: TaskWhen
  timezone: string
  graceSeconds: number
  employeeId: string
  /** The contact who asked for it: they, and admins, may change it. Its runs are theirs. */
  requesterId?: string
  /** Where firings run: the task's own session (tasks) or the session that left the note (follow-ups). */
  sessionId?: string
  sessionMode: TaskSessionMode
  report?: ReportTarget
  enabled: boolean
  /** A one-off that has fired (or was missed): it doesn't fire again. */
  done?: boolean
  /** The last slot handled, or when the schedule was set or resumed. Only moves forward. */
  lastScheduledAt: string
  fired: number
  lastFiredAt?: string
  lastRun?: TaskRun
}
export type ScheduledTask = StoredRecord<ScheduledTaskData>

export interface CreateScheduledTaskInput {
  kind?: ScheduledTaskKind
  instruction: string
  when: TaskWhen
  /** IANA name. Default UTC. */
  timezone?: string
  graceSeconds?: number
  employeeId: string
  requesterId?: string
  sessionId?: string
  /** Default `continue`. Follow-ups always continue their session. */
  sessionMode?: TaskSessionMode
  report?: ReportTarget
  enabled?: boolean
}

export interface ScheduledTaskPatch {
  instruction?: string
  when?: TaskWhen
  timezone?: string
  graceSeconds?: number
  /** `null` removes it. */
  report?: ReportTarget | null
  sessionMode?: TaskSessionMode
  enabled?: boolean
  /** Set by the harness once the task's session exists. */
  sessionId?: string
}

export interface DueTask {
  task: ScheduledTask
  /** The slot, ISO. */
  at: string
  /** A one-off whose time passed longer ago than its grace period: mark it missed, don't fire it. */
  missed?: boolean
}

export interface ScheduledTaskQuery {
  employeeId?: string
  kind?: ScheduledTaskKind
  sessionId?: string
  requesterId?: string
  enabled?: boolean
}

export interface ScheduledTasks {
  create(input: CreateScheduledTaskInput, actor?: Actor): Promise<ScheduledTask>
  get(id: string): Promise<ScheduledTask | null>
  require(id: string): Promise<ScheduledTask>
  /** Newest first. */
  list(q?: ScheduledTaskQuery): Promise<ScheduledTask[]>
  /**
   * Changes it. A new time or schedule starts from now (earlier slots don't fire) and re-arms a
   * one-off that already fired; resuming skips the slots that passed while it was paused. A one-off
   * whose time has passed can't be resumed without a new time.
   */
  update(id: string, patch: ScheduledTaskPatch, actor?: Actor): Promise<ScheduledTask>
  remove(id: string, actor?: Actor): Promise<void>
  /** Enabled tasks with a slot due at `now` (default: the clock), and one-offs missed beyond their grace. Read-only. */
  due(now?: number): Promise<DueTask[]>
  /** Records that the slot at `at` fired (event `eventId`). Forward only; a one-off is done. Safe under concurrency. */
  markFired(id: string, at: string, eventId?: string): Promise<ScheduledTask>
  /** A one-off that was missed: done, with a `missed` last run. */
  markMissed(id: string, at: string): Promise<ScheduledTask>
  /** Records a run now (not a slot): counts it; a one-off is done. */
  markRunNow(id: string, eventId: string): Promise<ScheduledTask>
  /** Updates the last run: a newer firing replaces it, the same firing (by `eventId`) is updated. */
  recordRun(id: string, run: TaskRun): Promise<ScheduledTask | null>
  /** When it fires next (ISO), or null: paused, done, or no further slot within a year. */
  nextRun(task: ScheduledTask | ScheduledTaskData, now?: number): string | null
}

export const scheduledTaskSchema: KindSchema = {
  kind: SCHEDULED_TASK_KIND,
  prefix: 'tsk',
  description:
    'An instruction an employee carries out at a time or on a schedule, for someone, reporting somewhere; or a follow-up a session left for itself.',
  titleField: 'instruction',
  core: [
    { name: 'kind', type: 'enum', values: ['task', 'follow_up'], required: true },
    { name: 'instruction', type: 'string', required: true, description: 'What to do (for a follow-up: the note).' },
    { name: 'when', type: 'json', required: true, description: '`{type:"once", at}` or `{type:"cron", cron}`.' },
    { name: 'timezone', type: 'string', required: true, description: 'IANA name the schedule is read in.' },
    { name: 'graceSeconds', type: 'number', required: true, description: 'How late a missed slot may still fire.' },
    { name: 'employeeId', type: 'ref', ref: 'employee', required: true },
    { name: 'requesterId', type: 'ref', ref: 'contact', description: 'Who asked for it.' },
    { name: 'sessionId', type: 'ref', ref: 'session', description: 'Where its firings run.' },
    { name: 'sessionMode', type: 'enum', values: ['continue', 'fresh'], required: true },
    { name: 'report', type: 'json', description: 'Where it reports: a chat thread or channel, or a subject.' },
    { name: 'enabled', type: 'boolean', required: true },
    { name: 'done', type: 'boolean' },
    { name: 'lastScheduledAt', type: 'timestamp', required: true },
    { name: 'fired', type: 'number', required: true },
    { name: 'lastFiredAt', type: 'timestamp' },
    { name: 'lastRun', type: 'json', description: 'The last firing: `{ at, eventId?, runId?, sessionId?, state, output? }`.' },
  ],
}

/** The dedupe key of a slot: once per task and time, across restarts and instances. */
export function scheduledTaskDedupeKey(taskId: string, at: string | Date): string {
  return `scheduled_task:${taskId}:${new Date(at).toISOString()}`
}

/** The task a `scheduled_task.fired` event is for, if it is one. */
export function scheduledTaskId(event: { source: string; type: string; payload?: Json }): string | undefined {
  if (event.source !== 'schedule' || event.type !== SCHEDULED_TASK_FIRED) return undefined
  const id = (event.payload as { taskId?: unknown } | undefined)?.taskId
  return typeof id === 'string' && id ? id : undefined
}

/** Validates a `when`. A one-off's time is an ISO time. */
export function checkWhen(input: unknown): TaskWhen {
  const w = input as TaskWhen
  if (!w || typeof w !== 'object') throw new ValidationError('when must be {type:"once", at} or {type:"cron", cron}')
  if (w.type === 'once') {
    const ms = typeof w.at === 'string' ? Date.parse(w.at) : Number.NaN
    if (Number.isNaN(ms)) throw new ValidationError('when.at must be an ISO time')
    return { type: 'once', at: new Date(ms).toISOString() }
  }
  if (w.type === 'cron') return { type: 'cron', cron: checkSchedule({ cron: w.cron }).cron }
  throw new ValidationError('when must be {type:"once", at} or {type:"cron", cron}')
}

/** Validates a report target. */
export function checkReport(input: unknown): ReportTarget {
  const r = input as ReportTarget
  const label = (v: unknown) => (typeof v === 'string' && v.trim() ? { label: v.trim().slice(0, 200) } : {})
  if (r && typeof r === 'object') {
    if (r.type === 'chat' && typeof r.channelId === 'string' && r.channelId)
      return {
        type: 'chat',
        channelId: r.channelId,
        ...(typeof r.threadId === 'string' && r.threadId ? { threadId: r.threadId } : {}),
        ...label(r.label),
      }
    if (
      r.type === 'subject' &&
      r.subject &&
      typeof r.subject.system === 'string' &&
      typeof r.subject.id === 'string' &&
      r.subject.system &&
      r.subject.id
    )
      return { type: 'subject', subject: { system: r.subject.system, id: r.subject.id }, ...label(r.label) }
  }
  throw new ValidationError('report must be {type:"chat", channelId, threadId?} or {type:"subject", subject:{system, id}}')
}

const checkInstruction = (v: unknown, what = 'instruction'): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${what} is required`)
  if (v.length > MAX_INSTRUCTION) throw new ValidationError(`${what} must be at most ${MAX_INSTRUCTION} characters`)
  return v.trim()
}

const checkGrace = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 7 * 86_400)
    throw new ValidationError('graceSeconds must be a number from 0 to 604800 (a week)')
  return Math.round(v)
}

const checkMode = (v: unknown): TaskSessionMode => {
  if (v !== 'continue' && v !== 'fresh') throw new ValidationError('sessionMode must be continue or fresh')
  return v
}

/** When a task fires next (ISO), or null. */
export function nextTaskRun(d: ScheduledTaskData, now: number): string | null {
  if (!d.enabled || d.done) return null
  if (d.when.type === 'once') return Date.parse(d.when.at) > Date.parse(d.lastScheduledAt) ? d.when.at : null
  const from = Math.max(now, Date.parse(d.lastScheduledAt))
  try {
    const [next] = nextFirings({ cron: d.when.cron, timezone: d.timezone }, from, from + 366 * 86_400_000, 1)
    return next ? next.toISOString() : null
  } catch {
    return null
  }
}

/**
 * The schedule in words, with its time zone: `every weekday 09:00 Europe/Belgrade`, or
 * `once, Fri 2026-10-02 16:00 Europe/Belgrade`.
 */
export function describeWhen(when: TaskWhen, timezone: string): string {
  if (when.type === 'once') return `once, ${formatLocal(Date.parse(when.at), timezone)} ${timezone}`
  return `${describeCron(when.cron)} ${timezone}`
}

/** How the run should report, for its instruction. */
export function reportHint(report: ReportTarget | undefined): string {
  if (!report) return 'Nobody asked for a report anywhere: do the work; your final answer is kept as the result.'
  if (report.type === 'chat') {
    if (report.threadId)
      return `Report in the harness chat thread ${report.threadId}${report.label ? ` (${report.label})` : ''} with chat.reply. If you end without posting, your final answer is posted there for you.`
    return `Report in the harness chat channel ${report.label ?? report.channelId} with chat.post (channel ${report.channelId}). If you end without posting, your final answer is posted there for you.`
  }
  const { system, id } = report.subject
  if (system === 'slack') {
    const [channel, ts] = id.split('/')
    return ts
      ? `Report in Slack: channel ${channel}, thread ${ts} (mcp.slack.reply).`
      : `Report in Slack channel ${channel} (mcp.slack.post_message).`
  }
  return `Report on ${system}:${id}${report.label ? ` (${report.label})` : ''}, with that system's tools.`
}

/**
 * The event a firing ingests. The instruction comes first (a fresh fork is titled after it), then
 * what the task is, who asked, and where to report.
 */
export function scheduledTaskEvent(
  task: ScheduledTask,
  at: string,
  opts: { dedupeKey?: string; manual?: boolean; requesterName?: string; byName?: string } = {},
): IngestInput {
  const d = task.data
  const when = describeWhen(d.when, d.timezone)
  const firedAt = `${formatLocal(Date.parse(at), d.timezone)} ${d.timezone}`
  const who = opts.requesterName ?? (d.requesterId ? `contact ${d.requesterId}` : undefined)
  const lines =
    d.kind === 'follow_up'
      ? [
          `Follow-up you left for yourself (${task.id}, set ${formatLocal(Date.parse(task.createdAt), d.timezone)} ${d.timezone} for ${firedAt}):`,
          d.instruction,
          '',
          'First check whether it is still needed: an answer may have arrived, or the work moved on, since you left it. If nothing is needed, end without doing anything.',
        ]
      : [
          d.instruction,
          '',
          `(Scheduled task ${task.id}, ${when}${who ? `, asked for by ${who}` : ''}. ${opts.manual ? `Run now${opts.byName ? ` by ${opts.byName}` : ''}` : `This firing: ${firedAt}`}.)`,
          reportHint(d.report),
        ]
  return {
    source: 'schedule',
    type: SCHEDULED_TASK_FIRED,
    dedupeKey: opts.dedupeKey ?? scheduledTaskDedupeKey(task.id, at),
    employeeId: d.employeeId,
    ...(d.requesterId ? { actorContactId: d.requesterId } : {}),
    subject: internalSubject(task.id),
    payload: {
      taskId: task.id,
      kind: d.kind,
      at,
      instruction: d.instruction,
      when: d.when as unknown as Json,
      timezone: d.timezone,
      ...(opts.manual ? { manual: true } : {}),
      ...(d.report ? { report: d.report as unknown as Json } : {}),
      ...(d.requesterId ? { requesterId: d.requesterId } : {}),
    },
    text: lines.join('\n'),
  }
}

export interface ScheduledTasksOptions {
  records: Records
  clock?: Clock
}

const MAX_CAS_RETRIES = 50

export function createScheduledTasks(opts: ScheduledTasksOptions): ScheduledTasks {
  const { records } = opts
  const clock = opts.clock ?? systemClock
  if (!records.kinds.has(SCHEDULED_TASK_KIND)) records.kinds.define(scheduledTaskSchema)

  const cas = async (id: string, fn: (t: ScheduledTask) => Partial<ScheduledTaskData> | null): Promise<ScheduledTask> => {
    for (let i = 0; ; i++) {
      const current = await records.require<ScheduledTaskData>(SCHEDULED_TASK_KIND, id)
      const patch = fn(current)
      if (!patch) return current
      try {
        return await records.update<ScheduledTaskData>(SCHEDULED_TASK_KIND, id, patch, { expectedVersion: current.version })
      } catch (e) {
        if (!isMpError(e, 'conflict') || i >= MAX_CAS_RETRIES) throw e
      }
    }
  }

  const checkFuture = (when: TaskWhen) => {
    if (when.type === 'once' && Date.parse(when.at) <= clock.now())
      throw new ValidationError(`the time ${when.at} has already passed: give a time in the future`)
  }

  const service: ScheduledTasks = {
    async create(input, actor) {
      if (!input || typeof input !== 'object') throw new ValidationError('a scheduled task needs an instruction and a time')
      const kind = input.kind ?? 'task'
      if (kind !== 'task' && kind !== 'follow_up') throw new ValidationError('kind must be task or follow_up')
      if (typeof input.employeeId !== 'string' || !input.employeeId) throw new ValidationError('employeeId is required')
      const instruction = checkInstruction(input.instruction, kind === 'follow_up' ? 'note' : 'instruction')
      const when = checkWhen(input.when)
      checkFuture(when)
      if (kind === 'follow_up' && when.type !== 'once')
        throw new ValidationError('a follow-up happens once: give a time, not a schedule')
      if (kind === 'follow_up' && !input.sessionId) throw new ValidationError('a follow-up needs the session it wakes')
      const timezone = input.timezone === undefined ? 'UTC' : checkTimeZone(input.timezone)
      const graceSeconds =
        input.graceSeconds === undefined
          ? when.type === 'once'
            ? ONCE_GRACE_SECONDS
            : TASK_GRACE_SECONDS
          : checkGrace(input.graceSeconds)
      const data: ScheduledTaskData = {
        kind,
        instruction,
        when,
        timezone,
        graceSeconds,
        employeeId: input.employeeId,
        ...(input.requesterId ? { requesterId: input.requesterId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        sessionMode:
          kind === 'follow_up' ? 'continue' : input.sessionMode === undefined ? 'continue' : checkMode(input.sessionMode),
        ...(input.report !== undefined ? { report: checkReport(input.report) } : {}),
        enabled: input.enabled ?? true,
        lastScheduledAt: clock.iso(),
        fired: 0,
      }
      return records.create<ScheduledTaskData>(SCHEDULED_TASK_KIND, data, actor ? { actor } : {})
    },
    get: (id) => records.get<ScheduledTaskData>(SCHEDULED_TASK_KIND, id),
    async require(id) {
      const t = await records.get<ScheduledTaskData>(SCHEDULED_TASK_KIND, id)
      if (!t) throw new NotFoundError('scheduled task', id)
      return t
    },
    async list(q = {}) {
      const where: Record<string, Json> = {}
      for (const k of ['employeeId', 'kind', 'sessionId', 'requesterId', 'enabled'] as const)
        if (q[k] !== undefined) where[k] = q[k] as Json
      return (
        await records.query<ScheduledTaskData>(SCHEDULED_TASK_KIND, { where, orderBy: { field: 'createdAt', dir: 'desc' } })
      ).items
    },
    async update(id, patch, actor) {
      if (!patch || typeof patch !== 'object') throw new ValidationError('nothing to change')
      const current = await service.require(id)
      const d = current.data
      const p: Partial<ScheduledTaskData> = {}
      if (patch.instruction !== undefined)
        p.instruction = checkInstruction(patch.instruction, d.kind === 'follow_up' ? 'note' : 'instruction')
      if (patch.timezone !== undefined) p.timezone = checkTimeZone(patch.timezone)
      if (patch.graceSeconds !== undefined) p.graceSeconds = checkGrace(patch.graceSeconds)
      if (patch.sessionMode !== undefined && d.kind === 'task') p.sessionMode = checkMode(patch.sessionMode)
      if (patch.report === null) p.report = undefined
      else if (patch.report !== undefined) p.report = checkReport(patch.report)
      if (patch.sessionId !== undefined) p.sessionId = patch.sessionId
      const now = clock.iso()
      if (patch.when !== undefined) {
        const when = checkWhen(patch.when)
        if (d.kind === 'follow_up' && when.type !== 'once') throw new ValidationError('a follow-up happens once: give a time')
        checkFuture(when)
        if (JSON.stringify(when) !== JSON.stringify(d.when) || d.done) {
          p.when = when
          p.lastScheduledAt = now
          p.done = undefined
          if (d.done && patch.enabled === undefined) p.enabled = true
          if (patch.graceSeconds === undefined && when.type !== d.when.type)
            p.graceSeconds = when.type === 'once' ? ONCE_GRACE_SECONDS : TASK_GRACE_SECONDS
        }
      }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw new ValidationError('enabled must be true or false')
        p.enabled = patch.enabled
        if (patch.enabled && !d.enabled) {
          const when = p.when ?? d.when
          if ((p.done ?? d.done) && !p.when)
            throw new ValidationError('this one-off already ran: give it a new time to run again')
          if (when.type === 'once' && !p.when && Date.parse(when.at) <= clock.now())
            throw new ValidationError('its time has passed while it was paused: give it a new time')
          // Slots that passed while it was paused don't fire now.
          if (when.type === 'cron') p.lastScheduledAt = now
        }
      }
      if (!Object.keys(p).length) return current
      return records.update<ScheduledTaskData>(SCHEDULED_TASK_KIND, id, p, actor ? { actor } : {})
    },
    remove: (id, actor) => records.delete(SCHEDULED_TASK_KIND, id, actor ? { actor } : {}),
    async due(now = clock.now()) {
      const out: DueTask[] = []
      for (const t of await service.list({ enabled: true })) {
        const d = t.data
        if (d.done) continue
        const graceMs = (d.graceSeconds ?? TASK_GRACE_SECONDS) * 1000
        if (d.when.type === 'once') {
          const at = Date.parse(d.when.at)
          if (Number.isNaN(at) || at > now || at <= Date.parse(d.lastScheduledAt)) continue
          out.push({ task: t, at: new Date(at).toISOString(), ...(now - at > graceMs ? { missed: true } : {}) })
          continue
        }
        let at: Date | null
        try {
          at = dueFiring({ cron: d.when.cron, timezone: d.timezone, graceSeconds: d.graceSeconds }, d.lastScheduledAt, now)
        } catch {
          continue // stored without validation: never due
        }
        if (at) out.push({ task: t, at: at.toISOString() })
      }
      return out
    },
    async markFired(id, at, eventId) {
      const ms = Date.parse(at)
      if (Number.isNaN(ms)) throw new ValidationError('at must be an ISO timestamp')
      const iso = new Date(ms).toISOString()
      return cas(id, (t) => {
        if (Date.parse(t.data.lastScheduledAt) >= ms) return null
        const once = t.data.when.type === 'once'
        return {
          lastScheduledAt: iso,
          fired: (t.data.fired ?? 0) + 1,
          lastFiredAt: clock.iso(),
          ...(once ? { done: true, enabled: false } : {}),
          ...(eventId && (!t.data.lastRun || t.data.lastRun.eventId !== eventId)
            ? { lastRun: { at: iso, eventId, state: 'queued' as const } }
            : {}),
        }
      })
    },
    async markMissed(id, at) {
      const ms = Date.parse(at)
      if (Number.isNaN(ms)) throw new ValidationError('at must be an ISO timestamp')
      return cas(id, (t) =>
        Date.parse(t.data.lastScheduledAt) >= ms
          ? null
          : {
              lastScheduledAt: new Date(ms).toISOString(),
              done: true,
              enabled: false,
              lastRun: { at: new Date(ms).toISOString(), state: 'missed' },
            },
      )
    },
    async markRunNow(id, eventId) {
      return cas(id, (t) => {
        if (t.data.lastRun?.eventId === eventId) return null
        return {
          fired: (t.data.fired ?? 0) + 1,
          lastFiredAt: clock.iso(),
          lastRun: { at: clock.iso(), eventId, state: 'queued', manual: true },
          ...(t.data.when.type === 'once' ? { done: true, enabled: false, lastScheduledAt: clock.iso() } : {}),
        }
      })
    },
    async recordRun(id, run) {
      if (!(await service.get(id))) return null
      return cas(id, (t) => {
        const last = t.data.lastRun
        const same = !!last && !!run.eventId && last.eventId === run.eventId
        if (last && !same && Date.parse(run.at) < Date.parse(last.at)) return null
        const next: TaskRun = { ...(same ? last : {}), ...run, ...(same && last?.manual ? { manual: true } : {}) }
        if (JSON.stringify(next) === JSON.stringify(last)) return null
        return { lastRun: next }
      })
    },
    nextRun(task, now = clock.now()) {
      const d = 'version' in task && 'data' in task ? (task as ScheduledTask).data : (task as ScheduledTaskData)
      return nextTaskRun(d, now)
    },
  }
  return service
}
