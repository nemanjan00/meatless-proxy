import { newId, silentLogger, UnavailableError, ValidationError, type EventBus, type Logger } from '@mp/core'
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
} from './types.ts'

export interface MemoryQueueOptions {
  /** Receives `QueueTopics.completed` and `QueueTopics.failed`. */
  bus?: EventBus
  logger?: Logger
}

type State = 'waiting' | 'delayed' | 'active'

interface Entry {
  id: string
  queue: string
  data: unknown
  priority: number
  /** Order of entering `waiting`, for FIFO within a priority. */
  seq: number
  attempts: number
  backoffMs: number
  /** The attempt that runs next (or is running). */
  attempt: number
  state: State
  timer?: ReturnType<typeof setTimeout>
}

interface Repeat {
  id: string
  data: unknown
  opts: JobOptions
  everyMs: number
  timer?: ReturnType<typeof setTimeout>
}

interface Consumer {
  handler: JobHandler<any>
  concurrency: number
  running: Set<Promise<void>>
  closed: boolean
}

interface QueueState {
  name: string
  /** Sorted: priority descending, then seq ascending. */
  waiting: Entry[]
  delayed: Set<Entry>
  active: Set<Entry>
  /** Live jobs by id, for dedupe. */
  byId: Map<string, Entry>
  repeats: Map<string, Repeat>
  consumers: Consumer[]
  /** Round-robin start index over consumers. */
  next: number
  completed: number
  failed: number
}

/**
 * In-process `Queue` with real timers. Nothing survives the process. For tests,
 * demos and single-process development without Redis.
 */
