import { randomBytes } from 'node:crypto'
import { DeniedError, isMpError } from '@mp/core'
import type { ContactData } from '@mp/directory'
import type { StoredRecord } from '@mp/store'
import type { Services } from '../services.ts'
import { hashToken } from '../tokens.ts'
import { type AuthSessionData, type LoginLinkData, accessOf, defineAuthKinds } from './access.ts'

/** How long a sign-in link works. */
export const LOGIN_LINK_TTL_MS = 15 * 60_000
/** A session expires this long after it was last used. */
export const SESSION_TTL_MS = 14 * 24 * 3600_000
/** A session id older than this is replaced by a new one on its next use. */
export const SESSION_ROTATE_MS = 4 * 3600_000
/** How long a replaced id keeps working, for requests already in flight. */
export const SESSION_GRACE_MS = 60_000
/** `lastSeenAt` (and so the sliding expiry) is written at most this often. */
const TOUCH_MS = 60_000

type Deps = Pick<Services, 'records' | 'directory' | 'clock' | 'config'>

const iso = (ms: number) => new Date(ms).toISOString()
const random = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`

/** The public origin sign-in links point at: `PUBLIC_URL`, else the local server. */
export function publicOrigin(config: Services['config']): string {
  if (config.PUBLIC_URL) return new URL(config.PUBLIC_URL).origin
  const host = config.HOST === '0.0.0.0' || config.HOST === '::' ? 'localhost' : config.HOST
  return `http://${host}:${config.PORT}`
}

/** The contact, if it may sign in. Throws `DeniedError` otherwise (AI employees, people who left). */
async function signInable(s: Deps, contactId: string): Promise<StoredRecord<ContactData>> {
  const contact = await s.directory.contacts.require(contactId)
  if (!accessOf(contact)) throw new DeniedError(`contact ${contactId} can't sign in (only people who are still here can)`)
  return contact
}

/** Resolves `--contact <id|email>` style input to a contact id. */
export async function findContact(s: Pick<Services, 'directory' | 'records'>, idOrEmail: string): Promise<string | null> {
  const needle = idOrEmail.trim()
  if (!needle) return null
  if (!needle.includes('@')) return (await s.directory.contacts.get(needle))?.id ?? null
  return (await contactByEmail(s, needle))?.id ?? null
}

/** The person contact with this email (case-insensitive), or null. */
export async function contactByEmail(s: Pick<Services, 'records'>, email: string): Promise<StoredRecord<ContactData> | null> {
  const want = email.trim().toLowerCase()
  const page = await s.records.query<ContactData>('contact', {
    where: [
      { field: 'email', op: 'exists', value: true },
      { field: 'kind', op: 'eq', value: 'person' },
    ],
    limit: 10_000,
  })
  return (page.items.find((c) => c.data.email?.trim().toLowerCase() === want) as StoredRecord<ContactData>) ?? null
}

/**
 * Creates a one-time sign-in link for a contact: a random token, stored
 * hashed, that works once within 15 minutes. The token is returned once.
 */
export async function createLoginLink(
  s: Deps,
  contactId: string,
  opts: { createdBy?: string } = {},
): Promise<{ id: string; token: string; url: string; contactId: string; expiresAt: string }> {
  defineAuthKinds(s.records)
  await signInable(s, contactId)
  const token = random('mpl_')
  const now = s.clock.now()
  const expiresAt = iso(now + LOGIN_LINK_TTL_MS)
  const rec = await s.records.create<LoginLinkData>(
    'login_link',
    { contactId, createdAt: iso(now), expiresAt, ...(opts.createdBy ? { createdBy: opts.createdBy } : {}) },
    { key: hashToken(token) },
  )
  const url = `${publicOrigin(s.config)}/auth/login?token=${encodeURIComponent(token)}`
  return { id: rec.id, token, url, contactId, expiresAt }
}

