import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

/**
 * All configuration, from environment variables (and `.env` in development).
 * Validated once at startup; an invalid value stops startup with a message
 * naming the variable. Secret values are never included in messages.
 */

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def
      if (typeof v === 'boolean') return v
      const s = v.trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(s)) return true
      if (['0', 'false', 'no', 'off'].includes(s)) return false
      ctx.addIssue({ code: 'custom', message: 'must be true/false (or 1/0, yes/no, on/off)' })
      return z.NEVER
    })

const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))

const url = (protocols: string[]) =>
  optStr.refine(
    (v) => {
      if (v === undefined) return true
      try {
        return protocols.includes(new URL(v).protocol)
      } catch {
        return false
      }
    },
    `must be a URL (${protocols.join(' or ')})`,
  )

/** Per-server mapping of MCP notifications to events. */
const mcpEventMapping = z.object({
  /** The notification method, e.g. `notifications/resources/updated`. `*` matches every method. */
  method: z.string().min(1),
  /** Event type; defaults to the method. */
  type: z.string().optional(),
  /** Dot path into params for the subject id, e.g. `uri` or `issue.identifier`. */
  subjectFrom: z.string().optional(),
  /** The subject's system; defaults to the server name. */
  subjectSystem: z.string().optional(),
  /** Dot path into params for a stable external id (used for the dedupe key). */
  idFrom: z.string().optional(),
  /** Dot path into params for the actor's handle in `subjectSystem` (resolved to a contact). */
  actorFrom: z.string().optional(),
  /** Dot path into params for a short text shown to the model. */
  textFrom: z.string().optional(),
})

export const mcpServerSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, _ and - only'),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  /** Effect class of the server's tools, default `non_idempotent`; per tool with `effects`. */
  effect: z.enum(['read', 'idempotent', 'non_idempotent']).optional(),
  effects: z.record(z.string(), z.enum(['read', 'idempotent', 'non_idempotent'])).optional(),
  /** Mapping of notifications to events. Unmapped notifications still become events. */
  events: z.array(mcpEventMapping).optional(),
  /** Employee whose triggers handle this server's events. */
  employee: z.string().optional(),
})

export type McpServerEntry = z.infer<typeof mcpServerSchema>
export type McpEventMapping = z.infer<typeof mcpEventMapping>

const priceSchema = z.object({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  cachedInputPerM: z.number().nonnegative().optional(),
})

const jsonOrFile = (what: string) =>
  optStr.transform((v, ctx) => {
    if (v === undefined) return undefined
    let text = v
    if (!v.startsWith('[') && !v.startsWith('{')) {
      const path = resolve(v)
      if (!existsSync(path)) {
        ctx.addIssue({ code: 'custom', message: `${what}: not JSON, and no file at ${path}` })
        return z.NEVER
      }
      text = readFileSync(path, 'utf8')
    }
    try {
      return JSON.parse(text) as unknown
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `${what}: invalid JSON (${e instanceof Error ? e.message : String(e)})` })
      return z.NEVER
    }
  })

export const configSchema = z.object({
  NODE_ENV: optStr,
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: optStr.transform((v) => v ?? '0.0.0.0'),
  DATABASE_URL: url(['postgres:', 'postgresql:']),
  /** Postgres schema holding the tables. Default `public`. */
  DATABASE_SCHEMA: optStr.refine((v) => v === undefined || /^[a-z_][a-z0-9_]*$/.test(v), 'must be a plain identifier'),
  REDIS_URL: url(['redis:', 'rediss:']),
  /** Redis key prefix for the queues. Default `mp`. */
  REDIS_PREFIX: optStr,
  OPENAI_BASE_URL: url(['http:', 'https:']),
  OPENAI_API_KEY: optStr,
  MODEL: optStr,
  SECRETS_KEY: optStr.refine((v) => v === undefined || v.length >= 16, 'must be at least 16 characters'),
  DATA_DIR: optStr.transform((v) => resolve(v ?? './.data/app')),
  GIT_CACHE_DIR: optStr,
  WORKTREES_DIR: optStr,
  DOCKER_ENABLED: bool(false),
  DOCKER_SOCKET: optStr,
  MCP_SERVERS: jsonOrFile('MCP_SERVERS').pipe(z.array(mcpServerSchema).optional()),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'info' : v.toLowerCase()))
    .pipe(z.enum(['debug', 'info', 'warn', 'error'])),
  MP_BOOTSTRAP: bool(true),
  MP_WEB_DIST: optStr,
  PRICING: jsonOrFile('PRICING').pipe(z.record(z.string(), priceSchema).optional()),
  /** Runs executed at once in this process. */
  RUN_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(4),
  /** Attempts per run job (retries for unavailable providers). */
  RUN_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  /** Base backoff between run job attempts, doubled each time. */
  RUN_BACKOFF_MS: z.coerce.number().int().min(0).default(2000),
  /** Model calls per run before it pauses. */
  MAX_STEPS: z.coerce.number().int().min(1).default(60),
  /** max_tokens per model call (leave room for reasoning). */
  MAX_TOKENS: z.coerce.number().int().min(1).optional(),
  /** Alerts in #alerts (src/alerts.ts). */
  ALERTS_ENABLED: bool(true),
  ALERT_PAUSED_MINUTES: z.coerce.number().min(0).default(30),
  ALERT_UNAVAILABLE_COUNT: z.coerce.number().int().min(1).default(3),
  ALERT_UNAVAILABLE_MINUTES: z.coerce.number().min(0.01).default(10),
})

