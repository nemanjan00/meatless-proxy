import { type KindSchema, ValidationError } from '@mp/core'
import { z } from 'zod'
import { mcpServerSchema } from '../config.ts'

/** Record kind of MCP servers added at runtime. */
export const MCP_SERVER_KIND = 'mcp_server'
/** Record kind of OAuth sign-ins in progress (the key is the sha256 of the `state`). */
export const MCP_OAUTH_STATE_KIND = 'mcp_oauth_state'

export type McpEffect = 'read' | 'idempotent' | 'non_idempotent'

export type McpServerAuth =
  | { type: 'none' }
  | { type: 'token'; header?: string; prefix?: string; secret: string }
  | { type: 'oauth'; scopes?: string[]; clientId?: string; clientSecretSecret?: string; authorizationServer?: string }

/** What an `mcp_server` record holds. No secret values: tokens and OAuth credentials are in the secret store. */
export interface McpServerData extends Record<string, unknown> {
  name: string
  transport: 'http'
  url: string
  headers?: Record<string, string>
  /** The employee whose sessions see its tools; absent for a global server. */
  employeeId?: string
  enabled: boolean
  effect?: McpEffect
  effects?: Record<string, McpEffect>
  events?: z.infer<typeof mcpServerSchema.shape.events>
  auth: McpServerAuth
  /** Secret names the harness generated for this server, deleted with it. */
  generatedSecrets?: string[]
}

export interface McpOAuthStateData extends Record<string, unknown> {
  serverId: string
  /** The person who started the sign-in: only they can finish it. */
  contactId: string
  /** Where the UI wants to land afterwards (a path on the harness). */
  returnTo: string
  redirectUrl: string
  createdAt: string
  expiresAt: string
  usedAt?: string
}

export const mcpServerKind: KindSchema = {
  kind: MCP_SERVER_KIND,
  prefix: 'mcs',
  description:
    'An MCP server added at runtime (http only), global or for one employee. Secret values live in the secret store, never here.',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true, description: 'Slug; tools are mcp.<name>.<tool>.' },
    { name: 'transport', type: 'enum', values: ['http'], required: true },
    { name: 'url', type: 'string', required: true },
    { name: 'headers', type: 'json', description: 'Non-secret headers.' },
    { name: 'employeeId', type: 'ref', ref: 'employee', description: 'Absent: every employee sees the tools.' },
    { name: 'enabled', type: 'boolean', required: true },
    { name: 'effect', type: 'enum', values: ['read', 'idempotent', 'non_idempotent'] },
    { name: 'effects', type: 'json' },
    { name: 'events', type: 'json' },
    { name: 'auth', type: 'json', required: true, description: 'none, token (a secret name) or oauth.' },
    { name: 'generatedSecrets', type: 'list', of: { type: 'string' } },
  ],
}

export const mcpOAuthStateKind: KindSchema = {
  kind: MCP_OAUTH_STATE_KIND,
  prefix: 'mos',
  description: 'An OAuth sign-in to an MCP server in progress. The key is the sha256 of its state; single-use, 10 minutes.',
  core: [
    { name: 'serverId', type: 'ref', ref: MCP_SERVER_KIND, required: true },
    { name: 'contactId', type: 'ref', ref: 'contact', required: true },
    { name: 'returnTo', type: 'string', required: true },
    { name: 'redirectUrl', type: 'string', required: true },
    { name: 'createdAt', type: 'timestamp', required: true },
    { name: 'expiresAt', type: 'timestamp', required: true },
    { name: 'usedAt', type: 'timestamp' },
  ],
}

/** Server names: lowercase letters, digits and inner hyphens, up to 40 characters. */
export const MCP_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
/** Names of the first-party integrations: their tools are `mcp.<name>.*` too. */
export const RESERVED_MCP_NAMES = ['slack', 'linear', 'gitlab', 'harness']

const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const SECRET_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** Headers the harness sets itself, or that would change what a request means. */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'])

const effect = z.enum(['read', 'idempotent', 'non_idempotent'])
const httpUrl = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v)
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password
    } catch {
      return false
    }
  }, 'must be an http(s) URL without credentials in it')
const headerName = z.string().regex(HEADER_RE, 'not a valid header name')
const headers = z
  .record(headerName, z.string().max(4000))
  .refine((h) => Object.keys(h).every((k) => !FORBIDDEN_HEADERS.has(k.toLowerCase())), 'that header is set by the harness')
const secretName = z.string().regex(SECRET_RE, 'letters, digits and _ only, not starting with a digit')

const authInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z
    .object({
      type: z.literal('token'),
      header: headerName.optional(),
      prefix: z.string().max(40).optional(),
      secret: secretName.optional(),
      token: z.string().min(1).max(8000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth'),
      scopes: z.array(z.string().min(1).max(200)).max(50).optional(),
      clientId: z.string().min(1).max(500).optional(),
      clientSecret: z.string().min(1).max(4000).optional(),
      clientSecretSecret: secretName.optional(),
      authorizationServer: httpUrl.optional(),
    })
    .strict(),
])

export type McpServerAuthInput = z.infer<typeof authInput>

const createInput = z
  .object({
    name: z.string(),
    transport: z.literal('http').optional(),
    url: httpUrl,
    headers: headers.optional(),
    employeeId: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
    effect: effect.optional(),
    effects: z.record(z.string(), effect).optional(),
    events: mcpServerSchema.shape.events,
    auth: authInput.optional(),
  })
  .strict()

const patchInput = z
  .object({
    name: z.string().optional(),
    employeeId: z.string().nullable().optional(),
    transport: z.literal('http').optional(),
    url: httpUrl.optional(),
    headers: headers.optional(),
    enabled: z.boolean().optional(),
    effect: effect.nullable().optional(),
    effects: z.record(z.string(), effect).nullable().optional(),
    events: mcpServerSchema.shape.events.nullable(),
    auth: authInput.optional(),
    version: z.number().int().optional(),
  })
  .strict()

export type McpServerCreateInput = z.infer<typeof createInput>
export type McpServerPatchInput = z.infer<typeof patchInput>

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  if ((input as { transport?: unknown } | null)?.transport === 'stdio')
    throw new ValidationError(
      'stdio MCP servers can only be configured in MCP_SERVERS: starting commands on the host is not something the API does',
    )
  const r = schema.safeParse(input)
  if (!r.success)
    throw new ValidationError(
      `invalid ${what}`,
      r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
    )
  return r.data
}

/** Validates a create body (http only: stdio is refused). */
export const parseCreate = (input: unknown) => parse(createInput, input, 'MCP server')
/** Validates a patch body. */
export const parsePatch = (input: unknown) => parse(patchInput, input, 'MCP server change')

/** Throws `ValidationError` unless the name is a slug that isn't reserved. */
export function checkName(name: string): void {
  if (!MCP_NAME_RE.test(name))
    throw new ValidationError(`invalid MCP server name ${JSON.stringify(name)}: lowercase letters, digits and - (a slug)`)
  if (RESERVED_MCP_NAMES.includes(name)) throw new ValidationError(`the MCP server name ${name} is reserved`)
}

/** `MCP_<NAME>_<SUFFIX>`, e.g. `MCP_NOTION_TOKEN` for `notion`. */
export const secretNameFor = (name: string, suffix: string) => `MCP_${name.toUpperCase().replace(/-/g, '_')}_${suffix}`
