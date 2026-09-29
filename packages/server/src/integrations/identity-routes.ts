import type * as Api from '@mp/api'
import { DeniedError } from '@mp/core'
import { type Context, Hono } from 'hono'
import { principalOf } from '../auth/guard.ts'
import { jsonBody } from '../http/util.ts'
import type { Services } from '../services.ts'
import { defineIdentityKinds, type IdentityAdminDeps, ignoreIdentity, linkIdentity, listIdentityLinks } from './identity.ts'

const adminOnly = (c: Context) => {
  const p = principalOf(c)
  if (p.access !== 'admin') throw new DeniedError('only admins can see and link integration users')
  return p.contactId
}

/**
 * Integration users the harness couldn't link by itself (docs/spec.md#identity-from-integrations).
 * Admins only, reading included (see `GUARD_RULES`): the list shows names and emails of people who
 * have no contact yet.
 *
 * - `GET /api/identity/unlinked?status=&system=&limit=` → `{ items }`, most recently seen first
 * - `POST /api/identity/link { system, id, contactId }` → the user, linked to that person
 * - `POST /api/identity/ignore { system, id, ignored? }` → the user, left anonymous (or not)
 */
export function identityRoutes(s: Services): Hono {
  const app = new Hono()
  defineIdentityKinds(s.records)
  const deps = (): IdentityAdminDeps => ({
    records: s.records,
    directory: s.directory,
    clock: s.clock,
    logger: s.logger.child({ component: 'identity' }),
    forget: (system, id) => s.integrations?.identity.forget(system, id),
  })

  app.get('/api/identity/unlinked', async (c) => {
    adminOnly(c)
    const limit = c.req.query('limit')
    const items = await listIdentityLinks(deps(), {
      ...(c.req.query('status') ? { status: c.req.query('status') } : {}),
      ...(c.req.query('system') ? { system: c.req.query('system') } : {}),
      ...(limit && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
    })
    return c.json({ items } satisfies { items: Api.IdentityLinkView[] })
  })

  app.post('/api/identity/link', async (c) => {
    const by = adminOnly(c)
    return c.json(await linkIdentity(deps(), await jsonBody(c), by))
  })

  app.post('/api/identity/ignore', async (c) => {
    const by = adminOnly(c)
    return c.json(await ignoreIdentity(deps(), await jsonBody(c), by))
  })

  return app
}
