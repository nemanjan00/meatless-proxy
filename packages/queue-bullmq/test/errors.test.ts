import { memoryLogger, type LogLine } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { logQueueError } from '../src/bullmq.ts'

describe('queue error logging', () => {
  it('logs a lost Redis connection as a warning (it retries by itself), anything else as an error', () => {
    const lines: LogLine[] = []
    const log = memoryLogger(lines)
    const lost = Object.assign(new Error('getaddrinfo ENOTFOUND redis'), { code: 'ENOTFOUND' })
    logQueueError(log, 'worker error', { queue: 'runs' }, lost)
    logQueueError(log, 'redis connection error', {}, new Error('connect ECONNREFUSED 10.0.0.5:6379'))
    logQueueError(log, 'queue error', { queue: 'events' }, new Error('Missing lock for job 7'))
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      ['warn', 'worker error (retrying)'],
      ['warn', 'redis connection error (retrying)'],
      ['error', 'queue error'],
    ])
  })
})
