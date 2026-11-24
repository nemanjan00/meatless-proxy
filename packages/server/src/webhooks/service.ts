import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { type Clock, ConflictError, globMatch, type Json, type Logger, NotFoundError, ValidationError } from '@mp/core'
import type { Directory } from '@mp/directory'
import type { Events } from '@mp/events'
import type { Records } from '@mp/records'
import type { SecretStore } from '@mp/secrets'
import type { Actor, StoredRecord } from '@mp/store'
import {
  asText,
  checkAuth,
  checkMapping,
  checkRules,
  valueAt,
  WEBHOOK_KIND,
  WEBHOOK_NAME_RE,
  type WebhookAction,
  type WebhookData,
  type WebhookMapping,
  type WebhookRule,
  webhookKind,
} from './schema.ts'

/** A webhook as the API shows it: no secret value, with the URL to post to. */
export interface WebhookInfo {
  id: string
  employeeId: string
  name: string
  enabled: boolean
  about?: string
  auth: WebhookData['auth']
  mapping: WebhookMapping
  rules: WebhookRule[]
  /** Where to post: `<PUBLIC_URL>/webhooks/custom/<id>` (a path when PUBLIC_URL isn't set). */
  url: string
  received: number
  ignored: number
  lastReceivedAt?: string
  createdAt: string
  updatedAt: string
}

/** What `receive` answers the sender. */
export interface WebhookResponse {
  status: number
  body: Record<string, Json>
}

/** Headers that carry a delivery's own id: a resent delivery is then stored once. */
const DELIVERY_HEADERS = [
  'x-github-delivery',
  'x-gitlab-event-uuid',
  'x-request-id',
  'x-delivery-id',
  'x-webhook-id',
  'idempotency-key',
]
/** The most body text an event carries for the model. */
const TEXT_BODY_MAX = 3000

const secretNameOf = (name: string) => `WEBHOOK_${name.toUpperCase().replace(/-/g, '_')}_SECRET`
const newSecret = () => randomBytes(24).toString('hex')
const eventType = (v: string | undefined) =>
  (v ?? 'received')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .slice(0, 100) || 'received'

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The first rule that matches an event decides; none matching: the router. */
export function decide(
  rules: readonly WebhookRule[],
  type: string,
  body: Json | undefined,
): { action: WebhookAction; rule?: number } {
  for (const [i, r] of rules.entries()) {
    if (r.type && !globMatch(r.type, type)) continue
    if (r.field) {
      const v = asText(valueAt(body, r.field))
      if (v === undefined) continue
      if (r.equals !== undefined && v !== r.equals) continue
      if (r.contains !== undefined && !v.toLowerCase().includes(r.contains.toLowerCase())) continue
    }
    return { action: r.action, rule: i + 1 }
  }
  return { action: { type: 'router' } }
}

/** The event text: the mapping's template with `{path}` filled in, else the name, type and subject, then the body. */
export function eventText(
  name: string,
  mapping: WebhookMapping,
  type: string,
  subject: string | undefined,
  body: Json | undefined,
) {
  if (mapping.text)
    return mapping.text.replace(/\{([^{}]+)\}/g, (_, p: string) => asText(valueAt(body, p.trim().replace(/^\$\.?/, ''))) ?? '')
  const json = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const clipped = json.length > TEXT_BODY_MAX ? `${json.slice(0, TEXT_BODY_MAX)}… (${json.length} characters)` : json
  return `Webhook ${name}: ${type}${subject ? ` (${subject})` : ''}${clipped ? `\n${clipped}` : ''}`
}

export interface WebhooksDeps {
  records: Records
  secrets: SecretStore
  directory: Directory
  events: Events
  clock: Clock
  logger: Logger
  publicUrl?: string
}

/**
 * An employee's own incoming webhooks (docs/spec.md#webhooks): other systems post JSON to a URL, which
 * is checked with a token or an HMAC signature, mapped to an event (type, subject, text), and sent where
 * the first matching rule says: nowhere, the router, or a session. Events are untrusted input.
 */
export class Webhooks {
  constructor(private readonly d: WebhooksDeps) {
    if (!d.records.kinds.has(WEBHOOK_KIND)) d.records.kinds.define(webhookKind)
  }

