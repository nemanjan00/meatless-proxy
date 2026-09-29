import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { runMigrations } from './migrate.ts'
import { ident } from './sql.ts'

export interface TestSchema {
  schema: string
  /** Drops the schema and everything in it. */
  drop(): Promise<void>
}

/**
 * Creates and migrates a fresh, uniquely named schema, for tests that share
 * one database with other test runs. Drop it when done.
 */
export async function createTestSchema(pool: pg.Pool, prefix = 'mp_test'): Promise<TestSchema> {
  const schema = `${prefix}_${randomBytes(6).toString('hex')}`
  await runMigrations({ pool, schema })
  return {
    schema,
    drop: async () => {
      await pool.query(`drop schema if exists ${ident(schema)} cascade`)
    },
  }
}
