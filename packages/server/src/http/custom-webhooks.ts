import type { Context } from 'hono'
import { Hono } from 'hono'
import { principalOf } from '../auth/guard.ts'
import type { Services } from '../services.ts'
import { jsonBody } from './util.ts'
import { createRateLimiter, WEBHOOK_MAX_BYTES } from './webhooks.ts'

/**
 * Employees' own webhooks (src/webhooks):
 *
 * - `POST /webhooks/custom/:id`: public, checked by the webhook's own token or signature; 1 MB bodies,
 *   `WEBHOOK_RATE_LIMIT` a minute per webhook.
 * - `GET /api/webhooks?employeeId=`, `POST /api/webhooks` (answers the secret once), `PATCH /:id`,
 *   `DELETE /:id`, `POST /:id/rotate` (a new secret, once): admins only (GUARD_RULES).
 */
export function customWebhookRoutes(s: Services): Hono {
  const app = new Hono()
  const limiter = createRateLimiter(s.config.WEBHOOK_RATE_LIMIT, s.clock)
  const actor = (c: Context) => ({ type: 'contact' as const, id: principalOf(c).contactId })

  app.post('/webhooks/custom/:id', async (c) => {
    const id = c.req.param('id')
    if (!limiter.hit(id)) return c.json({ error: 'too many requests' }, 429, { 'retry-after': '60' })
    if (Number(c.req.header('content-length') ?? 0) > WEBHOOK_MAX_BYTES) return c.json({ error: 'body too large' }, 413)
    const body = await c.req.text()
    if (Buffer.byteLength(body) > WEBHOOK_MAX_BYTES) return c.json({ error: 'body too large' }, 413)
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    const res = await s.webhooks.receive(id, { headers, body })
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } })
  })

  app.get('/api/webhooks', async (c) => c.json(await s.webhooks.list(c.req.query('employeeId') || undefined)))
  app.post('/api/webhooks', async (c) => c.json(await s.webhooks.create(await jsonBody(c), actor(c)), 201))
  app.patch('/api/webhooks/:id', async (c) => c.json(await s.webhooks.update(c.req.param('id'), await jsonBody(c), actor(c))))
  app.delete('/api/webhooks/:id', async (c) => {
    await s.webhooks.remove(c.req.param('id'))
    return c.body(null, 204)
  })
  app.post('/api/webhooks/:id/rotate', async (c) => c.json(await s.webhooks.rotate(c.req.param('id'), actor(c))))
  return app
}
