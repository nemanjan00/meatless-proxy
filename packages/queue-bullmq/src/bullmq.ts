import { newId, silentLogger, sleep, UnavailableError, ValidationError, type EventBus, type Logger } from '@mp/core'
import {
  QueueTopics,
  type Job,
  type JobHandler,
  type JobOptions,
  type ProcessOptions,
  type Queue,
  type QueueCounts,
  type QueueJobEvent,
  type WorkerHandle,
} from '@mp/queue'
import { Queue as BullQueue, Worker as BullWorker, type Job as BullJob, type JobsOptions } from 'bullmq'
import { Redis, type RedisOptions } from 'ioredis'

export interface BullmqWorkerOptions {
  /** How long a worker's lock on a job lasts before it counts as stalled. BullMQ default 30000. */
  lockDurationMs?: number
  /** How often workers look for stalled jobs. BullMQ default 30000. */
  stalledIntervalMs?: number
  /** How many times a job may stall before it fails. BullMQ default 1. */
  maxStalledCount?: number
}

export interface BullmqQueueOptions {
  /** A Redis URL, or ioredis options. The adapter opens (and closes) its own connections. */
  connection: string | RedisOptions
  /** Prefix of every Redis key. Default `mp`. */
  prefix?: string
  /** Receives `QueueTopics.completed` and `QueueTopics.failed`. */
  bus?: EventBus
  logger?: Logger
  /** Attempts for jobs that don't say. Default 1. */
  defaultAttempts?: number
  /** Lock and stalled-job settings for workers started by `process()`. */
  worker?: BullmqWorkerOptions
  /** How often `idle()` polls the counts. Default 20 ms. */
  idlePollMs?: number
}

/** Our priority 0 maps to this; BullMQ priorities run from 1 (highest) to 2^21. */
const PRIORITY_BASE = 2 ** 20
const PRIORITY_MAX = 2 ** 21

/**
 * Maps "higher runs first, default 0" onto BullMQ's "1 runs first". Every job gets a
 * BullMQ priority, also the default ones: BullMQ serves its plain wait list before
 * its prioritized set, so an unprioritized default job would jump ahead of jobs
 * with a positive priority.
 */
export function toBullPriority(priority = 0): number {
  return Math.min(PRIORITY_MAX, Math.max(1, PRIORITY_BASE - Math.round(priority)))
}

/**
 * BullMQ refuses ids and queue names containing `:` and custom ids that are
 * integers, so we escape them reversibly.
 */
export function encodeName(id: string): string {
  if (/^\d+$/.test(id)) return '%N' + id
  return id.replaceAll('%', '%25').replaceAll(':', '%3A')
}

export function decodeName(id: string): string {
  if (id.startsWith('%N')) return id.slice(2)
  return id.replaceAll('%3A', ':').replaceAll('%25', '%')
}

