import { NotFoundError, ValidationError, type Clock, type EventBus, type KindSchema } from '@mp/core'
import type { Records } from '@mp/records'
import type { Actor, Condition, StoredRecord } from '@mp/store'
import { priceFor, type ModelPrice, type Pricing } from './pricing.ts'

/** `Omit` that keeps known keys of types with an index signature. */
type Without<T, K extends PropertyKey> = { [P in keyof T as P extends K ? never : P]: T[P] }

/** Bus topic published after every recorded model call. */
export const USAGE_RECORDED = 'usage.recorded'

const idField = (name: string, description?: string) => ({
  name,
  type: 'string' as const,
  ...(description ? { description } : {}),
})

export const usageSchema: KindSchema = {
  kind: 'usage',
  prefix: 'use',
  description: 'Token usage and cost of one model call.',
  titleField: 'model',
  core: [
    idField('runId'),
    idField('sessionId'),
    idField('rootSessionId', 'The root of the session tree.'),
    idField('employeeId'),
    idField('requesterId', 'The contact who asked for the work.'),
    idField('templateId'),
    idField('procedureId'),
    idField('projectId'),
    { name: 'model', type: 'string', required: true },
    { name: 'promptTokens', type: 'number', required: true },
    { name: 'completionTokens', type: 'number', required: true },
    { name: 'cachedTokens', type: 'number' },
    { name: 'reasoningTokens', type: 'number' },
    { name: 'totalTokens', type: 'number', required: true },
    { name: 'costUsd', type: 'number', required: true },
    { name: 'at', type: 'timestamp', required: true },
  ],
}

export const LIMIT_TARGETS = ['global', 'employee', 'contact', 'template', 'procedure', 'session', 'tree'] as const
export const LIMIT_PERIODS = ['run', 'session', 'tree', 'day', 'month'] as const
export type LimitTargetType = (typeof LIMIT_TARGETS)[number]
export type LimitPeriod = (typeof LIMIT_PERIODS)[number]

/** Limit fields that cap a number (not budgets). */
export const CAP_FIELDS = ['maxDepth', 'maxFanOut', 'maxConcurrentSessions', 'maxSteps', 'maxWallMs', 'maxAiStreak'] as const
export type CapField = (typeof CAP_FIELDS)[number]

export const limitSchema: KindSchema = {
  kind: 'limit',
  prefix: 'lim',
  description:
    'An override of the deployment defaults: for the whole deployment (global), or per employee, requester (contact), template, procedure, session or tree.',
  core: [
    {
      name: 'target',
      type: 'object',
      required: true,
      description: 'What it applies to. Without an id, every one of that type.',
      fields: [
        { name: 'type', type: 'enum', values: [...LIMIT_TARGETS], required: true },
        { name: 'id', type: 'string' },
      ],
    },
    { name: 'maxTokens', type: 'number' },
    { name: 'maxCostUsd', type: 'number' },
    {
      name: 'period',
      type: 'enum',
      values: [...LIMIT_PERIODS],
      description:
        'What maxTokens/maxCostUsd are measured over. day/month: the target (employee, requester, whole deployment…) since the start of the UTC day/month.',
    },
    { name: 'maxDepth', type: 'number', description: 'Fork depth.' },
    { name: 'maxFanOut', type: 'number', description: 'Children per loop.' },
    { name: 'maxConcurrentSessions', type: 'number', description: 'Runs working at once per employee; more wait in the queue.' },
    { name: 'maxSteps', type: 'number', description: 'Model calls per run before it pauses.' },
    { name: 'maxWallMs', type: 'number', description: 'Wall-clock time a run may work before it pauses.' },
    { name: 'maxAiStreak', type: 'number', description: 'Messages between employees in one thread without a person.' },
    { name: 'enabled', type: 'boolean', description: 'Default true.' },
  ],
}

export interface UsageData extends Record<string, unknown> {
  runId?: string
  sessionId?: string
  rootSessionId?: string
  employeeId?: string
  requesterId?: string
  templateId?: string
  procedureId?: string
  projectId?: string
  model: string
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  reasoningTokens?: number
  totalTokens: number
  costUsd: number
  at: string
}

export type UsageRecord = StoredRecord<UsageData>

/** One model call. `totalTokens` defaults to prompt + completion, `costUsd` is computed from pricing, `at` from the clock. */
export type UsageInput = Without<UsageData, 'totalTokens' | 'costUsd' | 'at'> & {
  totalTokens?: number
  costUsd?: number
  at?: string
}

