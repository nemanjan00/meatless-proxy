// ─── Limits and pricing: runaway protection an admin can see and change ─────
//
// Served by packages/server/src/http/limits.ts. Admins only (reading included). The limits that
// apply are the deployment defaults (environment variables), overridden by limit records for their
// target: the whole deployment, every or one employee, every or one requester (contact).

import type { ApiRecord } from './resources.ts'

export type LimitTargetType = 'global' | 'employee' | 'contact' | 'template' | 'procedure' | 'session' | 'tree'
export type LimitPeriod = 'run' | 'session' | 'tree' | 'day' | 'month'
/** Limit fields that cap a number (not budgets). `maxConcurrentSessions` is runs working at once per employee. */
export type LimitCapField = 'maxDepth' | 'maxFanOut' | 'maxConcurrentSessions' | 'maxSteps' | 'maxWallMs' | 'maxAiStreak'

export const LIMIT_CAP_FIELDS: readonly LimitCapField[] = [
  'maxConcurrentSessions',
  'maxDepth',
  'maxFanOut',
  'maxSteps',
  'maxWallMs',
  'maxAiStreak',
]

/** A limit record: an override. A value of `null` means "no limit" (it lifts a default). */
export interface LimitData extends Record<string, unknown> {
  target: { type: LimitTargetType; id?: string }
  maxTokens?: number | null
  maxCostUsd?: number | null
  /** What maxTokens/maxCostUsd are measured over. Default: run (day for a contact, session/tree for those targets). */
  period?: LimitPeriod
  maxDepth?: number | null
  maxFanOut?: number | null
  maxConcurrentSessions?: number | null
  maxSteps?: number | null
  maxWallMs?: number | null
  maxAiStreak?: number | null
  enabled?: boolean
}

/** A budget that applies, with what has been used of it when that can be measured. */
export interface LimitBudgetView {
  /** `run`, `session`, `tree`, or `<day|month>:<scope>`, e.g. `day:employee`. */
  key: string
  period: LimitPeriod
  /** For day and month budgets: whose usage counts. */
  scope?: LimitTargetType
  maxTokens?: number
  maxCostUsd?: number
  /** Where each value comes from: a limit id, or `default`. */
  sources: { maxTokens?: string; maxCostUsd?: string }
  used?: { tokens: number; costUsd: number }
}

/** The limits that apply to one scope: every employee (the deployment), one employee, or one requester. */
export interface LimitScopeView {
  target: { type: 'global' | 'employee' | 'contact'; id?: string }
  name: string
  caps: Partial<Record<LimitCapField, number>>
  /** Where each cap comes from: a limit id, or `default`. A cap with a source but no value was lifted. */
  sources: Partial<Record<LimitCapField, string>>
  budgets: LimitBudgetView[]
}

export interface LimitsOverview {
  /** The deployment defaults from the environment. */
  defaults: Partial<Record<LimitCapField, number>> & {
    budgets: { target: LimitTargetType; period: LimitPeriod; maxTokens?: number; maxCostUsd?: number }[]
    /** Share (0–1) of a daily or monthly budget at which #alerts gets a warning. */
    warnAt?: number
  }
  /** Every limit record, oldest first. */
  overrides: ApiRecord<LimitData>[]
  /** Every employee (defaults and overrides for all), then each employee, then requesters with an override. */
  scopes: LimitScopeView[]
  /** Models used in the last 30 days (and the default model) that have no price: their cost counts as 0. */
  unpricedModels: string[]
}

/** USD per million tokens. */
export interface ModelPriceView {
  inputPerM: number
  outputPerM: number
  cachedInputPerM?: number
}

export interface PricingInfo {
  /** Edited in Settings → Pricing; wins over the others. */
  custom: Record<string, ModelPriceView>
  /** The `PRICING` environment variable. */
  env: Record<string, ModelPriceView>
  /** Prices checked on the providers' pricing pages. */
  builtin: Record<string, ModelPriceView>
  /** Models used in the last 30 days and the default model, with the price that applies and where it comes from. */
  models: { model: string; price: ModelPriceView | null; source: 'custom' | 'env' | 'builtin' | null }[]
}

/** The routes of this section (merged into `ROUTES`). */
export const LIMIT_ROUTES = {
  limits: ['GET', '/api/limits'],
  createLimit: ['POST', '/api/limits'],
  updateLimit: ['PUT', '/api/limits/:id'],
  deleteLimit: ['DELETE', '/api/limits/:id'],
  pricing: ['GET', '/api/pricing'],
  setPricing: ['PUT', '/api/pricing'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface LimitsApi {
  /** `GET /api/limits` → the defaults, the overrides and the effective limits per scope, with budget usage. Admins. */
  limits(): Promise<LimitsOverview>
  /** `POST /api/limits` → a new override (or the existing one for the same target and period, replaced). Admins. */
  createLimit(data: LimitData): Promise<ApiRecord<LimitData>>
  /** `PUT /api/limits/:id` → the override, replaced by `data`. Admins. */
  updateLimit(id: string, data: LimitData): Promise<ApiRecord<LimitData>>
  /** `DELETE /api/limits/:id`: the defaults apply again. Admins. */
  deleteLimit(id: string): Promise<void>
  /** `GET /api/pricing` → the pricing tables and the models in use. Admins. */
  pricing(): Promise<PricingInfo>
  /** `PUT /api/pricing` body `{ pricing }`: replaces the custom prices (an empty object clears them). Admins. */
  setPricing(pricing: Record<string, ModelPriceView>): Promise<PricingInfo>
}

type Call = <T>(
  route: keyof typeof LIMIT_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `LimitsApi` half of `createApiClient`. */
export function limitsMethods(call: Call): LimitsApi {
  return {
    limits: () => call('limits'),
    createLimit: (data) => call('createLimit', undefined, undefined, data),
    updateLimit: (id, data) => call('updateLimit', { id }, undefined, data),
    deleteLimit: (id) => call('deleteLimit', { id }),
    pricing: () => call('pricing'),
    setPricing: (pricing) => call('setPricing', undefined, undefined, { pricing }),
  }
}
