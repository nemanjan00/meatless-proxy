import { ConflictError, errorMessage, isMpError, type Json, type KindSchema } from '@mp/core'
import type { Channel } from '@mp/chat'
import type { Employee } from '@mp/directory'
import type { WorkerHandle } from '@mp/queue'
import { beforeDeliver } from '@mp/router'
import { SessionTopics, type Run, type RunStateChanged } from '@mp/sessions'
import type { Services } from './services.ts'
import { SettingNames } from './settings.ts'

/**
 * Alerts through chat (docs/spec.md#observability). They are posted in
 * `#alerts` (created on demand by the bootstrap employee) and tag the run's
 * requester and the session's employee:
 *
 * - a run failed (bus topic `run.state`, `to: 'failed'`);
 * - a run has been paused longer than `ALERT_PAUSED_MINUTES` (checked by a
 *   repeatable queue job);
 * - the model provider or an MCP server keeps failing: `ALERT_UNAVAILABLE_COUNT`
 *   `unavailable` errors within `ALERT_UNAVAILABLE_MINUTES`. The source is the
 *   run worker: an `unavailable` error that ends a run job attempt (the job is
 *   retried) is reported with `reportUnavailable`. The count is per process.
 *
 * Each alert is claimed with an `alert` record whose key is the condition and
 * the run (or the dependency and time window), so there is one alert per run
 * per condition, across restarts and instances. Alert messages themselves are
 * never routed: tagging the employee must not start a run, or a failing
 * provider would alert about its own alerts. Replies in an alert's thread are
 * routed as usual.
 */

export const ALERTS_CHANNEL = 'alerts'
export const ALERTS_QUEUE = 'alerts'
export const ALERTS_JOB_ID = 'alerts-paused-check'
/** How often paused runs are checked. */
export const ALERTS_CHECK_EVERY_MS = 60_000

export type AlertCondition = 'run.failed' | 'run.paused' | 'dependency.unavailable'

export interface AlertData extends Record<string, unknown> {
  condition: AlertCondition
  runId?: string
  sessionId?: string
  /** `model provider` or `MCP server <name>`, for `dependency.unavailable`. */
  dependency?: string
  channelId?: string
  messageId?: string
  text: string
  at: string
}

/** What an alert says and is about. */
export interface AlertInput {
  condition: AlertCondition
  runId?: string
  sessionId?: string
  dependency?: string
  text: string
}

export const alertSchema: KindSchema = {
  kind: 'alert',
  prefix: 'alr',
  description: 'An alert posted in #alerts. The record key (condition and run, or dependency and window) makes it once only.',
  titleField: 'text',
  core: [
    { name: 'condition', type: 'enum', values: ['run.failed', 'run.paused', 'dependency.unavailable'], required: true },
    { name: 'runId', type: 'ref', ref: 'run' },
    { name: 'sessionId', type: 'ref', ref: 'session' },
    { name: 'dependency', type: 'string' },
    { name: 'channelId', type: 'ref', ref: 'channel' },
    { name: 'messageId', type: 'ref', ref: 'message' },
    { name: 'text', type: 'string', required: true },
    { name: 'at', type: 'timestamp', required: true },
  ],
}

const MAX_ERROR_CHARS = 300

const clip = (text: string, max = MAX_ERROR_CHARS) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** The employee that owns `#alerts`: the bootstrap employee, else `@meatless`, else the first one. */
async function alertsEmployee(s: Services): Promise<Employee | null> {
  const boot = await s.settings.get<{ employeeId?: string }>(SettingNames.bootstrap)
  const id = boot && typeof boot === 'object' && !Array.isArray(boot) ? boot.employeeId : undefined
  if (typeof id === 'string') {
    const e = await s.directory.employees.get(id)
    if (e) return e
  }
  return (await s.directory.employees.byHandle('meatless')) ?? (await s.directory.employees.list()).items[0] ?? null
}