export interface UsageFilter {
  runId?: string
  sessionId?: string
  rootSessionId?: string
  employeeId?: string
  requesterId?: string
  templateId?: string
  procedureId?: string
  projectId?: string
  model?: string
  /** ISO timestamp, inclusive. */
  since?: string
  /** ISO timestamp, exclusive. */
  until?: string
}

export interface UsageTotals {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number
  calls: number
}

export type GroupBy =
  | 'employee'
  | 'session'
  | 'tree'
  | 'model'
  | 'requester'
  | 'run'
  | 'template'
  | 'procedure'
  | 'project'
  | 'day'

export interface BreakdownRow extends UsageTotals {
  /** The group's value, e.g. an employee id or `2026-09-29`. `null` for calls without one. */
  key: string | null
}

/** A cap or budget value: a number, or `null` for "no limit" (it overrides a default). */
export type LimitValue = number | null

export interface LimitData extends Record<string, unknown> {
  target: { type: LimitTargetType; id?: string }
  maxTokens?: LimitValue
  maxCostUsd?: LimitValue
  period?: LimitPeriod
  maxDepth?: LimitValue
  maxFanOut?: LimitValue
  maxConcurrentSessions?: LimitValue
  maxSteps?: LimitValue
  maxWallMs?: LimitValue
  maxAiStreak?: LimitValue
  enabled?: boolean
}

export type Limit = StoredRecord<LimitData>

/** Where the work is, to find the limits that apply. */
export interface LimitContext {
  employeeId?: string
  /** The contact who asked for the work. */
  requesterId?: string
  sessionId?: string
  rootSessionId?: string
  templateId?: string
  procedureId?: string
}

export interface BudgetContext extends LimitContext {
  runId?: string
}

/** A budget that applies without any limit record, e.g. 5M tokens per employee per day. */
export interface DefaultBudget {
  /** Whose usage counts, for day and month budgets (`global`: the whole deployment). */
  target: LimitTargetType
  period: LimitPeriod
  maxTokens?: number
  maxCostUsd?: number
}

/** Deployment-wide defaults. Limit records override them for their target. */
export interface LimitDefaults extends Partial<Record<CapField, number>> {
  budgets?: DefaultBudget[]
  /** Share of a budget (0–1) at which a warning is due. Default 0.8. */
  warnAt?: number
}

export interface EffectiveBudget {
  /** `run`, `session`, `tree`, or `<day|month>:<scope>`, e.g. `day:employee`. */
  key: string
  period: LimitPeriod
  /** For day and month budgets: whose usage counts (employee, contact, global = the whole deployment…). */
  scope?: LimitTargetType
  maxTokens?: number
  maxCostUsd?: number
  /** Where each value comes from: a limit id, or `default`. */
  sources: { maxTokens?: string; maxCostUsd?: string }
}

/** The limits that apply: the defaults, overridden by the most specific matching limit records. */
export interface EffectiveLimits extends Partial<Record<CapField, number>> {
  budgets: EffectiveBudget[]
  /** Ids of the limits that were merged. */
  limitIds: string[]
  /** Where each cap comes from: a limit id, or `default`. */
  sources: Partial<Record<CapField, string>>
}

/** A budget with what has been used of it. */
export interface BudgetStatus extends EffectiveBudget {
  /** The employee, contact, … whose usage counts (day and month budgets). */
  scopeId?: string
  /** Start of the period (day and month budgets). */
  since?: string
  used: { tokens: number; costUsd: number }
}

export type BudgetCheck =
  | { ok: true }
  | {
      ok: false
      reason: string
      field: 'maxTokens' | 'maxCostUsd'
      period: LimitPeriod
      scope?: LimitTargetType
      /** A limit id, or `default`. */
      source: string
      max: number
      used: { tokens: number; costUsd: number }
    }

export type ForkCheck =
  | { ok: true }
  | { ok: false; reason: string; field: 'maxDepth' | 'maxFanOut' | 'maxConcurrentSessions'; max: number }

export interface Limits {
  /** Creates a limit, or updates the one with the same target and period (or `id`). */
  set(data: LimitData & { id?: string }, opts?: { actor?: Actor }): Promise<Limit>
  get(id: string): Promise<Limit | null>
  list(filter?: { targetType?: LimitTargetType; targetId?: string }): Promise<Limit[]>
  remove(id: string, opts?: { actor?: Actor }): Promise<void>
  /** Enabled limits whose target matches the context. */
  matching(ctx: LimitContext): Promise<Limit[]>
  /** The deployment defaults. */
  defaults(): Promise<LimitDefaults>
  /** The defaults, overridden by the matching limits (the most specific wins). */
  effective(ctx: LimitContext): Promise<EffectiveLimits>
}

