/**
 * The sessions list (`GET /api/sessions`): filters that need links, runs or
 * events (project, requester, origin), the sort orders, and where each
 * session came from.
 */
import type * as Api from '@mp/api'
import type { MpEvent } from '@mp/events'
import type { Run, Session, SessionQuery } from '@mp/sessions'
import type { Services } from '../services.ts'
import { BadRequestError, intParam } from './util.ts'

/** `meta.role` of an employee's router context, and of one replaced by a newer router. */
export const ROUTER_ROLES = ['router', 'router-retired']
/** Roles left out of the list unless `excludeRoles` says otherwise. */
export const DEFAULT_EXCLUDED_ROLES = ['router-retired']

export const SESSION_ORIGINS: readonly Api.SessionStartedFrom[] = [
  'chat',
  'procedure',
  'trigger',
  'handoff',
  'session',
  'manual',
  'router',
]

export const SESSION_SORTS: Record<Api.SessionSort, NonNullable<SessionQuery['orderBy']>> = {
  activity: { field: 'updatedAt', dir: 'desc' },
  newest: { field: 'createdAt', dir: 'desc' },
  oldest: { field: 'createdAt', dir: 'asc' },
  title: { field: 'title', dir: 'asc' },
}

/** Links that don't make a session "about" a project: a document mentioning it in passing. */
const LOOSE_ROLES = new Set(['mentions'])
/** Most sessions an origin filter looks at (it's derived per session, so it can't be a store condition). */
const ORIGIN_SCAN_LIMIT = 10_000
const CACHE_LIMIT = 50_000
const CHUNK = 50

const isRouter = (s: Session | null | undefined) => ROUTER_ROLES.includes(String(s?.data.meta?.role ?? ''))

async function inChunks<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await Promise.all(items.slice(i, i + CHUNK).map(fn))))
  return out
}

/**
 * Where sessions came from. The answer depends on the session's role and
 * meta, and otherwise on its first run, which never changes, so it's cached
 * once the session has one.
 */
export function sessionOrigins(s: Services) {
  const cache = new Map<string, Api.SessionStartedFrom>()

  const byIds = async <T extends Record<string, unknown>>(kind: string, ids: string[]) => {
    const unique = [...new Set(ids)]
    if (!unique.length) return new Map<string, { id: string; data: T }>()
    const r = await s.records.query<T>(kind, { where: [{ field: 'id', op: 'in', value: unique }], limit: unique.length })
    return new Map(r.items.map((x) => [x.id, x]))
  }

  const firstRun = async (sessionId: string): Promise<Run | null> => (await s.sessions.runs({ sessionId, limit: 1 }))[0] ?? null

  /** Without runs: started by another session (a `created_by` link, or a fork), else by hand. */
  const structural = async (session: Session): Promise<Api.SessionStartedFrom> => {
    const creator = (
      await s.records.links({ from: { kind: 'session', id: session.id }, to: { kind: 'session' }, role: 'created_by' })
    )[0]
    const parentId = creator?.to.id ?? session.data.parent?.sessionId
    if (!parentId) return 'manual'
    return isRouter(await s.sessions.get(parentId)) ? 'handoff' : 'session'
  }

  return {
    /** Each session's origin, by id. */
    async of(sessions: Session[]): Promise<Map<string, Api.SessionStartedFrom>> {
      const out = new Map<string, Api.SessionStartedFrom>()
      const todo: Session[] = []
      for (const x of sessions) {
        const hit = cache.get(x.id)
        if (hit) out.set(x.id, hit)
        else if (isRouter(x)) out.set(x.id, 'router')
        else if (typeof x.data.meta?.procedureId === 'string' || x.data.meta?.procedureContext === true)
          out.set(x.id, 'procedure')
        else todo.push(x)
      }
      if (!todo.length) return out
      const firsts = await inChunks(todo, async (x) => ({ session: x, run: await firstRun(x.id) }))
      const parentRuns = await byIds<Run['data']>(
        'run',
        firsts.flatMap((f) => (f.run?.data.cause.parentRunId ? [f.run.data.cause.parentRunId] : [])),
      )
      const parentSessions = await byIds<Session['data']>(
        'session',
        [...parentRuns.values()].map((r) => r.data.sessionId),
      )
      const events = await byIds<MpEvent['data']>(
        'event',
        firsts.flatMap((f) => (f.run?.data.cause.type === 'event' && f.run.data.cause.eventId ? [f.run.data.cause.eventId] : [])),
      )
      for (const { session, run } of firsts) {
        if (!run) {
          out.set(session.id, await structural(session))
          continue
        }
        const cause = run.data.cause
        let origin: Api.SessionStartedFrom = 'manual'
        if ((cause.type === 'fork' || cause.type === 'loop') && cause.parentRunId) {
          const parent = parentRuns.get(cause.parentRunId)
          const parentSession = parent ? parentSessions.get(parent.data.sessionId) : undefined
          origin = isRouter(parentSession as Session | undefined) ? 'handoff' : 'session'
        } else if (cause.type === 'fork' || cause.type === 'loop') origin = await structural(session)
        else if (cause.type === 'event') {
          const source = cause.eventId ? events.get(cause.eventId)?.data.source : undefined
          origin = source === 'chat' ? 'chat' : source === 'ui' || source === undefined ? 'manual' : 'trigger'
        }
        if (cache.size >= CACHE_LIMIT) cache.clear()
        cache.set(session.id, origin)
        out.set(session.id, origin)
      }
      return out
    },
  }
}

