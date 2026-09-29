import { NotFoundError, ValidationError, type Clock, type EventBus, type KindSchema } from '@mp/core'
import type { Records } from '@mp/records'
import type { Actor, Condition, StoredRecord } from '@mp/store'

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

export const LIMIT_TARGETS = ['global', 'employee', 'template', 'procedure', 'session', 'tree'] as const
export const LIMIT_PERIODS = ['run', 'session', 'tree', 'day', 'month'] as const
export type LimitTargetType = (typeof LIMIT_TARGETS)[number]
export type LimitPeriod = (typeof LIMIT_PERIODS)[number]

export const limitSchema: KindSchema = {
  kind: 'limit',
  prefix: 'lim',
  description: 'A configurable limit: global, or tightened per employee, template, procedure, session or tree.',
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
      description: 'What maxTokens/maxCostUsd are measured over. day/month: the employee since the start of the UTC day/month.',
    },
    { name: 'maxDepth', type: 'number', description: 'Fork depth.' },
    { name: 'maxFanOut', type: 'number', description: 'Children per loop.' },
    { name: 'maxConcurrentSessions', type: 'number' },
    { name: 'maxWallMs', type: 'number' },
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

export interface ModelPrice {
  /** USD per million uncached input tokens. */
  inputPerM: number
  /** USD per million output tokens. */
  outputPerM: number
  /** USD per million cached input tokens. Defaults to `inputPerM`. */
  cachedInputPerM?: number
}

export type Pricing = Record<string, ModelPrice>

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

export interface LimitData extends Record<string, unknown> {
  target: { type: LimitTargetType; id?: string }
  maxTokens?: number
  maxCostUsd?: number
  period?: LimitPeriod
  maxDepth?: number
  maxFanOut?: number
  maxConcurrentSessions?: number
  maxWallMs?: number
  maxAiStreak?: number
  enabled?: boolean
}

export type Limit = StoredRecord<LimitData>

/** Where the work is, to find the limits that apply. */
export interface LimitContext {
  employeeId?: string
  sessionId?: string
  rootSessionId?: string
  templateId?: string
  procedureId?: string
}

export interface BudgetContext extends LimitContext {
  runId?: string
}

export interface Budget {
  maxTokens?: number
  maxCostUsd?: number
}

/** The tightest value of each field across the limits that apply. */
export interface EffectiveLimits {
  maxDepth?: number
  maxFanOut?: number
  maxConcurrentSessions?: number
  maxWallMs?: number
  maxAiStreak?: number
  budgets: Partial<Record<LimitPeriod, Budget>>
  /** Ids of the limits that were merged. */
  limitIds: string[]
}

export type BudgetCheck =
  | { ok: true }
  | {
      ok: false
      reason: string
      field: 'maxTokens' | 'maxCostUsd'
      period: LimitPeriod
      limit: Limit
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
  effective(ctx: LimitContext): Promise<EffectiveLimits>
}

export interface UsageService {
  record(input: UsageInput, opts?: { actor?: Actor }): Promise<UsageRecord>
  /** Cost of a call from the pricing table, 0 for unknown models. */
  cost(model: string, tokens: { promptTokens: number; completionTokens: number; cachedTokens?: number }): number
  totals(filter?: UsageFilter): Promise<UsageTotals>
  /** Totals per group, most tokens first. */
  breakdown(groupBy: GroupBy, filter?: UsageFilter): Promise<BreakdownRow[]>
  limits: Limits
  /** Whether the token and cost budgets that apply still have room. Returns the first one reached. */
  checkBudget(ctx: BudgetContext): Promise<BudgetCheck>
}

export interface UsageDeps {
  records: Records
  clock: Clock
  pricing?: Pricing
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

const TOKEN_FIELDS = ['promptTokens', 'completionTokens', 'cachedTokens', 'reasoningTokens', 'totalTokens'] as const
const NUMERIC_LIMIT_FIELDS = ['maxDepth', 'maxFanOut', 'maxConcurrentSessions', 'maxWallMs', 'maxAiStreak'] as const

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
  return target === 'session' ? 'session' : target === 'tree' ? 'tree' : 'run'
}

/** Whether a limit's target covers the context. A target without an id covers every one of its type. */
export function limitApplies(l: LimitData, ctx: LimitContext): boolean {
  if (l.enabled === false) return false
  const ctxId: Record<LimitTargetType, string | undefined> = {
    global: 'global',
    employee: ctx.employeeId,
    template: ctx.templateId,
    procedure: ctx.procedureId,
    session: ctx.sessionId,
    tree: ctx.rootSessionId,
  }
  const have = ctxId[l.target.type]
  if (l.target.type === 'global') return true
  if (!have) return false
  return l.target.id === undefined || l.target.id === have
}