export interface UsageService {
  record(input: UsageInput, opts?: { actor?: Actor }): Promise<UsageRecord>
  /** Cost of a call from the pricing table, 0 for unknown models. */
  cost(model: string, tokens: { promptTokens: number; completionTokens: number; cachedTokens?: number }): number
  /** The price of a model, or null when it has none. */
  priceOf(model: string): ModelPrice | null
  totals(filter?: UsageFilter): Promise<UsageTotals>
  /** Totals per group, most tokens first. */
  breakdown(groupBy: GroupBy, filter?: UsageFilter): Promise<BreakdownRow[]>
  limits: Limits
  /** Every token and cost budget that applies, with what has been used, in check order. */
  budgetStatus(ctx: BudgetContext): Promise<BudgetStatus[]>
  /**
   * Whether the token and cost budgets that apply still have room. Returns the first one reached,
   * in this order: run, session, tree, then day and month budgets from the narrowest scope to the
   * employee, the requester and the whole deployment.
   */
  checkBudget(ctx: BudgetContext): Promise<BudgetCheck>
}

export interface UsageDeps {
  records: Records
  clock: Clock
  /** Prices by model, or a function returning the current ones (they can change at runtime). */
  pricing?: Pricing | (() => Pricing)
  /** Deployment defaults, or a function returning the current ones. */
  defaults?: LimitDefaults | (() => LimitDefaults | Promise<LimitDefaults>)
  bus?: EventBus
}

const FILTER_FIELDS = [
  'runId',
  'sessionId',
  'rootSessionId',
  'employeeId',
  'requesterId',
  'templateId',
  'procedureId',
  'projectId',
  'model',
] as const

const GROUP_FIELD: Record<Exclude<GroupBy, 'day'>, keyof UsageData> = {
  employee: 'employeeId',
  session: 'sessionId',
  tree: 'rootSessionId',
  model: 'model',
  requester: 'requesterId',
  run: 'runId',
  template: 'templateId',
  procedure: 'procedureId',
  project: 'projectId',
}

/** The usage field and context field of each target type (global has none). */
const TARGET_FIELD: Record<Exclude<LimitTargetType, 'global'>, keyof LimitContext & keyof UsageFilter> = {
  employee: 'employeeId',
  contact: 'requesterId',
  template: 'templateId',
  procedure: 'procedureId',
  session: 'sessionId',
  tree: 'rootSessionId',
}

const TOKEN_FIELDS = ['promptTokens', 'completionTokens', 'cachedTokens', 'reasoningTokens', 'totalTokens'] as const

/** How specific a target type is: a more specific limit overrides a less specific one. */
const RANK: Record<LimitTargetType, number> = {
  global: 0,
  employee: 1,
  contact: 2,
  template: 3,
  procedure: 4,
  tree: 5,
  session: 6,
}

const emptyTotals = (): UsageTotals => ({
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  calls: 0,
})

/** Rounds away float noise in dollar sums. */
const roundUsd = (n: number) => Math.round(n * 1e9) / 1e9

export function startOfUtcDay(ms: number): string {
  const d = new Date(ms)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}