export type SessionOrigins = ReturnType<typeof sessionOrigins>

const list = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * One page of the sessions list for the query string of `GET /api/sessions`,
 * with the origin of each session on the page.
 */
export async function querySessionList(
  s: Services,
  origins: SessionOrigins,
  q: Record<string, string | undefined>,
): Promise<{ items: Session[]; total: number; origins: Map<string, Api.SessionStartedFrom> }> {
  const sort = (q.sort ?? 'activity') as Api.SessionSort
  if (!Object.hasOwn(SESSION_SORTS, sort))
    throw new BadRequestError(`sort must be one of ${Object.keys(SESSION_SORTS).join(', ')}`)
  const origin = q.origin as Api.SessionStartedFrom | undefined
  if (origin !== undefined && !SESSION_ORIGINS.includes(origin))
    throw new BadRequestError(`origin must be one of ${SESSION_ORIGINS.join(', ')}`)
  const excludeRoles =
    q.excludeRoles === undefined ? DEFAULT_EXCLUDED_ROLES : q.excludeRoles === 'none' ? [] : list(q.excludeRoles)
  const limit = intParam(q.limit, 'limit', 50, 500, 1)
  const offset = intParam(q.offset, 'offset', 0)

  // Filters on links and runs become a set of session ids.
  let ids: Set<string> | undefined
  const narrow = (next: Iterable<string>) => {
    const n = new Set(next)
    ids = ids ? new Set([...ids].filter((x) => n.has(x))) : n
  }
  if (q.projectId) {
    const links = await s.records.links({ from: { kind: 'session' }, to: { kind: 'project', id: q.projectId } })
    narrow(links.filter((l) => !LOOSE_ROLES.has(l.role)).map((l) => l.from.id))
  }
  if (q.requesterId) {
    const [links, runs] = await Promise.all([
      s.records.links({ from: { kind: 'session' }, to: { kind: 'contact', id: q.requesterId }, role: 'requested_by' }),
      s.records.query<Run['data']>('run', { where: { requesterId: q.requesterId }, limit: ORIGIN_SCAN_LIMIT }),
    ])
    narrow([...links.map((l) => l.from.id), ...runs.items.map((r) => r.data.sessionId)])
  }

  const status = list(q.status) as NonNullable<SessionQuery['status']>
  const base: SessionQuery = {
    ...(q.employeeId ? { employeeId: q.employeeId } : {}),
    ...(status.length ? { status } : {}),
    ...(q.rootId ? { rootId: q.rootId } : {}),
    ...(q.text ? { text: q.text } : {}),
    ...(ids ? { ids: [...ids] } : {}),
    ...(excludeRoles.length ? { excludeRoles } : {}),
    orderBy: SESSION_SORTS[sort],
  }
  if (!origin) {
    const page = await s.sessions.query({ ...base, limit, offset })
    return { ...page, origins: await origins.of(page.items) }
  }
  // Origins are derived, so filter the matching sessions here and page the result.
  const all = await s.sessions.query({ ...base, limit: ORIGIN_SCAN_LIMIT })
  const known = await origins.of(all.items)
  const matching = all.items.filter((x) => known.get(x.id) === origin)
  return { items: matching.slice(offset, offset + limit), total: matching.length, origins: known }
}