/** Uses a sign-in link. Returns its contact, or null when it is unknown, used or expired. Works once, also under races. */
export async function consumeLoginLink(s: Deps, token: string): Promise<string | null> {
  defineAuthKinds(s.records)
  if (!token.startsWith('mpl_')) return null
  const rec = await s.records.getByKey<LoginLinkData>('login_link', hashToken(token))
  if (!rec || rec.data.usedAt || Date.parse(rec.data.expiresAt) <= s.clock.now()) return null
  try {
    await s.records.update<LoginLinkData>('login_link', rec.id, { usedAt: s.clock.iso() }, { expectedVersion: rec.version })
  } catch (e) {
    if (isMpError(e, 'conflict')) return null
    throw e
  }
  const contact = await s.directory.contacts.get(rec.data.contactId)
  return accessOf(contact) ? rec.data.contactId : null
}

/** Starts a web session. Returns the cookie value (shown once; only its hash is stored). */
export async function createAuthSession(s: Deps, contactId: string, via: AuthSessionData['via']): Promise<string> {
  defineAuthKinds(s.records)
  await signInable(s, contactId)
  const id = random('mps_')
  const now = s.clock.now()
  await s.records.create<AuthSessionData>(
    'auth_session',
    { contactId, via, createdAt: iso(now), lastSeenAt: iso(now), expiresAt: iso(now + SESSION_TTL_MS) },
    { key: hashToken(id) },
  )
  return id
}

export interface ResolvedSession {
  contactId: string
  /** Set when the id was rotated: the new cookie value to send. */
  rotated?: string
}

/**
 * The contact of a session cookie, or null when it is unknown, ended or
 * expired. Slides the expiry forward, and replaces an id that is older than
 * a few hours with a new one (the old one keeps working for a minute).
 */
export async function resolveAuthSession(s: Deps, cookie: string): Promise<ResolvedSession | null> {
  defineAuthKinds(s.records)
  if (!cookie.startsWith('mps_')) return null
  const rec = await s.records.getByKey<AuthSessionData>('auth_session', hashToken(cookie))
  if (!rec) return null
  const d = rec.data
  const now = s.clock.now()
  if (d.endedAt || Date.parse(d.expiresAt) <= now) return null
  if (!d.rotatedAt && now - Date.parse(d.createdAt) >= SESSION_ROTATE_MS) {
    try {
      await s.records.update<AuthSessionData>(
        'auth_session',
        rec.id,
        { rotatedAt: iso(now), expiresAt: iso(Math.min(Date.parse(d.expiresAt), now + SESSION_GRACE_MS)) },
        { expectedVersion: rec.version },
      )
      return { contactId: d.contactId, rotated: await createAuthSession(s, d.contactId, 'rotation') }
    } catch (e) {
      // Another request rotated it first: this one still counts, within the grace period.
      if (isMpError(e, 'conflict')) return { contactId: d.contactId }
      throw e
    }
  }
  if (!d.rotatedAt && now - Date.parse(d.lastSeenAt) >= TOUCH_MS) {
    await s.records
      .update<AuthSessionData>(
        'auth_session',
        rec.id,
        { lastSeenAt: iso(now), expiresAt: iso(now + SESSION_TTL_MS) },
        { expectedVersion: rec.version },
      )
      .catch((e) => {
        if (!isMpError(e, 'conflict')) throw e
      })
  }
  return { contactId: d.contactId }
}

/** Ends a session (sign out). Unknown ids are ignored. */
export async function endAuthSession(s: Deps, cookie: string): Promise<void> {
  defineAuthKinds(s.records)
  const rec = await s.records.getByKey<AuthSessionData>('auth_session', hashToken(cookie))
  if (!rec || rec.data.endedAt) return
  await s.records.update<AuthSessionData>('auth_session', rec.id, { endedAt: s.clock.iso(), expiresAt: s.clock.iso() })
}

/** Whether this contact ever signed in (has a session record, current or not). */
export async function hasSignedIn(s: Pick<Services, 'records'>, contactId: string): Promise<boolean> {
  defineAuthKinds(s.records)
  return (await s.records.query('auth_session', { where: { contactId }, limit: 1 })).total > 0
}
