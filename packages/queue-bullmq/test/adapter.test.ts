import { createEventBus, deferred, memoryLogger, sleep } from '@mp/core'
import type { Queue } from '@mp/queue'
import { Worker as BullWorker } from 'bullmq'
import { Redis } from 'ioredis'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { bullmqQueue, decodeName, encodeName, toBullPriority } from '../src/index.ts'
import { deleteKeys, REDIS_URL, uniquePrefix } from './helpers.ts'

describe('helpers', () => {
  it('maps higher priorities to lower BullMQ numbers, never below 1', () => {
    expect(toBullPriority(10)).toBeLessThan(toBullPriority(0))
    expect(toBullPriority(0)).toBeLessThan(toBullPriority(-5))
    expect(toBullPriority()).toBe(toBullPriority(0))
    expect(toBullPriority(1e12)).toBe(1)
    expect(toBullPriority(-1e12)).toBe(2 ** 21)
  })

  it('escapes ids reversibly', () => {
    for (const id of ['run_01ABC', 'slack:C1:1712', '42', '%N42', '100%', 'a%3Ab', '']) {
      const enc = encodeName(id)
      expect(enc).not.toContain(':')
      expect(/^\d+$/.test(enc)).toBe(false)
      expect(decodeName(enc)).toBe(id)
    }
  })
})

const until = async (cond: () => boolean | Promise<boolean>, timeout = 5000) => {
  const end = Date.now() + timeout
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(10)
  }
}