/** Merges limits: the tightest value of each field, and of each period's budget. */
export function mergeLimits(limits: Limit[]): EffectiveLimits {
  const out: EffectiveLimits = { budgets: {}, limitIds: [] }
  const min = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b))
  for (const l of limits) {
    out.limitIds.push(l.id)
    for (const f of NUMERIC_LIMIT_FIELDS) {
      const v = min(out[f], l.data[f])
      if (v !== undefined) out[f] = v
    }
    if (l.data.maxTokens !== undefined || l.data.maxCostUsd !== undefined) {
      const p = l.data.period ?? defaultPeriod(l.data.target.type)
      const b = out.budgets[p] ?? {}
      const t = min(b.maxTokens, l.data.maxTokens)
      const c = min(b.maxCostUsd, l.data.maxCostUsd)
      out.budgets[p] = { ...(t !== undefined ? { maxTokens: t } : {}), ...(c !== undefined ? { maxCostUsd: c } : {}) }
    }
  }
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
  limits: EffectiveLimits
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

function checkLimitData(d: LimitData) {
  for (const f of ['maxTokens', 'maxCostUsd', ...NUMERIC_LIMIT_FIELDS] as const) {
    const v = d[f]
    if (v !== undefined && (typeof v !== 'number' || v < 0 || !Number.isFinite(v)))
      throw new ValidationError(`${f} must be a non-negative number`)
  }
  if (d.target?.type === 'global' && d.target.id !== undefined) throw new ValidationError('a global limit has no target id')
}

const limitKey = (d: LimitData) => `${d.target.type}:${d.target.id ?? '*'}:${d.period ?? ''}`

/** Registers the `usage` and `limit` kinds and returns the usage service. */
export function createUsage({ records, clock, pricing = {}, bus }: UsageDeps): UsageService {
  records.kinds.define(usageSchema)
  records.kinds.define(limitSchema)
  const store = records.store.records

  const where = (f: UsageFilter = {}): Condition[] => {
    const out: Condition[] = []
    for (const k of FILTER_FIELDS) if (f[k] !== undefined) out.push({ field: k, op: 'eq', value: f[k]! })
    if (f.since) out.push({ field: 'at', op: 'gte', value: f.since })
    if (f.until) out.push({ field: 'at', op: 'lt', value: f.until })
    return out
  }

  const cost: UsageService['cost'] = (model, t) => {
    const p = pricing[model]
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
    async effective(ctx) {
      return mergeLimits(await limits.matching(ctx))
    },
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

    async checkBudget(ctx) {
      const cache = new Map<LimitPeriod, Promise<UsageTotals> | null>()
      const usedFor = (period: LimitPeriod): Promise<UsageTotals> | null => {
        if (cache.has(period)) return cache.get(period)!
        const now = clock.now()
        const filter: UsageFilter | null =
          period === 'run'
            ? ctx.runId
              ? { runId: ctx.runId }
              : null
            : period === 'session'
              ? ctx.sessionId
                ? { sessionId: ctx.sessionId }
                : null
              : period === 'tree'
                ? ctx.rootSessionId
                  ? { rootSessionId: ctx.rootSessionId }
                  : null
                : ctx.employeeId
                  ? { employeeId: ctx.employeeId, since: period === 'day' ? startOfUtcDay(now) : startOfUtcMonth(now) }
                  : null
        const p = filter ? totals(filter) : null
        cache.set(period, p)
        return p
      }
      for (const l of await limits.matching(ctx)) {
        if (l.data.maxTokens === undefined && l.data.maxCostUsd === undefined) continue
        const period = l.data.period ?? defaultPeriod(l.data.target.type)
        const pending = usedFor(period)
        if (!pending) continue
        const t = await pending
        const used = { tokens: t.totalTokens, costUsd: t.costUsd }
        if (l.data.maxTokens !== undefined && t.totalTokens >= l.data.maxTokens)
          return {
            ok: false,
            reason: `${period} token budget reached: ${t.totalTokens} of ${l.data.maxTokens}`,
            field: 'maxTokens',
            period,
            limit: l,
            used,
          }
        if (l.data.maxCostUsd !== undefined && t.costUsd >= l.data.maxCostUsd)
          return {
            ok: false,
            reason: `${period} cost budget reached: $${t.costUsd} of $${l.data.maxCostUsd}`,
            field: 'maxCostUsd',
            period,
            limit: l,
            used,
          }
      }
      return { ok: true }
    },
  }
  return service
}
