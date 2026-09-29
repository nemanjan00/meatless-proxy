import {
  type ApiRecord,
  ApiRequestError,
  type ContactData,
  type EmployeeData,
  LIMIT_CAP_FIELDS,
  type LimitBudgetView,
  type LimitCapField,
  type LimitData,
  type LimitScopeView,
  type LimitsApi,
  type LimitsOverview,
  type ModelPriceView,
  type PricingInfo,
} from '@mp/api'
import type { MockDb } from './data.ts'

/** What the limits mock borrows from the mock API. */
export interface MockLimitsHelpers {
  db: MockDb
  iso(): string
  delay<T>(v: T): Promise<T>
  write<T extends Record<string, unknown>>(kind: string, id: string, data: T): ApiRecord<T>
  get<T>(kind: string, id: string): ApiRecord<T> | undefined
  all<T>(kind: string): ApiRecord<T>[]
}

/** The server's defaults (packages/server/src/limits.ts) when nothing is configured. */
export const MOCK_LIMIT_DEFAULTS: LimitsOverview['defaults'] = {
  maxDepth: 5,
  maxFanOut: 20,
  maxConcurrentSessions: 8,
  maxSteps: 60,
  maxWallMs: 30 * 60_000,
  maxAiStreak: 20,
  budgets: [{ target: 'employee', period: 'day', maxTokens: 5_000_000 }],
  warnAt: 0.8,
}

/** Prices checked on the providers' pages (a few of `@mp/usage`'s BUILTIN_PRICING). */
const BUILTIN: Record<string, ModelPriceView> = {
  'kimi-k3': { inputPerM: 3, cachedInputPerM: 0.3, outputPerM: 15 },
  'kimi-k2.7-code': { inputPerM: 0.95, cachedInputPerM: 0.19, outputPerM: 4 },
  'kimi-k2.6': { inputPerM: 0.95, cachedInputPerM: 0.16, outputPerM: 4 },
  'gpt-4.1': { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 8 },
}

