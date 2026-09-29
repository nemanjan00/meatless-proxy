import { parseArgs } from 'node:util'
import { errorMessage } from '@mp/core'
import { configFromEnv } from './env.ts'
import { buildServices } from './services.ts'
import { exportKnowledge } from './transfer/index.ts'

/**
 * Exports the knowledge base as a folder of markdown with frontmatter:
 * `npm run export -- --out <dir> [--force]`. The folder can be imported back
 * with `npm run import -- --dir <dir>`.
 */
const { values } = parseArgs({ options: { out: { type: 'string' }, force: { type: 'boolean' } } })
if (!values.out) {
  process.stderr.write('usage: npm run export -- --out <dir> [--force]\n')
  process.exit(2)
}
const config = configFromEnv()
const services = await buildServices({ ...config, LOG_LEVEL: 'warn' }, { stdlib: false })
try {
  const r = await exportKnowledge(services, values.out, { force: values.force ?? false })
  process.stdout.write(`exported ${r.files} files to ${values.out}\n`)
} catch (e) {
  process.stderr.write(`export failed: ${errorMessage(e)}\n`)
  process.exitCode = 1
} finally {
  await services.close()
}