describe.skipIf(!REDIS_URL)('bullmq adapter (needs REDIS_URL)', () => {
  const url = REDIS_URL!
  const prefix = uniquePrefix('adapter')
  const open: Queue[] = []
  const make = (extra: Partial<Parameters<typeof bullmqQueue>[0]> = {}) => {
    const q = bullmqQueue({ connection: url, prefix, ...extra })
    open.push(q)
    return q
  }
  let n = 0
  const name = () => `aq-${++n}`

  afterEach(async () => {
    await Promise.all(open.splice(0).map((q) => q.close()))
  })
  afterAll(() => deleteKeys(url, prefix))

  it('processes many jobs with concurrency', async () => {
    const queue = make()
    const qn = name()
    const seen = new Set<number>()
    queue.process(qn, async (job) => void seen.add(job.data as number), { concurrency: 10 })
    await Promise.all(Array.from({ length: 500 }, (_, i) => queue.add(qn, i)))
    await until(() => seen.size === 500, 15_000)
    await queue.idle()
    expect(await queue.counts(qn)).toEqual({ waiting: 0, delayed: 0, active: 0, completed: 500, failed: 0 })
  })

  it('shares jobs, dedupe and counts between instances on the same prefix', async () => {
    const producer = make()
    const consumer = make()
    const qn = name()
    const release = deferred<void>()
    const seen: string[] = []
    consumer.process(qn, async (job) => {
      seen.push(job.id)
      await release.promise
    })
    await producer.add(qn, 1, { jobId: 'run_a' })
    await until(() => seen.length === 1)
    await producer.add(qn, 2, { jobId: 'run_a' })
    expect(await producer.counts(qn)).toMatchObject({ active: 1, waiting: 0 })
    release.resolve()
    await until(async () => (await producer.counts(qn)).completed === 1)
    expect(seen).toEqual(['run_a'])
  })

  it('reports ids containing colons and digits unchanged', async () => {
    const queue = make()
    const qn = 'ns:queue'
    const seen: string[] = []
    queue.process(qn, async (job) => void seen.push(`${job.queue}|${job.id}`))
    await queue.add(qn, 1, { jobId: 'slack:C1:99' })
    await queue.add(qn, 2, { jobId: '12345' })
    await until(() => seen.length === 2)
    expect(seen.sort()).toEqual(['ns:queue|12345', 'ns:queue|slack:C1:99'])
  })

  it('uses defaultAttempts for jobs that do not say', async () => {
    const queue = make({ defaultAttempts: 3 })
    const qn = name()
    const attempts: number[] = []
    queue.process(qn, async (job) => {
      attempts.push(job.attempt)
      throw new Error('nope')
    })
    await queue.add(qn, 1, { backoffMs: 10 })
    await until(async () => (await queue.counts(qn)).failed === 1)
    expect(attempts).toEqual([1, 2, 3])
  })

  it('accepts ioredis options and logs handler failures', async () => {
    const u = new URL(url)
    const logger = memoryLogger()
    const queue = make({ connection: { host: u.hostname, port: Number(u.port || 6379) }, logger })
    const qn = name()
    queue.process(qn, async () => {
      throw 'not an Error'
    })
    await queue.add(qn, 1)
    await until(async () => (await queue.counts(qn)).failed === 1)
    await until(() => logger.lines.some((l) => l.msg === 'queue job failed'))
  })

  it('close() waits for active jobs and closes cleanly', async () => {
    const bus = createEventBus()
    const done: string[] = []
    bus.subscribe('queue.completed', (m: any) => void done.push(m.payload.id))
    const queue = make({ bus })
    const qn = name()
    let started = 0
    queue.process(
      qn,
      async () => {
        started++
        await sleep(200)
      },
      { concurrency: 3 },
    )
    for (let i = 0; i < 3; i++) await queue.add(qn, i, { jobId: `j${i}` })
    await until(() => started === 3)
    await queue.close()
    expect(done.sort()).toEqual(['j0', 'j1', 'j2'])
    // Everything finished in Redis, too.
    const check = make()
    expect(await check.counts(qn)).toMatchObject({ active: 0, waiting: 0, completed: 3 })
  })

  it('recovers a stalled job from a worker that died', async () => {
    const qn = name()
    const queue = make({ worker: { lockDurationMs: 300, stalledIntervalMs: 150 } })
    await queue.add(qn, { run: 'run_stall' }, { jobId: 'run_stall' })

    // A worker that takes the job and then "crashes": it stops renewing its lock.
    const conn = new Redis(url, { maxRetriesPerRequest: null })
    const taken = deferred<void>()
    const dead = new BullWorker(
      encodeName(qn),
      async () => {
        taken.resolve()
        await new Promise(() => {})
      },
      // skipStalledCheck: its stalled check would set the shared check key and delay everyone else's.
      { connection: conn, prefix, lockDuration: 300, skipStalledCheck: true },
    )
    dead.on('error', () => {})
    await taken.promise
    await dead.close(true)
    await conn.quit().catch(() => {})

    expect((await queue.counts(qn)).active).toBe(1)
    const seen: unknown[] = []
    queue.process(qn, async (job) => void seen.push({ id: job.id, data: job.data }))
    await until(() => seen.length === 1, 5000)
    expect(seen).toEqual([{ id: 'run_stall', data: { run: 'run_stall' } }])
    await until(async () => (await queue.counts(qn)).completed === 1)
  })

  it('reports repeatable iterations under their repeatable id, and removes them', async () => {
    const queue = make()
    const qn = name()
    const ids: string[] = []
    queue.process(qn, async (job) => void ids.push(job.id))
    await queue.add(qn, { poll: 1 }, { jobId: 'poll:mcp:1', repeatEveryMs: 50 })
    await until(() => ids.length >= 2)
    await queue.removeRepeatable(qn, 'poll:mcp:1')
    await queue.idle()
    expect(new Set(ids)).toEqual(new Set(['poll:mcp:1']))
    const count = ids.length
    await sleep(150)
    expect(ids.length).toBe(count)
    expect((await queue.counts(qn)).delayed).toBe(0)
  })

  it('close() is idempotent and refuses new jobs afterwards', async () => {
    const queue = bullmqQueue({ connection: url, prefix })
    const qn = name()
    queue.process(qn, async () => {})
    await queue.add(qn, 1)
    await queue.idle()
    await Promise.all([queue.close(), queue.close()])
    await queue.close()
    await expect(queue.add(qn, 2)).rejects.toThrow('closed')
    expect(() => queue.process(qn, async () => {})).toThrow('closed')
  })
})
