import { errorMessage } from '@mp/core'
import type { ModelClient } from '@mp/model'
import { startEvalApp, type EvalAppOptions } from './app.ts'
import type { ModelEnv } from './env.ts'
import type { CheckResult, Scenario } from './types.ts'

/** One scenario run once, in its own app. */
export interface ScenarioRun {
  scenario: string
  /** 1-based repetition. */
  iteration: number
  pass: boolean
  checks: (CheckResult & { name: string })[]
  /** Why it failed: the first failing check, or the error. */
  failure?: string
  /** Setup, act or settle failed (the checks still ran, when the app got that far). */
  error?: string
  tokens: number
  costUsd: number
  modelCalls: number
  /** From the request to the runs settling. */
  durationMs: number
}

export interface RunOptions {
  scenarios: Scenario[]
  /** Only these scenario names. Unknown names are an error. */
  only?: string[]
  /** Runs per scenario (default 1). */
  repeat?: number
  /** A fresh model client per run (unit tests: a scripted model). Otherwise `modelEnv` is used. */
  model?: (scenario: Scenario, iteration: number) => ModelClient
  modelEnv?: ModelEnv | null
  /** Settle timeout per scenario (ms), unless the scenario sets its own. */
  timeoutMs?: number
  /** Scenarios run at the same time (default 1). */
  concurrency?: number
  maxSteps?: number
  /** Called after each run, e.g. to print progress. */
  onResult?: (r: ScenarioRun) => void
  /** Wall-clock source (tests). */
  now?: () => number
}

/** The scenarios `only` selects, in suite order. */
export function selectScenarios(all: Scenario[], only?: string[]): Scenario[] {
  if (!only?.length) return all
  const names = new Set(all.map((s) => s.name))
  const unknown = only.filter((n) => !names.has(n))
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')}; known: ${[...names].join(', ')}`)
  return all.filter((s) => only.includes(s.name))
}

/** Runs one scenario once: a fresh app, setup, act, settle, then every check. Never throws. */
export async function runScenario(
  scenario: Scenario,
  iteration: number,
  opts: Omit<RunOptions, 'scenarios' | 'only' | 'repeat' | 'onResult'> = {},
): Promise<ScenarioRun> {
  const now = opts.now ?? Date.now
  const result: ScenarioRun = {
    scenario: scenario.name,
    iteration,
    pass: false,
    checks: [],
    tokens: 0,
    costUsd: 0,
    modelCalls: 0,
    durationMs: 0,
  }
  const appOpts: EvalAppOptions = {
    ...(opts.model ? { model: opts.model(scenario, iteration) } : { modelEnv: opts.modelEnv ?? null }),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
  }
  let app: Awaited<ReturnType<typeof startEvalApp>> | null = null
  try {
    app = await startEvalApp(appOpts)
    const ctx = app.ctx
    await scenario.setup(ctx)
    const started = now()
    try {
      await scenario.act(ctx)
      await ctx.settle(scenario.timeoutMs ?? opts.timeoutMs)
    } catch (e) {
      result.error = errorMessage(e)
    }
    result.durationMs = now() - started
    for (const check of scenario.checks) {
      try {
        const r = await check.run(ctx)
        result.checks.push({ name: check.name, pass: r.pass, reason: r.reason })
      } catch (e) {
        result.checks.push({ name: check.name, pass: false, reason: `check threw: ${errorMessage(e)}` })
      }
    }
    const u = await ctx.usage()
    result.tokens = u.totalTokens
    result.costUsd = u.costUsd
    result.modelCalls = u.calls
  } catch (e) {
    result.error = errorMessage(e)
  } finally {
    await app?.close()
  }
  const failed = result.checks.find((c) => !c.pass)
  result.pass = !result.error && result.checks.length === scenario.checks.length && !failed
  if (!result.pass) result.failure = result.error ?? (failed ? `${failed.name}: ${failed.reason}` : 'no checks ran')
  return result
}

/** Runs every selected scenario `repeat` times, each in its own app, and returns the runs in suite order. */
export async function runEvals(opts: RunOptions): Promise<ScenarioRun[]> {
  const scenarios = selectScenarios(opts.scenarios, opts.only)
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1))
  const jobs = scenarios.flatMap((s) => Array.from({ length: repeat }, (_, i) => ({ s, i: i + 1 })))
  const results: ScenarioRun[] = new Array(jobs.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const j = next++
      if (j >= jobs.length) return
      const { s, i } = jobs[j]!
      const r = await runScenario(s, i, opts)
      results[j] = r
      opts.onResult?.(r)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, jobs.length)) }, worker))
  return results
}
