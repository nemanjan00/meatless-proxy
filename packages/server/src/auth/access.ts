import type { FieldDef, KindSchema } from '@mp/core'
import type { ContactData } from '@mp/directory'
import type { Records } from '@mp/records'
import type { StoredRecord } from '@mp/store'

/**
 * What a signed-in person may do, from least to most: `viewer` reads,
 * `member` also chats, steers its own work and edits knowledge, `admin` also
 * manages secrets, employees, limits, triggers, the kill switch, other
 * people's tokens, sign-in links, and import and export.
 *
 * It lives on the contact as the extension field `access` (the contact's
 * `role` field is a job title). A person without it is a viewer. AI employees
 * (contacts of kind `ai`) never sign in: they act with their own permissions.
 */
export type Access = 'viewer' | 'member' | 'admin'

export const ACCESS_LEVELS: readonly Access[] = ['viewer', 'member', 'admin']

const RANK: Record<Access, number> = { viewer: 0, member: 1, admin: 2 }

/** Whether `have` is at least `need`. */
export const atLeast = (have: Access, need: Access) => RANK[have] >= RANK[need]

/**
 * The `access` of a person who may not sign in (yet): contacts created from an integration's
 * directory (src/integrations/identity.ts) get it. An admin gives them a real access to let them in.
 * Unlike `deactivatedAt`, it says nothing about the person having left.
 */
export const NO_ACCESS = 'none'

export const accessField: FieldDef = {
  name: 'access',
  type: 'enum',
  values: [...ACCESS_LEVELS, NO_ACCESS],
  description:
    'Sign-in access: viewer (read only), member (chat, sessions, knowledge) or admin; none: may not sign in. Missing means viewer.',
}

/** Set by an admin who deactivated someone (src/knowledge/people.ts): they can't sign in; their history stays. */
export const deactivatedFields: FieldDef[] = [
  { name: 'deactivatedAt', type: 'timestamp', description: 'When an admin deactivated them: they cannot sign in.' },
  { name: 'deactivatedBy', type: 'ref', ref: 'contact', description: 'The admin who deactivated them.' },
]

/** A one-time sign-in link. The record key is the sha256 of the link's token. */
export const loginLinkSchema: KindSchema = {
  kind: 'login_link',
  prefix: 'lgl',
  description: 'A one-time sign-in link for a contact. The record key is the sha256 of its token.',
  core: [
    { name: 'contactId', type: 'ref', ref: 'contact', required: true },
    { name: 'createdAt', type: 'timestamp', required: true },
    { name: 'expiresAt', type: 'timestamp', required: true },
    { name: 'usedAt', type: 'timestamp' },
    { name: 'createdBy', type: 'string' },
  ],
}

/** A web sign-in session. The record key is the sha256 of the session id in the cookie. */
export const authSessionSchema: KindSchema = {
  kind: 'auth_session',
  prefix: 'aus',
  description: 'A signed-in web session of a contact. The record key is the sha256 of the cookie value.',
  core: [
    { name: 'contactId', type: 'ref', ref: 'contact', required: true },
    { name: 'via', type: 'enum', values: ['link', 'oidc', 'rotation'], required: true },
    { name: 'createdAt', type: 'timestamp', required: true },
    { name: 'lastSeenAt', type: 'timestamp', required: true },
    { name: 'expiresAt', type: 'timestamp', required: true },
    { name: 'rotatedAt', type: 'timestamp', description: 'When a newer id replaced this one (it then expires soon).' },
    { name: 'endedAt', type: 'timestamp', description: 'Signed out.' },
  ],
}

export interface LoginLinkData extends Record<string, unknown> {
  contactId: string
  createdAt: string
  expiresAt: string
  usedAt?: string
  createdBy?: string
}

export interface AuthSessionData extends Record<string, unknown> {
  contactId: string
  via: 'link' | 'oidc' | 'rotation'
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  rotatedAt?: string
  endedAt?: string
}

/** Kinds that hold credentials: never exposed by the generic records API. */
export const AUTH_KINDS = ['login_link', 'auth_session', 'mcp_token'] as const

/** Defines the auth record kinds and the contact's `access` field (idempotent). */
export function defineAuthKinds(records: Records) {
  if (!records.kinds.has('login_link')) records.kinds.define(loginLinkSchema)
  if (!records.kinds.has('auth_session')) records.kinds.define(authSessionSchema)
  const contact = records.kinds.get('contact')
  if (!(contact.extensions ?? []).some((f) => f.name === 'access')) records.kinds.extend('contact', [accessField])
  if (!(records.kinds.get('contact').extensions ?? []).some((f) => f.name === 'deactivatedAt'))
    records.kinds.extend('contact', deactivatedFields)
}

/**
 * A contact's access, or null when it may not sign in at all (an AI employee, someone who left,
 * someone deactivated, or someone with access `none`, e.g. created from Slack's directory).
 */
export function accessOf(contact: StoredRecord<ContactData> | null | undefined): Access | null {
  if (!contact) return null
  if (contact.data.kind !== 'person' || contact.data.status === 'left' || contact.data.deactivatedAt) return null
  const a = contact.data.access
  if (a === NO_ACCESS) return null
  return typeof a === 'string' && (ACCESS_LEVELS as readonly string[]).includes(a) ? (a as Access) : 'viewer'
}
