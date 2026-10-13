import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { describeModelEnv, loadModelEnv } from '../env.ts'
import { ARMS, buildArchive, runArm, type BenchRun } from './context.ts'

/**
 * `npm run bench:context [-- --arms classic,managed] [--repeat N] [--concurrency N] [--window 64000] [--pages 20]`
 * Runs the context benchmark against the model from `.env`, prints a table per arm, and writes every run to
 * `packages/evals/results/context-<timestamp>.json`.
 */
const { values } = parseArgs({
  options: {
    arms: { type: 'string' },
    repeat: { type: 'string' },
    concurrency: { type: 'string' },
    window: { type: 'string' },
    pages: { type: 'string' },
    seed: { type: 'string' },
    'max-steps': { type: 'string' },
    timeout: { type: 'string' },
    'no-follow-up': { type: 'boolean' },
    source: { type: 'string' },
  },
})
const int = (v: string | undefined, def: number) => (v === undefined ? def : Number.parseInt(v, 10))
const repeat = int(values.repeat, 3)
const concurrency = int(values.concurrency, 3)
const opts = {
  window: int(values.window, 64_000),
  pages: int(values.pages, 20),
  seed: int(values.seed, 7),
  maxSteps: int(values['max-steps'], 120),
  timeoutMs: int(values.timeout, 1800) * 1000,
  followUp: !values['no-follow-up'],
  source: (values.source === 'feed' ? 'feed' : 'archive') as 'archive' | 'feed',
}
const names = (values.arms ?? ARMS.map((a) => a.name).join(',')).split(',').map((x) => x.trim())
const arms = ARMS.filter((a) => names.includes(a.name))
if (!arms.length) {
  process.stderr.write(`no such arm; arms: ${ARMS.map((a) => a.name).join(', ')}\n`)
  process.exit(2)
}
const modelEnv = loadModelEnv({ env: process.env })
if (!modelEnv) {
  process.stderr.write('the benchmark needs a real model: set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL\n')
  process.exit(2)
}
const archive = buildArchive({ seed: opts.seed, pages: opts.pages })
const chars = archive.pages.reduce((n, p) => n + p.length, 0)
process.stderr.write(
  `bench:context ${describeModelEnv(modelEnv)}, window ${opts.window}, ${opts.pages} pages (${chars.toLocaleString('en-US')} chars), ` +
    `${opts.source}, arms ${arms.map((a) => a.name).join(', ')}, repeat ${repeat}\n`,
)

const jobs = arms.flatMap((arm) => Array.from({ length: repeat }, (_, i) => ({ arm, i: i + 1 })))
const runs: BenchRun[] = []
let next = 0
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const { arm, i } = jobs[next++]!
      const r = await runArm(arm, i, { modelEnv, ...opts }, archive)
      runs.push(r)
      const f = r.followUp
      process.stderr.write(
        `  ${arm.name} #${i}: ${r.state}, ${r.score.correct}/${r.score.expected} correct, ${r.score.extra} extra, ` +
          `audit ${r.score.auditRef ? 'yes' : 'no'}, ${r.report.calls} calls, ${Math.round(r.report.promptTokens / 1000)}k prompt tokens, ` +
          `${r.report.compactions} compactions, ${r.report.collapses} collapses, ${r.report.restores} restores, ` +
          `${Math.round(r.report.durationMs / 1000)} s` +
          (f
            ? `; follow-up ${f.correct ? 'right' : 'wrong'} (${f.state}), ${f.stats.calls} calls, ` +
              `${Math.round(f.stats.promptTokens / 1000)}k tokens, ${f.stats.reads} pages re-read, ${f.stats.restores} restores`
            : '') +
          `${r.error ? ` (${r.error.slice(0, 120)})` : ''}\n`,
      )
    }
  }),
)

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const fmt = (n: number, d = 0) => n.toFixed(d)
/** The same follow-up asked of a new session: how often it was right, and its prompt tokens. */
const freshCell = (rs: BenchRun[]) => {
  const fr = rs.flatMap((r) => (r.fresh ? [r.fresh] : []))
  return fr.length
    ? `${fr.filter((x) => x.correct).length}/${fr.length}, ${fmt(mean(fr.map((x) => x.stats.promptTokens)) / 1000)}k`
    : '–'
}
const rows = arms.map((arm) => {
  const rs = runs.filter((r) => r.arm === arm.name)
  const m = (f: (r: BenchRun) => number) => mean(rs.map(f))
  const fs = rs.flatMap((r) => (r.followUp ? [r.followUp] : []))
  const mf = (f: (x: NonNullable<BenchRun['followUp']>) => number) => mean(fs.map(f))
  return [
    arm.name,
    `${fmt(
      m((r) => r.score.correct),
      1,
    )}/${archive.expected.length}`,
    fmt(
      m((r) => r.score.f1),
      2,
    ),
    `${rs.filter((r) => r.score.auditRef).length}/${rs.length}`,
    fmt(
      m((r) => r.report.calls),
      1,
    ),
    `${fmt(m((r) => r.report.promptTokens) / 1000)}k`,
    `${fmt(
      (100 * m((r) => r.report.cachedTokens)) /
        Math.max(
          1,
          m((r) => r.report.promptTokens),
        ),
    )}%`,
    `${fmt(m((r) => r.report.peakPrompt) / 1000, 1)}k`,
    fmt(
      m((r) => r.report.compactions),
      1,
    ),
    fmt(
      m((r) => r.report.collapses),
      1,
    ),
    fmt(
      m((r) => r.report.restores),
      1,
    ),
    `${fmt(m((r) => r.report.durationMs) / 1000)} s`,
    fs.length ? `${fs.filter((x) => x.correct).length}/${fs.length}` : '–',
    fs.length ? `${fmt(mf((x) => x.stats.promptTokens) / 1000)}k` : '–',
    fs.length
      ? fmt(
          mf((x) => x.stats.reads),
          1,
        )
      : '–',
    fs.length
      ? fmt(
          mf((x) => x.stats.restores),
          1,
        )
      : '–',
    freshCell(rs),
  ]
})
const head = [
  'arm',
  'correct',
  'F1',
  'audit ref',
  'calls',
  'prompt tokens',
  'cached',
  'peak prompt',
  'compactions',
  'collapses',
  'restores',
  'time',
  'follow-up right',
  'follow-up tokens',
  'pages re-read',
  'follow-up restores',
  'fresh session',
]
const table = [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n')
process.stdout.write(`${table}\n`)

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results')
mkdirSync(dir, { recursive: true })
const file = join(dir, `context-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify({ model: describeModelEnv(modelEnv), ...opts, expected: archive.expected, runs }, null, 2))
process.stderr.write(`report: ${file}\n`)
