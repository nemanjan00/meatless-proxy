import type { Session } from '@mp/sessions'
import type { Principal } from '../auth/guard.ts'
import type { Services } from '../services.ts'

/** The environment a session records in its meta (written by env.up, see @mp/stdlib's EnvMeta). */
export interface SessionEnvMeta {
  id: string
  name?: string
  expose?: number[]
  network?: { via?: string; allow?: string[]; reason?: string }
  image?: string
  profile?: string
  desktop?: boolean
  checkouts?: { key: string; path: string }[]
  services?: string[]
}

export const sessionEnvOf = (s: Session | null | undefined): SessionEnvMeta | null => {
  const e = s?.data.meta?.env as unknown as SessionEnvMeta | undefined
  return e && typeof e === 'object' && typeof e.id === 'string' ? e : null
}

/** Who a session's work is for: its `requested_by` people, and whoever asked for one of its runs. */
export async function requestersOf(s: Services, session: Session): Promise<string[]> {
  const [links, runs] = await Promise.all([
    s.records.links({ from: { kind: 'session', id: session.id }, role: 'requested_by' }),
    s.sessions.runs({ sessionId: session.id }),
  ])
  return [
    ...new Set([
      ...links.filter((l) => l.to.kind === 'contact').map((l) => l.to.id),
      ...runs.flatMap((r) => (r.data.requesterId ? [r.data.requesterId] : [])),
    ]),
  ]
}

/**
 * Whether someone may act on a session's environment (stop it, take control of its desktop): admins,
 * and the people the session's work is for. Environments no session points at are for admins only.
 */
export async function mayControlEnv(s: Services, p: Principal, session: Session | null): Promise<boolean> {
  if (p.access === 'admin') return true
  if (!session || p.access !== 'member') return false
  return (await requestersOf(s, session)).includes(p.contactId)
}
