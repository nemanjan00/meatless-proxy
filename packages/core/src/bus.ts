import { silentLogger, type Logger } from './logger.ts'

export interface BusMessage<T = unknown> {
  topic: string
  payload: T
  /** Milliseconds since the epoch, from the publisher's clock. */
  at: number
}

export type BusHandler<T = unknown> = (message: BusMessage<T>) => void | Promise<void>

/**
 * In-process publish/subscribe, used for feedback that flows up the layers
 * (low-level code publishes, high-level code listens) and for live updates.
 *
 * It's fire-and-forget: publishing never waits for handlers and never fails
 * because of them. Losing a message must never lose work; durable things go
 * through records and the queue.
 */
export interface EventBus {
  publish<T>(topic: string, payload: T): void
  /**
   * Subscribe to a topic or a pattern: `run.state`, `run.*` (one segment),
   * `run.**` or `**` (any number of segments). Returns an unsubscribe function.
   */
  subscribe<T = unknown>(pattern: string, handler: BusHandler<T>): () => void
  /** Resolves once every handler started so far has finished. For tests and shutdown. */
  idle(): Promise<void>
}

export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === '**' || pattern === topic) return true
  const p = pattern.split('.')
  const t = topic.split('.')
  const match = (i: number, j: number): boolean => {
    if (i === p.length) return j === t.length
    if (p[i] === '**') {
      for (let k = j; k <= t.length; k++) if (match(i + 1, k)) return true
      return false
    }
    if (j === t.length) return false
    return (p[i] === '*' || p[i] === t[j]) && match(i + 1, j + 1)
  }
  return match(0, 0)
}

export function createEventBus(opts: { logger?: Logger; now?: () => number } = {}): EventBus {
  const logger = opts.logger ?? silentLogger
  const now = opts.now ?? Date.now
  const subs = new Set<{ pattern: string; handler: BusHandler<any> }>()
  const pending = new Set<Promise<void>>()

  return {
    publish(topic, payload) {
      const message: BusMessage = { topic, payload, at: now() }
      for (const sub of [...subs]) {
        if (!topicMatches(sub.pattern, topic)) continue
        const p = (async () => {
          try {
            await sub.handler(message)
          } catch (err) {
            logger.error('bus handler failed', { topic, err })
          }
        })()
        pending.add(p)
        void p.finally(() => pending.delete(p))
      }
    },
    subscribe(pattern, handler) {
      const sub = { pattern, handler }
      subs.add(sub)
      return () => void subs.delete(sub)
    },
    async idle() {
      while (pending.size) await Promise.all([...pending])
    },
  }
}

/** Resolves with the first message on `pattern` that matches `predicate`. */
export function nextMessage<T = unknown>(
  bus: EventBus,
  pattern: string,
  predicate: (m: BusMessage<T>) => boolean = () => true,
  timeoutMs = 5000,
): Promise<BusMessage<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timed out waiting for ${pattern}`))
    }, timeoutMs)
    const off = bus.subscribe<T>(pattern, (m) => {
      if (!predicate(m)) return
      clearTimeout(timer)
      off()
      resolve(m)
    })
  })
}
