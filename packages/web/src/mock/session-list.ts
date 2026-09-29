import type {
  ApiRecord,
  EventData,
  RunData,
  Session,
  SessionData,
  SessionListItem,
  SessionListQuery,
  SessionStartedFrom,
} from '@mp/api'
import { CHN, CON, EMP, type MockDb, PRO, mockId } from './data.ts'

/**
 * The sessions list in the mock, like `GET /api/sessions` on the server
 * (packages/server/src/http/session-list.ts): where each session came from,
 * the project, requester and origin filters, and the sort orders. Also seeds
 * extra sessions so the list has enough to filter (called at the end of
 * `createMockDb`; only inside functions: data.ts and this module import each other).
 */

const ROUTER_ROLES = ['router', 'router-retired']
const SORTS = ['activity', 'newest', 'oldest', 'title'] as const
const ORIGINS: SessionStartedFrom[] = ['chat', 'procedure', 'trigger', 'handoff', 'session', 'manual', 'router']

const records = <T>(db: MockDb, kind: string) => [...(db.records.get(kind)?.values() ?? [])] as ApiRecord<T>[]
const record = <T>(db: MockDb, kind: string, id: string) => db.records.get(kind)?.get(id) as ApiRecord<T> | undefined
const runsOf = (db: MockDb, sessionId: string) =>
  records<RunData>(db, 'run')
    .filter((r) => r.data.sessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
const isRouter = (s: ApiRecord<SessionData> | undefined) =>
  !!s && (ROUTER_ROLES.includes(String(s.data.meta?.role ?? '')) || s.data.meta?.router === true)

/** Where a session came from: its role and meta, else its first run's cause. */
export function mockStartedFrom(db: MockDb, s: ApiRecord<SessionData>): SessionStartedFrom {
  const meta = s.data.meta ?? {}
  if (isRouter(s)) return 'router'
  if (meta.procedureId || meta.procedure || meta.procedureContext) return 'procedure'
  const first = runsOf(db, s.id)[0]
  const byParent = (parentId: string | undefined): SessionStartedFrom =>
    !parentId ? 'manual' : isRouter(record<SessionData>(db, 'session', parentId)) ? 'handoff' : 'session'
  if (!first) return byParent(s.data.parent?.sessionId)
  const cause = first.data.cause
  if (cause.type === 'fork' || cause.type === 'loop') {
    const parentRun = cause.parentRunId ? record<RunData>(db, 'run', cause.parentRunId) : undefined
    return byParent(parentRun?.data.sessionId ?? s.data.parent?.sessionId)
  }
  if (cause.type === 'event') {
    const source = cause.eventId ? record<EventData>(db, 'event', cause.eventId)?.data.source : undefined
    return source === 'chat' ? 'chat' : source === 'ui' || !source ? 'manual' : 'trigger'
  }
  return 'manual'
}

/** The list row fields the server adds: last activity, origin, requester and project. */
export function mockListExtras(
  db: MockDb,
  s: ApiRecord<SessionData>,
): Pick<SessionListItem, 'lastActivityAt' | 'startedFrom' | 'requester' | 'project'> {
  const runs = runsOf(db, s.id)
  const last = [...runs].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1)
  const out = db.links.filter((l) => l.from.kind === 'session' && l.from.id === s.id)
  const requesterId =
    out.find((l) => l.role === 'requested_by' && l.to.kind === 'contact')?.to.id ??
    runs.find((r) => r.data.requesterId)?.data.requesterId
  const projects = out.filter((l) => l.to.kind === 'project' && l.role !== 'mentions')
  const projectId = (projects.find((l) => l.role === 'works_on') ?? projects[0])?.to.id
  const requester = requesterId ? record<{ name: string }>(db, 'contact', requesterId) : undefined
  const project = projectId ? record<{ name: string }>(db, 'project', projectId) : undefined
  return {
    lastActivityAt: last && last.updatedAt > s.updatedAt ? last.updatedAt : s.updatedAt,
    startedFrom: mockStartedFrom(db, s),
    ...(requester ? { requester: { id: requester.id, name: requester.data.name } } : {}),
    ...(project ? { project: { id: project.id, name: project.data.name } } : {}),
  }
}