/** `#alerts`, created by the alerts employee when it doesn't exist yet. */
async function alertsChannel(s: Services, employee: Employee): Promise<Channel> {
  const existing = await s.chat.channelByName(ALERTS_CHANNEL)
  if (existing) return existing
  try {
    return await s.chat.createChannel({
      name: ALERTS_CHANNEL,
      topic: 'Failed runs, runs paused for a long time, and providers or MCP servers that keep failing.',
      createdBy: { kind: 'contact', id: employee.data.contactId },
      members: [{ kind: 'employee', id: employee.id }],
    })
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err
    const ch = await s.chat.channelByName(ALERTS_CHANNEL)
    if (!ch) throw err
    return ch
  }
}

/** `@handle` of a contact's `mp` handle, or its name, or null. */
async function contactTag(s: Services, contactId: string | undefined): Promise<string | null> {
  if (!contactId) return null
  const c = await s.directory.contacts.get(contactId)
  if (!c) return null
  const handle = c.data.handles?.find((h) => h.system === 'mp')?.id
  return handle ? `@${handle}` : c.data.name
}

/** Who to tag for a run: its requester and its session's employee. */
async function tagsFor(s: Services, run: Run | null): Promise<string[]> {
  if (!run) return []
  const tags: string[] = []
  const requester = await contactTag(s, run.data.requesterId)
  if (requester) tags.push(requester)
  const employee = await s.directory.employees.get(run.data.employeeId)
  const employeeTag = employee ? await contactTag(s, employee.data.contactId) : null
  if (employeeTag && !tags.includes(employeeTag)) tags.push(employeeTag)
  return tags
}

export interface Alerts extends WorkerHandle {
  /** Posts an alert unless one with the same key was posted before. Returns the message id, or null. */
  post(key: string, data: AlertInput, run: Run | null): Promise<string | null>
  /** Checks for runs paused longer than the threshold. */
  checkPaused(now?: number): Promise<number>
  /**
   * Reports an error that ended a run job attempt. Only `unavailable` errors
   * count; when a dependency keeps failing, an alert is posted.
   */
  reportUnavailable(runId: string | undefined, err: unknown): Promise<void>
}

/** The dependency an `unavailable` error is about: `MCP server <name>` or `model provider`. */
export function dependencyOf(err: unknown): string {
  const server = isMpError(err) ? (err.details as { server?: unknown } | undefined)?.server : undefined
  if (typeof server === 'string' && server) return `MCP server ${server}`
  const m = /MCP server (\S+)/.exec(errorMessage(err))
  if (m) return `MCP server ${m[1]!.replace(/[:.,]$/, '')}`
  return 'model provider'
}