  private url(id: string) {
    const path = `/webhooks/custom/${id}`
    return this.d.publicUrl ? `${this.d.publicUrl.replace(/\/+$/, '')}${path}` : path
  }

  view(r: StoredRecord<WebhookData>): WebhookInfo {
    const x = r.data
    return {
      id: r.id,
      employeeId: x.employeeId,
      name: x.name,
      enabled: x.enabled,
      ...(x.about ? { about: x.about } : {}),
      auth: x.auth,
      mapping: x.mapping ?? {},
      rules: x.rules ?? [],
      url: this.url(r.id),
      received: x.received ?? 0,
      ignored: x.ignored ?? 0,
      ...(x.lastReceivedAt ? { lastReceivedAt: x.lastReceivedAt } : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
  }

  private async require(id: string) {
    const r = await this.d.records.get<WebhookData>(WEBHOOK_KIND, id)
    if (!r) throw new NotFoundError('webhook', id)
    return r
  }

  async list(employeeId?: string): Promise<WebhookInfo[]> {
    const page = await this.d.records.query<WebhookData>(WEBHOOK_KIND, {
      ...(employeeId ? { where: { employeeId } } : {}),
      orderBy: { field: 'name', dir: 'asc' },
      limit: 1000,
    })
    return page.items.map((r) => this.view(r))
  }

  async get(id: string): Promise<WebhookInfo> {
    return this.view(await this.require(id))
  }

  /** Adds a webhook; its secret is returned this once. */
  async create(body: unknown, actor: Actor): Promise<{ webhook: WebhookInfo; secret: string }> {
    const b = (body ?? {}) as Record<string, unknown>
    const employeeId = typeof b.employeeId === 'string' ? b.employeeId : ''
    if (!employeeId) throw new ValidationError('employeeId is required')
    await this.d.directory.employees.require(employeeId)
    const name = typeof b.name === 'string' ? b.name.trim().toLowerCase() : ''
    if (!WEBHOOK_NAME_RE.test(name)) throw new ValidationError('name must be a slug: lowercase letters, digits and hyphens')
    const secretName = secretNameOf(name)
    const data: WebhookData = {
      employeeId,
      name,
      enabled: b.enabled !== false,
      auth: checkAuth(b.auth),
      secret: secretName,
      rules: checkRules(b.rules),
      received: 0,
      ignored: 0,
    }
    const mapping = checkMapping(b.mapping)
    if (mapping) data.mapping = mapping
    if (typeof b.about === 'string' && b.about.trim()) data.about = b.about.trim().slice(0, 300)
    let rec: StoredRecord<WebhookData>
    try {
      rec = await this.d.records.create<WebhookData>(WEBHOOK_KIND, data, { key: `${employeeId}:${name}`, actor })
    } catch (err) {
      if (err instanceof ConflictError) throw new ConflictError(`this employee already has a webhook named ${name}`)
      throw err
    }
    const secret = newSecret()
    await this.d.secrets.set(secretName, secret, { type: 'employee', id: employeeId }, actorId(actor))
    this.d.logger.info('webhook added', { webhookId: rec.id, employeeId, name })
    return { webhook: this.view(rec), secret }
  }

  /** Changes its auth, mapping, rules, description or whether it's on. The name stays. */
  async update(id: string, body: unknown, actor: Actor): Promise<WebhookInfo> {
    const r = await this.require(id)
    const b = (body ?? {}) as Record<string, unknown>
    const patch: Partial<WebhookData> = {}
    if ('enabled' in b) patch.enabled = b.enabled !== false
    if ('auth' in b) patch.auth = checkAuth(b.auth)
    if ('mapping' in b) patch.mapping = checkMapping(b.mapping) ?? {}
    if ('rules' in b) patch.rules = checkRules(b.rules)
    if ('about' in b) patch.about = typeof b.about === 'string' ? b.about.trim().slice(0, 300) : ''
    if ('name' in b && b.name !== r.data.name) throw new ValidationError("a webhook's name can't change: add a new one")
    const updated = await this.d.records.update<WebhookData>(WEBHOOK_KIND, id, patch, { actor })
    return this.view(updated)
  }

  /** A new secret, returned this once; the old one stops working at once. */
  async rotate(id: string, actor: Actor): Promise<{ webhook: WebhookInfo; secret: string }> {
    const r = await this.require(id)
    const secret = newSecret()
    await this.d.secrets.set(r.data.secret, secret, { type: 'employee', id: r.data.employeeId }, actorId(actor))
    return { webhook: this.view(r), secret }
  }

  async remove(id: string): Promise<void> {
    const r = await this.require(id)
    await this.d.records.delete(WEBHOOK_KIND, id)
    await this.d.secrets.delete(r.data.secret, { type: 'employee', id: r.data.employeeId }).catch(() => {})
  }

  /**
   * A delivery: checked, mapped and routed. Unknown, disabled and wrongly signed webhooks all get 404,
   * so a URL alone tells nothing. Bodies that aren't JSON are kept as text.
   */
  async receive(id: string, req: { headers: Record<string, string>; body: string }): Promise<WebhookResponse> {
    const notFound: WebhookResponse = { status: 404, body: { error: 'not found' } }
    if (!/^whk_[A-Za-z0-9]+$/.test(id)) return notFound
    const r = await this.d.records.get<WebhookData>(WEBHOOK_KIND, id)
    if (!r || !r.data.enabled) return notFound
    const scope = { employeeId: r.data.employeeId }
    const secret = (await this.d.secrets.resolve([r.data.secret], scope))[r.data.secret]
    if (!secret || !verify(r.data.auth, secret, req)) {
      this.d.logger.warn('webhook delivery refused: bad token or signature', { webhookId: id })
      return notFound
    }
    let body: Json | undefined
    try {
      body = req.body ? (JSON.parse(req.body) as Json) : undefined
    } catch {
      body = req.body
    }
    const mapping = r.data.mapping ?? {}
    const type = eventType(mapping.type ? asText(valueAt(body, mapping.type)) : undefined)
    const subjectId = mapping.subject ? asText(valueAt(body, mapping.subject))?.slice(0, 200) : undefined
    const { action, rule } = decide(r.data.rules ?? [], type, body)
    const now = this.d.clock.iso()
    if (action.type === 'ignore') {
      await this.count(r, { ignored: (r.data.ignored ?? 0) + 1, lastReceivedAt: now })
      return { status: 202, body: { ignored: true, ...(rule ? { rule } : {}) } }
    }
    const source = `webhook:${r.data.name}`
    const delivery = DELIVERY_HEADERS.map((h) => req.headers[h]).find((v) => v)
    const { event } = await this.d.events.ingest({
      source,
      type,
      employeeId: r.data.employeeId,
      ...(subjectId ? { subject: { system: source, id: subjectId } } : {}),
      ...(delivery ? { dedupeKey: `${source}:${delivery.slice(0, 200)}` } : {}),
      payload: {
        webhook: { id: r.id, name: r.data.name },
        route: action as unknown as Json,
        ...(rule ? { rule } : {}),
        body: body ?? null,
      },
      text: eventText(r.data.name, mapping, type, subjectId, body),
    })
    await this.count(r, { received: (r.data.received ?? 0) + 1, lastReceivedAt: now })
    return { status: 202, body: { eventId: event.id } }
  }

  private async count(r: StoredRecord<WebhookData>, patch: Partial<WebhookData>) {
    // Counters are a hint: a lost update under a burst only makes them a little low.
    await this.d.records.update<WebhookData>(WEBHOOK_KIND, r.id, patch).catch((err) => {
      this.d.logger.debug('webhook counter not updated', { webhookId: r.id, err: String(err) })
    })
  }
}

const actorId = (a: Actor) => (a.type === 'system' ? 'system' : a.id)

/** A token header equal to the secret, or an HMAC-SHA256 of the body (hex, `sha256=` prefix allowed). */
export function verify(
  auth: WebhookData['auth'],
  secret: string,
  req: { headers: Record<string, string>; body: string },
): boolean {
  const got = req.headers[auth.header.toLowerCase()]
  if (!got) return false
  if (auth.type === 'token') return safeEqual(got.replace(/^Bearer\s+/i, ''), secret)
  const want = createHmac('sha256', secret).update(req.body, 'utf8').digest('hex')
  return safeEqual(got.replace(/^sha256=/i, '').toLowerCase(), want)
}

/** For tests and tools: the HMAC signature header value of a body. */
export const signBody = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
