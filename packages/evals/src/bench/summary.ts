import type { BenchRun, PhaseStats } from './context.ts'

/**
 * Weights for billed-equivalent tokens, as multiples of an uncached input token: cached reads cost about a
 * tenth, and output about five times as much (Claude Sonnet's list prices). Cache writes (about 1.25×) aren't
 * reported by every provider, so they're counted as plain input: the uncached part is a lower bound.
 */
export const WEIGHTS = { cached: 0.1, output: 5 }

/** What a phase cost, in uncached input tokens. */
export function billed(s: PhaseStats): number {
  const cached = Math.min(s.cachedTokens, s.promptTokens)
  return s.promptTokens - cached + WEIGHTS.cached * cached + WEIGHTS.output * s.completionTokens
}

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const k = (n: number) => `${Math.round(n / 1000)}k`
/** `108k (100k–492k)`: the median, and the range when the runs differ. */
const spread = (xs: number[]) => {
  if (!xs.length) return '–'
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  return k(lo) === k(hi) ? k(median(xs)) : `${k(median(xs))} (${k(lo)}–${k(hi)})`
}

/** One row per arm: medians with ranges, so one runaway run doesn't hide the typical one. */
export function summaryTable(arms: string[], runs: BenchRun[], expected: number): string {
  const head = [
    'arm',
    'report correct',
    'audit ref',
    'calls',
    'prompt tokens',
    'cached',
    'billed-equivalent',
    'collapses',
    'restores',
    'compactions',
    'time',
    'follow-up right',
    'follow-up billed',
    'fresh session right',
    'fresh session billed',
  ]
  const rows = arms.map((arm) => {
    const rs = runs.filter((r) => r.arm === arm)
    const n = rs.length
    const med = (f: (r: BenchRun) => number) => median(rs.map(f))
    const fs = rs.flatMap((r) => (r.followUp ? [r.followUp] : []))
    const fr = rs.flatMap((r) => (r.fresh ? [r.fresh] : []))
    const prompt = rs.reduce((a, r) => a + r.report.promptTokens, 0)
    const cached = rs.reduce((a, r) => a + r.report.cachedTokens, 0)
    return [
      arm,
      `${med((r) => r.score.correct)}/${expected} (${rs.filter((r) => r.score.correct === expected).length}/${n} runs)`,
      `${rs.filter((r) => r.score.auditRef).length}/${n}`,
      String(med((r) => r.report.calls)),
      spread(rs.map((r) => r.report.promptTokens)),
      `${Math.round((100 * cached) / Math.max(1, prompt))}%`,
      spread(rs.map((r) => billed(r.report))),
      String(med((r) => r.report.collapses)),
      String(med((r) => r.report.restores)),
      String(med((r) => r.report.compactions)),
      `${Math.round(med((r) => r.report.durationMs) / 1000)} s`,
      fs.length ? `${fs.filter((x) => x.correct).length}/${fs.length}` : '–',
      spread(fs.map((x) => billed(x.stats))),
      fr.length ? `${fr.filter((x) => x.correct).length}/${fr.length}` : '–',
      spread(fr.map((x) => billed(x.stats))),
    ]
  })
  return [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n')
}
