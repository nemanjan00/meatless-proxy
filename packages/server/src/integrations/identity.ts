import type * as Api from '@mp/api'
import {
  type Clock,
  ConflictError,
  errorMessage,
  type FieldDef,
  isMpError,
  type Json,
  type KindSchema,
  type Logger,
  ValidationError,
} from '@mp/core'
import type { Contact, Directory, Handle } from '@mp/directory'
import type { ExternalUser, Integration, IntegrationEvent } from '@mp/mcp'
import type { Records } from '@mp/records'
import type { Actor, StoredRecord } from '@mp/store'
import { NO_ACCESS } from '../auth/access.ts'
import type { IdentityLookup } from './identity-lookups.ts'

/** How long a lookup's outcome (a miss, a suggestion or a bot included) is reused before asking the system again. */
export const IDENTITY_TTL_MS = 60 * 60_000
/** How long a failed lookup is remembered, so a broken lookup doesn't slow every event. */
const ERROR_TTL_MS = 60_000
/** How long an event waits for a lookup before it goes on anonymous (the lookup finishes in the background). */
export const DEFAULT_IDENTITY_TIMEOUT_MS = 1500
const CACHE_MAX = 5000
/** How often `lastSeenAt` of an unlinked user is written, at most. */
const SEEN_EVERY_MS = 5 * 60_000
/** Most mentions in one event that are looked up. */
const MAX_MENTIONS = 20
/** Names from other systems are shown to the model: one line, and short. */
const NAME_MAX = 80

export const IDENTITY_KIND = 'identity_link'

/**
 * One external user the harness has seen, keyed `<system>:<id>`: whether they're linked to a contact,
 * and what the system's directory said about them (name and email only).
 */
export const identityLinkSchema: KindSchema = {
  kind: IDENTITY_KIND,
  prefix: 'idl',
  description: "An integration user (Slack, GitLab, Linear) and the contact they are, if any. The key is '<system>:<id>'.",
  titleField: 'name',
  core: [
    { name: 'system', type: 'string', required: true },
    { name: 'externalId', type: 'string', required: true, description: 'Their id in the system.' },
    { name: 'status', type: 'enum', values: ['unknown', 'suggested', 'created', 'linked', 'ignored'], required: true },
    { name: 'name', type: 'string' },
    { name: 'email', type: 'string' },
    { name: 'contactId', type: 'ref', ref: 'contact', description: 'The contact with the handle (created or linked).' },
    {
      name: 'suggestedContactId',
      type: 'ref',
      ref: 'contact',
      description: 'A person with the same name, for an admin to confirm.',
    },
    { name: 'decidedBy', type: 'ref', ref: 'contact', description: 'The admin who linked or ignored them.' },
    { name: 'firstSeenAt', type: 'timestamp', required: true },
    { name: 'lastSeenAt', type: 'timestamp', required: true },
  ],
}

export interface IdentityLinkData extends Record<string, unknown> {
  system: string
  externalId: string
  status: Api.IdentityLinkStatus
  name?: string
  email?: string
  contactId?: string
  suggestedContactId?: string
  decidedBy?: string
  firstSeenAt: string
  lastSeenAt: string
}

/** Where a contact came from when the harness created it: `slack`, `gitlab`, `linear`. */
export const contactSourceField: FieldDef = {
  name: 'source',
  type: 'string',
  description: "Set when the harness created the contact from an integration's directory, e.g. slack.",
}

/** Defines the `identity_link` kind and the contact's `source` field (idempotent). */
export function defineIdentityKinds(records: Records) {
  if (!records.kinds.has(IDENTITY_KIND)) records.kinds.define(identityLinkSchema)
  if (!(records.kinds.get('contact').extensions ?? []).some((f) => f.name === 'source'))
    records.kinds.extend('contact', [contactSourceField])
}

const keyOf = (system: string, id: string) => `${system.trim().toLowerCase()}:${id.trim()}`
const SYSTEM_ACTOR = (system: string): Actor => ({ type: 'system', id: `integration:${system}` })

/** A name from another system, safe to show: one line, trimmed, at most `NAME_MAX` characters. */
export const cleanName = (s: string | undefined): string | undefined => {
  const one = s
    ?.replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!one) return undefined
  return one.length > NAME_MAX ? `${one.slice(0, NAME_MAX)}…` : one
}

/** What the harness knows about one external user. */
export interface ResolvedUser {
  /** Their contact, when they have one. */
  contactId?: string
  /** Their name (the contact's, or the system's when there's no contact). */
  name?: string
  bot?: boolean
}

