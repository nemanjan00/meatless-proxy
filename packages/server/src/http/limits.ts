import type * as Api from '@mp/api'
import { DeniedError, ValidationError } from '@mp/core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import {
  CAP_FIELDS,
  checkPricing,
  priceFor,
  type BudgetStatus,
  type EffectiveLimits,
  type LimitData,
  type Pricing,
  type UsageData,
} from '@mp/usage'
import { principalOf } from '../auth/guard.ts'
import type { Services } from '../services.ts'
import { jsonBody } from './util.ts'

/**
 * Settings → Limits and Settings → Pricing (docs/spec.md#configurable-limits). Admins only,
 * reading included: `GET/POST /api/limits`, `PUT/DELETE /api/limits/:id`, `GET/PUT /api/pricing`.
 */

/** Stands for "any one" when showing what every employee or requester gets. */
const ANY = '\u0000any'
const DAY_MS = 86_400_000

const adminOnly = (c: Context) => {
  const p = principalOf(c)
  if (p.access !== 'admin') throw new DeniedError('only admins can see and change limits and pricing')
  return { type: 'contact' as const, id: p.contactId }
}

/** The body of a create or update, checked (the usage service checks the numbers). */
function limitBody(body: Record<string, unknown>): LimitData {
  const t = body.target as { type?: unknown; id?: unknown } | undefined
  if (!t || typeof t !== 'object' || typeof t.type !== 'string') throw new ValidationError('target: { type, id? } is required')
  const allowed = new Set(['target', 'maxTokens', 'maxCostUsd', 'period', 'enabled', ...CAP_FIELDS])
  const unknown = Object.keys(body).filter((k) => !allowed.has(k))
  if (unknown.length) throw new ValidationError(`unknown fields: ${unknown.join(', ')}`)
  const data: Record<string, unknown> = { target: { type: t.type, ...(t.id !== undefined && t.id !== '' ? { id: t.id } : {}) } }
  for (const [k, v] of Object.entries(body)) if (k !== 'target' && v !== undefined) data[k] = v
  if (data.enabled !== undefined && typeof data.enabled !== 'boolean') throw new ValidationError('enabled must be true or false')
  const d = data as LimitData
  const setsBudget = d.maxTokens !== undefined || d.maxCostUsd !== undefined
  const setsSomething = setsBudget || CAP_FIELDS.some((f) => d[f] !== undefined)
  if (!setsSomething) throw new ValidationError('set at least one limit')
  if (d.period && !setsBudget) throw new ValidationError('a period applies to a token or cost budget; set one')
  return d
}

