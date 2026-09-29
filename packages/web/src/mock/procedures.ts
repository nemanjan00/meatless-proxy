import {
  type ApiRecord,
  ApiRequestError,
  CATCH_ALL_START_MESSAGE,
  type ContactData,
  type DeliveryData,
  type EmployeeData,
  type Me,
  type ProcedureContextInfo,
  type ProcedureDetail,
  type ProcedureListItem,
  type ProcedurePerson,
  type ProcedureRecordData,
  type ProcedureRun,
  type ProcedureRunCause,
  type ProcedureStart,
  type ProcedureTrigger,
  type ProceduresApi,
  type RunData,
  type SessionData,
  TERMINAL_RUN_STATES,
  type TriggerData,
  describeStart,
} from '@mp/api'
import { type MockDb, mockId } from './data.ts'
import { mockDigest, triggerShape } from './procedures-data.ts'

/** What the procedures mock borrows from the mock API. */
export interface MockProceduresHelpers {
  db: MockDb
  iso(): string
  delay<T>(v: T): Promise<T>
  write<T extends Record<string, unknown>>(kind: string, id: string, data: T): ApiRecord<T>
  get<T>(kind: string, id: string): ApiRecord<T> | undefined
  all<T>(kind: string): ApiRecord<T>[]
  /** Who is signed in (the triggers are for admins). */
  whoami(): Promise<Me>
}

type MockTrigger = ApiRecord<TriggerData & { procedureId?: string; start?: ProcedureStart; fired?: number; lastFiredAt?: string }>

const RECENT_MS = 30 * 24 * 3600 * 1000
const clip = (t: string, max = 200) => (t.length <= max ? t : `${t.slice(0, max - 1)}…`)
const fail = (status: number, code: 'not_found' | 'validation' | 'denied' | 'conflict' | 'bad_request', message: string) =>
  Promise.reject(new ApiRequestError(status, code, message))

/** Whether a start would catch every event (the server refuses those, like triggers `{}`). */
function catchAll(start: ProcedureStart): boolean {
  if (start.kind !== 'custom') return false
  const narrow = (g?: string) => !!g && g !== '*' && g !== '**'
  const has = (v: unknown) => !!v && typeof v === 'object' && Object.keys(v).length > 0
  return !(narrow(start.source) || narrow(start.type) || has(start.where) || has(start.filter))
}

/** A start from a form, checked like the server does (400 for a malformed one). */
function checkStart(start: ProcedureStart | undefined): string | null {
  if (!start || typeof start !== 'object') return 'start must be an object with a kind'
  switch (start.kind) {
    case 'channel':
      return start.channelId ? null : 'pick a channel'
    case 'tag':
      return /^@?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(start.tag ?? '')
        ? null
        : 'a tag is letters, digits, dots, dashes or underscores, e.g. access-request'
    case 'schedule':
      return (start.cron ?? '').trim().split(/\s+/).length === 5
        ? null
        : 'a schedule is a cron expression with five fields, e.g. 0 9 * * 1 (Mondays at 09:00)'
    case 'integration':
      return start.source && start.type ? null : 'pick an integration and an event'
    case 'custom':
      return null
    default:
      return 'start.kind must be channel, tag, schedule, integration or custom'
  }
}

const normal = (start: ProcedureStart): ProcedureStart =>
  start.kind === 'tag' ? { ...start, tag: start.tag.replace(/^@/, '').toLowerCase() } : start

