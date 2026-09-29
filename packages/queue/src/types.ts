export interface JobOptions {
  /**
   * Deduplication: while a job with this id is waiting, delayed or active, adding
   * another one with the same id does nothing. Required for repeatable jobs.
   */
  jobId?: string
  /** Run no earlier than this many milliseconds from now. */
  delayMs?: number
  /** Higher runs first. Default 0. */
  priority?: number
  /** Total attempts including the first one. Default 1 (no retries). */
  attempts?: number
  /** Delay before each retry, doubled every time. Default 1000. */
  backoffMs?: number
  /** Repeat every this many milliseconds, until `removeRepeatable`. */
  repeatEveryMs?: number
}

export interface Job<T = unknown> {
  id: string
  queue: string
  data: T
  /** 1 for the first attempt. */
  attempt: number
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>

export interface ProcessOptions {
  /** How many jobs of this queue run at once in this process. Default 1. */
  concurrency?: number
}

export interface WorkerHandle {
  close(): Promise<void>
}

export interface QueueCounts {
  waiting: number
  delayed: number
  active: number
  completed: number
  failed: number
}

/** Bus topics published by queue implementations that were given a bus. */
export const QueueTopics = {
  failed: 'queue.failed',
  completed: 'queue.completed',
} as const

export interface Queue {
  /** Adds a job to a named queue and returns its id. */
  add<T>(queue: string, data: T, opts?: JobOptions): Promise<string>
  /** Starts processing a named queue. A handler that throws fails the attempt. */
  process<T>(queue: string, handler: JobHandler<T>, opts?: ProcessOptions): WorkerHandle
  removeRepeatable(queue: string, jobId: string): Promise<void>
  counts(queue: string): Promise<QueueCounts>
  /**
   * Resolves when no job is waiting or active in any queue (delayed jobs are
   * ignored). Meant for tests; adapters may implement it by polling.
   */
  idle(): Promise<void>
  close(): Promise<void>
}