/** Filters and sorts sessions like the server; throws a message for a bad parameter. */
export function mockQuerySessions(db: MockDb, q: SessionListQuery): Session[] {
  const sort = q.sort ?? 'activity'
  if (!SORTS.includes(sort)) throw new Error(`sort must be one of ${SORTS.join(', ')}`)
  if (q.origin && !ORIGINS.includes(q.origin)) throw new Error(`origin must be one of ${ORIGINS.join(', ')}`)
  const exclude =
    q.excludeRoles === undefined ? ['router-retired'] : q.excludeRoles === 'none' ? [] : q.excludeRoles.split(',').filter(Boolean)
  const statuses = q.status ? String(q.status).split(',') : null
  const text = q.text?.toLowerCase()
  const linked = (to: { kind: string; id: string }, role?: string) =>
    new Set(
      db.links
        .filter((l) => l.from.kind === 'session' && l.to.kind === to.kind && l.to.id === to.id && l.role !== 'mentions')
        .filter((l) => !role || l.role === role)
        .map((l) => l.from.id),
    )
  const inProject = q.projectId ? linked({ kind: 'project', id: q.projectId }) : null
  const forRequester = q.requesterId
    ? new Set([
        ...linked({ kind: 'contact', id: q.requesterId }, 'requested_by'),
        ...records<RunData>(db, 'run')
          .filter((r) => r.data.requesterId === q.requesterId)
          .map((r) => r.data.sessionId),
      ])
    : null
  const items = records<SessionData>(db, 'session').filter(
    (s) =>
      (!q.employeeId || s.data.employeeId === q.employeeId) &&
      (!statuses || statuses.includes(s.data.status)) &&
      (!q.rootId || s.data.rootId === q.rootId) &&
      (!text || JSON.stringify(s.data).toLowerCase().includes(text)) &&
      !exclude.includes(String(s.data.meta?.role ?? '')) &&
      (!inProject || inProject.has(s.id)) &&
      (!forRequester || forRequester.has(s.id)) &&
      (!q.origin || mockStartedFrom(db, s) === q.origin),
  )
  const byte = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const cmp: Record<(typeof SORTS)[number], (a: Session, b: Session) => number> = {
    activity: (a, b) => byte(b.updatedAt, a.updatedAt),
    newest: (a, b) => byte(b.createdAt, a.createdAt),
    oldest: (a, b) => byte(a.createdAt, b.createdAt),
    title: (a, b) => byte(a.data.title, b.data.title),
  }
  return items.sort((a, b) => cmp[sort](a, b) || byte(a.id, b.id)) as Session[]
}

/**
 * Extra sessions across employees, projects, requesters and origins: chat requests, integration
 * events, router hand-offs, sub-sessions and manual ones, and a router replaced by a newer one.
 */
