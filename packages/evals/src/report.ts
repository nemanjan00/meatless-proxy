import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScenarioRun } from './runner.ts'

/** One row of the report: a scenario over all its runs. */
export interface ScenarioSummary {
  scenario: string
  runs: number
  passed: number
  /** 0..1 */
  passRate: number
  avgTokens: number
  avgCachedTokens: number
  avgCostUsd: number
  avgModelCalls: number
  avgDurationMs: number
  /** The first failure's reason, if any run failed. */
  failureSample?: string
  /** How often each check failed, by name. */
  failedChecks: Record<string, number>
}

export interface EvalReport {
  startedAt: string
  finishedAt: string
  /** e.g. `kimi-k2 at api.example.com`, or `scripted`. Never the key. */
  model: string
  repeat: number
  summary: ScenarioSummary[]
  totals: { runs: number; passed: number; passRate: number; tokens: number; cachedTokens: number; costUsd: number }
  runs: ScenarioRun[]
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** Per-scenario pass rates and averages, in the order scenarios first appear. */
export function summarize(runs: ScenarioRun[]): ScenarioSummary[] {
  const groups = new Map<string, ScenarioRun[]>()
  for (const r of runs) groups.set(r.scenario, [...(groups.get(r.scenario) ?? []), r])
  return [...groups].map(([scenario, rs]) => {
    const passed = rs.filter((r) => r.pass).length
    const failedChecks: Record<string, number> = {}
    for (const r of rs) for (const c of r.checks) if (!c.pass) failedChecks[c.name] = (failedChecks[c.name] ?? 0) + 1
    const failure = rs.find((r) => !r.pass)?.failure
    return {
      scenario,
      runs: rs.length,
      passed,
      passRate: passed / rs.length,
      avgTokens: Math.round(avg(rs.map((r) => r.tokens))),
      avgCachedTokens: Math.round(avg(rs.map((r) => r.cachedTokens ?? 0))),
      avgCostUsd: avg(rs.map((r) => r.costUsd)),
      avgModelCalls: avg(rs.map((r) => r.modelCalls)),
      avgDurationMs: Math.round(avg(rs.map((r) => r.durationMs))),
      ...(failure ? { failureSample: failure } : {}),
      failedChecks,
    }
  })
}

/** Builds the full report. */
export function buildReport(
  runs: ScenarioRun[],
  meta: { startedAt: string; finishedAt: string; model: string; repeat: number },
): EvalReport {
  const passed = runs.filter((r) => r.pass).length
  return {
    ...meta,
    summary: summarize(runs),
    totals: {
      runs: runs.length,
      passed,
      passRate: runs.length ? passed / runs.length : 0,
      tokens: runs.reduce((a, r) => a + r.tokens, 0),
      cachedTokens: runs.reduce((a, r) => a + (r.cachedTokens ?? 0), 0),
      costUsd: runs.reduce((a, r) => a + r.costUsd, 0),
    },
    runs,
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The report as a text table: scenario, pass rate, avg tokens, avg duration, and a failure reason sample. */
export function formatTable(summary: ScenarioSummary[], opts: { reasonWidth?: number } = {}): string {
  const width = opts.reasonWidth ?? 90
  const rows = [
    ['scenario', 'pass', 'avg tokens', 'cached', 'avg calls', 'avg time', 'failure sample'],
    ...summary.map((s) => [
      s.scenario,
      `${pct(s.passRate)} (${s.passed}/${s.runs})`,
      String(s.avgTokens),
      s.avgTokens ? pct((s.avgCachedTokens ?? 0) / s.avgTokens) : '-',
      s.avgModelCalls.toFixed(1),
      secs(s.avgDurationMs),
      s.failureSample ? clip(s.failureSample.replace(/\s+/g, ' '), width) : '',
    ]),
  ]
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`
  const sep = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`
  return [line(rows[0]!), sep, ...rows.slice(1).map(line)].join('\n')
}

/** Writes the report as `<dir>/<timestamp>.json` and returns the path. */
export function writeResults(dir: string, report: EvalReport): string {
  mkdirSync(dir, { recursive: true })
  const name = `${report.startedAt.replace(/[:.]/g, '-')}.json`
  const path = join(dir, name)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
  return path
}