export function startOfUtcMonth(ms: number): string {
  const d = new Date(ms)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

/** The period a budget is measured over when the limit doesn't say. */
export function defaultPeriod(target: LimitTargetType): LimitPeriod {
  return target === 'session' ? 'session' : target === 'tree' ? 'tree' : target === 'contact' ? 'day' : 'run'
}

/** Specificity of a target: the type, then whether it names one (an id beats "every one"). */
export function specificity(target: LimitData['target']): number {
  return RANK[target.type] * 2 + (target.id !== undefined ? 1 : 0)
}

/** The budget key: `run`, `session`, `tree`, or `<period>:<target type>` for day and month. */
export function budgetKey(period: LimitPeriod, target: LimitTargetType): string {
  return period === 'day' || period === 'month' ? `${period}:${target}` : period
}

/** Check order of a budget: run, session, tree, then day and month from the narrowest scope to the deployment. */
function budgetOrder(b: { period: LimitPeriod; scope?: LimitTargetType }): number {
  if (b.period === 'run') return 0
  if (b.period === 'session') return 1
  if (b.period === 'tree') return 2
  return 3 + (RANK.session - RANK[b.scope ?? 'global']) * 2 + (b.period === 'month' ? 1 : 0)
}

/** Whether a limit's target covers the context. A target without an id covers every one of its type. */
export function limitApplies(l: LimitData, ctx: LimitContext): boolean {
  if (l.enabled === false) return false
  if (l.target.type === 'global') return true
  const have = ctx[TARGET_FIELD[l.target.type]]
  if (!have) return false
  return l.target.id === undefined || l.target.id === have
}

/**
 * Merges defaults and limits: each cap and each budget value comes from the
 * most specific limit that sets it (session, tree, procedure, template,
 * requester, employee, then the whole deployment; one naming an id beats one
 * for every one of its type), else from the defaults. `null` means no limit.
 */
export function mergeLimits(limits: Limit[], defaults: LimitDefaults = {}): EffectiveLimits {
  const out: EffectiveLimits = { budgets: [], limitIds: [], sources: {} }
  const set = (f: CapField, v: LimitValue | undefined, source: string) => {
    if (v === undefined) return
    if (v === null) delete out[f]
    else out[f] = v
    out.sources[f] = source
  }
  for (const f of CAP_FIELDS) set(f, defaults[f], 'default')
  const budgets = new Map<string, EffectiveBudget>()
  const setBudget = (
    period: LimitPeriod,
    target: LimitTargetType,
    v: Pick<LimitData, 'maxTokens' | 'maxCostUsd'>,
    source: string,
  ) => {
    const key = budgetKey(period, target)
    const b = budgets.get(key) ?? { key, period, ...(key.includes(':') ? { scope: target } : {}), sources: {} }
    for (const f of ['maxTokens', 'maxCostUsd'] as const) {
      const x = v[f]
      if (x === undefined) continue
      if (x === null) delete b[f]
      else b[f] = x
      b.sources[f] = source
    }
    budgets.set(key, b)
  }
  for (const d of defaults.budgets ?? []) setBudget(d.period, d.target, d, 'default')
  const ordered = limits
    .filter((l) => l.data.enabled !== false)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => specificity(a.l.data.target) - specificity(b.l.data.target) || a.i - b.i)
  for (const { l } of ordered) {
    out.limitIds.push(l.id)
    for (const f of CAP_FIELDS) set(f, l.data[f], l.id)
    if (l.data.maxTokens !== undefined || l.data.maxCostUsd !== undefined)
      setBudget(l.data.period ?? defaultPeriod(l.data.target.type), l.data.target.type, l.data, l.id)
  }
  out.budgets = [...budgets.values()]
    .filter((b) => b.maxTokens !== undefined || b.maxCostUsd !== undefined)
    .sort((a, b) => budgetOrder(a) - budgetOrder(b))
  return out
}

/**
 * Pure check before starting a fork. Pass the values the new state would
 * have: the child's depth, the parent's number of children including the new
 * one, and running sessions including the new one.
 */
export function checkForkLimits(input: {
  depth: number
  fanOut: number
  runningSessions: number
  limits: Pick<EffectiveLimits, 'maxDepth' | 'maxFanOut' | 'maxConcurrentSessions'>
}): ForkCheck {
  const { limits } = input
  const checks = [
    ['maxDepth', input.depth, 'fork depth'],
    ['maxFanOut', input.fanOut, 'fan-out'],
    ['maxConcurrentSessions', input.runningSessions, 'running sessions'],
  ] as const
  for (const [field, value, what] of checks) {
    const max = limits[field]
    if (max !== undefined && value > max) return { ok: false, reason: `${what} ${value} is over the limit of ${max}`, field, max }
  }
  return { ok: true }
}

const WHOSE: Partial<Record<LimitTargetType, string>> = {
  employee: "the employee's",
  contact: "the requester's",
  global: "the whole deployment's",
}

/** "the employee's daily token budget is used up: 5,000,120 of 5,000,000 tokens today". */
export function describeBudget(
  b: Pick<BudgetStatus, 'period' | 'scope'>,
  field: 'maxTokens' | 'maxCostUsd',
  used: number,
  max: number,
) {
  const whose =
    b.period === 'run'
      ? 'the run'
      : b.period === 'session'
        ? 'the session'
        : b.period === 'tree'
          ? 'the session tree'
          : (WHOSE[b.scope ?? 'global'] ?? `the ${b.scope}'s`)
  const every = b.period === 'day' ? ' daily' : b.period === 'month' ? ' monthly' : ''
  const amount =
    field === 'maxTokens'
      ? `${Math.round(used).toLocaleString('en-US')} of ${max.toLocaleString('en-US')} tokens`
      : `$${used.toFixed(2)} of $${max.toFixed(2)}`
  const when = b.period === 'day' ? ' today (it resets at 00:00 UTC)' : b.period === 'month' ? ' this month' : ''
  return `${whose}${every} ${field === 'maxTokens' ? 'token' : 'cost'} budget is used up: ${amount}${when}`
}