/** An in-memory `ProceduresApi` over the mock data, behaving like the server's (packages/server/src/procedures). */
export function createMockProceduresApi(h: MockProceduresHelpers): ProceduresApi {
  const { db, delay, write, get, all } = h
  const idem = new Map<string, unknown>()

  const channelName = (id: string) => (get<{ name: string }>('channel', id)?.data.name as string | undefined) ?? undefined
  const employee = (id: string) => ({ id, name: get<EmployeeData>('employee', id)?.data.name ?? id })
  const person = (contactId: string | undefined): ProcedurePerson | null => {
    if (!contactId) return null
    const c = get<ContactData>('contact', contactId)
    if (!c) return { contactId, name: contactId, kind: 'person' }
    const kind =
      (c.data as { kind?: string; ai?: boolean }).ai || c.data.kind === 'ai' ? 'ai' : c.data.kind === 'agent' ? 'agent' : 'person'
    const emp = kind === 'ai' ? all<EmployeeData>('employee').find((e) => e.data.contactId === contactId) : undefined
    return { contactId, name: c.data.name, kind, ...(emp ? { employeeId: emp.id } : {}) }
  }
  const requireProcedure = (id: string) => get<ProcedureRecordData>('procedure', id)
  const contextsOf = (p: ApiRecord<ProcedureRecordData>) =>
    all<SessionData>('session').filter(
      (s) =>
        s.id === p.data.contextSessionId ||
        (s.data.meta?.procedure === p.id && s.data.meta?.context === true && s.data.status !== 'abandoned'),
    )
  const triggersOf = (p: ApiRecord<ProcedureRecordData>, contextIds: string[]) =>
    (all<TriggerData>('trigger') as MockTrigger[]).filter(
      (t) => t.data.procedureId === p.id || (!t.data.procedureId && contextIds.includes(t.data.contextId)),
    )
  const startOf = (t: MockTrigger): ProcedureStart => {
    if (t.data.start) return t.data.start
    const f = t.data.filters ?? {}
    if (t.data.source === 'chat' && typeof f['payload.channelId'] === 'string')
      return { kind: 'channel', channelId: f['payload.channelId'] as string }
    return { kind: 'custom', source: t.data.source, type: t.data.type, ...(Object.keys(f).length ? { where: f } : {}) }
  }
  const triggerView = (t: MockTrigger): ProcedureTrigger => {
    const start = startOf(t)
    const deliveries = all<DeliveryData>('delivery').filter((d) => d.data.triggerId === t.id)
    return {
      id: t.id,
      name: t.data.name,
      employee: employee(t.data.employeeId),
      enabled: t.data.enabled,
      start,
      description: describeStart(start, channelName),
      raw: {
        match: { source: t.data.source, type: t.data.type, ...(t.data.filters ? { where: t.data.filters } : {}) },
        ...(start.kind === 'schedule'
          ? { schedule: { cron: start.cron, ...(start.timezone ? { timezone: start.timezone } : {}) } }
          : {}),
      },
      fired: (t.data.fired ?? 0) + deliveries.length,
      lastFiredAt:
        t.data.lastFiredAt ??
        deliveries
          .map((d) => d.createdAt)
          .sort()
          .at(-1) ??
        null,
    }
  }
  const contextInfo = (p: ApiRecord<ProcedureRecordData>): ProcedureContextInfo => {
    const s = p.data.contextSessionId ? get<SessionData>('session', p.data.contextSessionId) : undefined
    if (!s) return { state: 'missing', sessionId: null, builtAt: null, builtFromVersion: null }
    const meta = s.data.meta ?? {}
    const stale = typeof meta.procedureDigest === 'string' && meta.procedureDigest !== mockDigest(p.data)
    return {
      state: stale ? 'stale' : 'ready',
      sessionId: s.id,
      slug: s.data.slug,
      employee: employee(s.data.employeeId),
      builtAt: s.createdAt,
      builtFromVersion: typeof meta.procedureVersion === 'number' ? meta.procedureVersion : null,
      ...(stale ? { reason: 'The procedure changed after its context was built.' } : {}),
    }
  }
  const causeOf = (run: ApiRecord<RunData> | undefined, triggers: MockTrigger[]): ProcedureRunCause => {
    if (!run) return { type: 'system', label: 'the harness' }
    const d = run.data as RunData & { triggerId?: string; callerSessionId?: string }
    const triggerId = d.triggerId ?? all<DeliveryData>('delivery').find((x) => x.data.runId === run.id)?.data.triggerId
    const t = triggerId ? triggers.find((x) => x.id === triggerId) : undefined
    if (t) return { type: 'trigger', label: t.data.name, id: t.id }
    if (d.callerSessionId) {
      const s = get<SessionData>('session', d.callerSessionId)
      if (s) return { type: 'session', label: s.data.title, id: s.id }
    }
    if (d.requesterId) {
      const who = person(d.requesterId)
      if (who) return { type: 'person', label: who.name, id: who.contactId }
    }
    if (d.cause.type === 'event') return { type: 'event', label: 'an event', ...(d.cause.eventId ? { id: d.cause.eventId } : {}) }
    return { type: 'system', label: d.cause.note ?? d.cause.type }
  }
  const runsOf = (
    p: ApiRecord<ProcedureRecordData>,
    contexts: ApiRecord<SessionData>[],
    triggers: MockTrigger[],
  ): ProcedureRun[] => {
    const ids = new Set(contexts.map((c) => c.id))
    const linked = new Set(db.links.filter((l) => l.role === 'runs_procedure' && l.to.id === p.id).map((l) => l.from.id))
    return all<SessionData>('session')
      .filter((s) => (s.data.parent && ids.has(s.data.parent.sessionId)) || linked.has(s.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map((s) => {
        const runs = all<RunData>('run')
          .filter((r) => r.data.sessionId === s.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        const first = runs[0]
        const last = runs.at(-1)
        const outcome = last?.data.result?.error ?? last?.data.result?.output
        return {
          sessionId: s.id,
          title: s.data.title,
          slug: s.data.slug,
          employee: employee(s.data.employeeId),
          runId: last?.id ?? null,
          state: last?.data.state ?? null,
          startedAt: first?.data.startedAt ?? first?.createdAt ?? s.createdAt,
          endedAt: last && TERMINAL_RUN_STATES.includes(last.data.state) ? (last.data.endedAt ?? last.updatedAt) : null,
          startedBy: causeOf(first, triggers),
          ...(outcome ? { outcome: clip(outcome) } : {}),
          runs: runs.length,
        }
      })
  }
  const detail = (p: ApiRecord<ProcedureRecordData>): ProcedureDetail => {
    const contexts = contextsOf(p)
    const triggers = triggersOf(
      p,
      contexts.map((c) => c.id),
    )
    const views = triggers.map(triggerView)
    const runs = runsOf(p, contexts, triggers)
    const since = new Date(db.now() - RECENT_MS).toISOString()
    const enabled = views.filter((t) => t.enabled)
    return {
      procedure: p,
      owner: person(p.data.ownerId),
      starts: enabled.length
        ? enabled.map((t) => ({ kind: t.start.kind, description: t.description }))
        : [{ kind: 'manual', description: describeStart({ kind: 'manual' }) }],
      approvals: p.data.approvals?.length ?? 0,
      runs30d: runs.filter((r) => r.startedAt >= since).length,
      lastRun: runs[0] ? { sessionId: runs[0].sessionId, state: runs[0].state, at: runs[0].startedAt } : null,
      context: contextInfo(p),
      triggers: views,
      approvers: (p.data.approvals ?? []).map((a) => ({ ...a, ...(a.contactId ? { name: person(a.contactId)?.name } : {}) })),
      runs,
    }
  }
  const listItem = (p: ApiRecord<ProcedureRecordData>): ProcedureListItem => {
    const { triggers: _t, approvers: _a, runs: _r, ...item } = detail(p)
    return item
  }

  const buildContext = (p: ApiRecord<ProcedureRecordData>, employeeId: string): ApiRecord<SessionData> => {
    const id = mockId('ses', `c${++db.seq}`)
    const router = all<SessionData>('session').find((s) => s.data.employeeId === employeeId && s.data.slug === 'router')
    const s = write<SessionData>('session', id, {
      title: `Procedure: ${p.data.name}`,
      slug: `procedure-${p.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${db.seq}`,
      employeeId,
      status: 'active',
      head: router?.data.head ?? null,
      rootId: id,
      depth: 0,
      toolset: router?.data.toolset ?? [],
      document: `Procedure context for [[procedure:${p.id}|${p.data.name}]].`,
      meta: {
        context: true,
        procedure: p.id,
        procedureContext: true,
        procedureVersion: p.version,
        procedureDigest: mockDigest(p.data),
      },
    })
    db.links.push({
      id: mockId('lnk', `c${db.seq}`),
      from: { kind: 'session', id },
      to: { kind: 'procedure', id: p.id },
      role: 'context_of',
      data: {},
      createdAt: h.iso(),
    })
    write<ProcedureRecordData>('procedure', p.id, { ...p.data, contextSessionId: id })
    return s
  }

  const addTrigger = (
    p: ApiRecord<ProcedureRecordData>,
    start: ProcedureStart,
    employeeId: string,
    contextId: string,
    name?: string,
  ) => {
    const words = describeStart(start, channelName).replace(/^When /, '')
    return write<TriggerData>('trigger', mockId('trg', `p${++db.seq}`), {
      name: name ?? words.charAt(0).toUpperCase() + words.slice(1),
      employeeId,
      contextId,
      fork: true,
      enabled: true,
      procedureId: p.id,
      start,
      ...triggerShape(start),
    })
  }

  const admin = async () => (await h.whoami()).access === 'admin'
  const refuse = (start: ProcedureStart) => {
    const bad = checkStart(start)
    if (bad) return fail(400, 'bad_request', bad)
    if (catchAll(start)) return fail(422, 'validation', CATCH_ALL_START_MESSAGE)
    return null
  }

  /** Moves a new run along (queued → running → completed), like a worker would. */
  const progress = (runId: string) => {
    if (typeof window === 'undefined') return
    const step = (state: RunData['state'], extra: Partial<RunData> = {}) => {
      const r = get<RunData>('run', runId)
      if (!r || TERMINAL_RUN_STATES.includes(r.data.state)) return
      write<RunData>('run', runId, { ...r.data, state, ...extra })
    }
    setTimeout(() => step('running'), 1200)
    setTimeout(
      () =>
        step('completed', {
          endedAt: h.iso(),
          result: { status: 'completed', output: 'Done: followed the steps and posted the result.' },
        }),
      6000,
    )
  }

  return {
    procedures(q = {}) {
      const text = q.text?.toLowerCase()
      const items = all<ProcedureRecordData>('procedure')
        .filter((p) => (q.archived || !p.data.archived) && (!q.ownerId || p.data.ownerId === q.ownerId))
        .filter((p) => !text || `${p.data.name} ${p.data.applies} ${p.data.body ?? ''}`.toLowerCase().includes(text))
        .sort((a, b) => a.data.name.localeCompare(b.data.name))
        .map(listItem)
      return delay(items)
    },
    procedure(id) {
      const p = requireProcedure(id)
      return p ? delay(detail(p)) : fail(404, 'not_found', `procedure ${id} not found`)
    },
    async createProcedure(body) {
      const key = body.idempotencyKey ? `create:${body.idempotencyKey}` : null
      if (key && idem.has(key)) {
        const p = requireProcedure(idem.get(key) as string)
        if (p) return delay({ created: false, procedure: detail(p) })
      }
      if (!body.name?.trim()) return fail(400, 'bad_request', 'name is required')
      if (!body.applies?.trim()) return fail(400, 'bad_request', 'applies is required')
      if (!get('employee', body.employeeId)) return fail(404, 'not_found', `employee ${body.employeeId} not found`)
      const starts = (body.starts ?? []).map(normal)
      if (starts.length && !(await admin()))
        return fail(403, 'denied', 'only admins decide when a procedure runs: its triggers route company events')
      for (const st of starts) {
        const bad = refuse(st)
        if (bad) return bad
      }
      const id = mockId('prc', `n${++db.seq}`)
      if (key) idem.set(key, id)
      let p = write<ProcedureRecordData>('procedure', id, {
        name: body.name.trim(),
        applies: body.applies.trim(),
        ...(body.body ? { body: body.body } : {}),
        ...(body.ownerId ? { ownerId: body.ownerId } : {}),
        ...(body.approvals?.length ? { approvals: body.approvals } : {}),
        ...(body.projectIds?.length ? { projectIds: body.projectIds } : {}),
      })
      const ctx = buildContext(p, body.employeeId)
      p = requireProcedure(id)!
      for (const st of starts) addTrigger(p, st, body.employeeId, ctx.id)
      return delay({ created: true, procedure: detail(p) })
    },
    async runProcedure(id, body = {}) {
      const p = requireProcedure(id)
      if (!p) return fail(404, 'not_found', `procedure ${id} not found`)
      if (p.data.archived) return fail(409, 'conflict', `procedure "${p.data.name}" is archived`)
      const key = body.idempotencyKey ? `run:${id}:${body.idempotencyKey}` : null
      if (key && idem.has(key)) return delay(idem.get(key) as never)
      let ctx = p.data.contextSessionId ? get<SessionData>('session', p.data.contextSessionId) : undefined
      if (!ctx) {
        if (!body.employeeId) return fail(422, 'validation', 'say which employee runs this procedure (employeeId)')
        ctx = buildContext(p, body.employeeId)
      }
      const n = ++db.seq
      const work = body.work?.trim()
      const title = `${p.data.name}: ${work ? clip(work.replace(/\s+/g, ' '), 60) : 'run now'}`
      const sid = mockId('ses', `f${n}`)
      write<SessionData>('session', sid, {
        title,
        slug: `${p.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${n}`,
        employeeId: ctx.data.employeeId,
        status: 'active',
        head: ctx.data.head,
        rootId: ctx.data.rootId,
        parent: { sessionId: ctx.id, entryId: ctx.data.head },
        depth: ctx.data.depth + 1,
        toolset: ctx.data.toolset,
        document: `# ${title}\n\n${work ?? 'Run this procedure now.'}\n`,
        meta: { procedure: p.id },
      })
      db.links.push({
        id: mockId('lnk', `f${n}`),
        from: { kind: 'session', id: sid },
        to: { kind: 'procedure', id: p.id },
        role: 'runs_procedure',
        data: {},
        createdAt: h.iso(),
      })
      const rid = mockId('run', `f${n}`)
      write<RunData>('run', rid, {
        sessionId: sid,
        employeeId: ctx.data.employeeId,
        rootSessionId: ctx.data.rootId,
        mode: 'continuing',
        state: 'queued',
        base: ctx.data.head,
        tip: ctx.data.head,
        cause: { type: 'manual', note: 'run now' },
        requesterId: (await h.whoami()).contactId,
        priority: 10,
        steps: 0,
        startedAt: h.iso(),
      })
      progress(rid)
      const out = { sessionId: sid, slug: `${n}`, runId: rid, contextSessionId: ctx.id }
      if (key) idem.set(key, out)
      return delay(out)
    },
    rebuildProcedureContext(id, body = {}) {
      const p = requireProcedure(id)
      if (!p) return fail(404, 'not_found', `procedure ${id} not found`)
      const old = p.data.contextSessionId ? get<SessionData>('session', p.data.contextSessionId) : undefined
      const employeeId = body.employeeId ?? old?.data.employeeId
      if (!employeeId) return fail(422, 'validation', 'the procedure has no context yet: say which employee runs it')
      buildContext(p, employeeId)
      if (old) write<SessionData>('session', old.id, { ...old.data, status: 'done' })
      return delay(detail(requireProcedure(id)!))
    },
    archiveProcedure(id, archived) {
      const p = requireProcedure(id)
      if (!p) return fail(404, 'not_found', `procedure ${id} not found`)
      const next = write<ProcedureRecordData>('procedure', id, { ...p.data, archived })
      if (archived)
        for (const t of triggersOf(
          next,
          contextsOf(next).map((c) => c.id),
        ))
          if (t.data.enabled) write<TriggerData>('trigger', t.id, { ...t.data, enabled: false })
      return delay(detail(requireProcedure(id)!))
    },
    async addProcedureTrigger(id, body) {
      if (!(await admin()))
        return fail(403, 'denied', 'only admins decide when a procedure runs: its triggers route company events')
      const p = requireProcedure(id)
      if (!p) return fail(404, 'not_found', `procedure ${id} not found`)
      const start = normal(body.start)
      const bad = refuse(start)
      if (bad) return bad
      const ctx = p.data.contextSessionId ? get<SessionData>('session', p.data.contextSessionId) : undefined
      const employeeId = body.employeeId ?? ctx?.data.employeeId
      if (!employeeId) return fail(422, 'validation', 'say which employee runs this procedure (employeeId)')
      addTrigger(p, start, employeeId, ctx?.id ?? '', body.name)
      return delay(detail(requireProcedure(id)!))
    },
    async updateProcedureTrigger(id, triggerId, body) {
      if (!(await admin()))
        return fail(403, 'denied', 'only admins decide when a procedure runs: its triggers route company events')
      const p = requireProcedure(id)
      if (!p) return fail(404, 'not_found', `procedure ${id} not found`)
      const t = triggersOf(
        p,
        contextsOf(p).map((c) => c.id),
      ).find((x) => x.id === triggerId)
      if (!t) return fail(404, 'not_found', `trigger ${triggerId} not found`)
      let data = { ...t.data }
      if (body.start) {
        const start = normal(body.start)
        const bad = refuse(start)
        if (bad) return bad
        const words = describeStart(start, channelName).replace(/^When /, '')
        const { filters: _f, ...rest } = data
        data = {
          ...rest,
          ...triggerShape(start),
          start,
          procedureId: p.id,
          name: body.name ?? words.charAt(0).toUpperCase() + words.slice(1),
        }
      }
      if (body.name) data.name = body.name
      if (typeof body.enabled === 'boolean') data.enabled = body.enabled
      write<TriggerData>('trigger', t.id, data)
      return delay(detail(requireProcedure(id)!))
    },
    async deleteProcedureTrigger(id, triggerId) {
      if (!(await admin()))
        return fail(403, 'denied', 'only admins decide when a procedure runs: its triggers route company events')
      const p = requireProcedure(id)
      if (!p) return fail(404, 'not_found', `procedure ${id} not found`)
      const t = triggersOf(
        p,
        contextsOf(p).map((c) => c.id),
      ).find((x) => x.id === triggerId)
      if (!t) return fail(404, 'not_found', `trigger ${triggerId} not found`)
      db.records.get('trigger')?.delete(t.id)
      return delay(detail(requireProcedure(id)!))
    },
  }
}