/** A `Queue` on BullMQ (Redis). Job data must be JSON-serialisable. */
export function bullmqQueue(opts: BullmqQueueOptions): Queue {
  const logger = opts.logger ?? silentLogger
  const bus = opts.bus
  const prefix = opts.prefix ?? 'mp'
  const defaultAttempts = opts.defaultAttempts ?? 1
  const idlePollMs = opts.idlePollMs ?? 20
  const redisOptions: RedisOptions = { maxRetriesPerRequest: null }
  // One connection for queues and counters; each worker duplicates it for its blocking calls.
  const redis =
    typeof opts.connection === 'string'
      ? new Redis(opts.connection, redisOptions)
      : new Redis({ ...opts.connection, ...redisOptions })
  redis.on('error', (err) => logger.error('redis connection error', { err }))

  const queues = new Map<string, BullQueue>()
  const workers = new Set<BullWorker>()
  const known = new Set<string>()
  let closed = false
  let closing: Promise<void> | undefined

  const bullQueue = (name: string): BullQueue => {
    known.add(name)
    let q = queues.get(name)
    if (!q) {
      q = new BullQueue(encodeName(name), { connection: redis, prefix })
      q.on('error', (err) => logger.error('queue error', { queue: name, err }))
      queues.set(name, q)
    }
    return q
  }

  const countsKey = (name: string) => `${prefix}:mp-counts:${encodeName(name)}`

  const publish = (topic: string, payload: QueueJobEvent) => {
    bus?.publish(topic, payload)
  }

  const assertOpen = () => {
    if (closed) throw new UnavailableError('queue is closed')
  }

  const jobOptions = (o: JobOptions): JobsOptions => ({
    priority: toBullPriority(o.priority),
    attempts: Math.max(1, o.attempts ?? defaultAttempts),
    backoff: { type: 'exponential', delay: o.backoffMs ?? 1000 },
    // Finished jobs are removed so their id can be added again; we count them ourselves.
    removeOnComplete: true,
    removeOnFail: true,
  })

  return {
    async add(queue, data, o = {}) {
      assertOpen()
      const q = bullQueue(queue)
      const delay = Math.max(0, o.delayMs ?? 0)
      if (o.repeatEveryMs !== undefined) {
        if (!o.jobId) throw new ValidationError('repeatable jobs need a jobId')
        if (!(o.repeatEveryMs > 0)) throw new ValidationError('repeatEveryMs must be positive')
        const schedulerId = encodeName(o.jobId)
        if (await q.getJobScheduler(schedulerId)) return o.jobId
        const { removeOnComplete, removeOnFail, priority, attempts, backoff } = jobOptions(o)
        await q.upsertJobScheduler(
          schedulerId,
          { every: o.repeatEveryMs, ...(delay ? { startDate: Date.now() + delay } : {}) },
          { name: 'job', data, opts: { removeOnComplete, removeOnFail, priority, attempts, backoff } },
        )
        return o.jobId
      }
      const id = o.jobId ?? newId('job')
      // BullMQ returns the existing job when one with this id is still around.
      await q.add('job', data, { ...jobOptions(o), jobId: encodeName(id), ...(delay ? { delay } : {}) })
      return id
    },

    process<T>(queue: string, handler: JobHandler<T>, o: ProcessOptions = {}): WorkerHandle {
      assertOpen()
      known.add(queue)
      const w = opts.worker ?? {}
      const jobs = new WeakMap<BullJob, Job<T>>()
      const toJob = (bj: BullJob): Job<T> => ({
        id: decodeName(bj.repeatJobKey ?? bj.id ?? ''),
        queue,
        data: bj.data as T,
        attempt: bj.attemptsMade + 1,
      })
      const worker = new BullWorker(
        encodeName(queue),
        async (bj: BullJob) => {
          const job = toJob(bj)
          jobs.set(bj, job)
          try {
            await handler(job)
          } catch (err) {
            throw err instanceof Error ? err : new Error(String(err))
          }
        },
        {
          connection: redis,
          prefix,
          concurrency: Math.max(1, o.concurrency ?? 1),
          ...(w.lockDurationMs !== undefined ? { lockDuration: w.lockDurationMs } : {}),
          ...(w.stalledIntervalMs !== undefined ? { stalledInterval: w.stalledIntervalMs } : {}),
          ...(w.maxStalledCount !== undefined ? { maxStalledCount: w.maxStalledCount } : {}),
        },
      )
      workers.add(worker)
      worker.on('error', (err) => logger.error('worker error', { queue, err }))
      worker.on('completed', (bj) => {
        const job = jobs.get(bj) ?? toJob(bj)
        void redis.hincrby(countsKey(queue), 'completed', 1).catch((err) => logger.error('queue count failed', { queue, err }))
        publish(QueueTopics.completed, { queue, id: job.id, attempt: job.attempt, data: job.data })
      })
      worker.on('failed', (bj, err) => {
        if (!bj) return
        const job = jobs.get(bj) ?? toJob(bj)
        // `finishedOn` is only set when BullMQ gave up on the job, not when it scheduled a retry.
        if (!bj.finishedOn) {
          logger.warn('queue job failed, retrying', { queue, id: job.id, attempt: job.attempt, err })
          return
        }
        logger.error('queue job failed', { queue, id: job.id, attempt: job.attempt, err })
        void redis.hincrby(countsKey(queue), 'failed', 1).catch((e) => logger.error('queue count failed', { queue, err: e }))
        publish(QueueTopics.failed, { queue, id: job.id, attempt: job.attempt, data: job.data, error: err.message })
      })
      return {
        async close() {
          await worker.close()
          workers.delete(worker)
        },
      }
    },

    async removeRepeatable(queue, jobId) {
      await bullQueue(queue).removeJobScheduler(encodeName(jobId))
    },

    async counts(queue): Promise<QueueCounts> {
      const c = await bullQueue(queue).getJobCounts('waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed')
      const own = await redis.hgetall(countsKey(queue))
      return {
        waiting: (c.waiting ?? 0) + (c.prioritized ?? 0),
        delayed: c.delayed ?? 0,
        active: c.active ?? 0,
        completed: (c.completed ?? 0) + Number(own.completed ?? 0),
        failed: (c.failed ?? 0) + Number(own.failed ?? 0),
      }
    },

    async idle() {
      // Two quiet polls in a row, so a job moving between states isn't missed.
      let quiet = 0
      while (quiet < 2 && !closed) {
        let busy = false
        for (const name of known) {
          const c = await this.counts(name)
          if (c.waiting || c.active) {
            busy = true
            break
          }
        }
        quiet = busy ? 0 : quiet + 1
        if (quiet < 2) await sleep(idlePollMs)
      }
    },

    close() {
      closed = true
      closing ??= (async () => {
        const results = await Promise.allSettled([...workers].map((w) => w.close()))
        results.push(...(await Promise.allSettled([...queues.values()].map((q) => q.close()))))
        for (const r of results) if (r.status === 'rejected') logger.error('queue close failed', { err: r.reason })
        await redis.quit().catch(() => redis.disconnect())
      })()
      return closing
    },
  }
}