const RANK: Record<string, number> = { global: 0, employee: 1, contact: 2, template: 3, procedure: 4, tree: 5, session: 6 }
const specificity = (t: LimitData['target']) => (RANK[t.type] ?? 0) * 2 + (t.id !== undefined ? 1 : 0)
const loose = (m: string) => m.toLowerCase().replace(/^.*\//, '').replace(/\./g, '-')
const ANY = '\u0000any'

/** Limits and pricing over the mock data, merged like `@mp/usage` does (most specific wins). */
export function createMockLimitsApi({ db, delay, write, get, all }: MockLimitsHelpers): LimitsApi {
  let custom: Record<string, ModelPriceView> = {}
  let seq = 100
  const fail = (status: number, code: 'validation' | 'not_found', message: string) =>
    Promise.reject(new ApiRequestError(status, code, message))

  const applies = (l: LimitData, ctx: { employeeId?: string; requesterId?: string }) => {
    if (l.enabled === false) return false
    if (l.target.type === 'global') return true
    const have = l.target.type === 'employee' ? ctx.employeeId : l.target.type === 'contact' ? ctx.requesterId : undefined
    return !!have && (l.target.id === undefined || l.target.id === have)
  }

  const effective = (ctx: { employeeId?: string; requesterId?: string }) => {
    const caps: LimitScopeView['caps'] = {}
    const sources: LimitScopeView['sources'] = {}
    for (const f of LIMIT_CAP_FIELDS) {
      const v = MOCK_LIMIT_DEFAULTS[f]
      if (v !== undefined) {
        caps[f] = v
        sources[f] = 'default'
      }
    }
    const budgets = new Map<string, LimitBudgetView>()
    const setBudget = (
      period: NonNullable<LimitData['period']>,
      target: string,
      v: Pick<LimitData, 'maxTokens' | 'maxCostUsd'>,
      source: string,
    ) => {
      const key = period === 'day' || period === 'month' ? `${period}:${target}` : period
      const b = budgets.get(key) ?? {
        key,
        period,
        ...(key.includes(':') ? { scope: target as LimitBudgetView['scope'] } : {}),
        sources: {},
      }
      for (const f of ['maxTokens', 'maxCostUsd'] as const) {
        if (v[f] === undefined) continue
        if (v[f] === null) delete b[f]
        else b[f] = v[f] as number
        b.sources[f] = source
      }
      budgets.set(key, b)
    }
    for (const d of MOCK_LIMIT_DEFAULTS.budgets) setBudget(d.period, d.target, d, 'default')
    const limits = all<LimitData>('limit')
      .filter((l) => applies(l.data, ctx))
      .sort((a, b) => specificity(a.data.target) - specificity(b.data.target))
    for (const l of limits) {
      for (const f of LIMIT_CAP_FIELDS) {
        const v = l.data[f]
        if (v === undefined) continue
        if (v === null) delete caps[f]
        else caps[f] = v
        sources[f] = l.id
      }
      if (l.data.maxTokens !== undefined || l.data.maxCostUsd !== undefined)
        setBudget(l.data.period ?? (l.data.target.type === 'contact' ? 'day' : 'run'), l.data.target.type, l.data, l.id)
    }
    return {
      caps,
      sources,
      budgets: [...budgets.values()].filter((b) => b.maxTokens !== undefined || b.maxCostUsd !== undefined),
    }
  }

  const usedToday = (match: (u: MockDb['usage'][number]) => boolean) => {
    const since = new Date(db.now())
    since.setUTCHours(0, 0, 0, 0)
    let tokens = 0
    let costUsd = 0
    for (const u of db.usage)
      if (u.at >= since.toISOString() && match(u)) {
        tokens += u.input + u.output
        costUsd += u.cost
      }
    return { tokens, costUsd }
  }

  const withUsage = (b: LimitBudgetView, ctx: { employeeId?: string; requesterId?: string }): LimitBudgetView => {
    if (b.period !== 'day') return b
    if (b.scope === 'global') return { ...b, used: usedToday(() => true) }
    if (b.scope === 'employee' && ctx.employeeId && ctx.employeeId !== ANY)
      return { ...b, used: usedToday((u) => u.employeeId === ctx.employeeId) }
    if (b.scope === 'contact' && ctx.requesterId && ctx.requesterId !== ANY)
      return { ...b, used: usedToday((u) => u.requesterId === ctx.requesterId) }
    return b
  }

  const scope = (
    target: LimitScopeView['target'],
    name: string,
    ctx: { employeeId?: string; requesterId?: string },
    keep: (b: LimitBudgetView) => boolean,
  ): LimitScopeView => {
    const e = effective(ctx)
    return { target, name, caps: e.caps, sources: e.sources, budgets: e.budgets.filter(keep).map((b) => withUsage(b, ctx)) }
  }

  const priceOf = (model: string): { price: ModelPriceView | null; source: 'custom' | 'builtin' | null } => {
    for (const [source, table] of [
      ['custom', custom],
      ['builtin', BUILTIN],
    ] as const) {
      const hit = table[model] ?? Object.entries(table).find(([k]) => loose(k) === loose(model))?.[1]
      if (hit) return { price: hit, source }
    }
    return { price: null, source: null }
  }
  const models = () => [...new Set(db.usage.map((u) => u.model))].sort()

  const check = (d: LimitData): string | null => {
    if (!d?.target || !Object.hasOwn(RANK, d.target.type)) return 'target.type is not valid'
    if (d.target.type === 'global' && d.target.id) return 'a global limit has no target id'
    const fields: (LimitCapField | 'maxTokens' | 'maxCostUsd')[] = [...LIMIT_CAP_FIELDS, 'maxTokens', 'maxCostUsd']
    for (const f of fields) {
      const v = d[f]
      if (v !== undefined && v !== null && (typeof v !== 'number' || v < 0 || !Number.isFinite(v)))
        return `${f} must be a non-negative number`
    }
    if (!fields.some((f) => d[f] !== undefined)) return 'set at least one limit'
    return null
  }

  const pricingInfo = (): PricingInfo => ({
    custom: { ...custom },
    env: {},
    builtin: { ...BUILTIN },
    models: models().map((model) => ({ model, ...priceOf(model) })),
  })

  return {
    limits: () => {
      const scopes: LimitScopeView[] = [
        scope({ type: 'global' }, 'Every employee', { employeeId: ANY, requesterId: ANY }, () => true),
      ]
      for (const e of all<EmployeeData>('employee'))
        scopes.push(scope({ type: 'employee', id: e.id }, e.data.name, { employeeId: e.id }, (b) => b.scope !== 'global'))
      const requesters = new Set(
        all<LimitData>('limit')
          .filter((l) => l.data.target.type === 'contact' && l.data.target.id)
          .map((l) => l.data.target.id!),
      )
      for (const id of requesters)
        scopes.push(
          scope(
            { type: 'contact', id },
            get<ContactData>('contact', id)?.data.name ?? id,
            { requesterId: id },
            (b) => b.scope === 'contact',
          ),
        )
      return delay({
        defaults: MOCK_LIMIT_DEFAULTS,
        overrides: all<LimitData>('limit'),
        scopes,
        unpricedModels: models().filter((m) => !priceOf(m).price),
      } satisfies LimitsOverview)
    },
    createLimit: (data) => {
      const problem = check(data)
      if (problem) return fail(422, 'validation', problem)
      const same = all<LimitData>('limit').find(
        (l) => l.data.target.type === data.target.type && l.data.target.id === data.target.id && l.data.period === data.period,
      )
      return delay(write('limit', same?.id ?? `lim_mock${++seq}`, data))
    },
    updateLimit: (id, data) => {
      if (!get('limit', id)) return fail(404, 'not_found', `limit ${id} not found`)
      const problem = check(data)
      if (problem) return fail(422, 'validation', problem)
      return delay(write('limit', id, data))
    },
    deleteLimit: (id) => {
      if (!db.records.get('limit')?.delete(id)) return fail(404, 'not_found', `limit ${id} not found`)
      return delay(undefined)
    },
    pricing: () => delay(pricingInfo()),
    setPricing: (pricing) => {
      for (const [m, p] of Object.entries(pricing))
        for (const f of ['inputPerM', 'outputPerM', 'cachedInputPerM'] as const) {
          const v = p[f]
          if ((v === undefined && f !== 'cachedInputPerM') || (v !== undefined && (typeof v !== 'number' || v < 0)))
            return fail(422, 'validation', `pricing: ${m}: ${f} must be a non-negative number`)
        }
      custom = structuredClone(pricing)
      return delay(pricingInfo())
    },
  }
}
