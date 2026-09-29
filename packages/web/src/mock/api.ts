import {
  type Access,
  type ApiToken,
  type ApiClient,
  type ApiEntry,
  type ApiEvent,
  type ApiRecord,
  ApiRequestError,
  type ChannelData,
  type Checklist,
  type ChecklistData,
  type DeliveryData,
  type EmployeeData,
  type EmployeeSummary,
  type EntryTree,
  type EventData,
  type FileEntry,
  type LineageEdge,
  type LineageGraph,
  type LineageNode,
  LIVE_RUN_STATES,
  type LiveTopic,
  type LiveTopics,
  type Message,
  type MessageData,
  type NowItem,
  type RecordListQuery,
  RUN_STATES,
  type Run,
  type RunData,
  type RunState,
  type Session,
  type SessionData,
  type SessionDetail,
  type SessionListItem,
  type SessionPreview,
  type SessionTreeNode,
  type SubscriptionData,
  type TokenTotals,
  type TriggerData,
  type TriggerStats,
  type UsageData,
  type UsageFilter,
  type UsageGroupBy,
  type UsageRow,
} from '@mp/api'
import { type MockDb, mockId } from './data.ts'
import { createMockSetupApi } from './setup.ts'
import { createMockMcpApi } from './mcp.ts'
import { createMockAttachmentsApi } from './attachments.ts'
import { createMockProjectsApi } from './projects.ts'
import { createMockProceduresApi } from './procedures.ts'
import { createMockKnowledgeApi } from './knowledge.ts'
import { createMockIdentityApi } from './identity.ts'
import { createMockLimitsApi } from './limits.ts'
import { createMockEnvironmentsApi } from './environments.ts'
import { createMockNotificationsApi } from './notifications.ts'
import { createMockChatActivity } from './chat-activity.ts'
import { mockListExtras, mockQuerySessions } from './session-list.ts'

/** Emits a live event (the mock live source implements this). */
export type Emit = <T extends LiveTopic>(topic: T, payload: LiveTopics[T]) => void

export interface MockApiOptions {
  /** Artificial latency per call, in ms. 0 in tests. */
  latencyMs?: number
  emit?: Emit
  /** The person using the UI (posts chat messages as them): a signed-in admin by default. */
  me?: { id: string; name: string; access?: Access }
}

/** A static stand-in for a proxied dev server: the mock has no real preview origin. */
function demoPreviewPage(port: number, sha: string | undefined, token: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>Preview :${port}</title>
<body style="margin:0;font:14px/1.5 system-ui,sans-serif;background:#0f1011;color:#d0d6e0;display:grid;place-items:center;height:100vh">
<main style="text-align:center"><h1 style="font-weight:590;font-size:20px;color:#f7f8f8">Demo app on port ${port}</h1>
<p style="color:#8a8f98">Running commit ${sha ? sha.slice(0, 7) : 'unknown'} · loaded with ${token}</p></main></body>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

const notFound = (what: string) => new ApiRequestError(404, 'not_found', `${what} not found`)

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cached: 0, reasoning: 0, total: 0, cost: 0, calls: 0 }
}

function addUsage(t: TokenTotals, u: UsageData) {
  t.input += u.input
  t.output += u.output
  t.cached += u.cached
  t.reasoning += u.reasoning ?? 0
  t.total += u.input + u.output
  t.cost += u.cost
  t.calls += 1
}

/**
 * An in-memory implementation of the whole `ApiClient` interface, over the
 * fake data in `data.ts`. Writes mutate the data and emit live events, so
 * the UI behaves as it would against the server.
 */