function checkLimitData(d: LimitData) {
  if (!d.target || typeof d.target !== 'object' || !LIMIT_TARGETS.includes(d.target.type))
    throw new ValidationError(`target.type must be one of ${LIMIT_TARGETS.join(', ')}`)
  if (d.target.id !== undefined && (typeof d.target.id !== 'string' || !d.target.id))
    throw new ValidationError('target.id must be a non-empty string')
  if (d.period !== undefined && !LIMIT_PERIODS.includes(d.period))
    throw new ValidationError(`period must be one of ${LIMIT_PERIODS.join(', ')}`)
  for (const f of ['maxTokens', 'maxCostUsd', ...CAP_FIELDS] as const) {
    const v = d[f]
    if (v !== undefined && v !== null && (typeof v !== 'number' || v < 0 || !Number.isFinite(v)))
      throw new ValidationError(`${f} must be a non-negative number`)
  }
  if (d.target.type === 'global' && d.target.id !== undefined) throw new ValidationError('a global limit has no target id')
}

const limitKey = (d: LimitData) => `${d.target.type}:${d.target.id ?? '*'}:${d.period ?? ''}`

/** Registers the `usage` and `limit` kinds and returns the usage service. */
export function createUsage({ records, clock, pricing = {}, defaults = {}, bus }: UsageDeps): UsageService {
  records.kinds.define(usageSchema)
  records.kinds.define(limitSchema)
  const store = records.store.records
  const prices = typeof pricing === 'function' ? pricing : () => pricing
  const getDefaults = async () => (typeof defaults === 'function' ? await defaults() : defaults)

  const where = (f: UsageFilter = {}): Condition[] => {
    const out: Condition[] = []
    for (const k of FILTER_FIELDS) if (f[k] !== undefined) out.push({ field: k, op: 'eq', value: f[k]! })
    if (f.since) out.push({ field: 'at', op: 'gte', value: f.since })
    if (f.until) out.push({ field: 'at', op: 'lt', value: f.until })
    return out
  }

  const priceOf: UsageService['priceOf'] = (model) => (typeof model === 'string' ? priceFor(model, prices()) : null)

  const cost: UsageService['cost'] = (model, t) => {
    const p = priceOf(model)
    if (!p) return 0
    const cached = Math.min(t.cachedTokens ?? 0, t.promptTokens)
    const uncached = t.promptTokens - cached
    return roundUsd(
      (uncached * p.inputPerM + cached * (p.cachedInputPerM ?? p.inputPerM) + t.completionTokens * p.outputPerM) / 1e6,
    )
  }

  const totals: UsageService['totals'] = async (filter) => {
    const w = where(filter)
    const out = emptyTotals()
    for (const f of TOKEN_FIELDS) out[f] = await store.sum('usage', f, w)
    out.costUsd = roundUsd(await store.sum('usage', 'costUsd', w))
    out.calls = await store.count('usage', w)
    return out
  }

  const limits: Limits = {
    async set(input, opts = {}) {
      const { id, ...data } = input
      checkLimitData(data)
      const o = opts.actor ? { actor: opts.actor } : {}
      const key = limitKey(data)
      if (id) {
        const current = await records.require<LimitData>('limit', id)
        return records.update<LimitData>('limit', id, data, { ...o, replace: true, ...(current.key !== key ? { key } : {}) })
      }
      const existing = await records.getByKey<LimitData>('limit', key)
      if (existing) return records.update<LimitData>('limit', existing.id, data, { ...o, replace: true })
      return records.create<LimitData>('limit', data, { ...o, key })
    },
    get: (id) => records.get<LimitData>('limit', id),
    async list(filter = {}) {
      const w: Condition[] = []
      if (filter.targetType) w.push({ field: 'target.type', op: 'eq', value: filter.targetType })
      if (filter.targetId) w.push({ field: 'target.id', op: 'eq', value: filter.targetId })
      return (await records.query<LimitData>('limit', { where: w, orderBy: { field: 'createdAt' } })).items
    },
    async remove(id, opts = {}) {
      if (!(await limits.get(id))) throw new NotFoundError('limit', id)
      await records.delete('limit', id, { cascade: true, ...opts })
    },
    async matching(ctx) {
      return (await limits.list()).filter((l) => limitApplies(l.data, ctx))
    },
    defaults: getDefaults,
    async effective(ctx) {
      return mergeLimits(await limits.matching(ctx), await getDefaults())
    },
  }

  const budgetStatus: UsageService['budgetStatus'] = async (ctx) => {
    const eff = await limits.effective(ctx)
    const now = clock.now()
    const cache = new Map<string, Promise<UsageTotals>>()
    const out: BudgetStatus[] = []
    for (const b of eff.budgets) {
      let filter: UsageFilter | null
      let scopeId: string | undefined
      let since: string | undefined
      if (b.period === 'run') filter = ctx.runId ? { runId: ctx.runId } : null
      else if (b.period === 'session') filter = ctx.sessionId ? { sessionId: ctx.sessionId } : null
      else if (b.period === 'tree') filter = ctx.rootSessionId ? { rootSessionId: ctx.rootSessionId } : null
      else {
        since = b.period === 'day' ? startOfUtcDay(now) : startOfUtcMonth(now)
        const scope = b.scope ?? 'global'
        if (scope === 'global') filter = { since }
        else {
          scopeId = ctx[TARGET_FIELD[scope]]
          filter = scopeId ? { [TARGET_FIELD[scope]]: scopeId, since } : null
        }
      }
      if (!filter) continue
      const k = JSON.stringify(filter)
      if (!cache.has(k)) cache.set(k, totals(filter))
      const t = await cache.get(k)!
      out.push({
        ...b,
        ...(scopeId ? { scopeId } : {}),
        ...(since ? { since } : {}),
        used: { tokens: t.totalTokens, costUsd: t.costUsd },
      })
    }
    return out
  }

  const service: UsageService = {
    async record(input, opts = {}) {
      for (const f of [
        'promptTokens',
        'completionTokens',
        'cachedTokens',
        'reasoningTokens',
        'totalTokens',
        'costUsd',
      ] as const) {
        const v = input[f]
        if (v !== undefined && (typeof v !== 'number' || v < 0 || !Number.isFinite(v)))
          throw new ValidationError(`${f} must be a non-negative number`)
      }
      const data: UsageData = {
        ...input,
        totalTokens: input.totalTokens ?? (input.promptTokens ?? 0) + (input.completionTokens ?? 0),
        costUsd: input.costUsd ?? cost(input.model, input),
        at: input.at ?? clock.iso(),
      }
      for (const [k, v] of Object.entries(data)) if (v === undefined) delete (data as any)[k]
      const r = await records.create<UsageData>('usage', data, opts.actor ? { actor: opts.actor } : {})
      bus?.publish(USAGE_RECORDED, { id: r.id, ...r.data })
      return r
    },

    cost,
    priceOf,
    totals,

    async breakdown(groupBy, filter) {
      const { items } = await records.query<UsageData>('usage', { where: where(filter) })
      const rows = new Map<string | null, BreakdownRow>()
      for (const u of items) {
        const key = groupBy === 'day' ? u.data.at.slice(0, 10) : ((u.data[GROUP_FIELD[groupBy]] as string | undefined) ?? null)
        const row = rows.get(key) ?? { key, ...emptyTotals() }
        for (const f of TOKEN_FIELDS) row[f] += u.data[f] ?? 0
        row.costUsd = roundUsd(row.costUsd + u.data.costUsd)
        row.calls++
        rows.set(key, row)
      }
      return [...rows.values()].sort((a, b) =>
        groupBy === 'day' ? String(a.key).localeCompare(String(b.key)) : b.totalTokens - a.totalTokens || b.costUsd - a.costUsd,
      )
    },

    limits,
    budgetStatus,

    async checkBudget(ctx) {
      for (const b of await budgetStatus(ctx)) {
        for (const field of ['maxTokens', 'maxCostUsd'] as const) {
          const max = b[field]
          const used = field === 'maxTokens' ? b.used.tokens : b.used.costUsd
          if (max === undefined || used < max) continue
          return {
            ok: false,
            reason: describeBudget(b, field, used, max),
            field,
            period: b.period,
            ...(b.scope ? { scope: b.scope } : {}),
            source: b.sources[field] ?? 'default',
            max,
            used: b.used,
          }
        }
      }
      return { ok: true }
    },
  }
  return service
}