export type RawConfig = z.infer<typeof configSchema>

export interface Config extends Omit<RawConfig, 'GIT_CACHE_DIR' | 'WORKTREES_DIR' | 'MCP_SERVERS'> {
  GIT_CACHE_DIR: string
  WORKTREES_DIR: string
  MCP_SERVERS: McpServerEntry[]
}

/** Variables whose values must never be printed. */
export const SECRET_VARS = ['OPENAI_API_KEY', 'SECRETS_KEY', 'DATABASE_URL', 'REDIS_URL'] as const

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

/** Parses and validates configuration. Throws `ConfigError` listing every problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const res = configSchema.safeParse(env)
  if (!res.success) {
    throw new ConfigError(res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  const c = res.data
  const issues: string[] = []
  if (c.OPENAI_API_KEY && !c.OPENAI_BASE_URL) issues.push('OPENAI_BASE_URL: required when OPENAI_API_KEY is set')
  if (c.OPENAI_BASE_URL && !c.MODEL) issues.push('MODEL: required when OPENAI_BASE_URL is set')
  if (c.DATABASE_URL && !c.SECRETS_KEY) issues.push('SECRETS_KEY: required with DATABASE_URL (it encrypts stored secrets)')
  const names = new Set<string>()
  for (const s of c.MCP_SERVERS ?? []) {
    if (names.has(s.name)) issues.push(`MCP_SERVERS: duplicate server name ${s.name}`)
    names.add(s.name)
    if (s.transport === 'stdio' && !s.command) issues.push(`MCP_SERVERS: ${s.name} (stdio) needs a command`)
    if (s.transport === 'http' && !s.url) issues.push(`MCP_SERVERS: ${s.name} (http) needs a url`)
  }
  if (issues.length) throw new ConfigError(issues)
  return {
    ...c,
    GIT_CACHE_DIR: resolve(c.GIT_CACHE_DIR ?? `${c.DATA_DIR}/git`),
    WORKTREES_DIR: resolve(c.WORKTREES_DIR ?? `${c.DATA_DIR}/worktrees`),
    MCP_SERVERS: c.MCP_SERVERS ?? [],
  }
}

/** A summary of the configuration that is safe to log: secret values are replaced by whether they are set. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    port: c.PORT,
    host: c.HOST,
    store: c.DATABASE_URL ? `postgres (schema ${c.DATABASE_SCHEMA ?? 'public'})` : 'memory',
    queue: c.REDIS_URL ? `bullmq (prefix ${c.REDIS_PREFIX ?? 'mp'})` : 'memory',
    model: c.OPENAI_BASE_URL
      ? { baseUrl: c.OPENAI_BASE_URL, model: c.MODEL, apiKey: c.OPENAI_API_KEY ? 'set' : 'unset' }
      : 'none',
    secretsKey: c.SECRETS_KEY ? 'set' : 'ephemeral',
    dataDir: c.DATA_DIR,
    docker: c.DOCKER_ENABLED,
    mcpServers: c.MCP_SERVERS.map((s) => s.name),
    bootstrap: c.MP_BOOTSTRAP,
    logLevel: c.LOG_LEVEL,
  }
}

/**
 * A tiny `.env` loader (no dependency): `KEY=value` lines, `#` comments,
 * optional `export `, single or double quotes. Existing variables win.
 * Returns the names it set.
 */
export function loadDotEnv(path = '.env', env: Record<string, string | undefined> = process.env): string[] {
  if (!existsSync(path)) return []
  const set: string[] = []
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!
    let value = m[2]!
    const q = value[0]
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) {
      value = value.slice(1, -1)
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      const hash = value.search(/\s#/)
      if (hash >= 0) value = value.slice(0, hash).trimEnd()
    }
    if (env[key] !== undefined) continue
    env[key] = value
    set.push(key)
  }
  return set
}