export function limitRoutes(s: Services): Hono {
  const app = new Hono()

  const budgetView = (b: EffectiveLimits['budgets'][number], used?: BudgetStatus['used']): Api.LimitBudgetView => ({
    key: b.key,
    period: b.period,
    ...(b.scope ? { scope: b.scope } : {}),
    ...(b.maxTokens !== undefined ? { maxTokens: b.maxTokens } : {}),
    ...(b.maxCostUsd !== undefined ? { maxCostUsd: b.maxCostUsd } : {}),
    sources: b.sources,
    ...(used ? { used } : {}),
  })

  const scopeView = (
    target: Api.LimitScopeView['target'],
    name: string,
    eff: EffectiveLimits,
    status: BudgetStatus[],
    keep: (b: EffectiveLimits['budgets'][number]) => boolean,
  ): Api.LimitScopeView => {
    const caps: Api.LimitScopeView['caps'] = {}
    for (const f of CAP_FIELDS) if (eff[f] !== undefined) caps[f] = eff[f]
    const used = new Map(status.map((b) => [b.key, b.used]))
    return {
      target,
      name,
      caps,
      sources: eff.sources,
      budgets: eff.budgets.filter(keep).map((b) => budgetView(b, used.get(b.key))),
    }
  }

  /** Models used in the last 30 days, and the default model. */
  const modelsInUse = async (): Promise<string[]> => {
    const since = new Date(s.clock.now() - 30 * DAY_MS).toISOString()
    const rows = await s.records.query<UsageData>('usage', { where: [{ field: 'at', op: 'gte', value: since }], limit: 5000 })
    const models = new Set(rows.items.map((u) => u.data.model))
    const def = s.config.MODEL ?? s.model.defaultModel
    if (def) models.add(def)
    return [...models].filter(Boolean).sort()
  }

  const pricingInfo = async (): Promise<Api.PricingInfo> => {
    const t = s.pricing.tables()
    const models = (await modelsInUse()).map((model) => {
      for (const source of ['custom', 'env', 'builtin'] as const) {
        const price = priceFor(model, t[source])
        if (price) return { model, price, source }
      }
      return { model, price: null, source: null }
    })
    return { ...t, models }
  }

  app.get('/api/limits', async (c) => {
    adminOnly(c)
    const defaults = await s.usage.limits.defaults()
    const overrides = await s.usage.limits.list()
    const scopes: Api.LimitScopeView[] = []
    // Every employee: the defaults, overridden by limits for the whole deployment and for every employee or requester.
    const every = await s.usage.limits.effective({ employeeId: ANY, requesterId: ANY })
    const deployment = await s.usage.budgetStatus({})
    scopes.push(scopeView({ type: 'global' }, 'Every employee', every, deployment, () => true))
    for (const e of (await s.directory.employees.list()).items) {
      const ctx = { employeeId: e.id }
      scopes.push(
        scopeView(
          { type: 'employee', id: e.id },
          e.data.name,
          await s.usage.limits.effective(ctx),
          await s.usage.budgetStatus(ctx),
          (b) => b.scope !== 'global',
        ),
      )
    }
    const requesters = [
      ...new Set(overrides.filter((l) => l.data.target.type === 'contact' && l.data.target.id).map((l) => l.data.target.id!)),
    ]
    for (const id of requesters) {
      const ctx = { requesterId: id }
      const contact = await s.directory.contacts.get(id)
      scopes.push(
        scopeView(
          { type: 'contact', id },
          contact?.data.name ?? id,
          await s.usage.limits.effective(ctx),
          await s.usage.budgetStatus(ctx),
          (b) => b.scope === 'contact',
        ),
      )
    }
    const unpricedModels = (await modelsInUse()).filter((m) => !s.usage.priceOf(m))
    return c.json({
      defaults: { ...defaults, budgets: defaults.budgets ?? [] },
      overrides: overrides as unknown as Api.ApiRecord<Api.LimitData>[],
      scopes,
      unpricedModels,
    } satisfies Api.LimitsOverview)
  })

  app.post('/api/limits', async (c) => {
    const actor = adminOnly(c)
    const data = limitBody(await jsonBody(c))
    return c.json(await s.usage.limits.set(data, { actor }), 201)
  })

  app.put('/api/limits/:id', async (c) => {
    const actor = adminOnly(c)
    const data = limitBody(await jsonBody(c))
    const id = c.req.param('id')
    if (!(await s.usage.limits.get(id))) return c.json({ error: { code: 'not_found', message: `limit ${id} not found` } }, 404)
    return c.json(await s.usage.limits.set({ ...data, id }, { actor }))
  })

  app.delete('/api/limits/:id', async (c) => {
    const actor = adminOnly(c)
    await s.usage.limits.remove(c.req.param('id'), { actor })
    return c.body(null, 204)
  })

  app.get('/api/pricing', async (c) => {
    adminOnly(c)
    return c.json(await pricingInfo())
  })

  app.put('/api/pricing', async (c) => {
    const actor = adminOnly(c)
    const body = await jsonBody<{ pricing?: unknown }>(c)
    let table: Pricing
    try {
      table = checkPricing(body.pricing ?? {})
    } catch (err) {
      throw new ValidationError(`pricing: ${err instanceof Error ? err.message : String(err)}`)
    }
    await s.pricing.set(table, actor)
    return c.json(await pricingInfo())
  })

  return app
}
