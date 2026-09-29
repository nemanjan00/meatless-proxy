import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { describeModelEnv, loadModelEnv } from './env.ts'
import { buildReport, formatTable, writeResults } from './report.ts'
import { runEvals } from './runner.ts'
import { SCENARIOS } from './scenarios/index.ts'

/**
 * `npm run eval [-- --only <name>[,<name>…]] [--repeat N] [--concurrency N] [--timeout <s>] [--list]`
 * Runs the suite against the model from `.env` and prints a table; the full
 * report goes to `packages/evals/results/<timestamp>.json`.
 */
const { values } = parseArgs({
  options: {
    only: { type: 'string', multiple: true },
    repeat: { type: 'string' },
    concurrency: { type: 'string' },
    timeout: { type: 'string' },
    list: { type: 'boolean' },
  },
})

if (values.list) {
  for (const s of SCENARIOS) process.stdout.write(`${s.name.padEnd(18)} ${s.description}\n`)
  process.exit(0)
}

const int = (v: string | undefined, name: string, def: number) => {
  if (v === undefined) return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`--${name} must be a positive integer\n`)
    process.exit(2)
  }
  return n
}
const repeat = int(values.repeat, 'repeat', 1)
const concurrency = int(values.concurrency, 'concurrency', 1)
const timeoutMs = int(values.timeout, 'timeout', 240) * 1000
const only = (values.only ?? [])
  .flatMap((o) => o.split(','))
  .map((o) => o.trim())
  .filter(Boolean)

const modelEnv = loadModelEnv({ env: process.env })
if (!modelEnv) {
  process.stderr.write('evals need a real model: set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL (in .env or the environment)\n')
  process.exit(2)
}
const model = describeModelEnv(modelEnv)
process.stderr.write(`eval: ${model}, repeat ${repeat}${only.length ? `, only ${only.join(', ')}` : ''}\n`)

const startedAt = new Date().toISOString()
let runs: Awaited<ReturnType<typeof runEvals>>
try {
  runs = await runEvals({
    scenarios: SCENARIOS,
    only,
    repeat,
    concurrency,
    timeoutMs,
    modelEnv,
    onResult: (r) =>
      process.stderr.write(
        `  ${r.pass ? 'pass' : 'FAIL'} ${r.scenario} #${r.iteration} (${(r.durationMs / 1000).toFixed(1)} s, ${r.tokens} tokens)${r.failure ? `: ${r.failure}` : ''}\n`,
      ),
  })
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(2)
}
const report = buildReport(runs, { startedAt, finishedAt: new Date().toISOString(), model, repeat })
process.stdout.write(`\n${formatTable(report.summary)}\n\n`)
process.stdout.write(
  `total: ${report.totals.passed}/${report.totals.runs} passed, ${report.totals.tokens} tokens (${report.totals.cachedTokens} cached)${report.totals.costUsd ? `, $${report.totals.costUsd.toFixed(4)}` : ''}\n`,
)
const path = writeResults(fileURLToPath(new URL('../results', import.meta.url)), report)
process.stdout.write(`results: ${path}\n`)
process.exitCode = report.totals.passed === report.totals.runs ? 0 : 1