export function seedListSessions(db: MockDb, at: (minutesAgo: number) => string) {
  const map = (kind: string) => {
    if (!db.records.has(kind)) db.records.set(kind, new Map())
    return db.records.get(kind)!
  }
  const put = <T extends Record<string, unknown>>(kind: string, id: string, data: T, created: number, updated = created) => {
    const rec: ApiRecord<T> = { kind, id, version: 1, key: null, data, createdAt: at(created), updatedAt: at(updated) }
    map(kind).set(id, rec as ApiRecord)
    db.revisions.set(id, [{ kind, id, version: 1, op: 'create', data, actor: { type: 'system', id: 'seed' }, at: at(created) }])
  }
  const link = (from: string, kind: string, to: string, role: string, created: number) =>
    db.links.push({
      id: mockId('lnk', `l${from.slice(-3)}${to.slice(-2)}${role.slice(0, 2)}`),
      from: { kind: 'session', id: from },
      to: { kind, id: to },
      role,
      data: {},
      createdAt: at(created),
    })
  const H = 60
  const D = 24 * H
  const routerOf: Record<string, string> = {}
  const billingRouter = records<SessionData>(db, 'session').find((s) => s.data.employeeId === EMP.billing && isRouter(s))
  if (billingRouter) routerOf[EMP.billing] = billingRouter.id

  // A retired router per employee (hidden by default), and live routers for the other two.
  const routers: [string, string, string, number][] = [
    [mockId('ses', 80), EMP.billing, 'router-retired', 40 * D],
    [mockId('ses', 81), EMP.infra, 'router', 30 * D],
    [mockId('ses', 82), EMP.support, 'router', 30 * D],
  ]
  for (const [id, emp, role, created] of routers) {
    const retired = role === 'router-retired'
    put<SessionData>(
      'session',
      id,
      {
        title: retired ? 'Router (before instructions v2)' : 'Router',
        slug: retired ? 'router-v1' : 'router',
        employeeId: emp,
        status: retired ? 'done' : 'active',
        head: null,
        rootId: id,
        depth: 0,
        toolset: ['sessions.fork', 'chat.post'],
        document: `# Router\n\n${retired ? 'Replaced by the current router.' : 'Hands every request to a session that owns it.'}\n`,
        defaultRunMode: 'ephemeral',
        meta: { context: true, role },
      },
      created,
      retired ? 31 * D : 40,
    )
    if (!retired) routerOf[emp] = id
  }

  type Spec = {
    n: number
    title: string
    emp: string
    status: SessionData['status']
    created: number
    updated: number
    from: 'chat' | 'trigger' | 'handoff' | 'session' | 'manual'
    source?: string
    parent?: number
    project?: string
    requester?: string
    state?: RunData['state']
  }
  const specs: Spec[] = [
    {
      n: 100,
      title: 'Why did the March invoice double?',
      emp: EMP.billing,
      status: 'done',
      created: 3 * D,
      updated: 3 * D - 40,
      from: 'chat',
      project: PRO.invoicing,
      requester: CON.dana,
    },
    {
      n: 101,
      title: 'Refund policy for annual plans',
      emp: EMP.billing,
      status: 'active',
      created: 6 * H,
      updated: 12,
      from: 'handoff',
      project: PRO.payments,
      requester: CON.ana,
    },
    {
      n: 102,
      title: 'PAY-150: Stripe payout report',
      emp: EMP.billing,
      status: 'waiting',
      created: 2 * D,
      updated: 5 * H,
      from: 'trigger',
      source: 'mcp:linear',
      project: PRO.payments,
      requester: CON.ana,
    },
    {
      n: 103,
      title: 'Draft the payout summary',
      emp: EMP.billing,
      status: 'done',
      created: 2 * D - 30,
      updated: 2 * D - 90,
      from: 'session',
      parent: 102,
      project: PRO.payments,
    },
    {
      n: 104,
      title: 'Tax rates for the new EU countries',
      emp: EMP.billing,
      status: 'active',
      created: 9 * D,
      updated: 4 * D,
      from: 'manual',
      project: PRO.invoicing,
    },
    {
      n: 105,
      title: 'Credit note for a cancelled order',
      emp: EMP.billing,
      status: 'abandoned',
      created: 12 * D,
      updated: 11 * D,
      from: 'chat',
      requester: CON.eli,
    },
    {
      n: 106,
      title: 'MR !482: currency formatting',
      emp: EMP.billing,
      status: 'done',
      created: 5 * D,
      updated: 5 * D - 120,
      from: 'trigger',
      source: 'mcp:gitlab',
      project: PRO.invoicing,
    },
    {
      n: 110,
      title: 'Rotate the staging TLS certificates',
      emp: EMP.infra,
      status: 'done',
      created: 4 * D,
      updated: 4 * D - 60,
      from: 'handoff',
      project: PRO.platform,
      requester: CON.bob,
    },
    {
      n: 111,
      title: 'Nightly backup job failed',
      emp: EMP.infra,
      status: 'active',
      created: 8 * H,
      updated: 30,
      from: 'trigger',
      source: 'timer',
      project: PRO.platform,
      state: 'failed',
    },
    {
      n: 112,
      title: 'Check backup retention settings',
      emp: EMP.infra,
      status: 'waiting',
      created: 7 * H,
      updated: 2 * H,
      from: 'session',
      parent: 111,
      project: PRO.platform,
    },
    {
      n: 113,
      title: 'Grant Eli read access to the logs',
      emp: EMP.infra,
      status: 'done',
      created: 6 * D,
      updated: 6 * D - 20,
      from: 'chat',
      requester: CON.eli,
    },
    {
      n: 114,
      title: 'MR !77: bump the Postgres image',
      emp: EMP.infra,
      status: 'active',
      created: 26 * H,
      updated: 3 * H,
      from: 'trigger',
      source: 'mcp:gitlab',
      project: PRO.platform,
      requester: CON.dana,
    },
    {
      n: 115,
      title: 'Cost report for September',
      emp: EMP.infra,
      status: 'active',
      created: 10 * D,
      updated: 2 * D,
      from: 'manual',
    },
    {
      n: 120,
      title: 'Customer asks for a data export',
      emp: EMP.support,
      status: 'done',
      created: 2 * D,
      updated: 2 * D - 45,
      from: 'handoff',
      project: PRO.portal,
      requester: CON.chen,
    },
    {
      n: 121,
      title: 'SUP-97: password reset emails are slow',
      emp: EMP.support,
      status: 'active',
      created: 5 * H,
      updated: 20,
      from: 'trigger',
      source: 'mcp:zendesk',
      project: PRO.portal,
      requester: CON.chen,
    },
    {
      n: 122,
      title: 'Reply draft for SUP-97',
      emp: EMP.support,
      status: 'waiting',
      created: 4 * H,
      updated: 90,
      from: 'session',
      parent: 121,
      project: PRO.portal,
    },
    {
      n: 123,
      title: 'How do refunds show up on the portal?',
      emp: EMP.support,
      status: 'done',
      created: 7 * D,
      updated: 7 * D - 15,
      from: 'chat',
      project: PRO.portal,
      requester: CON.dana,
    },
    {
      n: 124,
      title: 'Update the help centre FAQ',
      emp: EMP.support,
      status: 'abandoned',
      created: 15 * D,
      updated: 14 * D,
      from: 'manual',
      project: PRO.portal,
    },
  ]
  let seq = 0
  for (const s of specs) {
    const id = mockId('ses', s.n)
    const parentId = s.parent ? mockId('ses', s.parent) : s.from === 'handoff' ? routerOf[s.emp] : undefined
    const parent = parentId ? (map('session').get(parentId) as ApiRecord<SessionData> | undefined) : undefined
    put<SessionData>(
      'session',
      id,
      {
        title: s.title,
        slug: s.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40),
        employeeId: s.emp,
        status: s.status,
        head: null,
        rootId: parent ? parent.data.rootId : id,
        ...(parent ? { parent: { sessionId: parent.id, entryId: null } } : {}),
        depth: parent ? parent.data.depth + 1 : 0,
        toolset: ['sessions.fork', 'chat.post', 'docs.read'],
        document: `# ${s.title}\n`,
        defaultRunMode: 'continuing',
      },
      s.created,
      s.updated,
    )
    if (s.project) link(id, 'project', s.project, 'works_on', s.created)
    if (s.requester) link(id, 'contact', s.requester, 'requested_by', s.created)
    // The first run, and the event that caused it.
    const runId = mockId('run', 100 + seq++)
    let cause: RunData['cause'] = { type: 'manual' }
    if (s.from === 'chat' || s.from === 'trigger') {
      const eventId = mockId('evt', 100 + seq)
      put<EventData>(
        'event',
        eventId,
        {
          source: s.from === 'chat' ? 'chat' : (s.source ?? 'webhook'),
          type: s.from === 'chat' ? 'message.posted' : 'task.assigned',
          dedupeKey: `mock-list:${eventId}`,
          ...(s.from === 'chat' ? { subject: { system: 'chat', ref: CHN.billing, title: s.title } } : {}),
          ...(s.requester ? { actorId: s.requester } : {}),
          payload: { text: s.title },
          routed: true,
          receivedAt: at(s.created),
        },
        s.created,
      )
      cause = { type: 'event', eventId }
    } else if (parent) {
      const parentRun = runsOf(db, parent.id).at(-1)
      cause = { type: 'fork', ...(parentRun ? { parentRunId: parentRun.id } : {}) }
    }
    const state = s.state ?? (s.status === 'abandoned' ? 'cancelled' : 'completed')
    put<RunData>(
      'run',
      runId,
      {
        sessionId: id,
        employeeId: s.emp,
        rootSessionId: parent ? parent.data.rootId : id,
        mode: 'continuing',
        state,
        base: null,
        tip: null,
        cause,
        ...(s.requester ? { requesterId: s.requester } : {}),
        priority: 0,
        steps: 3,
        startedAt: at(s.created),
        endedAt: at(s.updated),
      },
      s.created,
      s.updated,
    )
  }
}