export function memoryQueue(opts: MemoryQueueOptions = {}): Queue {
  const logger = opts.logger ?? silentLogger
  const bus = opts.bus
  const queues = new Map<string, QueueState>()
  const idleWaiters = new Set<() => void>()
  let seq = 0
  let closed = false

  const q = (name: string): QueueState => {
    let s = queues.get(name)
    if (!s) {
      s = {
        name,
        waiting: [],
        delayed: new Set(),
        active: new Set(),
        byId: new Map(),
        repeats: new Map(),
        consumers: [],
        next: 0,
        completed: 0,
        failed: 0,
      }
      queues.set(name, s)
    }
    return s
  }

  const isIdle = () => [...queues.values()].every((s) => s.waiting.length === 0 && s.active.size === 0)

  const checkIdle = () => {
    if (!idleWaiters.size || !isIdle()) return
    for (const w of [...idleWaiters]) w()
    idleWaiters.clear()
  }

  const toWaiting = (s: QueueState, e: Entry) => {
    e.state = 'waiting'
    e.timer = undefined
    s.delayed.delete(e)
    e.seq = seq++
    // Binary search for the first entry that should run after `e`.
    let lo = 0
    let hi = s.waiting.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const m = s.waiting[mid]!
      if (m.priority > e.priority || (m.priority === e.priority && m.seq < e.seq)) lo = mid + 1
      else hi = mid
    }
    s.waiting.splice(lo, 0, e)
    pump(s)
  }

  const toDelayed = (s: QueueState, e: Entry, ms: number) => {
    e.state = 'delayed'
    s.delayed.add(e)
    e.timer = setTimeout(() => toWaiting(s, e), ms)
  }

  const publish = (topic: string, e: Entry, error?: string) => {
    if (!bus) return
    const payload: QueueJobEvent = { queue: e.queue, id: e.id, attempt: e.attempt, data: e.data }
    if (error !== undefined) payload.error = error
    bus.publish(topic, payload)
  }

  const run = (s: QueueState, c: Consumer, e: Entry) => {
    e.state = 'active'
    s.active.add(e)
    const job: Job = { id: e.id, queue: e.queue, data: e.data, attempt: e.attempt }
    const p = (async () => {
      let error: unknown
      let ok = true
      try {
        await c.handler(job)
      } catch (err) {
        ok = false
        error = err
      }
      s.active.delete(e)
      if (ok) {
        s.byId.delete(e.id)
        s.completed++
        publish(QueueTopics.completed, e)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      if (e.attempt < e.attempts) {
        if (closed) return // dropped: nothing survives close() in memory
        const wait = e.backoffMs * 2 ** (e.attempt - 1)
        logger.warn('queue job failed, retrying', { queue: e.queue, id: e.id, attempt: e.attempt, retryInMs: wait, err: error })
        e.attempt++
        toDelayed(s, e, wait)
        return
      }
      logger.error('queue job failed', { queue: e.queue, id: e.id, attempt: e.attempt, err: error })
      s.byId.delete(e.id)
      s.failed++
      publish(QueueTopics.failed, e, message)
    })()
    c.running.add(p)
    void p.finally(() => {
      c.running.delete(p)
      pump(s)
      checkIdle()
    })
  }

  const pump = (s: QueueState) => {
    if (closed) return
    const n = s.consumers.length
    let progressed = true
    while (s.waiting.length && progressed) {
      progressed = false
      for (let i = 0; i < n && s.waiting.length; i++) {
        const c = s.consumers[(s.next + i) % n]!
        if (c.closed || c.running.size >= c.concurrency) continue
        s.next = (s.next + i + 1) % n
        run(s, c, s.waiting.shift()!)
        progressed = true
        break
      }
    }
  }

  const enqueue = (s: QueueState, id: string, data: unknown, o: JobOptions, delayMs: number) => {
    const e: Entry = {
      id,
      queue: s.name,
      data,
      priority: o.priority ?? 0,
      seq: 0,
      attempts: Math.max(1, o.attempts ?? 1),
      backoffMs: o.backoffMs ?? 1000,
      attempt: 1,
      state: 'waiting',
    }
    s.byId.set(id, e)
    if (delayMs > 0) toDelayed(s, e, delayMs)
    else toWaiting(s, e)
  }

  const tick = (s: QueueState, r: Repeat) => {
    r.timer = setTimeout(() => tick(s, r), r.everyMs)
    if (s.byId.has(r.id)) return // the previous iteration hasn't finished yet
    enqueue(s, r.id, r.data, r.opts, 0)
  }

  const assertOpen = () => {
    if (closed) throw new UnavailableError('queue is closed')
  }

  return {
    async add(queue, data, o = {}) {
      assertOpen()
      const s = q(queue)
      const delayMs = Math.max(0, o.delayMs ?? 0)
      if (o.repeatEveryMs !== undefined) {
        if (!o.jobId) throw new ValidationError('repeatable jobs need a jobId')
        if (!(o.repeatEveryMs > 0)) throw new ValidationError('repeatEveryMs must be positive')
        if (s.repeats.has(o.jobId)) return o.jobId
        const r: Repeat = { id: o.jobId, data, opts: o, everyMs: o.repeatEveryMs }
        s.repeats.set(r.id, r)
        r.timer = setTimeout(() => tick(s, r), delayMs)
        return r.id
      }
      const id = o.jobId ?? newId('job')
      if (s.byId.has(id)) return id
      enqueue(s, id, data, o, delayMs)
      return id
    },

    process(queue, handler, o: ProcessOptions = {}): WorkerHandle {
      assertOpen()
      const s = q(queue)
      const c: Consumer = { handler, concurrency: Math.max(1, o.concurrency ?? 1), running: new Set(), closed: false }
      s.consumers.push(c)
      pump(s)
      return {
        async close() {
          if (!c.closed) {
            c.closed = true
            const i = s.consumers.indexOf(c)
            if (i >= 0) s.consumers.splice(i, 1)
            s.next = 0
          }
          while (c.running.size) await Promise.allSettled([...c.running])
        },
      }
    },

    async removeRepeatable(queue, jobId) {
      const s = queues.get(queue)
      const r = s?.repeats.get(jobId)
      if (!s || !r) return
      clearTimeout(r.timer)
      s.repeats.delete(jobId)
      // Drop an iteration that hasn't started yet.
      const e = s.byId.get(jobId)
      if (e && e.state === 'waiting') {
        s.waiting.splice(s.waiting.indexOf(e), 1)
        s.byId.delete(jobId)
        checkIdle()
      }
    },

    async counts(queue): Promise<QueueCounts> {
      const s = queues.get(queue)
      if (!s) return { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0 }
      let pendingRepeats = 0
      for (const r of s.repeats.values()) if (!s.byId.has(r.id)) pendingRepeats++
      return {
        waiting: s.waiting.length,
        delayed: s.delayed.size + pendingRepeats,
        active: s.active.size,
        completed: s.completed,
        failed: s.failed,
      }
    },

    idle() {
      if (isIdle()) return Promise.resolve()
      return new Promise<void>((resolve) => idleWaiters.add(resolve))
    },

    async close() {
      if (!closed) {
        closed = true
        for (const s of queues.values()) {
          for (const e of s.delayed) clearTimeout(e.timer)
          for (const r of s.repeats.values()) clearTimeout(r.timer)
          for (const c of s.consumers) c.closed = true
        }
      }
      const running = [...queues.values()].flatMap((s) => s.consumers.flatMap((c) => [...c.running]))
      await Promise.allSettled(running)
      for (const w of idleWaiters) w()
      idleWaiters.clear()
    },
  }
}
