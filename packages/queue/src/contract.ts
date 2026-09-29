/**
 * The queue contract. Every implementation of `Queue` must pass it:
 *
 *   queueContract('bullmq', async ({ bus }) => bullmqQueue({ connection, bus }), { timeScale: 2 })
 *
 * `make` must return a fresh queue each time. Queue names are unique per test,
 * so implementations sharing a backend don't collide. `timeScale` multiplies
 * every delay used here, for implementations with coarser timers.
 */
import { createEventBus, deferred, sleep, type EventBus } from '@mp/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QueueTopics, type Job, type Queue, type QueueJobEvent } from './types.ts'

export interface QueueContractContext {
  bus: EventBus
}

export interface QueueContractOptions {
  /** Multiplies every delay in the suite. Default 1. */
  timeScale?: number
}

let counter = 0

export function queueContract(
  name: string,
  make: (ctx: QueueContractContext) => Promise<Queue>,
  opts: QueueContractOptions = {},
) {
  const scale = opts.timeScale ?? 1
  const ms = (n: number) => Math.round(n * scale)

  /** Polls `cond` until it holds, failing after `timeout` ms. */
  const until = async (cond: () => boolean | Promise<boolean>, timeout = ms(2000)) => {
    const end = Date.now() + timeout
    while (!(await cond())) {
      if (Date.now() > end) throw new Error('condition not met in time')
      await sleep(5)
    }
  }

  describe(`queue contract: ${name}`, () => {
    let queue: Queue
    let bus: EventBus
    let events: { topic: string; payload: QueueJobEvent }[]
    let qn: string

    /** A queue name unique to this test. */
    const fresh = (label = 'q') => `${label}-${process.pid}-${++counter}-${Math.random().toString(36).slice(2, 8)}`

    beforeEach(async () => {
      bus = createEventBus()
      events = []
      bus.subscribe<QueueJobEvent>('queue.*', (m) => void events.push({ topic: m.topic, payload: m.payload }))
      queue = await make({ bus })
      qn = fresh()
    })

    afterEach(async () => {
      await queue.close()
    })

    describe('basics', () => {
      it('runs an added job with its id, queue, data and attempt', async () => {
        const seen: Job[] = []
        queue.process(qn, async (job) => void seen.push(job))
        const id = await queue.add(qn, { run: 'run_1' })
        expect(typeof id).toBe('string')
        await until(() => seen.length === 1)
        expect(seen[0]).toEqual({ id, queue: qn, data: { run: 'run_1' }, attempt: 1 })
        await queue.idle()
        expect(await queue.counts(qn)).toEqual({ waiting: 0, delayed: 0, active: 0, completed: 1, failed: 0 })
      })

      it('uses the given jobId, and generates distinct ids otherwise', async () => {
        expect(await queue.add(qn, 1, { jobId: 'run_given' })).toBe('run_given')
        const a = await queue.add(qn, 2)
        const b = await queue.add(qn, 3)
        expect(a).not.toBe(b)
      })

      it('keeps jobs added before any processor waiting until one exists', async () => {
        await queue.add(qn, 'a')
        await queue.add(qn, 'b')
        await sleep(ms(30))
        expect(await queue.counts(qn)).toMatchObject({ waiting: 2, active: 0, completed: 0 })
        const seen: unknown[] = []
        queue.process(qn, async (job) => void seen.push(job.data))
        await until(() => seen.length === 2)
        expect(seen).toEqual(['a', 'b'])
      })

      it('counts an empty or unknown queue as zeros', async () => {
        expect(await queue.counts(fresh('unknown'))).toEqual({ waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0 })
      })

      it('keeps queues apart', async () => {
        const other = fresh('other')
        const a: unknown[] = []
        const b: unknown[] = []
        queue.process(qn, async (job) => void a.push(job.data))
        queue.process(other, async (job) => void b.push(job.data))
        await queue.add(qn, 'to-a', { jobId: 'same' })
        await queue.add(other, 'to-b', { jobId: 'same' })
        await until(() => a.length === 1 && b.length === 1)
        expect(a).toEqual(['to-a'])
        expect(b).toEqual(['to-b'])
        await queue.idle()
        expect((await queue.counts(qn)).completed).toBe(1)
        expect((await queue.counts(other)).completed).toBe(1)
      })

      it('carries structured data intact', async () => {
        const data = { run: 'run_x', nested: { list: [1, 'two', null, true] }, empty: {} }
        const seen: unknown[] = []
        queue.process(qn, async (job) => void seen.push(job.data))
        await queue.add(qn, data)
        await until(() => seen.length === 1)
        expect(seen[0]).toEqual(data)
      })
    })

    describe('dedupe by jobId', () => {
      it('ignores a duplicate while the first is waiting', async () => {
        expect(await queue.add(qn, 'first', { jobId: 'j1' })).toBe('j1')
        expect(await queue.add(qn, 'second', { jobId: 'j1' })).toBe('j1')
        expect((await queue.counts(qn)).waiting).toBe(1)
        const seen: unknown[] = []
        queue.process(qn, async (job) => void seen.push(job.data))
        await until(() => seen.length === 1)
        await queue.idle()
        await sleep(ms(20))
        expect(seen).toEqual(['first'])
      })

      it('ignores a duplicate while the first is delayed', async () => {
        const seen: unknown[] = []
        queue.process(qn, async (job) => void seen.push(job.data))
        await queue.add(qn, 'first', { jobId: 'j1', delayMs: ms(60) })
        await queue.add(qn, 'second', { jobId: 'j1' })
        expect(await queue.counts(qn)).toMatchObject({ waiting: 0, delayed: 1 })
        await until(() => seen.length === 1)
        await queue.idle()
        await sleep(ms(20))
        expect(seen).toEqual(['first'])
      })

      it('ignores a duplicate while the first is active', async () => {
        const release = deferred<void>()
        const seen: unknown[] = []
        queue.process(qn, async (job) => {
          seen.push(job.data)
          await release.promise
        })
        await queue.add(qn, 'first', { jobId: 'j1' })
        await until(() => seen.length === 1)
        await queue.add(qn, 'second', { jobId: 'j1' })
        release.resolve()
        await queue.idle()
        await sleep(ms(30))
        await queue.idle()
        expect(seen).toEqual(['first'])
      })

      it('accepts the same jobId again after the job completed', async () => {
        const seen: unknown[] = []
        queue.process(qn, async (job) => void seen.push(job.data))
        await queue.add(qn, 'first', { jobId: 'j1' })
        await until(() => seen.length === 1)
        await queue.idle()
        await queue.add(qn, 'second', { jobId: 'j1' })
        await until(() => seen.length === 2)
        expect(seen).toEqual(['first', 'second'])
      })

      it('accepts the same jobId again after the job failed', async () => {
        let calls = 0
        queue.process(qn, async () => {
          calls++
          if (calls === 1) throw new Error('boom')
        })
        await queue.add(qn, 'x', { jobId: 'j1' })
        await until(async () => (await queue.counts(qn)).failed === 1)
        await queue.add(qn, 'x', { jobId: 'j1' })
        await until(async () => (await queue.counts(qn)).completed === 1)
        expect(calls).toBe(2)
      })
    })

    describe('delays', () => {
      it('runs a delayed job no earlier than its delay', async () => {
        const started = Date.now()
        let ranAt = 0
        queue.process(qn, async () => void (ranAt = Date.now()))
        await queue.add(qn, 'later', { delayMs: ms(80) })
        expect(await queue.counts(qn)).toMatchObject({ delayed: 1, waiting: 0 })
        await sleep(ms(30))
        expect(ranAt).toBe(0)
        await until(() => ranAt > 0)
        expect(ranAt - started).toBeGreaterThanOrEqual(ms(80) - 5)
      })

      it('lets undelayed jobs overtake delayed ones', async () => {
        const seen: unknown[] = []
        queue.process(qn, async (job) => void seen.push(job.data))
        await queue.add(qn, 'late', { delayMs: ms(60) })
        await queue.add(qn, 'now')
        await until(() => seen.length === 2)
        expect(seen).toEqual(['now', 'late'])
      })

      it('idle() ignores delayed jobs', async () => {
        queue.process(qn, async () => {})
        await queue.add(qn, 'later', { delayMs: ms(5000) })
        await queue.idle()
        expect((await queue.counts(qn)).delayed).toBe(1)
      })
    })

    describe('priority', () => {
      it('runs higher priority first, FIFO within a priority', async () => {
        await queue.add(qn, 'low', { priority: -1 })
        await queue.add(qn, 'default-1')
        await queue.add(qn, 'high-1', { priority: 10 })
        await queue.add(qn, 'default-2', { priority: 0 })
        await queue.add(qn, 'mid', { priority: 5 })
        await queue.add(qn, 'high-2', { priority: 10 })
        const seen: unknown[] = []
        queue.process(qn, async (job) => void seen.push(job.data))
        await until(() => seen.length === 6)
        expect(seen).toEqual(['high-1', 'high-2', 'mid', 'default-1', 'default-2', 'low'])
      })

      it('lets a later high priority job jump the waiting line', async () => {
        const release = deferred<void>()
        const seen: unknown[] = []
        queue.process(qn, async (job) => {
          seen.push(job.data)
          if (job.data === 'blocker') await release.promise
        })
        await queue.add(qn, 'blocker')
        await until(() => seen.length === 1)
        await queue.add(qn, 'background-1')
        await queue.add(qn, 'background-2')
        await queue.add(qn, 'human', { priority: 10 })
        release.resolve()
        await until(() => seen.length === 4)
        expect(seen).toEqual(['blocker', 'human', 'background-1', 'background-2'])
      })
    })

    describe('concurrency', () => {
      it('runs one job at a time by default', async () => {
        let running = 0
        let max = 0
        queue.process(qn, async () => {
          max = Math.max(max, ++running)
          await sleep(ms(15))
          running--
        })
        for (let i = 0; i < 4; i++) await queue.add(qn, i)
        await until(async () => (await queue.counts(qn)).completed === 4)
        expect(max).toBe(1)
      })

      it('runs up to `concurrency` jobs at once', async () => {
        let running = 0
        let max = 0
        queue.process(
          qn,
          async () => {
            max = Math.max(max, ++running)
            await sleep(ms(40))
            running--
          },
          { concurrency: 3 },
        )
        for (let i = 0; i < 7; i++) await queue.add(qn, i)
        await until(async () => (await queue.counts(qn)).completed === 7)
        expect(max).toBe(3)
      })

      it('shares a queue between several processors', async () => {
        const a: unknown[] = []
        const b: unknown[] = []
        const slow = (list: unknown[]) => async (job: Job) => {
          list.push(job.data)
          await sleep(ms(30))
        }
        queue.process(qn, slow(a))
        queue.process(qn, slow(b))
        for (let i = 0; i < 4; i++) await queue.add(qn, i)
        await until(async () => (await queue.counts(qn)).completed === 4)
        expect(a.length + b.length).toBe(4)
        expect(a.length).toBeGreaterThan(0)
        expect(b.length).toBeGreaterThan(0)
      })

      it('reports active jobs', async () => {
        const release = deferred<void>()
        queue.process(qn, () => release.promise, { concurrency: 2 })
        for (let i = 0; i < 3; i++) await queue.add(qn, i)
        await until(async () => (await queue.counts(qn)).active === 2)
        expect(await queue.counts(qn)).toMatchObject({ active: 2, waiting: 1 })
        release.resolve()
        await until(async () => (await queue.counts(qn)).completed === 3)
      })
    })

    describe('retries', () => {
      it('does not retry by default', async () => {
        let calls = 0
        queue.process(qn, async () => {
          calls++
          throw new Error('nope')
        })
        await queue.add(qn, 'x')
        await until(async () => (await queue.counts(qn)).failed === 1)
        await sleep(ms(50))
        expect(calls).toBe(1)
      })

      it('retries with exponential backoff until an attempt succeeds', async () => {
        const at: { attempt: number; t: number }[] = []
        queue.process(qn, async (job) => {
          at.push({ attempt: job.attempt, t: Date.now() })
          if (job.attempt < 3) throw new Error(`fail ${job.attempt}`)
        })
        await queue.add(qn, 'x', { attempts: 3, backoffMs: ms(30) })
        await until(async () => (await queue.counts(qn)).completed === 1)
        expect(at.map((a) => a.attempt)).toEqual([1, 2, 3])
        expect(at[1]!.t - at[0]!.t).toBeGreaterThanOrEqual(ms(30) - 5)
        expect(at[2]!.t - at[1]!.t).toBeGreaterThanOrEqual(ms(60) - 5)
        expect(await queue.counts(qn)).toMatchObject({ completed: 1, failed: 0 })
      })

      it('fails for good after the last attempt and publishes queue.failed', async () => {
        let calls = 0
        queue.process(qn, async () => {
          calls++
          throw new Error('always')
        })
        const id = await queue.add(qn, { run: 'r1' }, { attempts: 2, backoffMs: ms(20) })
        await until(async () => (await queue.counts(qn)).failed === 1)
        expect(calls).toBe(2)
        await until(() => events.some((e) => e.topic === QueueTopics.failed))
        const failed = events.filter((e) => e.topic === QueueTopics.failed)
        expect(failed).toHaveLength(1)
        expect(failed[0]!.payload).toMatchObject({ queue: qn, id, attempt: 2, data: { run: 'r1' }, error: 'always' })
        expect(events.some((e) => e.topic === QueueTopics.completed)).toBe(false)
      })

      it('counts a job in backoff as delayed', async () => {
        queue.process(qn, async (job) => {
          if (job.attempt === 1) throw new Error('once')
        })
        await queue.add(qn, 'x', { attempts: 2, backoffMs: ms(300) })
        await until(async () => (await queue.counts(qn)).delayed === 1)
        expect(await queue.counts(qn)).toMatchObject({ delayed: 1, failed: 0, completed: 0 })
      })

      it('dedupes while a job waits for its retry', async () => {
        let calls = 0
        queue.process(qn, async () => {
          calls++
          if (calls === 1) throw new Error('once')
        })
        await queue.add(qn, 'x', { jobId: 'j1', attempts: 2, backoffMs: ms(60) })
        await until(async () => (await queue.counts(qn)).delayed === 1)
        await queue.add(qn, 'y', { jobId: 'j1' })
        await until(async () => (await queue.counts(qn)).completed === 1)
        await sleep(ms(30))
        expect(calls).toBe(2)
      })
    })

    describe('bus', () => {
      it('publishes queue.completed for each successful job', async () => {
        queue.process(qn, async () => {})
        const id = await queue.add(qn, { run: 'r2' }, { jobId: 'run_2' })
        await until(() => events.some((e) => e.topic === QueueTopics.completed))
        expect(events).toEqual([{ topic: QueueTopics.completed, payload: { queue: qn, id, attempt: 1, data: { run: 'r2' } } }])
      })
    })

    describe('repeatable jobs', () => {
      it('repeats until removed', async () => {
        const seen: Job[] = []
        queue.process(qn, async (job) => void seen.push(job))
        expect(await queue.add(qn, { poller: 'p1' }, { jobId: 'poll-p1', repeatEveryMs: ms(40) })).toBe('poll-p1')
        await until(() => seen.length >= 3)
        expect(seen[0]).toMatchObject({ id: 'poll-p1', queue: qn, data: { poller: 'p1' }, attempt: 1 })
        await queue.removeRepeatable(qn, 'poll-p1')
        await queue.idle()
        const n = seen.length
        await sleep(ms(120))
        expect(seen.length).toBe(n)
      })

      it('does not register the same repeatable twice', async () => {
        const seen: number[] = []
        queue.process(qn, async () => void seen.push(Date.now()))
        await queue.add(qn, 1, { jobId: 'rep', repeatEveryMs: ms(50) })
        await queue.add(qn, 2, { jobId: 'rep', repeatEveryMs: ms(50) })
        await sleep(ms(230))
        await queue.removeRepeatable(qn, 'rep')
        // About 5 runs for one schedule; two schedules would make about 10.
        expect(seen.length).toBeGreaterThanOrEqual(2)
        expect(seen.length).toBeLessThanOrEqual(6)
      })

      it('needs a jobId', async () => {
        await expect(queue.add(qn, 1, { repeatEveryMs: ms(50) })).rejects.toThrow()
      })

      it('ignores removing an unknown repeatable', async () => {
        await expect(queue.removeRepeatable(qn, 'missing')).resolves.toBeUndefined()
      })
    })

    describe('idle and close', () => {
      it('idle() resolves right away when nothing is queued', async () => {
        await queue.idle()
      })

      it('idle() waits for waiting and active jobs', async () => {
        let done = 0
        queue.process(
          qn,
          async () => {
            await sleep(ms(20))
            done++
          },
          { concurrency: 2 },
        )
        for (let i = 0; i < 5; i++) await queue.add(qn, i)
        await queue.idle()
        expect(done).toBe(5)
      })

      it('closing a worker stops it taking new jobs and waits for its active one', async () => {
        const seen: unknown[] = []
        let finished = false
        const worker = queue.process(qn, async (job) => {
          seen.push(job.data)
          await sleep(ms(60))
          finished = true
        })
        await queue.add(qn, 'a')
        await until(() => seen.length === 1)
        await queue.add(qn, 'b')
        await worker.close()
        expect(finished).toBe(true)
        await sleep(ms(40))
        expect(seen).toEqual(['a'])
        expect((await queue.counts(qn)).waiting).toBe(1)
        const later: unknown[] = []
        queue.process(qn, async (job) => void later.push(job.data))
        await until(() => later.length === 1)
        expect(later).toEqual(['b'])
      })

      it('close() waits for active jobs', async () => {
        let finished = false
        let started = false
        queue.process(qn, async () => {
          started = true
          await sleep(ms(80))
          finished = true
        })
        await queue.add(qn, 'x')
        await until(() => started)
        await queue.close()
        expect(finished).toBe(true)
      })

      it('close() stops timers', async () => {
        const rq = fresh('rep')
        let calls = 0
        let repeats = 0
        queue.process(qn, async () => void calls++)
        queue.process(rq, async () => void repeats++)
        await queue.add(qn, 'later', { delayMs: ms(40) })
        await queue.add(rq, 'r', { jobId: 'rep', repeatEveryMs: ms(40) })
        await until(() => repeats >= 1)
        await queue.close()
        const n = repeats
        await sleep(ms(120))
        expect(calls).toBe(0)
        expect(repeats).toBe(n)
      })

      it('refuses new jobs after close()', async () => {
        await queue.close()
        await expect(queue.add(qn, 'x')).rejects.toThrow()
      })
    })
  })
}
