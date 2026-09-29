import { errorMessage } from '@mp/core'
import { SCHEDULE_FIRED, SCHEDULE_SOURCE, internalSubject, scheduleDedupeKey, scheduledTaskEvent } from '@mp/events'
import type { WorkerHandle } from '@mp/queue'
import { beforeDeliver } from '@mp/router'
import type { Services } from './services.ts'

/**
 * Schedule triggers (docs/spec.md#schedules). A repeatable queue job looks for
 * due firings and ingests one `schedule.fired` event per trigger and slot,
 * which the router then delivers to the trigger's context like any other
 * event. The event's dedupe key is the trigger and the slot, so a restart,
 * racing ticks or a second instance never fire twice.
 *
 * Scheduled tasks and follow-ups (docs/spec.md#scheduled-tasks) fire the same
 * way: one `scheduled_task.fired` event per task and slot, routed to the
 * task's session (src/schedules/recipients.ts). A one-off missed by more than
 * its grace period is marked missed instead of firing late.
 */

/** The queue and repeatable job id of the scheduler tick. */
export const SCHEDULER_QUEUE = 'schedules'
export const SCHEDULER_JOB_ID = 'schedule-tick'
/** How often due schedules are looked for. Firings are at most this late (plus routing). */
export const SCHEDULER_EVERY_MS = 30_000

/** One scheduler pass: ingests every due firing and marks it handled. Returns how many were due and how many fired now. */
export async function scheduleTick(s: Services, now = s.clock.now()): Promise<{ due: number; fired: number }> {
  const log = s.logger.child({ component: 'scheduler' })
  const due = await s.events.triggers.dueSchedules(now)
  let fired = 0
  for (const { trigger, at } of due) {
    const schedule = trigger.data.schedule!
    try {
      const { event, created } = await s.events.ingest({
        source: SCHEDULE_SOURCE,
        type: SCHEDULE_FIRED,
        dedupeKey: scheduleDedupeKey(trigger.id, at),
        employeeId: trigger.data.employeeId,
        subject: internalSubject(trigger.id),
        payload: {
          triggerId: trigger.id,
          name: trigger.data.name,
          at,
          cron: schedule.cron,
          ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
        },
        text: `Scheduled: ${trigger.data.name} (${schedule.cron})`,
      })
      await s.events.triggers.markScheduled(trigger.id, at)
      if (created) {
        fired++
        log.info('schedule fired', { triggerId: trigger.id, at, eventId: event.id })
      }
    } catch (err) {
      log.error('schedule could not fire', { triggerId: trigger.id, at, err: errorMessage(err) })
    }
  }
  const tasks = await fireScheduledTasks(s, now)
  return { due: due.length + tasks.due, fired: fired + tasks.fired }
}

/** Fires the scheduled tasks and follow-ups due at `now`. */
export async function fireScheduledTasks(s: Services, now = s.clock.now()): Promise<{ due: number; fired: number }> {
  const log = s.logger.child({ component: 'scheduler' })
  const due = await s.scheduledTasks.due(now)
  let fired = 0
  for (const { task, at, missed } of due) {
    try {
      if (missed) {
        await s.scheduledTasks.markMissed(task.id, at)
        log.warn('scheduled task missed: its time passed while the harness was down', { taskId: task.id, at })
        continue
      }
      const requester = task.data.requesterId ? await s.directory.contacts.get(task.data.requesterId) : null
      const { event, created } = await s.events.ingest(
        scheduledTaskEvent(task, at, requester ? { requesterName: requester.data.name } : {}),
      )
      await s.scheduledTasks.markFired(task.id, at, event.id)
      if (created) {
        fired++
        log.info('scheduled task fired', { taskId: task.id, kind: task.data.kind, at, eventId: event.id })
      }
    } catch (err) {
      log.error('scheduled task could not fire', { taskId: task.id, at, err: errorMessage(err) })
    }
  }
  return { due: due.length, fired }
}

/**
 * Starts the scheduler: the repeatable tick job and its processor. A firing
 * whose trigger was disabled or removed before routing is dropped instead of
 * going to the fallback router.
 */
export function startScheduler(s: Services, opts: { everyMs?: number } = {}): WorkerHandle {
  const log = s.logger.child({ component: 'scheduler' })
  const off = s.hooks.on(beforeDeliver, ({ event, delivery }) =>
    event.data.source === SCHEDULE_SOURCE && delivery.reason === 'fallback'
      ? { skip: 'the schedule trigger is gone or disabled' }
      : undefined,
  )
  const handle = s.queue.process(
    SCHEDULER_QUEUE,
    async () => {
      await scheduleTick(s)
    },
    { concurrency: 1 },
  )
  s.queue
    .add(SCHEDULER_QUEUE, {}, { jobId: SCHEDULER_JOB_ID, repeatEveryMs: opts.everyMs ?? SCHEDULER_EVERY_MS })
    .catch((err) => log.error('could not start the scheduler', { err: errorMessage(err) }))
  return {
    async close() {
      off()
      await handle.close()
    },
  }
}
