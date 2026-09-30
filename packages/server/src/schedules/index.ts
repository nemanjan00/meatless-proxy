import type * as Api from '@mp/api'
import { DeniedError, NotFoundError, UnavailableError, ValidationError, errorMessage } from '@mp/core'
import {
  checkTimeZone,
  checkWhen,
  describeWhen,
  formatLocal,
  nextFirings,
  scheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskPatch,
  type TaskRun,
  type TaskRunState,
} from '@mp/events'
import { SessionTopics, TERMINAL_RUN_STATES, type RunStateChanged } from '@mp/sessions'
import type { ScheduleService, WhenInput } from '@mp/stdlib'
import { type Context, Hono } from 'hono'
import type { GuardContext } from '../auth/guard.ts'
import { principalOf, viewerOf } from '../auth/guard.ts'
import type { ChatVisibility } from '../auth/visibility.ts'
import { BadRequestError, jsonBody, requireString } from '../http/util.ts'
import { actorOf } from '../http/views.ts'
import type { Services } from '../services.ts'

export { scheduledTaskRecipients } from './recipients.ts'

/**
 * Scheduled tasks and follow-ups in the web UI and the API (`@mp/api` schedules.ts,
 * docs/spec.md#scheduled-tasks): the Schedules page lists them, people create tasks, and admins and
 * the person who asked run, pause, edit and delete them. Also keeps each task's last run up to date
 * as its runs move (`trackScheduledRuns`).
 */

