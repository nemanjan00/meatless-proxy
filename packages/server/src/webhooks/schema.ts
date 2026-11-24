import { type Json, type KindSchema, ValidationError } from '@mp/core'

/** Record kind of an employee's own incoming webhooks. */
export const WEBHOOK_KIND = 'webhook'

/** How a request proves it's from the sender: a token in a header, or an HMAC-SHA256 signature of the body. */
export type WebhookAuth = { type: 'token'; header: string } | { type: 'hmac'; header: string }

/** Where the event's type, subject and text come from in the JSON body. Paths look like `action` or `issue.id`. */
export interface WebhookMapping {
  /** The event type (default `received`). */
  type?: string
  /** The event subject's id: events about the same thing reach the session that handles it. */
  subject?: string
  /** The event text, with `{path}` placeholders (default: the name, the type and the subject). */
  text?: string
}

/** What a rule does with an event it matches. */
export type WebhookAction = { type: 'ignore' } | { type: 'router' } | { type: 'session'; sessionId: string }

/** One rule: the first that matches decides. An event no rule matches goes to the router. */
export interface WebhookRule {
  /** A glob on the event type, e.g. `issue.*`. */
  type?: string
  /** A path in the body, compared with `equals` or `contains` (as text). */
  field?: string
  equals?: string
  contains?: string
  action: WebhookAction
}

/** What a `webhook` record holds. The secret's value lives in the secret store. */
export interface WebhookData extends Record<string, unknown> {
  employeeId: string
  /** A slug, unique per employee; events come from source `webhook:<name>`. */
  name: string
  enabled: boolean
  auth: WebhookAuth
  /** The secret store name of its token or HMAC key (scoped to the employee). */
  secret: string
  mapping?: WebhookMapping
  rules?: WebhookRule[]
  /** What it's for, in a line: shown to people and to the employee. */
  about?: string
  received?: number
  ignored?: number
  lastReceivedAt?: string
}

export const webhookKind: KindSchema = {
  kind: WEBHOOK_KIND,
  prefix: 'whk',
  description: "An employee's own incoming webhook: a URL other systems post JSON to, with rules for where its events go.",
  titleField: 'name',
  core: [
    { name: 'employeeId', type: 'ref', ref: 'employee', required: true },
    { name: 'name', type: 'string', required: true, description: 'Slug; events come from source webhook:<name>.' },
    { name: 'enabled', type: 'boolean', required: true },
    { name: 'auth', type: 'json', required: true },
    { name: 'secret', type: 'string', required: true, description: 'The secret store name of its token or key.' },
    { name: 'mapping', type: 'json' },
    { name: 'rules', type: 'json' },
    { name: 'about', type: 'string' },
    { name: 'received', type: 'number' },
    { name: 'ignored', type: 'number' },
    { name: 'lastReceivedAt', type: 'string' },
  ],
}

export const WEBHOOK_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/
const PATH_RE = /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+){0,15}$/
export const MAX_RULES = 50

const str = (v: unknown, what: string, max = 500): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || v.length > max) throw new ValidationError(`${what} must be text of at most ${max} characters`)
  return v
}
const path = (v: unknown, what: string) => {
  const p = str(v, what, 200)?.replace(/^\$\.?/, '')
  if (p !== undefined && !PATH_RE.test(p)) throw new ValidationError(`${what} must be a path like issue.id`)
  return p
}

export function checkAuth(v: unknown): WebhookAuth {
  const a = (v ?? { type: 'token' }) as Record<string, unknown>
  if (a.type !== 'token' && a.type !== 'hmac') throw new ValidationError('auth.type must be token or hmac')
  const header = str(a.header, 'auth.header', 64) ?? (a.type === 'token' ? 'X-Webhook-Token' : 'X-Signature')
  if (!HEADER_RE.test(header)) throw new ValidationError('auth.header must be a header name')
  return { type: a.type, header }
}

export function checkMapping(v: unknown): WebhookMapping | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError('mapping must be an object')
  const m = v as Record<string, unknown>
  const out: WebhookMapping = {}
  const type = path(m.type, 'mapping.type')
  const subject = path(m.subject, 'mapping.subject')
  const text = str(m.text, 'mapping.text', 1000)
  if (type) out.type = type
  if (subject) out.subject = subject
  if (text) out.text = text
  return out
}

export function checkRules(v: unknown): WebhookRule[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > MAX_RULES) throw new ValidationError(`rules must be a list of at most ${MAX_RULES}`)
  return v.map((r, i) => {
    if (!r || typeof r !== 'object') throw new ValidationError(`rule ${i + 1} must be an object`)
    const x = r as Record<string, unknown>
    const a = (x.action ?? {}) as Record<string, unknown>
    let action: WebhookAction
    if (a.type === 'ignore' || a.type === 'router') action = { type: a.type }
    else if (a.type === 'session' && typeof a.sessionId === 'string' && /^ses_[A-Za-z0-9]+$/.test(a.sessionId))
      action = { type: 'session', sessionId: a.sessionId }
    else throw new ValidationError(`rule ${i + 1}: action must be ignore, router, or session with a sessionId`)
    const rule: WebhookRule = { action }
    const type = str(x.type, `rule ${i + 1} type`, 200)
    const field = path(x.field, `rule ${i + 1} field`)
    const equals = str(x.equals, `rule ${i + 1} equals`)
    const contains = str(x.contains, `rule ${i + 1} contains`)
    if (type) rule.type = type
    if (field) rule.field = field
    if (equals !== undefined) rule.equals = equals
    if (contains !== undefined) rule.contains = contains
    if (field && equals === undefined && contains === undefined)
      throw new ValidationError(`rule ${i + 1}: a field needs equals or contains`)
    if (!field && (equals !== undefined || contains !== undefined))
      throw new ValidationError(`rule ${i + 1}: equals and contains need a field`)
    return rule
  })
}

/** The value at a dot path (`issue.id`, `items.0.name`) of a JSON value. */
export function valueAt(body: Json | undefined, p: string): Json | undefined {
  let cur: Json | undefined = body
  for (const k of p.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = Array.isArray(cur) ? cur[Number(k)] : (cur as Record<string, Json>)[k]
  }
  return cur
}

/** A value as text, for matching and for the event: scalars as they are, anything else as JSON. */
export const asText = (v: Json | undefined): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v)
