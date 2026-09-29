import { getConnInfo } from '@hono/node-server/conninfo'
import type { Clock } from '@mp/core'
import { type Context, Hono } from 'hono'
import type { Services } from '../services.ts'

/** Largest webhook body accepted. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024
const WINDOW_MS = 60_000
const MAX_TRACKED_IPS = 10_000

/** A fixed-window counter per key: at most `limit` hits per minute. */
export function createRateLimiter(limit: number, clock: Clock) {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    /** Counts a hit; false when the key is over its limit for this minute. */
    hit(key: string): boolean {
      const now = clock.now()
      const w = windows.get(key)
      if (!w || now - w.start >= WINDOW_MS) {
        if (windows.size >= MAX_TRACKED_IPS) {
          for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k)
          if (windows.size >= MAX_TRACKED_IPS) windows.delete(windows.keys().next().value!)
        }
        windows.set(key, { start: now, count: 1 })
        return true
      }
      w.count++
      return w.count <= limit
    },
  }
}

/** The client address: the first `X-Forwarded-For` hop behind a proxy, else the socket's address. */
function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (fwd) return fwd
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown' // no socket, e.g. app.request() in tests
  }
}

/**
 * Webhooks from the integrations (docs/spec.md#integrations), unauthenticated:
 * each integration verifies its own signature.
 *
 * - `POST /webhooks/:integration`: deployment-wide hooks, verified with the deployment-wide secrets.
 * - `POST /webhooks/:integration/:employee` (an employee id or handle): hooks of one employee's
 *   identity, verified with that employee's secrets, and its events belong to that employee.
 *
 * Bodies are limited to 1 MB, and each client address to `WEBHOOK_RATE_LIMIT` requests a minute.
 */
export function webhookRoutes(s: Services): Hono {
  const app = new Hono()
  const limiter = createRateLimiter(s.config.WEBHOOK_RATE_LIMIT, s.clock)

  const handle = async (c: Context) => {
    const integrations = s.integrations
    if (!integrations) return c.json({ error: 'integrations are disabled' }, 404)
    if (!limiter.hit(clientIp(c))) return c.json({ error: 'too many requests' }, 429, { 'retry-after': '60' })
    const length = Number(c.req.header('content-length') ?? 0)
    if (length > WEBHOOK_MAX_BYTES) return c.json({ error: 'body too large' }, 413)
    const body = await c.req.text()
    if (Buffer.byteLength(body) > WEBHOOK_MAX_BYTES) return c.json({ error: 'body too large' }, 413)
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    const res = await integrations.handleWebhook(c.req.param('integration')!, c.req.param('employee'), {
      method: c.req.method,
      headers,
      body,
      query: c.req.query(),
    })
    return new Response(res.body || null, { status: res.status, headers: res.headers })
  }

  app.all('/webhooks/:integration', handle)
  app.all('/webhooks/:integration/:employee', handle)
  return app
}
