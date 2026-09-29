import { createHash } from 'node:crypto'
import { ConflictError, MpError, NotFoundError, ValidationError, errorMessage, globMatch, type Json } from '@mp/core'
import type { ToolSpec } from '@mp/model'
import {
  RETHROWN_ERROR_CODES,
  type RegisteredTool,
  type ToolDefinition,
  type ToolLists,
  type ToolRegistry,
  type ToolResult,
} from './types.ts'

const MAX_PROVIDER_NAME = 64

/**
 * Maps a tool name to one OpenAI accepts (`^[a-zA-Z0-9_-]{1,64}$`): `.` becomes
 * `__`, other characters become `_`, and names longer than 64 are shortened
 * with a hash suffix.
 */
export function toProviderName(name: string): string {
  const safe = name.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_')
  if (safe.length <= MAX_PROVIDER_NAME) return safe
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${safe.slice(0, MAX_PROVIDER_NAME - 9)}_${hash}`
}

const NAME_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
const EFFECTS = new Set(['read', 'idempotent', 'non_idempotent'])

function checkDefinition(def: ToolDefinition) {
  const issues: string[] = []
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) issues.push('name must be dot-separated segments of [A-Za-z0-9_-]')
  if (typeof def.description !== 'string') issues.push('description must be a string')
  if (!def.parameters || typeof def.parameters !== 'object' || Array.isArray(def.parameters))
    issues.push('parameters must be a JSON schema object')
  if (!EFFECTS.has(def.effect)) issues.push('effect must be read, idempotent or non_idempotent')
  if (def.source !== 'stdlib' && def.source !== 'mcp') issues.push('source must be stdlib or mcp')
  if (def.secrets !== undefined && (!Array.isArray(def.secrets) || def.secrets.some((s) => typeof s !== 'string')))
    issues.push('secrets must be a list of names')
  if (issues.length) throw new ValidationError(`invalid tool ${String(def.name)}`, issues)
}

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  null: (v) => v === null,
}

/**
 * Minimal argument validation against a JSON schema: the arguments are an
 * object, `required` fields are present, and top-level properties with a
 * simple `type` (or list of types) have that type. Returns the problems.
 */
export function checkArgs(schema: Record<string, unknown>, args: unknown): string[] {
  if (!TYPE_CHECKS.object!(args)) return ['arguments must be an object']
  const a = args as Record<string, unknown>
  const issues: string[] = []
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : []
  for (const r of required) if (typeof r === 'string' && (a[r] === undefined || a[r] === null)) issues.push(`${r} is required`)
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown }>
  for (const [k, v] of Object.entries(a)) {
    const t = props[k]?.type
    if (v === undefined || t === undefined) continue
    const types = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string' && x in TYPE_CHECKS)
    if (types.length && !types.some((x) => TYPE_CHECKS[x]!(v))) issues.push(`${k} must be ${types.join(' or ')}`)
  }
  return issues
}

/** Placeholder values of an example call: what a model that sent the wrong arguments should send. */
const EXAMPLE_VALUES: Record<string, Json> = { string: '…', number: 0, integer: 0, boolean: true, array: [], object: {} }

/**
 * An example of valid arguments for a schema: its required fields, with placeholder values. Shown with
 * an invalid call, next to what was received: live, a model sent `{}` sixteen times, sure that it had
 * sent the text, because the error only said "text is required".
 */
export function exampleArgs(schema: Record<string, unknown>): Record<string, Json> {
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown }>
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((r) => typeof r === 'string') : []
  const out: Record<string, Json> = {}
  for (const r of required as string[]) {
    const t = props[r]?.type
    const first = Array.isArray(t) ? t[0] : t
    out[r] = typeof first === 'string' && first in EXAMPLE_VALUES ? EXAMPLE_VALUES[first]! : '…'
  }
  return out
}

/** Arguments as received, for an error message: short, and never more than a line or two. */
const received = (args: unknown) => {
  let text: string
  try {
    text = JSON.stringify(args) ?? String(args)
  } catch {
    text = String(args)
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const allowedBy = (name: string, lists: ToolLists) =>
  (lists.allow ?? []).some((p) => globMatch(p, name)) && !(lists.deny ?? []).some((p) => globMatch(p, name))

/** An in-process tool registry. */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredTool>()
  const byProvider = new Map<string, string>()

  const registry: ToolRegistry = {
    register(def, handler, opts = {}) {
      checkDefinition(def)
      if (typeof handler !== 'function') throw new ValidationError(`tool ${def.name} needs a handler`)
      if (tools.has(def.name) && !opts.replace) throw new ConflictError(`tool ${def.name} is already registered`)
      const pn = toProviderName(def.name)
      const clash = byProvider.get(pn)
      if (clash !== undefined && clash !== def.name)
        throw new ConflictError(`tool ${def.name} clashes with ${clash} (provider name ${pn})`)
      tools.set(def.name, { def: { ...def }, handler })
      byProvider.set(pn, def.name)
    },
    unregister(name) {
      if (!tools.delete(name)) return false
      byProvider.delete(toProviderName(name))
      return true
    },
    get: (name) => tools.get(name) ?? null,
    list: () => [...tools.values()].map((t) => t.def).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    allowed: (lists) => registry.list().filter((d) => allowedBy(d.name, lists)),
    isAllowed: (name, lists) => tools.has(name) && allowedBy(name, lists),
    specs(names) {
      return [...new Set(names)].sort().map((n) => {
        const t = tools.get(n)
        if (!t) throw new NotFoundError('tool', n)
        return {
          type: 'function' as const,
          function: { name: toProviderName(n), description: t.def.description, parameters: t.def.parameters },
        } satisfies ToolSpec
      })
    },
    providerName: toProviderName,
    resolveProviderName: (pn) => byProvider.get(pn) ?? (tools.has(pn) ? pn : null),
    async execute(name, args, ctx): Promise<ToolResult> {
      const t = tools.get(name)
      if (!t) throw new NotFoundError('tool', name)
      const issues = checkArgs(t.def.parameters, args)
      if (issues.length)
        return {
          output: {
            error: `invalid arguments for ${name}: ${issues.join('; ')}`,
            received: received(args),
            example: exampleArgs(t.def.parameters),
            hint: 'Your call arrived with exactly the arguments under "received". Send the call again with every required field filled in, like "example".',
          },
          isError: true,
        }
      try {
        const res = await t.handler(args, ctx)
        if (!res || typeof res !== 'object' || !('output' in res))
          return { output: { error: `tool ${name} returned no result` }, isError: true }
        return res
      } catch (e) {
        if (ctx.signal?.aborted) throw e
        if (e instanceof MpError && RETHROWN_ERROR_CODES.includes(e.code)) throw e
        ctx.logger?.warn('tool failed', { tool: name, callId: ctx.callId, err: e })
        return { output: { error: errorMessage(e) }, isError: true }
      }
    },
  }
  return registry
}
