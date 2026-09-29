import { Redis } from 'ioredis'

export const REDIS_URL = process.env.REDIS_URL

/** A key prefix unique to one test file run. */
export function uniquePrefix(label: string): string {
  return `mptest-${label}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
}

/** Deletes every key under `prefix`. */
export async function deleteKeys(url: string, prefix: string): Promise<void> {
  const redis = new Redis(url, { maxRetriesPerRequest: null })
  try {
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000)
      cursor = next
      if (keys.length) await redis.del(...keys)
    } while (cursor !== '0')
  } finally {
    await redis.quit()
  }
}
