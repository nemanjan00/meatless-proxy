import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { describeModelEnv, loadModelEnv } from '../env.ts'
import { scoreAnswer } from './archive.ts'
import { ARMS, buildArchive, runArm, type BenchRun } from './context.ts'
import { chainTable, summaryTable } from './summary.ts'

/**
 * `npm run bench:context [-- --arms classic,managed] [--repeat N] [--concurrency N] [--window 64000] [--pages 20] [--source feed]`
 * `npm run bench:context -- --summarize packages/evals/results/context-<timestamp>.json` re-prints a saved report's table.
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
    summarize: { type: 'string' },
    severe: { type: 'string' },
    'follow-ups': { type: 'string' },
    'fuzzy-follow-ups': { type: 'string' },
    chain: { type: 'string' },
    instructions: { type: 'boolean' },
  },
})
if (values.summarize) {
  // Re-print the table of a saved report (e.g. after changing how it's summarised).
  const saved = JSON.parse(readFileSync(values.summarize, 'utf8')) as {
    runs: BenchRun[]
    expected: string[]
    seed?: number
    pages?: number
    severe?: number
  }
  // Score the saved answers again with the current scorer, on the same archive.
  const again = buildArchive({ seed: saved.seed ?? 7, pages: saved.pages ?? 20, severe: saved.severe ?? saved.expected.length })
  if (JSON.stringify(again.expected) === JSON.stringify(saved.expected))
    for (const r of saved.runs) r.score = scoreAnswer(again, r.answer)
  const names = [...new Set(saved.runs.map((r) => r.arm))]
  const chained = saved.runs.some((r) => r.chain)
  process.stdout.write(`${chained ? chainTable(names, saved.runs) : summaryTable(names, saved.runs, saved.expected.length)}\n`)
  process.exit(0)
}
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
  severe: int(values.severe, 12),
  followUps: int(values['follow-ups'], 1),
  fuzzyFollowUps: int(values['fuzzy-follow-ups'], 0),
  chain: int(values.chain, 0),
  instructions: !!values.instructions,
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
/** The code the runs used: the commit, and whether the working tree had changes on top of it. */
const git = (...args: string[]) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const code = { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'packages').length > 0 }
// A chain has five pages per task and no corrections, so each task's answer stays within its own pages.
const archive = opts.chain
  ? buildArchive({ seed: opts.seed, pages: opts.chain * 5, severe: opts.severe, corrections: false })
  : buildArchive({ seed: opts.seed, pages: opts.pages, severe: opts.severe })
const chars = archive.pages.reduce((n, p) => n + p.length, 0)
process.stderr.write(
  `bench:context at ${code.commit.slice(0, 7)}${code.dirty ? ' (with uncommitted changes)' : ''}, ${describeModelEnv(modelEnv)}, window ${opts.window}, ${archive.pages.length} pages (${chars.toLocaleString('en-US')} chars), ` +
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

const armNames = arms.map((a) => a.name)
process.stdout.write(`${opts.chain ? chainTable(armNames, runs) : summaryTable(armNames, runs, archive.expected.length)}\n`)

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results')
mkdirSync(dir, { recursive: true })
const file = join(dir, `context-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(
  file,
  `${JSON.stringify({ model: describeModelEnv(modelEnv), code, ...opts, expected: archive.expected, runs }, null, 2)}\n`,
)
process.stderr.write(`report: ${file}\n`)