export function createMockApi(db: MockDb, opts: MockApiOptions = {}): ApiClient & { db: MockDb } {
  const emit: Emit = opts.emit ?? (() => {})
  const me = opts.me ?? { id: mockId('con', 1), name: 'Ana Novak' }
  const iso = () => new Date(db.now()).toISOString()
  const delay = <T>(v: T): Promise<T> => {
    // Snapshot when the response "arrives", like a server that reads at the end of the round trip.
    if (!opts.latencyMs) return Promise.resolve(structuredClone(v))
    return new Promise((r) => setTimeout(() => r(structuredClone(v)), opts.latencyMs))
  }
  const fail = (e: Error): Promise<never> => Promise.reject(e)
  const tokens: ApiToken[] = []
  const attachments = createMockAttachmentsApi({
    db,
    meId: me.id,
    meName: me.name,
    access: () => me.access ?? 'admin',
    ...(opts.latencyMs ? { latencyMs: opts.latencyMs } : {}),
  })

  const kindMap = (kind: string) => {
    if (!db.records.has(kind)) db.records.set(kind, new Map())
    return db.records.get(kind)!
  }
  const all = <T>(kind: string) => [...kindMap(kind).values()] as ApiRecord<T>[]
  const get = <T>(kind: string, id: string) => kindMap(kind).get(id) as ApiRecord<T> | undefined
  const find = (id: string): ApiRecord | undefined => {
    for (const m of db.records.values()) {
      const r = m.get(id)
      if (r) return r
    }
    return undefined
  }
  const write = <T extends Record<string, unknown>>(
    kind: string,
    id: string,
    data: T,
    actor = { type: 'contact' as const, id: me.id },
  ) => {
    const prev = get<T>(kind, id)
    const rec: ApiRecord<T> = prev
      ? { ...prev, version: prev.version + 1, data, updatedAt: iso() }
      : { kind, id, version: 1, key: null, data, createdAt: iso(), updatedAt: iso() }
    kindMap(kind).set(id, rec as ApiRecord)
    const revs = db.revisions.get(id) ?? []
    revs.push({
      kind,
      id,
      version: rec.version,
      op: prev ? 'update' : 'create',
      data: data as Record<string, unknown>,
      actor,
      at: iso(),
    })
    db.revisions.set(id, revs)
    emit('record.changed', { kind, id, version: rec.version, op: prev ? 'update' : 'create', actor })
    return rec
  }

  /** What the session's environment serves, read from its meta like the server does. */
  const previewOf = (s: ApiRecord<SessionData>): SessionPreview => {
    const env = s.data.meta?.env as { id?: string; expose?: number[] } | undefined
    if (!env?.id) return { sessionId: s.id, envId: null, status: 'none', ports: [], commit: null }
    const wt = (s.data.meta?.worktrees as { key?: string; head?: string; headSubject?: string }[] | undefined)?.[0]
    return {
      sessionId: s.id,
      envId: env.id,
      status: 'running',
      ports: env.expose ?? [],
      commit: wt?.head
        ? { sha: wt.head, ...(wt.headSubject ? { subject: wt.headSubject } : {}), ...(wt.key ? { repo: wt.key } : {}) }
        : null,
    }
  }

  const employeeSummary = (id: string): EmployeeSummary => {
    const e = get<EmployeeData>('employee', id)
    return { id, name: e?.data.name ?? id }
  }
  const sessionRuns = (sessionId: string) =>
    all<RunData>('run')
      .filter((r) => r.data.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const latestRun = (sessionId: string) => {
    const runs = sessionRuns(sessionId)
    return runs.find((r) => LIVE_RUN_STATES.includes(r.data.state)) ?? runs[0] ?? null
  }
  const totalsFor = (pred: (u: UsageData) => boolean) => {
    const t = emptyTotals()
    for (const u of db.usage) if (pred(u)) addUsage(t, u)
    return t
  }
  const checklistOf = (sessionId: string) => all<ChecklistData>('checklist').find((c) => c.data.sessionId === sessionId) ?? null
  const progress = (c: Checklist | null) =>
    c ? { done: c.data.items.filter((i) => i.checked).length, total: c.data.items.length } : undefined

  const listItem = (s: Session): SessionListItem => {
    const children = all<SessionData>('session').filter((c) => c.data.parent?.sessionId === s.id).length
    const p = progress(checklistOf(s.id))
    return {
      session: s,
      employee: employeeSummary(s.data.employeeId),
      runState: latestRun(s.id)?.data.state ?? null,
      tokens: totalsFor((u) => u.sessionId === s.id),
      children,
      ...(p ? { checklist: p } : {}),
      ...mockListExtras(db, s),
    }
  }

  const matchesWhere = (r: ApiRecord, where: RecordListQuery['where']) => {
    if (!where) return true
    const conds = Array.isArray(where) ? where : Object.entries(where).map(([field, value]) => ({ field, op: 'eq', value }))
    return conds.every((c) => {
      const v = ['id', 'key', 'version', 'createdAt', 'updatedAt'].includes(c.field)
        ? (r as unknown as Record<string, unknown>)[c.field]
        : getPath(r.data, c.field)
      switch (c.op) {
        case 'eq':
          return JSON.stringify(v) === JSON.stringify(c.value)
        case 'ne':
          return JSON.stringify(v) !== JSON.stringify(c.value)
        case 'in':
          return Array.isArray(c.value) && c.value.some((x) => JSON.stringify(x) === JSON.stringify(v))
        case 'like':
          return typeof v === 'string' && v.toLowerCase().includes(String(c.value).toLowerCase())
        case 'exists':
          return (v !== undefined && v !== null) === c.value
        case 'contains':
          return Array.isArray(v) && v.some((x) => JSON.stringify(x) === JSON.stringify(c.value))
        default:
          return true
      }
    })
  }

  // ── entry tree ownership: which session each entry belongs to ──
  const ownerOf = () => {
    const owned = new Map<string, string>()
    const walk = (from: string | null, stop: string | null, sessionId: string) => {
      for (let id = from; id && id !== stop; id = db.entries.get(id)?.parent ?? null) {
        if (!owned.has(id)) owned.set(id, sessionId)
      }
    }
    const sessions = all<SessionData>('session')
    // children first, so that a fork owns its own entries
    for (const s of [...sessions].sort((a, b) => b.data.depth - a.data.depth)) {
      walk(s.data.head, s.data.parent?.entryId ?? null, s.id)
      for (const r of sessionRuns(s.id)) walk(r.data.tip, r.data.base, s.id)
    }
    const owner = (id: string): string | undefined => {
      const seen = new Set<string>()
      for (let cur: string | null = id; cur && !seen.has(cur); cur = db.entries.get(cur)?.parent ?? null) {
        seen.add(cur)
        const o = owned.get(cur)
        if (o) return o
      }
      return undefined
    }
    return owner
  }
  const path = (head: string | null): ApiEntry[] => {
    const out: ApiEntry[] = []
    for (let id = head; id; ) {
      const e = db.entries.get(id)
      if (!e) break
      out.unshift(e)
      id = e.parent
    }
    return out
  }

  // ── lineage ──
  const lineageGraph = (): { nodes: Map<string, LineageNode>; edges: LineageEdge[] } => {
    const nodes = new Map<string, LineageNode>()
    const edges: LineageEdge[] = []
    for (const e of all<EventData>('event')) {
      nodes.set(e.id, {
        id: e.id,
        type: 'event',
        label: e.data.subject?.title ?? e.data.subject?.ref ?? e.data.type,
        detail: `${e.data.source} · ${e.data.type}`,
        at: e.data.receivedAt,
      })
    }
    for (const t of all<TriggerData>('trigger'))
      nodes.set(t.id, { id: t.id, type: 'trigger', label: t.data.name, detail: `${t.data.source} · ${t.data.type}` })
    for (const s of all<SubscriptionData>('subscription'))
      nodes.set(s.id, {
        id: s.id,
        type: 'subscription',
        label: s.data.subject.title ?? s.data.subject.ref,
        detail: `${s.data.subject.system}:${s.data.subject.ref}`,
      })
    for (const s of all<SessionData>('session'))
      nodes.set(s.id, {
        id: s.id,
        type: 'session',
        label: s.data.title,
        detail: `@${employeeSlug(s.data.employeeId)}#${s.data.slug}`,
        status: liveState(s.id) ?? s.data.status,
        at: s.createdAt,
      })
    for (const r of all<RunData>('run')) {
      nodes.set(r.id, {
        id: r.id,
        type: 'run',
        label: `${r.data.mode} run`,
        detail: `${r.data.state} · ${r.data.steps} steps · ${r.data.cause.type}`,
        status: r.data.state,
        at: r.data.startedAt ?? r.createdAt,
      })
      edges.push({ from: r.data.sessionId, to: r.id, type: 'ran' })
    }
    for (const d of all<DeliveryData>('delivery')) {
      // One node per delivery keeps chains event-specific even when a trigger fires many times.
      const via = d.data.triggerId ?? d.data.subscriptionId
      const viaNode = via ? nodes.get(via) : undefined
      nodes.set(d.id, {
        id: d.id,
        type: 'delivery',
        label: viaNode?.label ?? d.data.rule.replace(/_/g, ' '),
        detail: `${d.data.rule.replace(/_/g, ' ')}${d.data.inbox ? ' · inbox' : ''}${d.data.expectedToAct ? '' : ' · context only'}`,
        at: d.createdAt,
      })
      edges.push({ from: d.data.eventId, to: d.id, type: 'matched' })
      if (via) edges.push({ from: via, to: d.id, type: 'matched' })
      if (d.data.runId) edges.push({ from: d.id, to: d.data.runId, type: 'delivered' })
      else edges.push({ from: d.id, to: d.data.sessionId, type: 'delivered' })
    }
    for (const s of all<SessionData>('session')) {
      const byRun = s.data.meta?.createdByRun
      if (typeof byRun === 'string') edges.push({ from: byRun, to: s.id, type: s.data.meta?.loop ? 'looped' : 'forked' })
    }
    for (const e of all<EventData>('event')) {
      const runId = (e.data.payload as Record<string, unknown> | null)?.runId
      if (e.data.source === 'run' && typeof runId === 'string') edges.push({ from: runId, to: e.id, type: 'emitted' })
    }
    // dedupe
    const seen = new Set<string>()
    return {
      nodes,
      edges: edges.filter((e) => {
        const k = `${e.from}>${e.to}>${e.type}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      }),
    }
  }
  const liveState = (sessionId: string) => {
    const r = latestRun(sessionId)
    return r && LIVE_RUN_STATES.includes(r.data.state) ? r.data.state : undefined
  }
  /** The mock person's read markers, by channel or thread id. */
  const reads = new Map<string, string>()
  const react = (id: string, emoji: string, on: boolean) => {
    const m = get<MessageData>('message', id)
    if (!m) return fail(notFound('message'))
    const reactions = { ...(m.data.reactions ?? {}) }
    const who = (reactions[emoji] ?? []).filter((r) => r.id !== me.id)
    if (on) who.push({ kind: 'contact', id: me.id })
    if (who.length) reactions[emoji] = who
    else delete reactions[emoji]
    const next = write<MessageData>('message', id, { ...m.data, reactions }) as Message
    emit('chat.message', { channelId: m.data.channelId, message: next })
    return delay(next)
  }
  const chatActivity = createMockChatActivity({ db, iso, delay, emit, write, get, all })
  const employeeSlug = (id: string) =>
    (get<EmployeeData>('employee', id)?.data.name ?? id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

  const usageMatch =
    (f: UsageFilter = {}) =>
    (u: UsageData) =>
      (!f.runId || u.runId === f.runId) &&
      (!f.employeeId || u.employeeId === f.employeeId) &&
      (!f.sessionId || u.sessionId === f.sessionId) &&
      (!f.rootSessionId || u.rootSessionId === f.rootSessionId) &&
      (!f.projectId || u.projectId === f.projectId) &&
      (!f.requesterId || u.requesterId === f.requesterId) &&
      (!f.templateId || u.templateId === f.templateId) &&
      (!f.model || u.model === f.model) &&
      (!f.since || u.at >= f.since) &&
      (!f.until || u.at < f.until)

  const groupKey = (u: UsageData, g: UsageGroupBy): string => {
    switch (g) {
      case 'employee':
        return u.employeeId
      case 'model':
        return u.model
      case 'session':
        return u.sessionId
      case 'tree':
        return u.rootSessionId
      case 'project':
        return u.projectId ?? '—'
      case 'contact':
        return u.requesterId ?? '—'
      case 'template':
        return u.templateId ?? '—'
      case 'tool':
        return u.tool ?? '—'
      case 'day':
        return u.at.slice(0, 10)
      case 'hour':
        return `${u.at.slice(0, 13)}:00`
    }
  }
  const groupLabel = (key: string, g: UsageGroupBy): string => {
    if (key === '—') return '—'
    if (g === 'employee' || g === 'session' || g === 'tree' || g === 'project' || g === 'contact' || g === 'template') {
      const r = find(key)
      const d = r?.data as Record<string, unknown> | undefined
      return String(d?.title ?? d?.name ?? key)
    }
    return key
  }

  const nowItem = (r: Run): NowItem => {
    const s = get<SessionData>('session', r.data.sessionId)!
    const step = db.steps.get(r.id) ?? {
      kind:
        r.data.state === 'queued'
          ? 'queued'
          : r.data.state === 'paused'
            ? 'paused'
            : r.data.state === 'suspended'
              ? 'waiting'
              : 'model',
      label: r.data.state === 'running' ? 'Thinking' : r.data.state,
      since: r.updatedAt,
    }
    const p = progress(checklistOf(s.id))
    const wait = db.waits.get(r.id)
    const stream = db.streaming.get(r.id)
    return {
      run: r,
      session: s,
      employee: employeeSummary(r.data.employeeId),
      step,
      ...(wait ? { waitingOn: wait } : {}),
      tokens: totalsFor((u) => u.runId === r.id || (u.sessionId === s.id && u.at >= (r.data.startedAt ?? ''))),
      ...(p ? { checklist: p } : {}),
      recentTools: db.recentTools.get(r.id) ?? [],
      ...(stream ? { streaming: stream } : {}),
    }
  }

  const treeNode = (s: Session, sessions: Session[]): SessionTreeNode => {
    const kids = sessions
      .filter((c) => c.data.parent?.sessionId === s.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const loop = s.data.meta?.loop as { index: number; of: number } | undefined
    return {
      id: s.id,
      title: s.data.title,
      slug: s.data.slug,
      status: s.data.status,
      employee: employeeSummary(s.data.employeeId),
      origin: !s.data.parent ? 'root' : loop ? 'loop' : 'fork',
      ...(loop ? { loop: { index: loop.index, of: loop.of } } : {}),
      runState: latestRun(s.id)?.data.state ?? null,
      tokens: totalsFor((u) => u.sessionId === s.id).total,
      createdAt: s.createdAt,
      children: kids.map((k) => treeNode(k, sessions)),
    }
  }

  const setRunState = (id: string, to: RunState, patch: Partial<RunData> = {}) => {
    const r = get<RunData>('run', id)
    if (!r) throw notFound('run')
    const from = r.data.state
    const next = write<RunData>('run', id, { ...r.data, ...patch, state: to }, { type: 'contact', id: me.id })
    if (to === 'paused') db.steps.set(id, { kind: 'paused', label: patch.pauseReason ?? 'Paused from the UI', since: iso() })
    if (to === 'queued') db.steps.set(id, { kind: 'queued', label: 'Queued', since: iso() })
    if (to === 'cancelled') db.steps.delete(id)
    emit('run.state', { runId: id, sessionId: r.data.sessionId, employeeId: r.data.employeeId, from, to, run: next as Run })
    return next as Run
  }

  const api: ApiClient & { db: MockDb } = {
    db,
    kinds: () => delay(db.kinds),
    listRecords: <T>(kind: string, q: RecordListQuery = {}) => {
      let items = all<T>(kind).filter((r) => matchesWhere(r as ApiRecord, q.where))
      if (q.text) {
        const t = q.text.toLowerCase()
        items = items.filter((r) => JSON.stringify(r.data).toLowerCase().includes(t))
      }
      const field = q.orderBy ?? 'updatedAt'
      const dir = q.dir === 'asc' ? 1 : -1
      const val = (r: ApiRecord<T>) =>
        String(field === 'createdAt' || field === 'updatedAt' ? r[field] : (getPath(r.data, field) ?? ''))
      items.sort((a, b) => val(a).localeCompare(val(b)) * dir)
      const total = items.length
      const off = q.offset ?? 0
      return delay({ items: items.slice(off, off + (q.limit ?? 50)), total })
    },
    getRecord: <T>(kind: string, id: string) => {
      const r = get<T>(kind, id)
      return r ? delay(r) : fail(notFound(kind))
    },
    createRecord: <T>(kind: string, data: T, o: { key?: string } = {}) => {
      const schema = db.kinds.find((k) => k.kind === kind)
      const missing = (schema?.core ?? []).filter((f) => f.required && (data as Record<string, unknown>)[f.name] === undefined)
      if (missing.length)
        return fail(
          new ApiRequestError(
            422,
            'validation',
            `invalid ${kind}`,
            missing.map((f) => `${f.name} is required`),
          ),
        )
      const id = mockId(schema?.prefix ?? kind.slice(0, 3), ++db.seq)
      const rec = write(kind, id, data as Record<string, unknown>)
      if (o.key) rec.key = o.key
      return delay(rec as unknown as ApiRecord<T>)
    },
    updateRecord: <T>(kind: string, id: string, data: Partial<T>, version: number) => {
      const r = get<T>(kind, id)
      if (!r) return fail(notFound(kind))
      if (r.version !== version) return fail(new ApiRequestError(409, 'conflict', `${kind} ${id} is at version ${r.version}`, r))
      const next: Record<string, unknown> = { ...(r.data as Record<string, unknown>) }
      for (const [k, v] of Object.entries(data)) {
        if (v === null || v === undefined) delete next[k]
        else next[k] = v
      }
      return delay(write(kind, id, next) as unknown as ApiRecord<T>)
    },
    deleteRecord: (kind, id, o = {}) => {
      const r = get(kind, id)
      if (!r) return fail(notFound(kind))
      const linked = db.links.filter((l) => l.from.id === id || l.to.id === id)
      if (linked.length && !o.cascade)
        return fail(new ApiRequestError(409, 'conflict', `${kind} ${id} has ${linked.length} links`))
      db.links = db.links.filter((l) => l.from.id !== id && l.to.id !== id)
      kindMap(kind).delete(id)
      emit('record.changed', { kind, id, version: r.version + 1, op: 'delete', actor: { type: 'contact', id: me.id } })
      return delay(undefined)
    },
    recordLinks: (_kind, id, o = {}) => {
      const dir = o.direction ?? 'both'
      const out = db.links
        .filter((l) => (dir !== 'in' && l.from.id === id) || (dir !== 'out' && l.to.id === id))
        .filter((l) => !o.role || l.role === o.role)
        .map((l) => {
          const other = l.from.id === id ? l.to : l.from
          const record = find(other.id)
          return record ? { link: l, record } : null
        })
        .filter((x) => x !== null)
      return delay(out)
    },
    createLink: (kind, id, to, role, data = {}) => {
      const existing = db.links.find((l) => l.from.id === id && l.to.id === to.id && l.role === role)
      if (existing) return delay(existing)
      if (!find(id) || !find(to.id)) return fail(notFound('record'))
      const l = { id: mockId('lnk', ++db.seq), from: { kind, id }, to, role, data, createdAt: iso() }
      db.links.push(l)
      emit('link.changed', { id: l.id, from: l.from, to: l.to, role, op: 'link' })
      return delay(l)
    },
    deleteLink: (linkId) => {
      const l = db.links.find((x) => x.id === linkId)
      if (!l) return fail(notFound('link'))
      db.links = db.links.filter((x) => x.id !== linkId)
      emit('link.changed', { id: l.id, from: l.from, to: l.to, role: l.role, op: 'unlink' })
      return delay(undefined)
    },
    recordRevisions: <T>(_kind: string, id: string) =>
      delay((db.revisions.get(id) ?? []) as never as import('@mp/api').ApiRevision<T>[]),
    recordBacklinks: (kind, id) => {
      const needle = `[[${kind}:${id}`
      const out: ApiRecord[] = []
      for (const m of db.records.values())
        for (const r of m.values()) if (r.id !== id && JSON.stringify(r.data).includes(needle)) out.push(r)
      return delay(out)
    },

    listSessions: (q = {}) => {
      let items: Session[]
      try {
        items = mockQuerySessions(db, q)
      } catch (e) {
        return fail(new ApiRequestError(400, 'bad_request', (e as Error).message))
      }
      const off = q.offset ?? 0
      return delay({ items: items.slice(off, off + (q.limit ?? 50)).map(listItem), total: items.length })
    },
    getSession: (id) => {
      const s = get<SessionData>('session', id)
      if (!s) return fail(notFound('session'))
      const runs = sessionRuns(id)
      const active =
        runs
          .filter((r) => LIVE_RUN_STATES.includes(r.data.state))
          .sort((a, b) => (a.data.mode === 'continuing' ? -1 : 1) - (b.data.mode === 'continuing' ? -1 : 1))[0] ?? null
      const links = db.links
        .filter((l) => l.from.id === id || l.to.id === id)
        .map((l) => ({ link: l, record: find(l.from.id === id ? l.to.id : l.from.id)! }))
        .filter((x) => x.record)
      const threads = all<SubscriptionData>('subscription')
        .filter((sub) => sub.data.sessionId === id && sub.data.subject.system === 'chat')
        .map((sub) => {
          const m = get<MessageData>('message', sub.data.subject.ref)
          return m ? { channelId: m.data.channelId, threadId: m.id, title: m.data.text.slice(0, 80) } : null
        })
        .filter((x) => x !== null)
      const detail: SessionDetail = {
        session: s,
        employee: employeeSummary(s.data.employeeId),
        checklist: checklistOf(id),
        activeRun: active,
        links,
        tokens: totalsFor((u) => u.sessionId === id),
        threads,
      }
      return delay(detail)
    },
    sessionHistory: (id) => {
      const s = get<SessionData>('session', id)
      return s ? delay(path(s.data.head)) : fail(notFound('session'))
    },
    sessionTree: (id) => {
      const s = get<SessionData>('session', id)
      if (!s) return fail(notFound('session'))
      const sessions = all<SessionData>('session').filter((x) => x.data.rootId === s.data.rootId)
      const root = sessions.find((x) => x.id === s.data.rootId) ?? s
      return delay(treeNode(root, sessions))
    },
    sessionEntryTree: (id) => {
      const s = get<SessionData>('session', id)
      if (!s) return fail(notFound('session'))
      const owner = ownerOf()
      const ids = new Set(path(s.data.head).map((e) => e.id))
      for (const e of db.entries.values()) if (owner(e.id) === id) ids.add(e.id)
      const entries = [...ids].map((x) => db.entries.get(x)!).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const tree: EntryTree = {
        sessionId: id,
        head: s.data.head,
        entries,
        runs: sessionRuns(id).map((r) => ({
          id: r.id,
          mode: r.data.mode,
          state: r.data.state,
          base: r.data.base,
          tip: r.data.tip,
        })),
      }
      return delay(tree)
    },
    sessionRuns: (id) => delay(sessionRuns(id)),
    sessionPreview: (id) => {
      const s = get<SessionData>('session', id)
      if (!s) return fail(notFound('session'))
      return delay(previewOf(s))
    },
    previewToken: (envId, port) => {
      const s = all<SessionData>('session').find((x) => previewOf(x).envId === envId)
      if (!s || !previewOf(s).ports.includes(port)) return fail(notFound('preview'))
      const token = `mpp_mock_${++db.seq}`
      const commit = previewOf(s).commit
      return delay({
        envId,
        port,
        token,
        url: demoPreviewPage(port, commit?.sha, token),
        origin: `http://${envId}-${port}.preview.example.com`,
        expiresAt: new Date(db.now() + 5 * 60_000).toISOString(),
      })
    },
    subscriptions: (q = {}) =>
      delay(all<SubscriptionData>('subscription').filter((s) => !q.sessionId || s.data.sessionId === q.sessionId)),
    forkSession: (id, body = {}) => {
      const s = get<SessionData>('session', id)
      if (!s) return fail(notFound('session'))
      const newId = mockId('ses', ++db.seq)
      const slug = `${s.data.slug}-fork-${db.seq}`
      const rec = write<SessionData>('session', newId, {
        ...s.data,
        title: body.title ?? `${s.data.title} (fork)`,
        slug,
        status: 'active',
        head: body.atEntry ?? s.data.head,
        parent: { sessionId: id, entryId: body.atEntry ?? s.data.head },
        depth: s.data.depth + 1,
        meta: { forkedFromUi: true },
      })
      return delay(rec as Session)
    },
    sendMessage: (id, text) => {
      const s = get<SessionData>('session', id)
      if (!s) return fail(notFound('session'))
      const evId = mockId('evt', ++db.seq)
      const event = write<EventData>('event', evId, {
        source: 'ui',
        type: 'message.posted',
        dedupeKey: `ui:${evId}`,
        subject: { system: 'session', ref: id, title: s.data.title },
        actorId: me.id,
        payload: { text },
        receivedAt: iso(),
        routed: true,
        matched: ['session_tag'],
      }) as ApiEvent
      emit('event.ingested', { event })
      const run = latestRun(id)
      const live = run && LIVE_RUN_STATES.includes(run.data.state) ? run : null
      write<DeliveryData>('delivery', mockId('dlv', ++db.seq), {
        eventId: evId,
        sessionId: id,
        rule: 'session_tag',
        expectedToAct: true,
        inbox: !!live,
        ...(live ? { runId: live.id } : {}),
      })
      if (live) {
        const entry: ApiEntry = {
          id: mockId('ent', ++db.seq),
          parent: live.data.tip,
          kind: 'event',
          content: {
            eventId: evId,
            source: 'ui',
            type: 'message.posted',
            text: `${me.name}: ${text}`,
            trusted: true,
            expectedToAct: true,
          },
          hash: String(db.seq),
          meta: { runId: live.id },
          createdAt: iso(),
        }
        db.entries.set(entry.id, entry)
        write<RunData>('run', live.id, { ...live.data, tip: entry.id })
        emit('entry.appended', { sessionId: id, runId: live.id, entry })
      }
      return delay({ event, runId: live?.id ?? null, inbox: !!live })
    },
    entryChildren: (id) => delay([...db.entries.values()].filter((e) => e.parent === id)),
    getRun: (id) => {
      const r = get<RunData>('run', id)
      return r ? delay(r) : fail(notFound('run'))
    },
    runHistory: (id) => {
      const r = get<RunData>('run', id)
      return r ? delay(path(r.data.tip ?? r.data.base)) : fail(notFound('run'))
    },
    pauseRun: (id, reason) => {
      try {
        return delay(setRunState(id, 'paused', { pauseReason: reason ?? 'Paused from the UI' }))
      } catch (e) {
        return fail(e as Error)
      }
    },
    resumeRun: (id) => {
      try {
        return delay(setRunState(id, 'queued', { pauseReason: undefined as never }))
      } catch (e) {
        return fail(e as Error)
      }
    },
    cancelRun: (id) => {
      try {
        return delay(
          setRunState(id, 'cancelled', { endedAt: iso(), result: { status: 'cancelled', output: `Cancelled by ${me.name}` } }),
        )
      } catch (e) {
        return fail(e as Error)
      }
    },
    lineage: (id) => {
      const { nodes, edges } = lineageGraph()
      if (!nodes.has(id)) return fail(notFound('lineage focus'))
      const out = new Map<string, string[]>()
      const inc = new Map<string, string[]>()
      for (const e of edges) {
        out.set(e.from, [...(out.get(e.from) ?? []), e.to])
        inc.set(e.to, [...(inc.get(e.to) ?? []), e.from])
      }
      const reach = (start: string, next: Map<string, string[]>) => {
        const seen = new Set([start])
        const q = [start]
        while (q.length) for (const n of next.get(q.shift()!) ?? []) if (!seen.has(n)) seen.add(n) && q.push(n)
        return seen
      }
      const keep = new Set([...reach(id, out), ...reach(id, inc)])
      const graph: LineageGraph = {
        focus: id,
        nodes: [...keep].map((k) => nodes.get(k)!).filter(Boolean),
        edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
      }
      return delay(graph)
    },

    now: () => {
      const items = all<RunData>('run')
        .filter((r) => LIVE_RUN_STATES.includes(r.data.state))
        .map((r) => nowItem(r as Run))
      const counts = Object.fromEntries(RUN_STATES.map((s) => [s, 0])) as Record<RunState, number>
      for (const r of all<RunData>('run')) counts[r.data.state]++
      return delay({ items, paused: db.control.paused, counts })
    },
    inbox: () => delay([...db.inbox].sort((a, b) => b.at.localeCompare(a.at))),
    markInboxRead: (q) => {
      if (q.clear) db.inbox = []
      else for (const i of db.inbox) if (q.ids?.includes(i.id)) i.read = true
      emit('inbox.read', { contactId: me.id, ...(q.ids ? { ids: q.ids } : {}), ...(q.clear ? { clear: true } : {}) })
      return delay(undefined)
    },

    listEvents: (q = {}) => {
      let items = all<EventData>('event').filter(
        (e) =>
          (!q.source || e.data.source === q.source) &&
          (!q.type || e.data.type === q.type) &&
          (!q.subject || e.data.subject?.ref === q.subject) &&
          (q.routed === undefined ||
            (q.routed === 'true' && e.data.routed) ||
            (q.routed === 'false' && !e.data.routed) ||
            (q.routed === 'unmatched' &&
              e.data.routed &&
              (!e.data.matched?.length || e.data.matched.every((m) => m === 'fallback')))),
      )
      items = items.sort((a, b) => b.data.receivedAt.localeCompare(a.data.receivedAt))
      const off = q.offset ?? 0
      return delay({ items: items.slice(off, off + (q.limit ?? 100)), total: items.length })
    },
    getEvent: (id) => {
      const e = get<EventData>('event', id)
      if (!e) return fail(notFound('event'))
      const deliveries = all<DeliveryData>('delivery').filter((d) => d.data.eventId === id)
      const runs = deliveries
        .map((d) => (d.data.runId ? get<RunData>('run', d.data.runId) : undefined))
        .filter((r) => r !== undefined)
      return delay({ event: e, deliveries, runs: [...new Map(runs.map((r) => [r.id, r])).values()] })
    },
    ingestEvent: (body) => {
      const key = body.dedupeKey ?? `${body.source}:${JSON.stringify(body.payload)}`
      const existing = all<EventData>('event').find((e) => e.data.dedupeKey === key)
      if (existing) return delay({ event: existing, created: false })
      const id = mockId('evt', ++db.seq)
      const event = write<EventData>('event', id, {
        source: body.source,
        type: body.type,
        dedupeKey: key,
        ...(body.subject ? { subject: body.subject } : {}),
        payload: body.payload,
        receivedAt: iso(),
        routed: false,
      }) as ApiEvent
      emit('event.ingested', { event })
      return delay({ event, created: true })
    },
    triggers: () => {
      const deliveries = all<DeliveryData>('delivery')
      const out: TriggerStats[] = all<TriggerData>('trigger').map((t) => {
        const ds = deliveries.filter((d) => d.data.triggerId === t.id)
        const evs = ds
          .map((d) => get<EventData>('event', d.data.eventId))
          .filter((e) => e !== undefined)
          .sort((a, b) => b.data.receivedAt.localeCompare(a.data.receivedAt))
        const ctx = get<SessionData>('session', t.data.contextId)
        return {
          trigger: t,
          context: ctx ? { id: ctx.id, title: ctx.data.title, slug: ctx.data.slug } : null,
          employee: employeeSummary(t.data.employeeId),
          fires: ds.length,
          lastFiredAt: evs[0]?.data.receivedAt ?? null,
          recentEvents: evs.slice(0, 5).map((e) => ({
            id: e.id,
            type: e.data.type,
            ...(e.data.subject ? { subject: e.data.subject } : {}),
            receivedAt: e.data.receivedAt,
          })),
        }
      })
      return delay(out)
    },

    channels: () => {
      const msgs = all<MessageData>('message')
      return delay(
        all<ChannelData>('channel').map((c) => {
          const mine = msgs.filter((m) => m.data.channelId === c.id)
          const last =
            mine
              .map((m) => m.createdAt)
              .sort()
              .at(-1) ?? null
          return { channel: c, lastMessageAt: last, messages: mine.length }
        }),
      )
    },
    createChannel: (body) => {
      const id = mockId('chn', ++db.seq)
      return delay(
        write<ChannelData>('channel', id, {
          name: body.name.replace(/^#/, ''),
          ...(body.topic ? { topic: body.topic } : {}),
          archived: false,
          createdBy: { type: 'contact', id: me.id },
          members: body.members ?? [{ type: 'person', id: me.id, label: me.name }],
        }),
      )
    },
    channelMessages: (id, q = {}) => {
      if (!get('channel', id)) return fail(notFound('channel'))
      const items = all<MessageData>('message')
        .filter((m) => m.data.channelId === id && m.data.threadId === null && (!q.before || m.createdAt < q.before))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return delay(items.slice(-(q.limit ?? 100)) as Message[])
    },
    thread: (id) => {
      const root = get<MessageData>('message', id)
      if (!root) return fail(notFound('thread'))
      const replies = all<MessageData>('message')
        .filter((m) => m.data.threadId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const sessions = all<SubscriptionData>('subscription')
        .filter((s) => s.data.subject.system === 'chat' && s.data.subject.ref === id)
        .map((s) => get<SessionData>('session', s.data.sessionId))
        .filter((s) => s !== undefined)
        .map((s) => ({ id: s.id, slug: s.data.slug, title: s.data.title, employee: employeeSummary(s.data.employeeId) }))
      return delay({ root: root as Message, replies: replies as Message[], sessions })
    },
    postMessage: (channelId, body) => {
      if (!get('channel', channelId)) return fail(notFound('channel'))
      const tags: MessageData['tags'] = []
      for (const m of body.text.matchAll(/@([a-z][a-z0-9-]*)(?:#([a-z0-9-]+))?/g)) {
        const emp = all<EmployeeData>('employee').find((e) => employeeSlug(e.id) === m[1])
        if (emp && m[2]) {
          const s = all<SessionData>('session').find((x) => x.data.employeeId === emp.id && x.data.slug === m[2])
          tags.push({ type: 'session', id: s?.id ?? emp.id, text: m[0] })
        } else if (emp) tags.push({ type: 'employee', id: emp.id, text: m[0] })
        else tags.push({ type: 'person', id: m[1]!, text: m[0] })
      }
      let files: MessageData['attachments'] = []
      try {
        files = body.attachments?.length ? attachments.take(body.attachments) : []
      } catch (e) {
        return fail(e as Error)
      }
      const id = mockId('msg', ++db.seq)
      const message = write<MessageData>('message', id, {
        channelId,
        threadId: body.threadId ?? null,
        author: { type: 'person', id: me.id, name: me.name },
        text: body.text,
        tags,
        mentions: [],
        ...(files.length ? { attachments: files } : {}),
      }) as Message
      if (body.threadId) {
        const root = get<MessageData>('message', body.threadId)
        if (root)
          write<MessageData>('message', root.id, {
            ...root.data,
            replyCount: (root.data.replyCount ?? 0) + 1,
            lastReplyAt: iso(),
          })
      }
      emit('chat.message', { channelId, message })
      chatActivity.onPosted(message)
      return delay(message)
    },
    addMember: (channelId, member) => {
      const c = get<ChannelData>('channel', channelId)
      if (!c) return fail(notFound('channel'))
      if (c.data.members.some((m) => m.id === member.id)) return delay(c)
      const label = member.label ?? (find(member.id)?.data as { name?: string } | undefined)?.name ?? member.id
      return delay(write<ChannelData>('channel', channelId, { ...c.data, members: [...c.data.members, { ...member, label }] }))
    },

    editMessage: (id, text) => {
      const m = get<MessageData>('message', id)
      if (!m) return fail(notFound('message'))
      if (m.data.author.id !== me.id) return fail(new ApiRequestError(403, 'denied', 'only the author can edit a message'))
      const next = write<MessageData>('message', id, { ...m.data, text, editedAt: iso() }) as Message
      emit('chat.message', { channelId: m.data.channelId, message: next })
      return delay(next)
    },
    deleteMessage: (id) => {
      const m = get<MessageData>('message', id)
      if (!m) return fail(notFound('message'))
      if (m.data.author.id !== me.id) return fail(new ApiRequestError(403, 'denied', 'only the author can delete a message'))
      attachments.drop(m.data.attachments)
      const next = write<MessageData>('message', id, {
        ...m.data,
        text: '',
        deleted: true,
        tags: [],
        attachments: undefined,
      }) as Message
      emit('chat.message', { channelId: m.data.channelId, message: next })
      return delay(next)
    },
    addReaction: (id, emoji) => react(id, emoji, true),
    removeReaction: (id, emoji) => react(id, emoji, false),
    markRead: (scope) => {
      reads.set(scope, iso())
      return delay(undefined)
    },
    unread: () =>
      delay(
        all<ChannelData>('channel')
          .filter((c) => !c.data.archived)
          .map((c) => {
            const since = reads.get(c.id) ?? ''
            const mine = all<MessageData>('message').filter(
              (m) => m.data.channelId === c.id && m.data.author.id !== me.id && !m.data.deleted && m.createdAt > since,
            )
            return {
              channelId: c.id,
              unread: mine.length,
              mentions: mine.filter((m) => m.data.tags.some((t) => t.id === me.id)).length,
              lastReadAt: reads.get(c.id) ?? null,
            }
          }),
      ),
    openDm: (members) => {
      const ids = [...new Set([me.id, ...members.map((m) => m.id)])].sort()
      const existing = all<ChannelData>('channel').find(
        (c) => c.data.dm && [...new Set(c.data.members.map((m) => m.id))].sort().join(',') === ids.join(','),
      )
      if (existing) return delay(existing)
      const id = mockId('chn', ++db.seq)
      const label = (mid: string) => (find(mid)?.data as { name?: string } | undefined)?.name ?? mid
      return delay(
        write<ChannelData>('channel', id, {
          name: `dm-${id.slice(-6).toLowerCase()}`,
          dm: true,
          archived: false,
          createdBy: { type: 'contact', id: me.id },
          members: [
            { type: 'person', id: me.id, label: me.name },
            ...members.map((m) => ({
              type: (m.kind === 'employee'
                ? 'employee'
                : m.kind === 'session'
                  ? 'session'
                  : 'person') as ChannelData['members'][number]['type'],
              id: m.id,
              label: label(m.id),
            })),
          ],
        }),
      )
    },
    searchChat: (q) => {
      const text = (q.text ?? '').toLowerCase()
      const hits = all<MessageData>('message')
        .filter(
          (m) =>
            !m.data.deleted &&
            (!text || m.data.text.toLowerCase().includes(text)) &&
            (!q.channelId || m.data.channelId === q.channelId) &&
            (!q.threadId || m.id === q.threadId || m.data.threadId === q.threadId) &&
            (!q.author || q.author.endsWith(m.data.author.id)) &&
            (!q.tagged || m.data.tags.some((t) => t.id === q.tagged)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, q.limit ?? 50)
      return delay(
        hits.map((m) => {
          const c = get<ChannelData>('channel', m.data.channelId)
          return {
            message: m as Message,
            channel: { id: m.data.channelId, name: c?.data.name ?? m.data.channelId, dm: c?.data.dm === true },
            threadId: m.data.threadId ?? m.id,
          }
        }),
      )
    },
    me: () => delay({ contactId: me.id, name: me.name, access: me.access ?? 'admin', via: 'session' as const }),

    authConfig: () => delay({ oidc: false }),
    logout: () => delay(undefined),
    listTokens: (q = {}) =>
      delay(
        tokens
          .filter((x) => (q.all ? true : x.contactId === (q.contactId ?? me.id)))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      ),
    createToken: (body = {}) => {
      const t = {
        id: mockId('mtk', tokens.length + 1),
        contactId: body.contactId ?? me.id,
        ...(body.name ? { name: body.name } : {}),
        createdAt: iso(),
        revoked: false,
      }
      tokens.push(t)
      return delay({ ...t, token: `mpt_mock${Math.random().toString(36).slice(2, 14)}` })
    },
    revokeToken: (id) => {
      const t = tokens.find((x) => x.id === id)
      if (!t) return fail(notFound(`token ${id}`))
      t.revoked = true
      return delay(t)
    },
    createLoginLink: (who) => {
      const c =
        'contactId' in who
          ? get<{ name: string }>('contact', who.contactId)
          : all<{ email?: string }>('contact').find((x) => x.data.email?.toLowerCase() === who.email.toLowerCase())
      if (!c) return fail(new ApiRequestError(400, 'bad_request', 'no such contact'))
      return delay({
        contactId: c.id,
        url: `${typeof location === 'undefined' ? 'http://localhost' : location.origin}/auth/login?token=mpl_mock${c.id.slice(-6)}`,
        expiresAt: new Date(db.now() + 15 * 60_000).toISOString(),
      })
    },

    usageTotals: (f) => delay(totalsFor(usageMatch(f))),
    usageBreakdown: (groupBy, f) => {
      const rows = new Map<string, UsageRow>()
      for (const u of db.usage) {
        if (!usageMatch(f)(u)) continue
        const key = groupKey(u, groupBy)
        if (!rows.has(key)) rows.set(key, { key, label: groupLabel(key, groupBy), ...emptyTotals() })
        addUsage(rows.get(key)!, u)
      }
      const list = [...rows.values()]
      if (groupBy === 'day' || groupBy === 'hour') list.sort((a, b) => a.key.localeCompare(b.key))
      else list.sort((a, b) => b.total - a.total)
      return delay({ groupBy, rows: list })
    },
    usageSeries: (interval, f = {}) => {
      const bucket = (u: UsageData) => (interval === 'day' ? u.at.slice(0, 10) : `${u.at.slice(0, 13)}:00`)
      const points = new Map<string, Record<string, number | string>>()
      const keys = new Map<string, string>()
      for (const u of db.usage) {
        if (!usageMatch(f)(u)) continue
        const t = bucket(u)
        const k = f.splitBy ? groupKey(u, f.splitBy) : 'total'
        if (!keys.has(k)) keys.set(k, f.splitBy ? groupLabel(k, f.splitBy) : 'Tokens')
        const p = points.get(t) ?? { t }
        p[k] = ((p[k] as number | undefined) ?? 0) + u.input + u.output
        points.set(t, p)
      }
      const sorted = [...points.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)))
      for (const p of sorted) for (const k of keys.keys()) p[k] ??= 0
      return delay({
        interval,
        ...(f.splitBy ? { splitBy: f.splitBy } : {}),
        keys: [...keys.entries()].map(([key, label]) => ({ key, label })),
        points: sorted as ({ t: string } & Record<string, number | string>)[],
      })
    },

    listFiles: (employeeId, dir = '/') => {
      const files = db.files.get(employeeId) ?? new Map()
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const out = new Map<string, FileEntry>()
      for (const f of files.values()) {
        if (!f.path.startsWith(prefix)) continue
        const rest = f.path.slice(prefix.length)
        const [name, ...more] = rest.split('/')
        if (!name) continue
        const p = prefix + name
        if (more.length) {
          const prev = out.get(p)
          out.set(p, {
            path: p,
            name,
            type: 'dir',
            size: (prev?.size ?? 0) + 1,
            updatedAt: prev && prev.updatedAt > f.updatedAt ? prev.updatedAt : f.updatedAt,
          })
        } else
          out.set(p, {
            path: p,
            name,
            type: 'file',
            size: new TextEncoder().encode(f.content).length,
            updatedAt: f.updatedAt,
            ...(p.startsWith('/shared/') ? { shared: { ownerEmployeeId: mockId('emp', 2), permission: 'read' as const } } : {}),
          })
      }
      return delay(
        [...out.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)),
      )
    },
    readFile: (employeeId, p) => {
      const f = db.files.get(employeeId)?.get(p)
      return f ? delay(f) : fail(notFound('file'))
    },
    writeFile: (employeeId, p, content, version) => {
      if (p.startsWith('/shared/')) return fail(new ApiRequestError(403, 'denied', 'shared read-only'))
      if (!db.files.has(employeeId)) db.files.set(employeeId, new Map())
      const files = db.files.get(employeeId)!
      const prev = files.get(p)
      if (prev && version !== undefined && prev.version !== version)
        return fail(new ApiRequestError(409, 'conflict', 'file changed', prev))
      const next = { path: p, content, version: (prev?.version ?? 0) + 1, updatedAt: iso() }
      files.set(p, next)
      return delay(next)
    },

    secrets: () => delay(db.secrets),
    putSecret: (name, _value, scope) => {
      const i = db.secrets.findIndex((s) => s.name === name && s.scope.type === scope.type && s.scope.id === scope.id)
      const info = {
        name,
        scope,
        createdAt: i >= 0 ? db.secrets[i]!.createdAt : iso(),
        updatedAt: iso(),
        uses: i >= 0 ? db.secrets[i]!.uses : 0,
      }
      if (i >= 0) db.secrets[i] = info
      else db.secrets.push(info)
      return delay(info)
    },
    deleteSecret: (name, scope) => {
      db.secrets = db.secrets.filter((s) => !(s.name === name && s.scope.type === scope.type && s.scope.id === scope.id))
      return delay(undefined)
    },

    control: () => delay(db.control),
    pauseAll: () => {
      db.control = { paused: true, pausedAt: iso(), pausedBy: { type: 'contact', id: me.id } }
      emit('control.changed', { paused: true })
      return delay(db.control)
    },
    resumeAll: () => {
      db.control = { paused: false }
      emit('control.changed', { paused: false })
      return delay(db.control)
    },
    health: () => delay({ ok: true, version: 'mock' }),
    ready: () => delay({ ok: true, checks: { database: true, queue: true, migrations: true } }),

    // Employees, SSH keys and guided integration setup (./setup.ts).
    ...createMockSetupApi({ db, iso, delay, write, get, all }),

    // MCP servers, global and per employee (./mcp.ts).
    ...createMockMcpApi({ db, iso, delay }),

    // Chat image attachments (./attachments.ts).
    ...attachments.api,

    // Projects and who works on them (./projects.ts).
    ...createMockProjectsApi({ db, iso, delay, write, get, all }),

    // Procedures: how they start, their runs and context (./procedures.ts).
    ...createMockProceduresApi({ db, iso, delay, write, get, all, whoami: () => api.me() }),

    // Memory, skills and people (./knowledge.ts).
    ...createMockKnowledgeApi({ db, iso, delay, write, get, all, me, tokens }),

    // Notification preferences (./notifications.ts).
    ...createMockNotificationsApi({ delay }),

    // Limits and pricing (./limits.ts).
    ...createMockLimitsApi({ db, iso, delay, write, get, all }),

    // Environments: live metrics, logs, processes, the desktop viewer (./environments.ts).
    ...createMockEnvironmentsApi({ db, delay, get, all, emit }),

    // Integration users the harness couldn't link to a contact by itself (./identity.ts).
    ...createMockIdentityApi({ delay }),

    // Who is working on chat threads, and a small simulation when you post (./chat-activity.ts).
    channelActivity: chatActivity.channelActivity,
  }
  return api
}
