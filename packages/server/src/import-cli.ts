import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { errorMessage } from '@mp/core'
import { configFromEnv } from './env.ts'
import { buildServices } from './services.ts'
import { applyImport, formatApplyResult, formatPlan, planImport, readTree, type ImportSource } from './transfer/index.ts'

/**
 * Imports knowledge from an export folder and/or CSV files:
 * `npm run import -- [--dir <folder>] [--contacts <file.csv>] [--projects <file.csv>] [--dry-run] [--strict] [--verbose]`.
 * `--dry-run` prints the plan and changes nothing. Invalid rows are reported and
 * skipped; with `--strict` any error stops the import before anything is written.
 */
const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    contacts: { type: 'string' },
    projects: { type: 'string' },
    'dry-run': { type: 'boolean' },
    strict: { type: 'boolean' },
    verbose: { type: 'boolean' },
  },
})
if (!values.dir && !values.contacts && !values.projects) {
  process.stderr.write(
    'usage: npm run import -- [--dir <folder>] [--contacts <file.csv>] [--projects <file.csv>] [--dry-run] [--strict] [--verbose]\n',
  )
  process.exit(2)
}
const source: ImportSource = {
  ...(values.dir ? { tree: readTree(values.dir) } : {}),
  ...(values.contacts ? { contactsCsv: readFileSync(values.contacts, 'utf8') } : {}),
  ...(values.projects ? { projectsCsv: readFileSync(values.projects, 'utf8') } : {}),
  names: {
    ...(values.contacts ? { contacts: basename(values.contacts) } : {}),
    ...(values.projects ? { projects: basename(values.projects) } : {}),
  },
}
const config = configFromEnv()
const services = await buildServices({ ...config, LOG_LEVEL: 'warn' }, { stdlib: false })
try {
  const plan = await planImport(services, source)
  process.stdout.write(formatPlan(plan, { verbose: values.verbose ?? false }))
  if (values['dry-run']) process.stdout.write('dry run: nothing was changed\n')
  else if (values.strict && plan.errors.length) {
    process.stderr.write('--strict: the plan has errors, nothing was changed\n')
    process.exitCode = 1
  } else {
    const r = await applyImport(services, plan, { strict: values.strict ?? false })
    process.stdout.write(formatApplyResult(r))
    if (r.errors.length) process.exitCode = 1
  }
} catch (e) {
  process.stderr.write(`import failed: ${errorMessage(e)}\n`)
  process.exitCode = 1
} finally {
  await services.close()
}
