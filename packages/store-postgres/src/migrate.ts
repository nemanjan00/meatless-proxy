import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { silentLogger, type Logger } from '@mp/core'
import type pg from 'pg'
import { ident } from './sql.ts'

/** The directory holding this package's numbered SQL migrations. */
export const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url))

export interface Migration {
  version: number
  /** File name without `.sql`, e.g. `0001_init`. */
  name: string
  sql: string
}

export interface MigrateOptions {
  pool: pg.Pool
  /** Target schema, created if missing. Defaults to `public`. */
  schema?: string
  logger?: Logger
  /** Read migrations from here instead of `migrationsDir` (for tests). */
  dir?: string
}

const FILE = /^(\d+)_([\w.-]+)\.sql$/

/** Lists the migrations in a directory, ordered by version. */
export function loadMigrations(dir: string = migrationsDir): Migration[] {
  const out = readdirSync(dir)
    .map((f) => ({ f, m: FILE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .map(({ f, m }) => ({ version: Number(m[1]), name: f.slice(0, -4), sql: readFileSync(join(dir, f), 'utf8') }))
    .sort((a, b) => a.version - b.version)
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.version === out[i - 1]!.version) throw new Error(`duplicate migration version ${out[i]!.version} in ${dir}`)
  }
  return out
}

/** Advisory lock key: one lock per schema, so different schemas migrate independently. */
const LOCK_SQL = `hashtext('mp.store-postgres.migrations'), hashtext($1)`

/**
 * Applies pending migrations, forward-only, each in its own transaction, and
 * records them in `schema_migrations`. Holds a Postgres advisory lock for the
 * whole run, so concurrent callers (several app instances starting at once)
 * wait for each other instead of racing.
 */
export async function runMigrations(opts: MigrateOptions): Promise<{ applied: string[] }> {
  const schema = opts.schema ?? 'public'
  const logger = opts.logger ?? silentLogger
  const migrations = loadMigrations(opts.dir)
  const s = ident(schema)
  const client = await opts.pool.connect()
  let broken = false
  try {
    await client.query(`select pg_advisory_lock(${LOCK_SQL})`, [schema])
    try {
      await client.query(`create schema if not exists ${s}`)
      await client.query(
        `create table if not exists ${s}.schema_migrations (
          version integer primary key,
          name text not null,
          applied_at timestamptz not null default now()
        )`,
      )
      const done = new Set(
        (await client.query<{ version: number }>(`select version from ${s}.schema_migrations`)).rows.map((r) => r.version),
      )
      const applied: string[] = []
      for (const m of migrations) {
        if (done.has(m.version)) continue
        await client.query('begin')
        try {
          await client.query(`set local search_path to ${s}, public`)
          await client.query(m.sql)
          await client.query(`insert into ${s}.schema_migrations (version, name) values ($1, $2)`, [m.version, m.name])
          await client.query('commit')
        } catch (e) {
          await client.query('rollback').catch(() => {
            broken = true
          })
          logger.error('migration failed', { schema, migration: m.name, error: e instanceof Error ? e.message : String(e) })
          throw e
        }
        logger.info('migration applied', { schema, migration: m.name })
        applied.push(m.name)
      }
      return { applied }
    } finally {
      await client.query(`select pg_advisory_unlock(${LOCK_SQL})`, [schema]).catch(() => {
        broken = true
      })
    }
  } finally {
    client.release(broken)
  }
}

/** Migrations in the directory that haven't been applied to `schema` yet. */
export async function pendingMigrations(opts: Omit<MigrateOptions, 'logger'>): Promise<string[]> {
  const s = ident(opts.schema ?? 'public')
  const all = loadMigrations(opts.dir)
  const exists = await opts.pool.query<{ t: string | null }>('select to_regclass($1) as t', [`${s}.schema_migrations`])
  if (!exists.rows[0]?.t) return all.map((m) => m.name)
  const done = new Set(
    (await opts.pool.query<{ version: number }>(`select version from ${s}.schema_migrations`)).rows.map((r) => r.version),
  )
  return all.filter((m) => !done.has(m.version)).map((m) => m.name)
}
