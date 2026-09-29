import type { App } from '../src/app.ts'
import type { Access } from '../src/auth/access.ts'
import { createLoginLink } from '../src/auth/sessions.ts'
import { createMcpToken } from '../src/tokens.ts'

/**
 * Signing in, for tests. Every request to /api and /ws needs a signed-in
 * person; these helpers make one and return the headers to send.
 */

export interface SignInOptions {
  /** `token` (default): `Authorization: Bearer`. `cookie`: a real sign-in link exchanged for a session cookie. */
  via?: 'token' | 'cookie'
  /** Sets the contact's access first. Default: keep it, or `member` when it has none. */
  access?: Access
}

/** The first admin contact (the bootstrap creates one), created when there is none. */
export async function adminOf(a: App): Promise<string> {
  const s = a.services
  const found = await s.records.query('contact', { where: { access: 'admin', kind: 'person' }, limit: 1 })
  if (found.items[0]) return found.items[0].id
  return (await s.directory.contacts.create({ name: 'Admin', kind: 'person', access: 'admin' })).id
}

/** The cookie header value from a response's `set-cookie` headers (name=value pairs only). */
export function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';')
    const i = pair!.indexOf('=')
    out[pair!.slice(0, i).trim()] = decodeURIComponent(pair!.slice(i + 1).trim())
  }
  return out
}

/** Signs a contact in and returns the headers that authenticate as them. */
export async function signIn(a: App, contactId: string, opts: SignInOptions = {}): Promise<Record<string, string>> {
  const s = a.services
  const contact = await s.directory.contacts.require(contactId)
  const access = opts.access ?? (contact.data.access as Access | undefined) ?? 'member'
  if (contact.data.access !== access) await s.directory.contacts.update(contactId, { access })
  if (opts.via === 'cookie') {
    const link = await createLoginLink(s, contactId)
    const res = await a.app.request(`/auth/login?token=${encodeURIComponent(link.token)}`)
    if (res.status !== 303) throw new Error(`sign-in failed: ${res.status}`)
    const c = cookiesOf(res)
    return { cookie: `mp_session=${c.mp_session}; mp_csrf=${c.mp_csrf}`, 'x-mp-csrf': c.mp_csrf! }
  }
  const { token } = await createMcpToken(s, contactId, 'test')
  return { authorization: `Bearer ${token}` }
}
