import { errorMessage, type Json, type Logger } from '@mp/core'
import type { RunLimits } from '@mp/runner'
import type { Run, Session } from '@mp/sessions'
import {
  BUILTIN_PRICING,
  checkPricing,
  type DefaultBudget,
  type LimitContext,
  type LimitDefaults,
  type Pricing,
  type UsageService,
} from '@mp/usage'
import type { Config } from './config.ts'
import type { Settings } from './settings.ts'

/**
 * Runaway protection that works without configuration (docs/spec.md#configurable-limits):
 * deployment-wide defaults from the environment, which limit records (Settings → Limits)
 * override per deployment, employee or requester; and the pricing table that turns tokens
 * into dollars.
 */

/** The setting holding the pricing edited in Settings → Pricing. */
export const PRICING_SETTING = 'pricing'

/** The deployment defaults from the configuration. `0` turns a limit off where the variable allows it. */
export function limitDefaults(c: Config): LimitDefaults {
  const budgets: DefaultBudget[] = []
  const employee: DefaultBudget = { target: 'employee', period: 'day' }
  if (c.LIMIT_EMPLOYEE_DAILY_TOKENS > 0) employee.maxTokens = c.LIMIT_EMPLOYEE_DAILY_TOKENS
  if (c.LIMIT_EMPLOYEE_DAILY_COST_USD !== undefined) employee.maxCostUsd = c.LIMIT_EMPLOYEE_DAILY_COST_USD
  if (employee.maxTokens !== undefined || employee.maxCostUsd !== undefined) budgets.push(employee)
  const deployment: DefaultBudget = { target: 'global', period: 'day' }
  if (c.LIMIT_DEPLOYMENT_DAILY_TOKENS !== undefined) deployment.maxTokens = c.LIMIT_DEPLOYMENT_DAILY_TOKENS
  if (c.LIMIT_DEPLOYMENT_DAILY_COST_USD !== undefined) deployment.maxCostUsd = c.LIMIT_DEPLOYMENT_DAILY_COST_USD
  if (deployment.maxTokens !== undefined || deployment.maxCostUsd !== undefined) budgets.push(deployment)
  return {
    maxDepth: c.LIMIT_MAX_DEPTH,
    maxFanOut: c.LIMIT_MAX_FAN_OUT,
    maxConcurrentSessions: c.LIMIT_MAX_CONCURRENT_RUNS,
    maxSteps: c.MAX_STEPS,
    ...(c.LIMIT_RUN_WALL_MINUTES > 0 ? { maxWallMs: Math.round(c.LIMIT_RUN_WALL_MINUTES * 60_000) } : {}),
    maxAiStreak: c.LIMIT_MAX_AI_STREAK,
    budgets,
    warnAt: c.BUDGET_WARN_PERCENT / 100,
  }
}

/** Where the work of a run is, for the limits that apply to it. */
export function runLimitContext(run: Run, session: Session): LimitContext {
  return {
    employeeId: run.data.employeeId,
    sessionId: session.id,
    rootSessionId: run.data.rootSessionId,
    ...(run.data.requesterId ? { requesterId: run.data.requesterId } : {}),
    ...(session.data.template ? { templateId: session.data.template.id } : {}),
    ...(typeof session.data.meta?.procedureId === 'string' ? { procedureId: session.data.meta.procedureId } : {}),
  }
}

/** The runner's `limitsFor`: steps, wall clock and the employee's concurrency cap from the effective limits. */
export function runLimitsFor(usage: UsageService) {
  return async (run: Run, session: Session): Promise<RunLimits> => {
    const eff = await usage.limits.effective(runLimitContext(run, session))
    return {
      ...(eff.maxSteps !== undefined ? { maxSteps: eff.maxSteps } : {}),
      ...(eff.maxWallMs !== undefined ? { maxWallMs: eff.maxWallMs } : {}),
      ...(eff.maxConcurrentSessions !== undefined ? { maxConcurrentRuns: eff.maxConcurrentSessions } : {}),
    }
  }
}

/** The pricing tables, in the order they win. */
export interface PricingTables {
  /** Edited in Settings → Pricing (the `pricing` setting). */
  custom: Pricing
  /** The `PRICING` variable. */
  env: Pricing
  /** Prices checked on the providers' pages (`@mp/usage`). */
  builtin: Pricing
}

/**
 * The current pricing: Settings → Pricing, then `PRICING`, then the built-in table. Reads are
 * synchronous (the usage ledger prices every call); the setting is loaded at start, after every
 * change through `set`, and again when it is older than `refreshMs` (another instance may have changed it).
 */
export class PricingStore {
  private customTable: Pricing = {}
  private loadedAt = 0
  private loading: Promise<void> | null = null

  constructor(
    private readonly deps: { settings: Settings; env?: Pricing; logger: Logger; now: () => number },
    private readonly refreshMs = 60_000,
  ) {}

  /** The merged table the ledger uses. */
  current(): Pricing {
    if (this.deps.now() - this.loadedAt > this.refreshMs) void this.load()
    return { ...BUILTIN_PRICING, ...(this.deps.env ?? {}), ...this.customTable }
  }

  tables(): PricingTables {
    return { custom: { ...this.customTable }, env: { ...(this.deps.env ?? {}) }, builtin: { ...BUILTIN_PRICING } }
  }

  /** Reads the setting again. A broken value is ignored (and logged). */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const v = await this.deps.settings.get(PRICING_SETTING)
        this.customTable = v === undefined || v === null ? {} : checkPricing(v)
      } catch (err) {
        this.deps.logger.warn('the pricing setting is invalid; ignoring it', { err: errorMessage(err) })
      } finally {
        this.loadedAt = this.deps.now()
        this.loading = null
      }
    })()
    return this.loading
  }

  /** Replaces the custom prices (validated; throws with a message naming the problem). */
  async set(value: unknown, actor?: Parameters<Settings['set']>[2]): Promise<Pricing> {
    const table = checkPricing(value)
    await this.deps.settings.set(PRICING_SETTING, table as unknown as Json, actor)
    this.customTable = table
    this.loadedAt = this.deps.now()
    return table
  }
}
