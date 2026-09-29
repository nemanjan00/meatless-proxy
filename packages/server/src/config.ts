import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEgressEntry } from '@mp/containers'
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

/** A non-negative number, or undefined when unset or empty; `0` means off where the variable says so. */
const optNum = optStr.transform((v, ctx) => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) {
    ctx.addIssue({ code: 'custom', message: 'must be a non-negative number' })
    return z.NEVER
  }
  return n
})

/** A non-negative number with a default when unset or empty. */
const numOr = (def: number) => optNum.transform((v) => v ?? def)

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
  /**
   * Prefix of every Docker container and network this deployment makes (and its `mp.deployment` label): two
   * deployments on one Docker host need different ones, e.g. `mp-e2e-`. Default `mp-`.
   */
  DOCKER_NAME_PREFIX: optStr
    .transform((v) => v ?? 'mp-')
    .refine(
      (v) => /^mp-[a-z0-9-]*$/.test(v) && v.endsWith('-') && v.length <= 12,
      'must start with mp-, end with -, use a-z, 0-9 and - only, and be at most 12 characters (e.g. mp-e2e-)',
    ),
  /** Employee files: `<FILES_DIR>/<employeeId>/<path>`. Default `<DATA_DIR>/files`. */
  FILES_DIR: optStr,
  /**
   * The named Docker volume mounted at FILES_DIR (compose: `mp-files`). With it, code.run sandboxes mount
   * each employee's directory of it (volume subpaths, Docker Engine 26+) instead of copying files.
   */
  FILES_VOLUME: optStr.refine(
    (v) => v === undefined || /^mp-[A-Za-z0-9_.-]+$/.test(v),
    'must be a volume name starting with mp-',
  ),
  /** code.run: Python and Node in a sandbox container per employee. Needs DOCKER_ENABLED. */
  SANDBOX_ENABLED: bool(true),
  /** The sandbox image (docker/sandbox/Dockerfile). */
  SANDBOX_IMAGE: optStr.transform((v) => v ?? 'ghcr.io/nemanjan00/meatless-proxy-sandbox:latest'),
  /**
   * Hosts environments and code.run sandboxes may reach through the egress proxy when neither the employee's
   * network setting nor the session's project names any, comma-separated (e.g. `pypi.org,files.pythonhosted.org`).
   * Default: none, so no network.
   */
  DEFAULT_EGRESS: optStr.transform((v) =>
    (v ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  ),
  /**
   * Whether an employee's `direct` network setting gives its sandbox and environments a real network with
   * no proxy (a bridge of its own, out through the host's NAT). `false` turns every direct setting into no
   * network. Default true.
   */
  DOCKER_DIRECT_NETWORK: bool(true),
  /** The sandbox user, `uid:gid`: the same as the app's, so both can write the files volume. */
  SANDBOX_USER: optStr.transform((v) => v ?? '1000:1000').refine((v) => /^\d+:\d+$/.test(v), 'must be uid:gid'),
  SANDBOX_CPUS: z.coerce.number().positive().default(1),
  SANDBOX_MEMORY_MB: z.coerce.number().int().min(64).default(1024),
  SANDBOX_PIDS: z.coerce.number().int().min(16).default(256),
  /** Minutes a kernel (and then the container) may sit idle before it is stopped. */
  SANDBOX_IDLE_MINUTES: z.coerce.number().positive().default(15),
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
  // ── Runaway protection defaults (src/limits.ts). Settings → Limits overrides them per deployment, employee or requester. ──
  /** How deep forks may go. */
  LIMIT_MAX_DEPTH: numOr(5),
  /** Children per loop. */
  LIMIT_MAX_FAN_OUT: numOr(20),
  /** Runs of one employee working at once; more wait in the queue. */
  LIMIT_MAX_CONCURRENT_RUNS: numOr(8),
  /** Minutes of work per run before it pauses (0 = no limit). */
  LIMIT_RUN_WALL_MINUTES: numOr(30),
  /** Tokens per employee per UTC day before its new work pauses (0 = no limit). */
  LIMIT_EMPLOYEE_DAILY_TOKENS: numOr(5_000_000),
  /** USD per employee per UTC day (unset = no cost budget; it counts only models with a price). */
  LIMIT_EMPLOYEE_DAILY_COST_USD: optNum,
  /** Tokens per UTC day for the whole deployment (unset = none). */
  LIMIT_DEPLOYMENT_DAILY_TOKENS: optNum,
  /** USD per UTC day for the whole deployment (unset = none). */
  LIMIT_DEPLOYMENT_DAILY_COST_USD: optNum,
  /** Messages between employees in a thread without a person before deliveries pause. */
  LIMIT_MAX_AI_STREAK: numOr(20),
  /** Percent of a daily or monthly budget at which #alerts gets a warning (0 = no warnings). */
  BUDGET_WARN_PERCENT: numOr(80).refine((v) => v <= 100, 'must be at most 100'),
  /** max_tokens per model call (leave room for reasoning). */
  MAX_TOKENS: z.coerce.number().int().min(1).optional(),
  /**
   * Whether the model can see images (image.view): `auto` (default: what the provider's model list says,
   * else known vision model names), `true` or `false`.
   */
  MODEL_VISION: z
    .string()
    .optional()
    .transform((v) => {
      const s = (v ?? '').trim().toLowerCase()
      if (s === '' || s === 'auto') return 'auto' as const
      if (['1', 'true', 'yes', 'on'].includes(s)) return 'on' as const
      if (['0', 'false', 'no', 'off'].includes(s)) return 'off' as const
      return s
    })
    .pipe(z.enum(['auto', 'on', 'off'])),
  /** Images for the model are downscaled to this many pixels on the longest side (PNG; other types pass through). */
  MODEL_IMAGE_MAX_SIDE: z.coerce.number().int().min(64).default(1568),
  /** Images larger than this (after downscaling) aren't sent to the model. */
  MODEL_IMAGE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(5 * 1024 * 1024),
  /**
   * Saved image descriptions (one model call per image, reused everywhere): `view` (default) describes an
   * image on its first image.view, `upload` in the background when a message with images is posted,
   * `off` never. Needs a model that can see images (MODEL_VISION).
   */
  IMAGE_DESCRIBE: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().toLowerCase() || 'view')
    .pipe(z.enum(['view', 'upload', 'off'])),
  /** The model for describe calls, on the same provider. Default: MODEL. */
  IMAGE_DESCRIBE_MODEL: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  /** Chat attachments: bytes per image (PNG, JPEG, GIF, WebP). */
  CHAT_ATTACHMENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(10 * 1024 * 1024),
  /** Chat attachments per message. */
  CHAT_ATTACHMENTS_PER_MESSAGE: z.coerce.number().int().min(1).max(50).default(10),
  /** Alerts in #alerts (src/alerts.ts). */
  ALERTS_ENABLED: bool(true),
  ALERT_PAUSED_MINUTES: z.coerce.number().min(0).default(30),
  ALERT_UNAVAILABLE_COUNT: z.coerce.number().int().min(1).default(3),
  ALERT_UNAVAILABLE_MINUTES: z.coerce.number().min(0.01).default(10),
  /** First-party integrations to enable (src/integrations): comma-separated, or `none`. Default all. */
  INTEGRATIONS: optStr.transform((v) => {
    if (v === undefined) return ['slack', 'linear', 'gitlab']
    if (v === 'none') return []
    return v
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  }),
  /** Self-hosted GitLab's URL; a `GITLAB_BASE_URL` secret overrides it per employee. Default https://gitlab.com. */
  GITLAB_BASE_URL: url(['http:', 'https:']),
  /** Webhook requests per minute per client address. */
  WEBHOOK_RATE_LIMIT: z.coerce.number().int().min(1).default(300),
  // ── Sign-in (src/auth) ──
  /** The public URL people open, e.g. `https://mp.example.com`: sign-in links, the CSRF origin check, cookies. */
  PUBLIC_URL: url(['http:', 'https:']),
  /** `Secure` on the session cookie: `auto` (when served over https), `true` or `false`. */
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'auto' : v.toLowerCase()))
    .pipe(z.enum(['auto', 'true', 'false'])),
  /** Trust `x-forwarded-for` and `x-forwarded-proto` from a reverse proxy. */
  TRUST_PROXY: bool(false),
  /** Email of the admin contact the first start creates. */
  ADMIN_EMAIL: optStr,
  /** Optional OIDC sign-in: all four, or none. */
  OIDC_ISSUER: url(['http:', 'https:']),
  OIDC_CLIENT_ID: optStr,
  OIDC_CLIENT_SECRET: optStr,
  OIDC_REDIRECT_URL: url(['http:', 'https:']),
  /** A bearer token that may read `/metrics` (besides admins). */
  METRICS_TOKEN: optStr.refine((v) => v === undefined || v.length >= 16, 'must be at least 16 characters'),
  /** Domain of live previews (`<env>-<port>.<PREVIEW_DOMAIN>`): the only origins the UI may frame. */
  PREVIEW_DOMAIN: optStr.refine((v) => v === undefined || /^[a-z0-9.-]+$/i.test(v), 'must be a domain name'),
  /** The live preview listener's port (src/previews). Without PREVIEW_DOMAIN it is also the previews' origin. */
  PREVIEW_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  /**
   * The container the harness runs in (id or name), so it can join environments' preview networks.
   * Default: this host name when running in Docker (`/.dockerenv`), else none.
   */
  SELF_CONTAINER: optStr,
})

