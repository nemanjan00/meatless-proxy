import { errorMessage, isMpError, type Json } from '@mp/core'
import type { WorkerHandle } from '@mp/queue'
import type { RouteResult } from '@mp/router'
import { startAlerts } from './alerts.ts'
import { wireBudgetAlerts } from './budget-alerts.ts'
import { asEmployee } from './git-store.ts'
import { wireMcpAlerts } from './mcp-servers/index.ts'
import { startScheduler } from './scheduler.ts'
import { startAttachmentCleanup } from './attachments.ts'
import { startDescribeWorker } from './image-descriptions.ts'
import { QUEUES, activeJobs, enqueueEvent } from './queues.ts'
import type { Services } from './services.ts'

/** What routing did with an event, stored on the event record (`data.routing`) for lineage and the UI. */
export interface StoredRouting {
  at: string
  deliveries: {
    sessionId: string
    reason: string
    expectedToAct: boolean
    trusted: boolean
    fork: boolean
    triggerId?: string
    subscriptionId?: string
    outcome: { type: string; sessionId: string; runId?: string; inboxId?: string; reason?: string }
  }[]
  triggerIds: string[]
  subscriptionIds: string[]
}

export function toStoredRouting(res: RouteResult, at: string): StoredRouting {
  const deliveries = res.deliveries.map((d) => ({
    sessionId: d.sessionId,
    reason: d.reason,
    expectedToAct: d.expectedToAct,
    trusted: d.trusted,
    fork: d.fork,
    ...(d.triggerId ? { triggerId: d.triggerId } : {}),
    ...(d.subscriptionId ? { subscriptionId: d.subscriptionId } : {}),
    outcome: {
      type: d.outcome.type,
      sessionId: d.outcome.sessionId,
      ...('runId' in d.outcome ? { runId: d.outcome.runId } : {}),
      ...('inboxId' in d.outcome ? { inboxId: d.outcome.inboxId } : {}),
      ...('reason' in d.outcome ? { reason: d.outcome.reason } : {}),
    },
  }))
  return {
    at,
    deliveries,
    triggerIds: [...new Set(deliveries.flatMap((d) => (d.triggerId ? [d.triggerId] : [])))],
    subscriptionIds: [...new Set(deliveries.flatMap((d) => (d.subscriptionId ? [d.subscriptionId] : [])))],
  }
}

/** Routes an event and stores the result on it. */
export async function routeEvent(s: Services, eventId: string): Promise<RouteResult> {
  const res = await s.router.route(eventId)
  const event = await s.rawEvents.get(eventId)
  if (event && !event.data.routing) {
    await s.records.update('event', eventId, { routing: toStoredRouting(res, s.clock.iso()) as unknown as Json })
  }
  return res
}

export interface Workers {
  /** Stops taking jobs and waits (up to `timeoutMs`) for the jobs in progress. */
  stop(timeoutMs?: number): Promise<void>
}

/** Starts the queue consumers: `events` (routing, one at a time, in order) and `runs` (execution). */
export function startWorkers(s: Services): Workers {
  const log = s.logger.child({ component: 'workers' })
  const handles: WorkerHandle[] = []
  const alerts = s.config.ALERTS_ENABLED ? startAlerts(s) : null
  handles.push(startScheduler(s), ...(alerts ? [alerts] : []))
  handles.push(startAttachmentCleanup(s.attachments, log))
  handles.push(startDescribeWorker(s.queue, s.attachments, s.describer, log))
  // A runtime MCP server that needs a new sign-in is an alert too (src/mcp-servers/alerts.ts).
  if (alerts) {
    const off = wireMcpAlerts(s, alerts)
    // Budgets at their warning share, and used up (src/budget-alerts.ts).
    const offBudgets = wireBudgetAlerts(s, alerts)
    handles.push({
      close: async () => {
        off()
        offBudgets()
      },
    })
  }
  handles.push(
    s.queue.process<{ eventId: string }>(
      QUEUES.events,
      async (job) => {
        await routeEvent(s, job.data.eventId)
      },
      { concurrency: 1 },
    ),
  )
  handles.push(
    s.queue.process<{ runId: string }>(
      QUEUES.runs,
      async (job) => {
        const runId = job.data.runId
        const key = `${QUEUES.runs}:${runId}`
        activeJobs.add(key)
        try {
          const run = await s.sessions.getRun(runId)
          const outcome = await asEmployee(run?.data.employeeId, () => s.runner.execute(runId))
          log.debug('run job done', { runId, attempt: job.attempt, outcome: outcome.status })
        } catch (err) {
          await alerts?.reportUnavailable(runId, err)
          throw err
        } finally {
          activeJobs.delete(key)
        }
      },
      { concurrency: s.config.RUN_CONCURRENCY },
    ),
  )
  return {
    async stop(timeoutMs = 30_000) {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), timeoutMs)
      })
      const done = Promise.all(handles.map((h) => h.close())).then(() => 'done' as const)
      const r = await Promise.race([done, timeout])
      clearTimeout(timer)
      if (r === 'timeout') log.warn('jobs still running at shutdown; they resume from their journal on the next start')
    },
  }
}

/**
 * Rebuilds the queues from the database (docs/execution.md#storage-and-processes):
 * every event not routed yet, every queued or running run, and every suspended
 * run whose wait is satisfied or has a timer. Duplicate jobs are harmless.
 */
export async function recoverQueues(s: Services): Promise<{ events: number; runs: number; timers: number }> {
  const out = { events: 0, runs: 0, timers: 0 }
  for (const e of await s.rawEvents.query({ routed: false, limit: 100_000 })) {
    await enqueueEvent(s.queue, e.id)
    out.events++
  }
  for (const r of await s.sessions.runs({ state: ['queued', 'running'] })) {
    await s.runner.enqueue(r.id, { priority: r.data.priority })
    out.runs++
  }
  for (const r of await s.sessions.runs({ state: 'suspended' })) {
    try {
      if (await s.runner.wake(r.id)) {
        out.runs++
        continue
      }
    } catch (err) {
      if (!isMpError(err, 'conflict')) s.logger.warn('could not wake run', { runId: r.id, err: errorMessage(err) })
    }
    const w = r.data.wait
    const at = w?.type === 'timer' ? w.until : w?.timeoutAt
    if (at) {
      await s.runner.enqueue(r.id, { delayMs: Math.max(0, Date.parse(at) - s.clock.now()), priority: r.data.priority })
      out.timers++
    }
  }
  return out
}