export interface IdentityResolverDeps {
  records: Records
  directory: Directory
  clock: Clock
  logger: Logger
}

export interface IdentityResolverOptions {
  /** How long an event waits for a lookup. Default 1.5 s. */
  timeoutMs?: number
  /** How long outcomes are cached. Default 1 hour. */
  ttlMs?: number
}

export interface IdentityResolver {
  /**
   * The contact of an external user (docs/spec.md#identity-from-integrations): by handle; else the
   * system's directory is asked (`lookup`), and the user is linked by email, suggested for a person
   * with the same name, or created as a contact that can't sign in. Bots get no contact. Waits at most
   * the timeout; after that the event goes on without it and the lookup finishes in the background.
   */
  resolve(integration: Integration, lookup: IdentityLookup | undefined, handle: Handle): Promise<ResolvedUser | undefined>
  /**
   * An event with its actor and the users it mentions resolved: the actor's contact (for
   * `actorContactId`), the text with names in, and `payload.author` set to the contact.
   */
  annotate(
    integration: Integration,
    lookup: IdentityLookup | undefined,
    e: IntegrationEvent,
  ): Promise<{ contactId?: string; text: string; payload: Json }>
  /** Forgets the cached outcome for a user (after an admin linked or ignored them). */
  forget(system: string, id: string): void
  /** Resolves when every lookup and write in the background has finished (tests, shutdown). */
  idle(): Promise<void>
}