export type RawConfig = z.infer<typeof configSchema>

export interface Config extends Omit<RawConfig, 'GIT_CACHE_DIR' | 'WORKTREES_DIR' | 'MCP_SERVERS' | 'FILES_DIR'> {
  GIT_CACHE_DIR: string
  WORKTREES_DIR: string
  FILES_DIR: string
  MCP_SERVERS: McpServerEntry[]
}

/** Variables whose values must never be printed. */
export const SECRET_VARS = [
  'OPENAI_API_KEY',
  'SECRETS_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'OIDC_CLIENT_SECRET',
  'METRICS_TOKEN',
] as const

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
  const oidc = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URL'] as const
  if (oidc.some((k) => c[k]) && !oidc.every((k) => c[k]))
    issues.push(`OIDC: set all of ${oidc.join(', ')}, or none (missing ${oidc.filter((k) => !c[k]).join(', ')})`)
  const badEgress = c.DEFAULT_EGRESS.filter((e) => !parseEgressEntry(e))
  if (badEgress.length) issues.push(`DEFAULT_EGRESS: not hostname globs: ${badEgress.join(', ')}`)
  if (c.PREVIEW_PORT !== 0 && c.PREVIEW_PORT === c.PORT)
    issues.push('PREVIEW_PORT: must differ from PORT (previews need their own origin)')
  if (issues.length) throw new ConfigError(issues)
  return {
    ...c,
    GIT_CACHE_DIR: resolve(c.GIT_CACHE_DIR ?? `${c.DATA_DIR}/git`),
    WORKTREES_DIR: resolve(c.WORKTREES_DIR ?? `${c.DATA_DIR}/worktrees`),
    FILES_DIR: resolve(c.FILES_DIR ?? `${c.DATA_DIR}/files`),
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
    docker: c.DOCKER_ENABLED ? { namePrefix: c.DOCKER_NAME_PREFIX } : false,
    defaultEgress: c.DEFAULT_EGRESS.length ? c.DEFAULT_EGRESS : 'none',
    directNetwork: c.DOCKER_DIRECT_NETWORK,
    files: { dir: c.FILES_DIR, volume: c.FILES_VOLUME ?? null },
    vision: c.MODEL_VISION,
    imageDescriptions: c.IMAGE_DESCRIBE === 'off' ? 'off' : { when: c.IMAGE_DESCRIBE, model: c.IMAGE_DESCRIBE_MODEL ?? c.MODEL },
    sandbox: c.DOCKER_ENABLED && c.SANDBOX_ENABLED ? { image: c.SANDBOX_IMAGE } : 'off',
    mcpServers: c.MCP_SERVERS.map((s) => s.name),
    bootstrap: c.MP_BOOTSTRAP,
    logLevel: c.LOG_LEVEL,
    publicUrl: c.PUBLIC_URL ?? null,
    oidc: c.OIDC_ISSUER ? { issuer: c.OIDC_ISSUER, clientId: c.OIDC_CLIENT_ID } : 'off',
    metricsToken: c.METRICS_TOKEN ? 'set' : 'unset',
    previews: c.PREVIEW_DOMAIN ? { domain: c.PREVIEW_DOMAIN, port: c.PREVIEW_PORT } : { port: c.PREVIEW_PORT },
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
