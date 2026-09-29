import { errorMessage, type Logger } from '@mp/core'
import type { Events } from '@mp/events'
import type { JobOptions, Queue } from '@mp/queue'
import { QUEUES as ROUTER_QUEUES } from '@mp/router'

export const QUEUES = ROUTER_QUEUES

/**
 * Job ids of jobs this process is executing right now, as `<queue>:<jobId>`.
 * A job added with the id of an active job would be dropped as a duplicate,
 * which loses a wake-up the run gives itself while its own job is still
 * finishing (e.g. a wait already satisfied). Such adds get a fresh id.
 */
export const activeJobs = new Set<string>()
let resubmits = 0

/** A queue that fills in default job options per queue name (e.g. retries for runs). */
export function withJobDefaults(queue: Queue, defaults: Record<string, JobOptions>): Queue {
  return {
    add: (name, data, opts) => {
      const o = { ...defaults[name], ...opts }
      if (o.jobId && !o.repeatEveryMs && activeJobs.has(`${name}:${o.jobId}`)) o.jobId = `${o.jobId}~${++resubmits}`
      return queue.add(name, data, o)
    },
    process: (name, handler, opts) => queue.process(name, handler, opts),
    removeRepeatable: (name, jobId) => queue.removeRepeatable(name, jobId),
    counts: (name) => queue.counts(name),
    idle: () => queue.idle(),
    close: () => queue.close(),
  }
}

/** Enqueues an event for routing. The job id is the event id, so enqueueing twice is harmless. */
export function enqueueEvent(queue: Queue, eventId: string): Promise<string> {
  return queue.add(QUEUES.events, { eventId }, { jobId: eventId })
}

/**
 * The `Events` service, but every newly stored event is also put on the
 * `events` queue. The row is written first, then the job, so a job never
 * refers to a missing event; an event whose job was lost is re-enqueued at
 * startup (see `recoverQueues`).
 */
export function enqueueOnIngest(events: Events, queue: Queue, logger: Logger): Events {
  return {
    async ingest(input) {
      const res = await events.ingest(input)
      if (res.created) {
        try {
          await enqueueEvent(queue, res.event.id)
        } catch (err) {
          logger.error('could not enqueue event; it is routed at the next startup', {
            eventId: res.event.id,
            err: errorMessage(err),
          })
        }
      }
      return res
    },
    get: (id) => events.get(id),
    require: (id) => events.require(id),
    markRouted: (id) => events.markRouted(id),
    query: (q) => events.query(q),
    triggers: events.triggers,
    subscriptions: events.subscriptions,
  }
}