/** Starts alerts: the `run.state` listener, the paused-run check job, the unavailable counter. */
export function startAlerts(s: Services, opts: { checkEveryMs?: number } = {}): Alerts {
  const log = s.logger.child({ component: 'alerts' })
  const cfg = s.config
  const pausedMs = cfg.ALERT_PAUSED_MINUTES * 60_000
  const windowMs = cfg.ALERT_UNAVAILABLE_MINUTES * 60_000
  if (!s.records.kinds.has(alertSchema.kind)) s.records.kinds.define(alertSchema)
  let channelId: string | null = null
  const failures = new Map<string, number[]>()

  const alerts: Alerts = {
    async post(key, data, run) {
      const employee = await alertsEmployee(s)
      if (!employee) {
        log.warn('no employee to post alerts', { key })
        return null
      }
      const at = s.clock.iso()
      const { record, created } = await s.records.store.records.createOrGet<AlertData>(
        alertSchema.kind,
        key,
        { ...data, at } as AlertData,
        { prefix: alertSchema.prefix },
      )
      if (!created) return null
      const channel = await alertsChannel(s, employee)
      channelId = channel.id
      const tags = await tagsFor(s, run)
      const text = tags.length ? `${data.text}\n\n${tags.join(' ')}` : data.text
      const msg = await s.chat.post({ channelId: channel.id, author: { kind: 'contact', id: employee.data.contactId }, text })
      await s.records.update<AlertData>(alertSchema.kind, record.id, { channelId: channel.id, messageId: msg.id })
      log.info('alert posted', { key, messageId: msg.id })
      return msg.id
    },

    async checkPaused(now = s.clock.now()) {
      let n = 0
      for (const run of await s.sessions.runs({ state: 'paused' })) {
        // A paused run doesn't change, so its last update is when it was paused.
        const minutes = Math.floor((now - Date.parse(run.updatedAt)) / 60_000)
        if (now - Date.parse(run.updatedAt) < pausedMs) continue
        const session = await s.sessions.get(run.data.sessionId)
        const why = run.data.pauseReason ? `: ${clip(run.data.pauseReason)}` : ''
        const id = await alerts.post(
          `run.paused:${run.id}`,
          {
            condition: 'run.paused',
            runId: run.id,
            sessionId: run.data.sessionId,
            text: `Run paused for ${minutes} minutes in [[session:${run.data.sessionId}]] (${session?.data.title ?? 'unknown session'}, run ${run.id})${why}. It waits for someone to resume or cancel it.`,
          },
          run,
        )
        if (id) n++
      }
      return n
    },

    async reportUnavailable(runId, err) {
      if (!isMpError(err, 'unavailable')) return
      try {
        const dependency = dependencyOf(err)
        const now = s.clock.now()
        const recent = (failures.get(dependency) ?? []).filter((t) => now - t < windowMs)
        recent.push(now)
        failures.set(dependency, recent)
        if (recent.length < cfg.ALERT_UNAVAILABLE_COUNT) return
        const run = runId ? await s.sessions.getRun(runId) : null
        const id = await alerts.post(
          `dependency.unavailable:${dependency}:${Math.floor(now / windowMs)}`,
          {
            condition: 'dependency.unavailable',
            dependency,
            ...(run ? { runId: run.id, sessionId: run.data.sessionId } : {}),
            text: `The ${dependency} keeps failing: ${recent.length} unavailable errors in ${cfg.ALERT_UNAVAILABLE_MINUTES} minutes. Last: ${clip(errorMessage(err))}`,
          },
          run,
        )
        if (id) failures.set(dependency, [])
      } catch (e) {
        log.error('could not post an unavailable alert', { err: errorMessage(e) })
      }
    },

    async close() {
      offBus()
      offHook()
      await handle.close()
    },
  }

  const offBus = s.bus.subscribe<RunStateChanged>(SessionTopics.runState, async (m) => {
    if (m.payload.to !== 'failed') return
    try {
      const run = await s.sessions.getRun(m.payload.runId)
      const session = await s.sessions.get(m.payload.sessionId)
      const error = run?.data.result?.error ? `: ${clip(run.data.result.error)}` : ''
      await alerts.post(
        `run.failed:${m.payload.runId}`,
        {
          condition: 'run.failed',
          runId: m.payload.runId,
          sessionId: m.payload.sessionId,
          text: `Run failed in [[session:${m.payload.sessionId}]] (${session?.data.title ?? 'unknown session'}, run ${m.payload.runId})${error}`,
        },
        run,
      )
    } catch (err) {
      log.error('could not post a failed-run alert', { runId: m.payload.runId, err: errorMessage(err) })
    }
  })

  // Alert messages are notifications: they don't start runs (see above). An alert is a
  // top-level message in #alerts by an AI employee's contact (sessions post as sessions).
  const offHook = s.hooks.on(beforeDeliver, async ({ event }) => {
    if (event.data.source !== 'chat' || event.data.type !== 'message.posted') return undefined
    const p = event.data.payload as { channelId?: unknown; threadId?: unknown; author?: { kind?: unknown; id?: unknown } } | null
    if (!p || p.threadId || p.author?.kind !== 'contact' || typeof p.author.id !== 'string') return undefined
    channelId ??= (await s.chat.channelByName(ALERTS_CHANNEL))?.id ?? null
    if (p.channelId !== channelId) return undefined
    return (await s.directory.contacts.get(p.author.id))?.data.kind === 'ai' ? { skip: 'an alert' } : undefined
  })

  const handle = s.queue.process(
    ALERTS_QUEUE,
    async () => {
      await alerts.checkPaused()
    },
    { concurrency: 1 },
  )
  s.queue
    .add(ALERTS_QUEUE, {} as Json, { jobId: ALERTS_JOB_ID, repeatEveryMs: opts.checkEveryMs ?? ALERTS_CHECK_EVERY_MS })
    .catch((err) => log.error('could not start the paused-run check', { err: errorMessage(err) }))

  return alerts
}
