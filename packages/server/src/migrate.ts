import { jsonLogger } from '@mp/core'
import { runMigrations } from '@mp/store-postgres'
import pg from 'pg'
import { configFromEnv } from './env.ts'

/** Applies pending database migrations and exits (`npm run migrate`). */
const config = configFromEnv()
const log = jsonLogger(config.LOG_LEVEL, { service: 'meatless-proxy', task: 'migrate' })
if (!config.DATABASE_URL) {
  log.error('DATABASE_URL is not set: nothing to migrate')
  process.exit(1)
}
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 })
try {
  const { applied } = await runMigrations({ pool, schema: config.DATABASE_SCHEMA ?? 'public', logger: log })
  log.info(applied.length ? 'migrations applied' : 'no pending migrations', { applied })
} finally {
  await pool.end()
}