export function createIdentityResolver(deps: IdentityResolverDeps, opts: IdentityResolverOptions = {}): IdentityResolver {
  const { records, directory, clock, logger } = deps
  const timeoutMs = opts.timeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS
  const ttl = opts.ttlMs ?? IDENTITY_TTL_MS
  const cache = new Map<string, { until: number; result: ResolvedUser | undefined }>()
  const inflight = new Map<string, Promise<ResolvedUser | undefined>>()
  const touched = new Map<string, number>()
  const pending = new Set<Promise<unknown>>()

  const track = (p: Promise<unknown>) => {
    const t = p.catch(() => {})
    pending.add(t)
    void t.finally(() => pending.delete(t))
  }

  const remember = (key: string, result: ResolvedUser | undefined, forMs = ttl) => {
    cache.delete(key)
    cache.set(key, { until: clock.now() + forMs, result })
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    return result
  }

  /** Records what's known about the user (upsert by key). Failures are logged, never thrown. */
  const note = async (handle: Handle, patch: Partial<IdentityLinkData> & { status: Api.IdentityLinkStatus }) => {
    const key = keyOf(handle.system, handle.id)
    const now = clock.iso()
    touched.set(key, clock.now())
    try {
      await upsertLink(records, handle, patch, now)
    } catch (err) {
      logger.warn('could not record the integration user', { system: handle.system, err: errorMessage(err) })
    }
  }

  /** Bumps `lastSeenAt` of a user we already know is unlinked, at most every few minutes. */
  const seen = (handle: Handle, key: string) => {
    const last = touched.get(key)
    if (last !== undefined && clock.now() - last < SEEN_EVERY_MS) return
    touched.set(key, clock.now())
    if (touched.size > CACHE_MAX) touched.delete(touched.keys().next().value as string)
    track(
      (async () => {
        const rec = await records.getByKey<IdentityLinkData>(IDENTITY_KIND, key)
        if (rec) await records.update(IDENTITY_KIND, rec.id, { lastSeenAt: clock.iso() }, { actor: SYSTEM_ACTOR(handle.system) })
      })(),
    )
  }

  const addHandles = async (contact: Contact, handles: Handle[], system: string) => {
    const have = contact.data.handles ?? []
    const add = handles.filter(
      (h, i) =>
        !have.some((x) => x.system === h.system && x.id === h.id) &&
        handles.findIndex((y) => y.system === h.system && y.id === h.id) === i,
    )
    if (!add.length) return
    try {
      await directory.contacts.update(contact.id, { handles: [...have, ...add] }, { actor: SYSTEM_ACTOR(system) })
      logger.info('contact matched by email: handle recorded', { contactId: contact.id, system })
    } catch (err) {
      // Someone else changed the contact at the same time: the match still holds.
      logger.warn('could not record the handle on the contact', { contactId: contact.id, err: errorMessage(err) })
    }
  }

  /** People with exactly this name and no handle in the system yet (who may be this user). */
  const sameName = async (user: ExternalUser, system: string): Promise<Contact[]> => {
    const names = [...new Set([user.name, user.displayName].map((n) => n?.trim()).filter((n): n is string => !!n))]
    const out = new Map<string, Contact>()
    for (const name of names) {
      const found = await directory.contacts.list({ where: { name, kind: 'person' }, limit: 10 })
      for (const c of found.items)
        if (c.data.status !== 'left' && !(c.data.handles ?? []).some((h) => h.system === system)) out.set(c.id, c)
    }
    return [...out.values()]
  }

  /** Looks the user up and links, suggests or creates. Never throws. */
  const settle = async (
    integration: Integration,
    lookup: IdentityLookup | undefined,
    handle: Handle,
    key: string,
  ): Promise<ResolvedUser | undefined> => {
    const system = handle.system
    try {
      const rec = await records.getByKey<IdentityLinkData>(IDENTITY_KIND, key)
      if (rec?.data.status === 'ignored') return remember(key, undefined)
      let user: ExternalUser | null
      try {
        user = lookup ? await lookup.lookup(integration, handle.id) : null
      } catch (err) {
        logger.warn('integration user lookup failed', { system, err: errorMessage(err) })
        if (!rec) await note(handle, { status: 'unknown' })
        return remember(key, undefined, Math.min(ERROR_TTL_MS, ttl))
      }
      if (!user) {
        await note(handle, { status: 'unknown' })
        return remember(key, undefined)
      }
      const name = cleanName(user.name || user.displayName)
      if (user.bot) return remember(key, name ? { name, bot: true } : { bot: true })
      const handles = [
        { system, id: handle.id },
        ...(user.handle?.id ? [{ system: user.handle.system || system, id: user.handle.id }] : []),
      ]
      const info = { ...(name ? { name } : {}), ...(user.email ? { email: user.email.trim().toLowerCase() } : {}) }

      // 1. The same email: the same person.
      const byEmail = user.email ? await directory.contacts.byEmail(user.email) : null
      if (byEmail) {
        await addHandles(byEmail, handles, system)
        await note(handle, { status: 'linked', contactId: byEmail.id, ...info })
        return { contactId: byEmail.id, name: cleanName(byEmail.data.name) ?? name }
      }
      // 2. Only the same name: maybe the same person. An admin decides.
      const same = await sameName(user, system)
      if (same.length) {
        await note(handle, { status: 'suggested', ...(same.length === 1 ? { suggestedContactId: same[0]!.id } : {}), ...info })
        logger.info('integration user has the name of a contact: suggested, not linked', { system, candidates: same.length })
        return remember(key, name ? { name } : undefined)
      }
      // 3. Nobody: a new contact that can't sign in until an admin lets them.
      try {
        const contact = await directory.contacts.create(
          {
            kind: 'person',
            name: name ?? `${system} user ${handle.id}`,
            ...(info.email ? { email: info.email } : {}),
            handles: handles.filter((h, i) => handles.findIndex((y) => y.system === h.system && y.id === h.id) === i),
            status: 'active',
            access: NO_ACCESS,
            source: system,
          },
          { actor: SYSTEM_ACTOR(system) },
        )
        logger.info('contact created from the integration directory', { contactId: contact.id, system })
        await note(handle, { status: 'created', contactId: contact.id, ...info })
        return { contactId: contact.id, name: cleanName(contact.data.name) }
      } catch (err) {
        if (!isMpError(err, 'conflict')) throw err
        // The handle was recorded meanwhile (another event, another process): use that contact.
        const now = await directory.contacts.byHandle(system, handle.id)
        return now ? { contactId: now.id, name: cleanName(now.data.name) } : undefined
      }
    } catch (err) {
      logger.warn('could not resolve the integration user', { system, err: errorMessage(err) })
      return remember(key, undefined, Math.min(ERROR_TTL_MS, ttl))
    }
  }

  const resolve: IdentityResolver['resolve'] = async (integration, lookup, handle) => {
    if (!handle?.id?.trim() || !handle.system) return undefined
    const contact = await directory.contacts.byHandle(handle.system, handle.id)
    if (contact) return { contactId: contact.id, name: cleanName(contact.data.name) }
    const key = keyOf(handle.system, handle.id)
    const hit = cache.get(key)
    if (hit && hit.until > clock.now()) {
      if (!hit.result?.bot) seen(handle, key)
      return hit.result
    }
    let work = inflight.get(key)
    if (!work) {
      work = settle(integration, lookup, { system: handle.system.trim().toLowerCase(), id: handle.id.trim() }, key)
      inflight.set(key, work)
      track(work.finally(() => inflight.delete(key)))
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = Symbol('late')
    const out = await Promise.race([
      work,
      new Promise<typeof late>((r) => {
        timer = setTimeout(() => r(late), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (out === late) {
      logger.debug('integration user lookup is slow: the event goes on without it', { system: handle.system, timeoutMs })
      return undefined
    }
    return out
  }

  return {
    resolve,
    async annotate(integration, lookup, e) {
      const actor = e.actor?.id ? e.actor : undefined
      const mentioned =
        lookup?.mentions && e.text
          ? lookup
              .mentions(e.text)
              .filter((id) => id !== actor?.id)
              .slice(0, MAX_MENTIONS)
          : []
      const [who, ...others] = await Promise.all([
        actor ? resolve(integration, lookup, actor) : Promise.resolve(undefined),
        ...mentioned.map((id) => resolve(integration, lookup, { system: lookup!.system, id })),
      ])
      const names = new Map<string, string>()
      if (actor && who?.name) names.set(actor.id, who.name)
      mentioned.forEach((id, i) => {
        const n = others[i]?.name
        if (n) names.set(id, n)
      })
      const text = lookup?.render && names.size && e.text ? lookup.render(e.text, names, actor?.id) : e.text
      let payload = e.payload
      if (who?.contactId && payload && typeof payload === 'object' && !Array.isArray(payload) && !('author' in payload)) {
        // The kind says whether a person or an AI wrote it: another employee's bot isn't "a person".
        const contact = await directory.contacts.get(who.contactId).catch(() => null)
        payload = {
          ...payload,
          author: {
            kind: 'contact',
            id: who.contactId,
            ...(contact?.data.kind ? { contactKind: contact.data.kind } : {}),
            ...(contact?.data.name ? { name: contact.data.name } : {}),
          },
        }
      }
      return { ...(who?.contactId ? { contactId: who.contactId } : {}), text, payload }
    },
    forget(system, id) {
      const key = keyOf(system, id)
      cache.delete(key)
      touched.delete(key)
    },
    async idle() {
      while (pending.size) await Promise.all([...pending])
    },
  }
}

/** Creates or replaces the `identity_link` record of a user. */
async function upsertLink(
  records: Records,
  handle: Handle,
  patch: Partial<IdentityLinkData> & { status: Api.IdentityLinkStatus },
  now: string,
  actor: Actor = SYSTEM_ACTOR(handle.system),
  /** Whether this is a sighting (an event): false for an admin's decision, which leaves `lastSeenAt` alone. */
  sighting = true,
): Promise<StoredRecord<IdentityLinkData>> {
  const key = keyOf(handle.system, handle.id)
  for (let attempt = 0; ; attempt++) {
    const rec = await records.getByKey<IdentityLinkData>(IDENTITY_KIND, key)
    // The fields that describe a status go when the status changes.
    const carry = rec ? { ...rec.data } : undefined
    if (carry && carry.status !== patch.status) {
      delete carry.suggestedContactId
      delete carry.decidedBy
      if (patch.status === 'unknown' || patch.status === 'suggested' || patch.status === 'ignored') delete carry.contactId
    }
    const data: IdentityLinkData = {
      ...carry,
      ...patch,
      system: handle.system,
      externalId: handle.id,
      firstSeenAt: rec?.data.firstSeenAt ?? now,
      lastSeenAt: sighting || !rec ? now : rec.data.lastSeenAt,
    }
    try {
      if (rec) return await records.update<IdentityLinkData>(IDENTITY_KIND, rec.id, data, { actor, replace: true })
      return await records.create<IdentityLinkData>(IDENTITY_KIND, data, { actor, key })
    } catch (err) {
      // Created by another event at the same moment: try once more as an update.
      if (attempt === 0 && isMpError(err, 'conflict')) continue
      throw err
    }
  }
}

// ── Admin: see, link and ignore (src/integrations/identity-routes.ts) ─────────

export interface IdentityAdminDeps {
  records: Records
  directory: Directory
  clock: Clock
  logger: Logger
  /** Drops the resolver's cached outcome, so the change applies to the next event. */
  forget?(system: string, id: string): void
}

const handleOf = (input: { system?: unknown; id?: unknown }): Handle => {
  const system = typeof input.system === 'string' ? input.system.trim().toLowerCase() : ''
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!system || !id) throw new ValidationError('system and id are required')
  return { system, id }
}

/** The view of one record, with the names of the contacts it points to. */
async function viewOf(directory: Directory, rec: StoredRecord<IdentityLinkData>): Promise<Api.IdentityLinkView> {
  const d = rec.data
  const named = async (id: string | undefined) => {
    if (!id) return undefined
    const c = await directory.contacts.get(id)
    return c ? { id: c.id, name: c.data.name } : undefined
  }
  const suggested = d.status === 'suggested' ? await named(d.suggestedContactId) : undefined
  const contact = d.status === 'created' || d.status === 'linked' ? await named(d.contactId) : undefined
  return {
    system: d.system,
    id: d.externalId,
    ...(d.name ? { name: d.name } : {}),
    ...(d.email ? { email: d.email } : {}),
    status: d.status,
    firstSeenAt: d.firstSeenAt,
    lastSeenAt: d.lastSeenAt,
    ...(suggested ? { suggested } : {}),
    ...(contact ? { contact } : {}),
  }
}

/** External users by status (default: the ones an admin should look at), most recently seen first. */
export async function listIdentityLinks(
  deps: IdentityAdminDeps,
  query: { status?: string; system?: string; limit?: number } = {},
): Promise<Api.IdentityLinkView[]> {
  const all = new Set<string>(['unknown', 'suggested', 'created', 'linked', 'ignored'])
  const statuses =
    query.status === 'all'
      ? [...all]
      : (query.status ?? 'unknown,suggested')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
  const bad = statuses.filter((s) => !all.has(s))
  if (bad.length) throw new ValidationError(`unknown status: ${bad.join(', ')}`)
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 100)), 500)
  const where: { field: string; op: 'in' | 'eq'; value: Json }[] = [{ field: 'status', op: 'in', value: statuses }]
  if (query.system) where.push({ field: 'system', op: 'eq', value: query.system.trim().toLowerCase() })
  const page = await deps.records.query<IdentityLinkData>(IDENTITY_KIND, {
    where: where as never,
    orderBy: { field: 'lastSeenAt', dir: 'desc' },
    limit,
  })
  return Promise.all(page.items.map((r) => viewOf(deps.directory, r)))
}

/**
 * Puts the handle on a person. A handle on a contact the harness created for this very user moves
 * (that contact stays, without it); a handle on any other contact is a conflict.
 */
export async function linkIdentity(
  deps: IdentityAdminDeps,
  input: { system?: unknown; id?: unknown; contactId?: unknown },
  by: string,
): Promise<Api.IdentityLinkView> {
  const handle = handleOf(input)
  if (typeof input.contactId !== 'string' || !input.contactId) throw new ValidationError('contactId is required')
  const contact = await deps.directory.contacts.require(input.contactId)
  if (contact.data.kind !== 'person') throw new ValidationError('only people can be linked to an integration user')
  const actor: Actor = { type: 'contact', id: by }
  const key = keyOf(handle.system, handle.id)
  const rec = await deps.records.getByKey<IdentityLinkData>(IDENTITY_KIND, key)
  const owner = await deps.directory.contacts.byHandle(handle.system, handle.id)
  if (owner && owner.id !== contact.id) {
    const createdForIt = rec?.data.status === 'created' && rec.data.contactId === owner.id
    if (!createdForIt)
      throw new ConflictError(`${handle.system}:${handle.id} is already on another contact`, { contactId: owner.id })
    const keep = (owner.data.handles ?? []).filter((h) => !(h.system === handle.system && h.id === handle.id))
    await deps.directory.contacts.update(owner.id, { handles: keep }, { actor })
  }
  if (owner?.id !== contact.id)
    await deps.directory.contacts.update(contact.id, { handles: [...(contact.data.handles ?? []), handle] }, { actor })
  const saved = await upsertLink(
    deps.records,
    handle,
    { status: 'linked', contactId: contact.id, decidedBy: by },
    deps.clock.iso(),
    actor,
    false,
  )
  deps.forget?.(handle.system, handle.id)
  deps.logger.info('integration user linked by an admin', { system: handle.system, contactId: contact.id, by })
  return viewOf(deps.directory, saved)
}

/** Leaves the user anonymous (`ignored: false` undoes it). A handle already on a contact stays there. */
export async function ignoreIdentity(
  deps: IdentityAdminDeps,
  input: { system?: unknown; id?: unknown; ignored?: unknown },
  by: string,
): Promise<Api.IdentityLinkView> {
  const handle = handleOf(input)
  if (input.ignored !== undefined && typeof input.ignored !== 'boolean') throw new ValidationError('ignored must be a boolean')
  const actor: Actor = { type: 'contact', id: by }
  const saved = await upsertLink(
    deps.records,
    handle,
    input.ignored === false ? { status: 'unknown' } : { status: 'ignored', decidedBy: by },
    deps.clock.iso(),
    actor,
    false,
  )
  deps.forget?.(handle.system, handle.id)
  deps.logger.info(input.ignored === false ? 'integration user no longer ignored' : 'integration user ignored', {
    system: handle.system,
    by,
  })
  return viewOf(deps.directory, saved)
}
