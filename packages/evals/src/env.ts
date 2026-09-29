import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadDotEnv } from '@mp/server'

/** The model provider the evals run against. The key is only ever passed to the app, never printed. */
export interface ModelEnv {
  OPENAI_BASE_URL: string
  OPENAI_API_KEY: string
  MODEL: string
}

/** The nearest `.env` from `start` upwards, or null. */
export function findDotEnv(start?: string): string | null {
  let dir = resolve(start ?? '.')
  for (;;) {
    const p = join(dir, '.env')
    if (existsSync(p)) return p
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * Reads OPENAI_BASE_URL, OPENAI_API_KEY and MODEL from `env` (the CLI passes
 * `process.env`), falling back to a `.env` file (`path`, `DOTENV_PATH`, or the
 * nearest one upwards from `cwd`). Only those three variables are read from the
 * file, and `env` is not changed. Null when any of them is missing.
 */
export function loadModelEnv(
  opts: { path?: string | null; env?: Record<string, string | undefined>; cwd?: string } = {},
): ModelEnv | null {
  const env = opts.env ?? {}
  const file: Record<string, string | undefined> = {}
  const path = opts.path === null ? null : (opts.path ?? env.DOTENV_PATH ?? findDotEnv(opts.cwd))
  if (path) loadDotEnv(path, file)
  const get = (k: keyof ModelEnv) => env[k] || file[k] || ''
  const out: ModelEnv = { OPENAI_BASE_URL: get('OPENAI_BASE_URL'), OPENAI_API_KEY: get('OPENAI_API_KEY'), MODEL: get('MODEL') }
  return out.OPENAI_BASE_URL && out.OPENAI_API_KEY && out.MODEL ? out : null
}

/** What may be printed about the provider: its host and the model, never the key. */
export function describeModelEnv(m: ModelEnv): string {
  let host = 'provider'
  try {
    host = new URL(m.OPENAI_BASE_URL).host
  } catch {}
  return `${m.MODEL} at ${host}`
}
