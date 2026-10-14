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

type Answered = {
  state: string
  correct: boolean
  right?: number
  of?: number
  invented?: number
  abstained?: number
  unanswered?: number
}

/**
 * `14/15 (1 abstained)`: incidents answered right of those asked, over the runs that finished; wrong ones split
 * into abstained and invented when the report says (older reports: runs right of runs). Harness failures are
 * left out here and counted on their own.
 */
const rightOf = (xs: Answered[]) => {
  const ok = xs.filter((x) => x.state === 'completed')
  if (!ok.length) return xs.length ? 'harness failed' : '–'
  const right = ok.reduce((a, x) => a + (x.right ?? (x.correct ? 1 : 0)), 0)
  const of = ok.reduce((a, x) => a + (x.of ?? 1), 0)
  const inv = ok.reduce((a, x) => a + (x.invented ?? 0), 0)
  const abs = ok.reduce((a, x) => a + (x.abstained ?? 0), 0)
  const una = ok.reduce((a, x) => a + (x.unanswered ?? 0), 0)
  const why = [abs ? `${abs} abstained` : '', inv ? `${inv} invented` : '', una ? `${una} unanswered` : '']
    .filter(Boolean)
    .join(', ')
  return `${right}/${of}${why ? ` (${why})` : ''}`
}
/**
 * What the reports got wrong, summed over the runs: a named incident with a wrong location or engineer (a wrong
 * value: the worse failure), one not named at all (missing), and one listed that isn't SEV1 (extra).
 */
const reportErrors = (rs: BenchRun[]) => {
  const wrong = rs.reduce((a, r) => a + r.score.wrongDetail, 0)
  const missing = rs.reduce((a, r) => a + (r.score.missing ?? r.score.expected - r.score.correct - r.score.wrongDetail), 0)
  const extra = rs.reduce((a, r) => a + r.score.extra, 0)
  const parts = [wrong ? `${wrong} wrong value` : '', missing ? `${missing} missing` : '', extra ? `${extra} extra` : '']
  return parts.filter(Boolean).join(', ') || 'none'
}

/** `2/3 runs (1 dropped the constraint's incidents)`: whether reports followed the constraint as corrected. */
const instructionsCell = (rs: BenchRun[]) => {
  const xs = rs.flatMap((r) => (r.instructions ? [r.instructions] : []))
  if (!xs.length) return '–'
  const why = [
    ['dropped', xs.reduce((n, x) => n + x.dropped, 0)],
    ['unmarked', xs.reduce((n, x) => n + x.unmarked, 0)],
    ['wrongly marked', xs.reduce((n, x) => n + x.wronglyMarked, 0)],
  ]
    .filter(([, n]) => n)
    .map(([w, n]) => `${n} ${w}`)
    .join(', ')
  return `${xs.filter((x) => x.followed).length}/${xs.length} runs${why ? ` (${why})` : ''}`
}

/** Runs the harness failed (not a wrong answer: the run itself failed). */
const failedOf = (xs: Answered[]) => String(xs.filter((x) => x.state !== 'completed').length)

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
    'report errors',
    'audit ref',
    'calls',
    'prompt tokens',
    'cached',
    'billed-equivalent',
    'collapses',
    'restores',
    'compactions',
    'retries',
    'context at end',
    'time',
    'follow-up right',
    'follow-up billed',
    'follow-up harness failures',
    'follow-ups re-read the source',
    'fuzzy follow-up right',
    'fuzzy follow-up billed',
    'instructions followed',
  ]
  const rows = arms.map((arm) => {
    const rs = runs.filter((r) => r.arm === arm)
    const n = rs.length
    const med = (f: (r: BenchRun) => number) => median(rs.map(f))
    const fs = rs.flatMap((r) => (r.followUp ? [r.followUp] : []))
    const fz = rs.flatMap((r) => (r.fuzzy ? [r.fuzzy] : []))
    const prompt = rs.reduce((a, r) => a + r.report.promptTokens, 0)
    const cached = rs.reduce((a, r) => a + r.report.cachedTokens, 0)
    return [
      arm,
      `${med((r) => r.score.correct)}/${expected} (${rs.filter((r) => r.score.correct === expected).length}/${n} runs)`,
      reportErrors(rs),
      `${rs.filter((r) => r.score.auditRef).length}/${n}`,
      String(med((r) => r.report.calls)),
      spread(rs.map((r) => r.report.promptTokens)),
      `${Math.round((100 * cached) / Math.max(1, prompt))}%`,
      spread(rs.map((r) => billed(r.report))),
      String(med((r) => r.report.collapses)),
      String(med((r) => r.report.restores)),
      String(med((r) => r.report.compactions)),
      String(rs.reduce((a, r) => a + (r.report.retries ?? 0) + (r.followUp?.stats.retries ?? 0), 0)),
      spread(rs.map((r) => r.report.endPrompt ?? 0)),
      `${Math.round(med((r) => r.report.durationMs) / 1000)} s`,
      rightOf(fs),
      spread(fs.filter((x) => x.state === 'completed').map((x) => billed(x.stats))),
      failedOf(fs),
      // A follow-up answered by reading the source again lost the detail and recovered it: on a one-time source
      // it would have been wrong.
      fs.length ? `${fs.filter((x) => x.state === 'completed' && x.stats.reads > 0).length}/${fs.length} runs` : '–',
      rightOf(fz),
      spread(fz.filter((x) => x.state === 'completed').map((x) => billed(x.stats))),
      instructionsCell(rs),
    ]
  })
  const table = [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n')
  // The fresh session doesn't depend on the arm: one baseline over every run, its range a noise floor.
  const fr = runs.flatMap((r) => (r.fresh ? [r.fresh] : []))
  const done = fr.filter((x) => x.state === 'completed')
  return fr.length
    ? `${table}\n\nFresh session (the same follow-up, from zero; any arm): ${rightOf(fr)} right, ${spread(done.map((x) => billed(x.stats)))} billed-equivalent over ${done.length} runs.`
    : table
}

/**
 * A chain of tasks, per arm and task: SEV1 rows right, the question about the earlier task, billed cost and the
 * context left at the end (medians over the runs). Whether cost per task climbs along the chain is the point.
 */
export function chainTable(arms: string[], runs: BenchRun[]): string {
  const head = [
    'arm',
    'task',
    'rows right',
    'earlier-task question',
    'billed-equivalent',
    'calls',
    'compactions',
    'collapses',
    'harness collapses',
    'context at end',
  ]
  const rows: string[][] = []
  for (const arm of arms) {
    const rs = runs.filter((r) => r.arm === arm && r.chain)
    const tasks = Math.max(0, ...rs.map((r) => r.chain!.length))
    for (let k = 0; k < tasks; k++) {
      const ts = rs.flatMap((r) => (r.chain![k] ? [r.chain![k]!] : []))
      const done = ts.filter((t) => t.state === 'completed')
      const cross = done.filter((t) => t.cross !== undefined)
      rows.push([
        arm,
        String(k + 1),
        `${done.reduce((n, t) => n + t.correct, 0)}/${done.reduce((n, t) => n + t.expected, 0)}`,
        cross.length ? `${cross.filter((t) => t.cross).length}/${cross.length}` : '–',
        spread(done.map((t) => billed(t.stats))),
        String(median(done.map((t) => t.stats.calls))),
        String(median(done.map((t) => t.stats.compactions))),
        String(median(done.map((t) => t.stats.collapses))),
        String(median(done.map((t) => t.stats.harnessCollapses ?? 0))),
        spread(done.map((t) => t.stats.endPrompt)),
      ])
    }
  }
  return [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n')
}
