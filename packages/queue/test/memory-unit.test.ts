import { createEventBus, memoryLogger, sleep, UnavailableError, ValidationError } from '@mp/core'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryQueue, type Queue } from '../src/index.ts'

describe('memoryQueue specifics', () => {
  let queue: Queue
  afterEach(() => queue.close())

  it('works without a bus', async () => {
    queue = memoryQueue()
    const seen: unknown[] = []
    queue.process('q', async (job) => void seen.push(job.data))
    await queue.add('q', 1)
    await queue.idle()
    expect(seen).toEqual([1])
  })

  it('logs retries and final failures', async () => {
    const logger = memoryLogger()
    queue = memoryQueue({ logger })
    queue.process('q', async () => {
      throw new Error('bad')
    })
    await queue.add('q', 1, { attempts: 2, backoffMs: 1 })
    await sleep(30)
    expect(logger.lines.map((l) => l.msg)).toEqual(['queue job failed, retrying', 'queue job failed'])
  })

  it('treats non-Error throws as failures with their string as the error', async () => {
    const bus = createEventBus()
    const errors: string[] = []
    bus.subscribe('queue.failed', (m: any) => void errors.push(m.payload.error))
    queue = memoryQueue({ bus })
    queue.process('q', () => Promise.reject('plain'))
    await queue.add('q', 1)
    await queue.idle()
    await bus.idle()
    expect(errors).toEqual(['plain'])
  })

  it('fails the attempt when the handler throws synchronously', async () => {
    queue = memoryQueue()
    queue.process('q', (() => {
      throw new Error('sync')
    }) as any)
    await queue.add('q', 1)
    await queue.idle()
    expect((await queue.counts('q')).failed).toBe(1)
  })

  it('throws typed errors', async () => {
    queue = memoryQueue()
    await expect(queue.add('q', 1, { repeatEveryMs: 10 })).rejects.toBeInstanceOf(ValidationError)
    await expect(queue.add('q', 1, { jobId: 'r', repeatEveryMs: 0 })).rejects.toBeInstanceOf(ValidationError)
    await queue.close()
    await expect(queue.add('q', 1)).rejects.toBeInstanceOf(UnavailableError)
    expect(() => queue.process('q', async () => {})).toThrow(UnavailableError)
  })

  it('idle() waits while jobs have no processor, and close() releases it', async () => {
    queue = memoryQueue()
    await queue.add('q', 1)
    let resolved = false
    const idle = queue.idle().then(() => (resolved = true))
    await sleep(30)
    expect(resolved).toBe(false)
    await queue.close()
    await idle
    expect(resolved).toBe(true)
  })

  it('drops pending retries on close()', async () => {
    let calls = 0
    queue = memoryQueue()
    queue.process('q', async () => {
      calls++
      throw new Error('x')
    })
    await queue.add('q', 1, { attempts: 3, backoffMs: 10 })
    await sleep(5)
    await queue.close()
    await sleep(40)
    expect(calls).toBe(1)
    expect(await queue.counts('q')).toMatchObject({ failed: 0 })
  })

  it('keeps priority order for many jobs', async () => {
    queue = memoryQueue()
    const added: { p: number; i: number }[] = []
    for (let i = 0; i < 300; i++) {
      const p = (i * 7) % 5
      added.push({ p, i })
      await queue.add('q', { p, i }, { priority: p })
    }
    const seen: { p: number; i: number }[] = []
    queue.process('q', async (job) => void seen.push(job.data as any))
    await queue.idle()
    expect(seen).toEqual([...added].sort((a, b) => b.p - a.p || a.i - b.i))
  })

  it('removing a repeatable drops its waiting iteration', async () => {
    queue = memoryQueue()
    await queue.add('q', 1, { jobId: 'rep', repeatEveryMs: 1000 })
    await sleep(5)
    expect((await queue.counts('q')).waiting).toBe(1)
    await queue.removeRepeatable('q', 'rep')
    expect(await queue.counts('q')).toMatchObject({ waiting: 0, delayed: 0 })
    await queue.idle()
  })

  it('counts a registered repeatable between iterations as delayed', async () => {
    queue = memoryQueue()
    queue.process('q', async () => {})
    await queue.add('q', 1, { jobId: 'rep', repeatEveryMs: 1000 })
    await sleep(10)
    expect(await queue.counts('q')).toMatchObject({ delayed: 1, completed: 1 })
  })
})