const MANAGE_DENIED = 'only admins and the person who asked for it can change a scheduled task'
const OUTPUT_CHARS = 500
const SYSTEM = { type: 'system' as const, id: 'schedules' }
const line = (t: string, max: number) => {
  const v = t.replace(/\s+/g, ' ').trim()
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`
}

/** Admins, and the person who asked for the task. Used by the guard table and the views. */
export const canManageTask = (task: ScheduledTask, contactId: string, admin: boolean) =>
  admin || (!!task.data.requesterId && task.data.requesterId === contactId)

/** Guard check (src/auth/guard.ts): the task's requester or an admin. A missing task passes (the handler answers 404). */
export async function ownSchedule({ principal, params, s }: GuardContext): Promise<void> {
  if (principal.access === 'admin') return
  const task = await s.scheduledTasks.get(params.id ?? '')
  if (!task) return
  if (!canManageTask(task, principal.contactId, false)) throw new DeniedError(MANAGE_DENIED)
}

const clip = (t: string | undefined, max = OUTPUT_CHARS) => (t && t.length > max ? `${t.slice(0, max - 1)}…` : t)

/**
 * Follows the runs of scheduled tasks: when a firing is routed, the task's last run gets the run it
 * started (or the run whose inbox it went to); every state change of that run updates it, with the
 * start of the final answer or error once it ends. Returns a function that stops it.
 */
export function trackScheduledRuns(s: Services): () => void {
  const log = s.logger.child({ component: 'schedules' })
  const record = async (taskId: string, run: TaskRun) => {
    try {
      await s.scheduledTasks.recordRun(taskId, run)
    } catch (err) {
      log.warn('could not record a scheduled run', { taskId, err: errorMessage(err) })
    }
  }
  const runFacts = async (runId: string): Promise<Pick<TaskRun, 'runId' | 'sessionId' | 'state' | 'output'> | null> => {
    const run = await s.sessions.getRun(runId)
    if (!run) return null
    const out = run.data.result?.output ?? run.data.result?.error
    return {
      runId,
      sessionId: run.data.sessionId,
      state: run.data.state as TaskRunState,
      ...(TERMINAL_RUN_STATES.includes(run.data.state) && out ? { output: clip(out) } : {}),
    }
  }
  const offRouted = s.bus.subscribe<{ eventId: string; deliveries?: { runId?: string }[] }>('event.routed', async (m) => {
    const event = await s.rawEvents.get(m.payload.eventId)
    if (!event) return
    const taskId = scheduledTaskId(event.data)
    if (!taskId) return
    const at = String((event.data.payload as { at?: unknown } | undefined)?.at ?? event.data.receivedAt)
    const runId = m.payload.deliveries?.find((d) => d.runId)?.runId
    const facts = runId ? await runFacts(runId) : null
    // A fresh fork per firing is titled after the task and the day, not the start of the firing's text.
    const task = await s.scheduledTasks.get(taskId)
    if (task && facts?.sessionId && facts.sessionId !== task.data.sessionId) {
      const title = `${line(task.data.instruction, 50)} · ${formatLocal(Date.parse(at), task.data.timezone).slice(0, 14)}`
      await s.sessions
        .update(facts.sessionId, { title }, SYSTEM)
        .catch((err) => log.warn('could not title a scheduled fork', { taskId, err: errorMessage(err) }))
    }
    await record(taskId, {
      at,
      eventId: event.id,
      ...(facts ?? { state: 'cancelled', output: 'nobody took it: its session is gone' }),
    })
  })
  const offState = s.bus.subscribe<RunStateChanged>(SessionTopics.runState, async (m) => {
    const tasks = await s.records.query<ScheduledTask['data']>('scheduled_task', {
      where: [{ field: 'lastRun.runId', op: 'eq', value: m.payload.runId }],
      limit: 20,
    })
    if (!tasks.items.length) return
    const facts = await runFacts(m.payload.runId)
    if (!facts) return
    for (const t of tasks.items) {
      const last = t.data.lastRun
      if (!last) continue
      await record(t.id, { ...last, ...facts })
      // A task's run that started an environment stops it when it ends: nothing uses it until the next firing
      // (live, a daily status task left a container running). Not follow-ups: they wake ordinary work sessions.
      if (t.data.kind === 'task' && TERMINAL_RUN_STATES.includes(facts.state as never)) {
        if (facts.sessionId) await stopEnvOf(facts.sessionId)
      }
    }
  })
  const stopEnvOf = async (sessionId: string) => {
    try {
      const session = await s.sessions.get(sessionId)
      const env = session?.data.meta?.env as { id?: unknown } | undefined
      if (!session || typeof env?.id !== 'string' || !s.containers) return
      await s.containers.destroyEnv(env.id)
      const { env: _gone, ...meta } = (session.data.meta ?? {}) as Record<string, unknown>
      await s.sessions.update(session.id, { meta: meta as never })
      log.info('stopped the environment of a finished scheduled run', { sessionId, envId: env.id })
    } catch (err) {
      log.warn('could not stop the environment of a finished scheduled run', { sessionId, err: errorMessage(err) })
    }
  }
  return () => {
    offRouted()
    offState()
  }
}

/** The API view of a task. */
export async function taskView(
  s: Services,
  t: ScheduledTask,
  viewer: { contactId: string; admin?: boolean; readOnly?: boolean },
): Promise<Api.ScheduledTask> {
  const d = t.data
  const [employee, requester, session] = await Promise.all([
    s.directory.employees.get(d.employeeId),
    d.requesterId ? s.directory.contacts.get(d.requesterId) : null,
    d.sessionId ? s.sessions.get(d.sessionId) : null,
  ])
  const r = d.report
  return {
    id: t.id,
    kind: d.kind,
    instruction: d.instruction,
    when: d.when,
    timezone: d.timezone,
    description: describeWhen(d.when, d.timezone),
    enabled: d.enabled,
    done: !!d.done,
    nextRunAt: s.scheduledTasks.nextRun(t),
    employee: { id: d.employeeId, name: employee?.data.name ?? d.employeeId },
    requester: requester ? { id: requester.id, name: requester.data.name } : null,
    session: session ? { id: session.id, title: session.data.title, slug: session.data.slug } : null,
    sessionMode: d.sessionMode,
    report: r
      ? r.type === 'chat'
        ? {
            label: r.label ?? (r.threadId ? 'a chat thread' : 'a chat channel'),
            channelId: r.channelId,
            ...(r.threadId ? { threadId: r.threadId } : {}),
          }
        : { label: r.label ?? `${r.subject.system}:${r.subject.id}`, subject: { system: r.subject.system, ref: r.subject.id } }
      : null,
    lastRun: d.lastRun
      ? {
          at: d.lastRun.at,
          state: d.lastRun.state,
          ...(d.lastRun.runId ? { runId: d.lastRun.runId } : {}),
          ...(d.lastRun.sessionId ? { sessionId: d.lastRun.sessionId } : {}),
          ...(d.lastRun.output ? { output: d.lastRun.output } : {}),
          ...(d.lastRun.manual ? { manual: true } : {}),
        }
      : null,
    fired: d.fired ?? 0,
    createdAt: t.createdAt,
    canManage: !viewer.readOnly && canManageTask(t, viewer.contactId, !!viewer.admin),
  }
}

/** Upcoming first (soonest next run), then paused, then finished (newest first). */
function order(a: Api.ScheduledTask, b: Api.ScheduledTask): number {
  const rank = (x: Api.ScheduledTask) => (x.nextRunAt ? 0 : x.enabled && !x.done ? 1 : x.done ? 3 : 2)
  return (
    rank(a) - rank(b) ||
    (a.nextRunAt && b.nextRunAt ? a.nextRunAt.localeCompare(b.nextRunAt) : 0) ||
    b.createdAt.localeCompare(a.createdAt)
  )
}

const optString = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new BadRequestError(`${name} must be a string`)
  return v.trim() || undefined
}

function whenInput(raw: unknown): WhenInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BadRequestError('when must be { at } | { in } | { every } | { cron }')
  const w = raw as Record<string, unknown>
  const out: WhenInput = {}
  for (const k of ['at', 'in', 'every', 'cron'] as const) {
    const v = optString(w[k], `when.${k}`)
    if (v) out[k] = v
  }
  return out
}

export function scheduleRoutes(s: Services, vis: ChatVisibility): Hono {
  const app = new Hono()
  const svc = (): ScheduleService => {
    if (!s.schedules) throw new UnavailableError('scheduled tasks need the standard library, which is turned off')
    return s.schedules
  }
  const viewer = (c: Context) => viewerOf(principalOf(c))
  const actor = (c: Context) => actorOf(principalOf(c).contactId)

  /** Whether the viewer may see a task: a task of a private (DM) session only its members. */
  const visible = async (c: Context, t: ScheduledTask) => {
    if (!t.data.sessionId) return true
    const session = await s.sessions.get(t.data.sessionId)
    return !session || (await vis.canReadSession(viewer(c), session))
  }
  const requireTask = async (c: Context, id: string) => {
    const t = await s.scheduledTasks.get(id)
    if (!t || !(await visible(c, t))) throw new NotFoundError('scheduled task', id)
    return t
  }
  const view = (c: Context, t: ScheduledTask) => taskView(s, t, { ...viewer(c), readOnly: principalOf(c).access === 'viewer' })

  const timezoneOf = async (raw: unknown) => {
    const tz = optString(raw, 'timezone')
    return tz ? checkTimeZone(tz) : svc().defaultTimezone()
  }
  const reportOf = async (c: Context, raw: unknown) => {
    if (raw === undefined) return undefined
    if (raw === null) return null
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestError('report must be { threadId } or { channelId }')
    const r = raw as { threadId?: unknown; channelId?: unknown }
    const threadId = optString(r.threadId, 'report.threadId')
    const channelId = optString(r.channelId, 'report.channelId')
    if (!threadId && !channelId) return null
    if (threadId) await vis.requireMessage(principalOf(c).contactId, threadId)
    return (await svc().parseReport(threadId ? { threadId } : { channel: channelId }, undefined, '')) ?? null
  }
  app.get('/api/schedules/preview', async (c) => {
    const q = c.req.query()
    const timezone = await timezoneOf(q.timezone)
    const when = checkWhen(svc().resolveWhen(whenInput(q), timezone))
    const now = s.clock.now()
    const next =
      when.type === 'once'
        ? [when.at]
        : nextFirings({ cron: when.cron, timezone }, now, now + 400 * 86_400_000, 5).map((d) => d.toISOString())
    return c.json({ when, timezone, description: describeWhen(when, timezone), next } satisfies Api.SchedulePreview)
  })

  app.get('/api/schedules', async (c) => {
    const q = c.req.query()
    if (q.kind !== undefined && q.kind !== 'task' && q.kind !== 'follow_up')
      throw new BadRequestError('kind must be task or follow_up')
    const list = await s.scheduledTasks.list({
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(q.kind ? { kind: q.kind as 'task' | 'follow_up' } : {}),
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
    })
    const items: Api.ScheduledTask[] = []
    for (const t of list) if (await visible(c, t)) items.push(await view(c, t))
    return c.json({ items: items.sort(order) })
  })

  app.post('/api/schedules', async (c) => {
    const body = await jsonBody<Partial<Api.ScheduleCreateBody>>(c)
    const employeeId = requireString(body.employeeId, 'employeeId')
    const instruction = requireString(body.instruction, 'instruction')
    if (!(await s.directory.employees.get(employeeId))) throw new NotFoundError('employee', employeeId)
    const timezone = await timezoneOf(body.timezone)
    const when = svc().resolveWhen(whenInput(body.when), timezone)
    const report = await reportOf(c, body.report)
    if (body.sessionMode !== undefined && body.sessionMode !== 'continue' && body.sessionMode !== 'fresh')
      throw new BadRequestError('sessionMode must be continue or fresh')
    const t = await svc().create(
      {
        employeeId,
        instruction,
        when,
        timezone,
        requesterId: principalOf(c).contactId,
        ...(report ? { report } : {}),
        ...(body.sessionMode ? { sessionMode: body.sessionMode } : {}),
      },
      actor(c),
    )
    return c.json(await view(c, t), 201)
  })

  app.patch('/api/schedules/:id', async (c) => {
    const t = await requireTask(c, c.req.param('id'))
    const body = await jsonBody<Api.SchedulePatchBody>(c)
    const patch: ScheduledTaskPatch = {}
    if (body.instruction !== undefined) patch.instruction = requireString(body.instruction, 'instruction')
    const timezone = body.timezone !== undefined ? await timezoneOf(body.timezone) : t.data.timezone
    if (body.timezone !== undefined) patch.timezone = timezone
    if (body.when !== undefined) patch.when = svc().resolveWhen(whenInput(body.when), timezone)
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean')
      patch.enabled = body.enabled
    }
    if (body.sessionMode !== undefined) {
      if (body.sessionMode !== 'continue' && body.sessionMode !== 'fresh')
        throw new BadRequestError('sessionMode must be continue or fresh')
      patch.sessionMode = body.sessionMode
    }
    const report = await reportOf(c, body.report)
    if (report !== undefined) patch.report = report
    if (!Object.keys(patch).length) throw new ValidationError('nothing to change')
    return c.json(await view(c, await svc().update(t.id, patch, actor(c))))
  })

  app.delete('/api/schedules/:id', async (c) => {
    const t = await requireTask(c, c.req.param('id'))
    await svc().cancel(t.id, actor(c))
    return c.body(null, 204)
  })

  app.post('/api/schedules/:id/run', async (c) => {
    const t = await requireTask(c, c.req.param('id'))
    if (t.data.kind !== 'task')
      throw new ValidationError('a follow-up comes back to its session on its own: change its time instead')
    const p = principalOf(c)
    const key = c.req.header('idempotency-key') ?? `${p.contactId}:${s.clock.now()}`
    const r = await svc().runNow(t.id, { key, byName: p.name })
    const out: { task: Api.ScheduledTask; eventId: string } = { task: await view(c, r.task), eventId: r.eventId }
    return c.json(out)
  })

  return app
}
