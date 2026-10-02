import { ConflictError, NotFoundError, ValidationError, newId, systemClock, type Clock, type EventBus, type Json } from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import { SYSTEM, type Actor, type Condition, type Entry, type Ref, type Store } from '@mp/store'
import {
  INBOX_KIND,
  RUN_KIND,
  SESSION_KIND,
  SessionRoles,
  TEMPLATE_KIND,
  inboxSchema,
  runSchema,
  sessionSchema,
  sessionSchemas,
  templateSchema,
} from './schemas.ts'
import {
  RUN_TRANSITIONS,
  SessionTopics,
  TERMINAL_RUN_STATES,
  type AssistantContent,
  type CreateSessionInput,
  type EntryKind,
  type InboxItem,
  type InboxItemData,
  type PointerContent,
  type RewindOptions,
  type Run,
  type RunData,
  type RunState,
  type RunStateChanged,
  type SearchHit,
  type Session,
  type SessionData,
  type SessionHeadChanged,
  type Sessions,
  type SummaryContent,
  type TemplateData,
  type TreeNode,
  type WaitCondition,
  type WaitResult,
} from './types.ts'
import { checkRequiredParams, fillPlaceholders, searchSnippet, searchableText, slugify } from './util.ts'

export interface SessionsOptions {
  records: Records
  clock?: Clock
  bus?: EventBus
}

export const ENTRY_KINDS: readonly EntryKind[] = ['system', 'user', 'assistant', 'tool_result', 'event', 'summary', 'pointer']

type NewEntry = { kind: EntryKind; content: Json; meta?: Record<string, Json> }

/** Everything a transaction body gets: the bound store, records bound to it, and a way to publish after commit. */
interface Tx {
  store: Store
  rec: Records
  emit(topic: string, payload: unknown): void
}

/** Who wrote an entry: merged over caller-supplied meta, so attribution can't be spoofed. */
interface Attribution {
  sessionId: string
  employeeId: string
  runId?: string
}

const MAX_ATTEMPTS = 10
const ALL = 1_000_000

const isTerminal = (s: RunState) => TERMINAL_RUN_STATES.includes(s)

/** The ids of the tool calls an assistant entry makes (none for other entries). */
const callIds = (e: Entry): string[] =>
  e.kind === 'assistant' ? ((e.content as unknown as AssistantContent).toolCalls ?? []).map((c) => c.id) : []

/** The tool call an entry answers: a tool result, or a pointer standing for one. */
const answeredBy = (e: Entry): string | undefined => {
  if (e.kind !== 'tool_result' && e.kind !== 'pointer') return undefined
  const id = (e.content as { toolCallId?: unknown } | null)?.toolCallId
  return typeof id === 'string' ? id : undefined
}

/** The calls of a path's last assistant entry that have no result after it, and that entry's index. */
function openCallsOf(path: Entry[]): { index: number; calls: string[] } {
  const index = path.findLastIndex((e) => e.kind === 'assistant')
  if (index < 0) return { index, calls: [] }
  const done = new Set(path.slice(index + 1).map(answeredBy))
  return { index, calls: callIds(path[index]!).filter((id) => !done.has(id)) }
}
const runRef = (id: string): Ref => ({ kind: RUN_KIND, id })
const sessionRef = (id: string): Ref => ({ kind: SESSION_KIND, id })

/**
 * The sessions service: sessions as pointers into the append-only entry tree,
 * runs and their state machine, waits, inbox and templates, on top of
 * `@mp/records` and the storage port.
 *
 * Every operation that writes more than one thing runs in one store
 * transaction. Compare-and-swap writes (`expectedVersion`) that lose a race
 * are retried from scratch, re-checking their preconditions; a precondition
 * that no longer holds is reported as `ConflictError`.
 */
export function createSessions(opts: SessionsOptions): Sessions {
  const { records } = opts
  const clock = opts.clock ?? systemClock
  const store = records.store
  for (const s of sessionSchemas) records.kinds.define(s)

  // Conflicts raised by our own precondition checks: never retried.
  const logical = new WeakSet<object>()
  const conflict = (message: string, details?: Record<string, unknown>) => {
    const e = new ConflictError(message, details)
    logical.add(e)
    return e
  }

  const now = () => new Date(clock.now()).toISOString()

  /** Records bound to a transaction, with the same kind schemas (incl. extensions). */
  const bind = (tx: Store): Records => {
    const r = createRecords({ store: tx })
    for (const s of [sessionSchema, runSchema, inboxSchema, templateSchema]) r.kinds.define(records.kinds.get(s.kind))
    return r
  }

  /** Runs `fn` in a transaction, retrying lost CAS races; bus messages go out after the commit. */
  async function atomic<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const queued: [string, unknown][] = []
      try {
        const value = await store.transaction((tx) => fn({ store: tx, rec: bind(tx), emit: (t, p) => void queued.push([t, p]) }))
        for (const [t, p] of queued) opts.bus?.publish(t, p)
        return value
      } catch (e) {
        if (!(e instanceof ConflictError) || logical.has(e) || attempt >= MAX_ATTEMPTS) throw e
      }
    }
  }

  // ─── Reads inside a transaction ──────────────────────────────────────────

  async function sessionIn(s: Store, id: string): Promise<Session> {
    const r = await s.records.get<SessionData>(SESSION_KIND, id)
    if (!r) throw new NotFoundError('session', id)
    return r
  }
  async function runIn(s: Store, id: string): Promise<Run> {
    const r = await s.records.get<RunData>(RUN_KIND, id)
    if (!r) throw new NotFoundError('run', id)
    return r
  }
  const pathOf = (s: Store, head: string | null): Promise<Entry[]> => (head === null ? Promise.resolve([]) : s.entries.path(head))
  const runPath = (s: Store, run: Run) => pathOf(s, run.data.tip ?? run.data.base)

  function checkEntry(e: NewEntry, i?: number) {
    const where = i === undefined ? 'entry' : `entries[${i}]`
    if (!ENTRY_KINDS.includes(e.kind)) throw new ValidationError(`${where} has unknown kind ${String(e.kind)}`)
    if (e.content === undefined) throw new ValidationError(`${where} has no content`)
  }

  const attributed = (who: Attribution, meta: Record<string, Json> | undefined, extra: Record<string, Json> = {}) => ({
    ...(meta ?? {}),
    ...extra,
    sessionId: who.sessionId,
    employeeId: who.employeeId,
    ...(who.runId ? { runId: who.runId } : {}),
  })

  async function appendOne(s: Store, parent: string | null, e: NewEntry, who: Attribution, extra?: Record<string, Json>) {
    return s.entries.append({ parent, kind: e.kind, content: e.content, meta: attributed(who, e.meta, extra) })
  }

  /** Appends entries as a chain on `parent`; returns the last one (or null when there were none). */
  async function appendChain(s: Store, parent: string | null, entries: NewEntry[], who: Attribution): Promise<Entry | null> {
    let last: Entry | null = null
    let p = parent
    for (const e of entries) {
      last = await appendOne(s, p, e, who)
      p = last.id
    }
    return last
  }

  /**
   * Entries that describe the history as it was, not the work: context notes (`meta.contextNote`) and anything
   * marked `meta.transient`. A rewind or compaction doesn't copy them into the kept part.
   */
  const isStaleOnRewrite = (e: Entry) => e.meta.transient === true || typeof e.meta.contextNote === 'number'

  /** Re-creates `entries` on top of `parent` with the same kind, content and meta (plus `copiedFrom`). */
  async function copyChain(s: Store, parent: string | null, entries: Entry[], who: Attribution): Promise<Entry | null> {
    let last: Entry | null = null
    let p = parent
    for (const e of entries) {
      last = await appendOne(s, p, { kind: e.kind as EntryKind, content: e.content, meta: e.meta }, who, { copiedFrom: e.id })
      p = last.id
    }
    return last
  }

  async function uniqueSlug(s: Store, employeeId: string, wanted: string): Promise<string> {
    const base = slugify(wanted)
    for (let n = 1; n < 10_000; n++) {
      const slug = n === 1 ? base : `${base}-${n}`
      if (!(await s.records.getByKey(SESSION_KIND, `${employeeId}:${slug}`))) return slug
    }
    throw conflict(`no free slug for ${base}`)
  }

  interface NewSession {
    employeeId: string
    title: string
    slug?: string | undefined
    parent?: SessionData['parent']
    rootId?: string
    depth?: number
    toolset: string[]
    model?: string | undefined
    document?: string | undefined
    defaultRunMode?: SessionData['defaultRunMode'] | undefined
    template?: SessionData['template']
    meta?: Record<string, Json> | undefined
    /** The head to start from (fork point), before `entries`. */
    head: string | null
    entries: NewEntry[]
    links: { ref: Ref; role: string }[]
    actor: Actor
  }

  async function createSessionIn(t: Tx, n: NewSession): Promise<Session> {
    if (!n.employeeId) throw new ValidationError('employeeId is required')
    if (!n.title?.trim()) throw new ValidationError('title is required')
    n.entries.forEach(checkEntry)
    const id = newId(sessionSchema.prefix, clock.now())
    const slug = await uniqueSlug(t.store, n.employeeId, n.slug?.trim() || n.title)
    const who = { sessionId: id, employeeId: n.employeeId }
    const last = await appendChain(t.store, n.head, n.entries, who)
    const data: SessionData = {
      title: n.title.trim(),
      slug,
      employeeId: n.employeeId,
      status: 'active',
      head: last?.id ?? n.head,
      rootId: n.rootId ?? id,
      depth: n.depth ?? 0,
      toolset: [...n.toolset],
      document: n.document ?? '',
      ...(n.parent ? { parent: n.parent } : {}),
      ...(n.template ? { template: n.template } : {}),
      ...(n.model !== undefined ? { model: n.model } : {}),
      ...(n.defaultRunMode !== undefined ? { defaultRunMode: n.defaultRunMode } : {}),
      ...(n.meta !== undefined ? { meta: n.meta } : {}),
    }
    const session = await t.rec.create<SessionData>(SESSION_KIND, data, { id, key: `${n.employeeId}:${slug}`, actor: n.actor })
    if (n.parent)
      await t.rec.link(sessionRef(id), sessionRef(n.parent.sessionId), SessionRoles.forkedFrom, {}, { actor: n.actor })
    for (const l of n.links) await t.rec.link(sessionRef(id), l.ref, l.role, {}, { actor: n.actor })
    t.emit(SessionTopics.sessionCreated, {
      sessionId: id,
      employeeId: n.employeeId,
      rootId: data.rootId,
      parentId: n.parent?.sessionId ?? null,
    })
    return session
  }

  /**
   * Where a session may be forked: any entry on its committed history, any
   * entry a run of this session wrote (including rewound-away branches), or
   * any entry on the current path of one of its runs. `null` forks an empty
   * history.
   */
  async function checkForkPoint(s: Store, session: Session, entryId: string | null): Promise<void> {
    if (entryId === null) return
    const entry = await s.entries.get(entryId)
    if (!entry) throw new NotFoundError('entry', entryId)
    if (entryId === session.data.head) return
    if ((await pathOf(s, session.data.head)).some((e) => e.id === entryId)) return
    const runId = entry.meta.runId
    if (typeof runId === 'string') {
      const r = await s.records.get<RunData>(RUN_KIND, runId)
      if (r?.data.sessionId === session.id) return
    }
    const runs = await s.records.query<RunData>(RUN_KIND, { where: { sessionId: session.id } })
    for (const r of runs.items) if ((await runPath(s, r)).some((e) => e.id === entryId)) return
    throw new ValidationError(`entry ${entryId} is not in the history of session ${session.id} or of one of its runs`)
  }

  const forkInput = (
    parent: Session,
    head: string | null,
    o: { title: string; slug?: string | undefined; toolset?: string[] | undefined; actor?: Actor | undefined },
  ): NewSession => ({
    employeeId: parent.data.employeeId,
    title: o.title,
    slug: o.slug,
    parent: { sessionId: parent.id, entryId: head },
    rootId: parent.data.rootId,
    depth: parent.data.depth + 1,
    toolset: o.toolset ?? parent.data.toolset,
    model: parent.data.model,
    defaultRunMode: parent.data.defaultRunMode,
    head,
    entries: [],
    links: [],
    actor: o.actor ?? SYSTEM,
  })

  // ─── Runs ────────────────────────────────────────────────────────────────

  function checkWait(wait: WaitCondition) {
    const ts = (v: unknown, name: string) => {
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new ValidationError(`${name} must be an ISO timestamp`)
    }
    switch (wait?.type) {
      case 'runs':
        if (!Array.isArray(wait.runIds) || !wait.runIds.length) throw new ValidationError('a runs wait needs at least one run id')
        if (wait.mode !== 'all' && wait.mode !== 'any') throw new ValidationError('wait mode must be all or any')
        if (wait.timeoutAt !== undefined) ts(wait.timeoutAt, 'timeoutAt')
        break
      case 'delivery':
        if (wait.timeoutAt !== undefined) ts(wait.timeoutAt, 'timeoutAt')
        break
      case 'timer':
        ts(wait.until, 'until')
        break
      default:
        throw new ValidationError('unknown wait type')
    }
  }

  async function transitionIn(t: Tx, runId: string, from: RunState | RunState[], to: RunState, patch: Partial<RunData> = {}) {
    const run = await runIn(t.store, runId)
    const allowedFrom = Array.isArray(from) ? from : [from]
    const cur = run.data.state
    if (!allowedFrom.includes(cur)) throw conflict(`run ${runId} is ${cur}, not ${allowedFrom.join(' or ')}`, { state: cur })
    if (!RUN_TRANSITIONS[cur].includes(to)) throw conflict(`run ${runId} can't move from ${cur} to ${to}`, { state: cur })
    const { state: _ignored, ...rest } = patch
    const next: Partial<RunData> = { ...rest, state: to }
    if (to === 'running' && !run.data.startedAt) next.startedAt = now()
    if (isTerminal(to)) next.endedAt = now()
    const ref = runRef(runId)
    if (cur === 'suspended')
      for (const l of await t.store.links.query({ from: ref, role: SessionRoles.waitsOn })) await t.store.links.unlink(l.id)
    if (to === 'suspended') {
      const wait = (next.wait ?? run.data.wait) as WaitCondition | undefined
      if (!wait) throw new ValidationError('suspending a run needs a wait condition')
      checkWait(wait)
      next.wait = wait
      if (wait.type === 'runs') {
        for (const id of wait.runIds) {
          if (id === runId) throw new ValidationError("a run can't wait for itself")
          await runIn(t.store, id)
          await t.store.links.link(ref, runRef(id), SessionRoles.waitsOn, {})
        }
      }
    }
    const updated = await t.rec.update<RunData>(RUN_KIND, runId, next, {
      expectedVersion: run.version,
      // The continuing-run key only lives while the run is not terminal.
      ...(isTerminal(to) && run.key !== null ? { key: null } : {}),
    })
    t.emit(SessionTopics.runState, {
      runId,
      sessionId: run.data.sessionId,
      employeeId: run.data.employeeId,
      from: cur,
      to,
    } satisfies RunStateChanged)
    return updated
  }

  /** Moves a run's tip, CAS on the version we read. */
  async function moveTip(t: Tx, run: Run, tip: string, extra: Partial<RunData> = {}) {
    return t.rec.update<RunData>(RUN_KIND, run.id, { tip, ...extra }, { expectedVersion: run.version })
  }

  async function liveRun(t: Tx, runId: string): Promise<Run> {
    const run = await runIn(t.store, runId)
    if (isTerminal(run.data.state)) throw conflict(`run ${runId} is ${run.data.state}`, { state: run.data.state })
    return run
  }

  const runWho = (run: Run): Attribution => ({ sessionId: run.data.sessionId, employeeId: run.data.employeeId, runId: run.id })

  /**
   * A summary entry on `toEntry`, then the kept part of the path (from `keepFrom`/after `keepAfter`, to the tip)
   * re-created on top. With neither, nothing is kept (a jump back). Shared by rewind and compact.
   */
  async function rewindIn(t: Tx, run: Run, toEntry: string, text: string, op: 'rewind' | 'compact', o: RewindOptions = {}) {
    if (!text?.trim()) throw new ValidationError('a summary is required')
    if (o.keepFrom !== undefined && o.keepAfter !== undefined) throw new ValidationError('give keepFrom or keepAfter, not both')
    const path = await runPath(t.store, run)
    const indexOf = (id: string) => {
      const i = path.findIndex((e) => e.id === id)
      if (i < 0) throw new ValidationError(`entry ${id} is not on the current path of run ${run.id}`)
      return i
    }
    const at = indexOf(toEntry)
    const collapsing = o.keepFrom !== undefined || o.keepAfter !== undefined
    let keep = path.length
    if (o.keepFrom !== undefined) keep = indexOf(o.keepFrom)
    if (o.keepAfter !== undefined) keep = indexOf(o.keepAfter) + 1
    if (collapsing && keep <= at && op === 'rewind')
      throw new ValidationError(`the kept part must come after entry ${toEntry}, the point the summary hangs on`)
    if (collapsing && keep === at + 1 && op === 'rewind')
      throw new ValidationError('nothing to collapse: the stretch between the rewind point and the kept part is empty')
    const dropped = path.slice(at + 1, keep)
    // Notes about the context as it was (its size, what to free) are stale once it changes: they aren't kept.
    const kept = path.slice(keep).filter((e) => !isStaleOnRewrite(e))

    // Never cut between a tool call and its results.
    const callsUpTo = new Set(path.slice(0, at + 1).flatMap(callIds))
    const firstCall = dropped[0] ? answeredBy(dropped[0]) : undefined
    if (firstCall !== undefined && callsUpTo.has(firstCall))
      throw new ValidationError(
        `entry ${toEntry} is between a tool call and its results: rewind to the last result of that turn, or before the call`,
      )
    // Never drop a tool call that is still waiting for its result.
    const open = openCallsOf(path)
    if (open.calls.length && open.index > at && open.index < keep)
      throw new ValidationError(`tool call ${open.calls[0]} is still waiting for its result; it can't be rewound away`)

    // Kept results whose call is collapsed bring a copy of their assistant entry, with only those calls.
    const leading: string[] = []
    for (const e of kept) {
      const id = answeredBy(e)
      if (id === undefined) break
      leading.push(id)
    }
    const owner = leading.length ? dropped.findLast((e) => callIds(e).some((id) => leading.includes(id))) : undefined
    const carriedCalls = owner ? callIds(owner).filter((id) => leading.includes(id)) : []

    const who = runWho(run)
    const content: SummaryContent = { text, rewoundTo: toEntry, replacesTip: path[path.length - 1]!.id }
    const droppedCalls = dropped.flatMap(callIds).length - carriedCalls.length
    const summary = await appendOne(t.store, toEntry, { kind: 'summary', content: content as unknown as Json }, who, {
      ...(o.meta ?? {}),
      op,
      ...(collapsing && op === 'rewind'
        ? {
            collapsedEntries: dropped.length,
            collapsedToolCalls: droppedCalls,
            collapsedFrom: dropped[0]!.id,
            collapsedTo: dropped[dropped.length - 1]!.id,
          }
        : {}),
      ...(kept.length ? { keptEntries: kept.length, keptFrom: kept[0]!.id } : {}),
    })
    let tip = summary
    if (owner) {
      const a = owner.content as unknown as AssistantContent
      const trimmed: AssistantContent = { ...a, toolCalls: (a.toolCalls ?? []).filter((c) => carriedCalls.includes(c.id)) }
      tip = await appendOne(t.store, tip.id, { kind: 'assistant', content: trimmed as unknown as Json, meta: owner.meta }, who, {
        copiedFrom: owner.id,
        trimmedCalls: true,
      })
    }
    tip = (await copyChain(t.store, tip.id, kept, who)) ?? tip
    await moveTip(t, run, tip.id)
    return tip
  }

  async function headMoved(t: Tx, session: Session, to: string | null, runId: string) {
    const updated = await t.rec.update<SessionData>(SESSION_KIND, session.id, { head: to }, { expectedVersion: session.version })
    t.emit(SessionTopics.sessionHead, { sessionId: session.id, from: session.data.head, to, runId } satisfies SessionHeadChanged)
    return updated
  }

  const inboxWhere = (sessionId: string): Condition[] => [
    { field: 'sessionId', op: 'eq', value: sessionId },
    { field: 'consumed', op: 'eq', value: false },
  ]

  // ─── The service ─────────────────────────────────────────────────────────

  const svc: Sessions = {
    create: (input: CreateSessionInput) =>
      atomic((t) =>
        createSessionIn(t, {
          employeeId: input.employeeId,
          title: input.title,
          slug: input.slug,
          toolset: input.toolset ?? [],
          model: input.model,
          document: input.document,
          defaultRunMode: input.defaultRunMode,
          meta: input.meta,
          head: null,
          entries: input.entries ?? [],
          links: input.links ?? [],
          actor: input.actor ?? SYSTEM,
        }),
      ),

    get: (id) => records.get<SessionData>(SESSION_KIND, id),
    require: (id) => records.require<SessionData>(SESSION_KIND, id),
    bySlug: (employeeId, slug) => records.getByKey<SessionData>(SESSION_KIND, `${employeeId}:${slug}`),

    async query(q) {
      const where: Condition[] = []
      if (q.employeeId) where.push({ field: 'employeeId', op: 'eq', value: q.employeeId })
      if (q.status) where.push({ field: 'status', op: 'in', value: Array.isArray(q.status) ? q.status : [q.status] })
      if (q.rootId) where.push({ field: 'rootId', op: 'eq', value: q.rootId })
      if (q.ids) {
        if (!q.ids.length) return { items: [], total: 0 }
        where.push({ field: 'id', op: 'in', value: q.ids })
      }
      if (q.excludeRoles?.length) where.push({ field: 'meta.role', op: 'nin', value: q.excludeRoles })
      const orderBy = q.orderBy ?? { field: 'createdAt', dir: 'desc' }
      if (!['createdAt', 'updatedAt', 'title'].includes(orderBy.field))
        throw new ValidationError(`cannot order sessions by ${orderBy.field}`)
      return records.query<SessionData>(SESSION_KIND, {
        where,
        ...(q.text ? { text: q.text } : {}),
        orderBy: { field: orderBy.field, dir: orderBy.dir ?? 'desc' },
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      })
    },

    async update(id, patch, actor) {
      const allowed = ['title', 'status', 'document', 'meta', 'model', 'toolset'] as const
      const clean: Partial<SessionData> = {}
      for (const k of allowed) if (k in patch) (clean as any)[k] = patch[k]
      if ('title' in clean && !clean.title?.trim()) throw new ValidationError('title is required')
      return records.update<SessionData>(SESSION_KIND, id, clean, { actor: actor ?? SYSTEM })
    },

    async history(sessionId) {
      const s = await svc.require(sessionId)
      return pathOf(store, s.data.head)
    },

    async tree(sessionId) {
      const s = await svc.require(sessionId)
      const all = await records.query<SessionData>(SESSION_KIND, { where: { rootId: s.data.rootId }, limit: ALL })
      const byParent = new Map<string, Session[]>()
      for (const x of all.items) {
        const p = x.data.parent?.sessionId
        if (p) byParent.set(p, [...(byParent.get(p) ?? []), x])
      }
      const root = all.items.find((x) => x.id === s.data.rootId) ?? (await svc.require(s.data.rootId))
      const build = (session: Session): TreeNode => ({ session, children: (byParent.get(session.id) ?? []).map(build) })
      return build(root)
    },

    async children(sessionId) {
      await svc.require(sessionId)
      const r = await records.query<SessionData>(SESSION_KIND, { where: { 'parent.sessionId': sessionId }, limit: ALL })
      return r.items
    },

    fork: (sessionId, o = {}) =>
      atomic(async (t) => {
        const parent = await sessionIn(t.store, sessionId)
        const at = o.atEntry === undefined ? parent.data.head : o.atEntry
        await checkForkPoint(t.store, parent, at)
        return createSessionIn(
          t,
          forkInput(parent, at, {
            title: o.title ?? `${parent.data.title} (fork)`,
            slug: o.slug,
            toolset: o.toolset,
            actor: o.actor,
          }),
        )
      }),

    loop: (sessionId, items, o = {}) =>
      atomic(async (t) => {
        const parent = await sessionIn(t.store, sessionId)
        const at = o.atEntry === undefined ? parent.data.head : o.atEntry
        await checkForkPoint(t.store, parent, at)
        const prefix = o.titlePrefix ?? parent.data.title
        const out: Session[] = []
        for (const [i, item] of items.entries()) {
          const text = o.render ? o.render(item, i) : JSON.stringify(item)
          const input = forkInput(parent, at, { title: `${prefix} #${i + 1}`, actor: o.actor })
          input.entries = [{ kind: 'user', content: { text }, meta: { loopIndex: i, loopItem: item } }]
          input.meta = { loop: { index: i, item } }
          out.push(await createSessionIn(t, input))
        }
        return out
      }),

    async search(q) {
      if (!q.text?.trim()) throw new ValidationError('search text is required')
      const meta: Record<string, Json | Json[]> = {}
      if (q.employeeId) meta.employeeId = q.employeeId
      if (q.sessionIds) {
        if (!q.sessionIds.length) return { items: [], total: 0 }
        meta.sessionId = q.sessionIds
      }
      const res = await store.entries.search({
        text: q.text,
        ...(q.allWords ? { allWords: true } : {}),
        ...(q.kinds ? { kinds: q.kinds } : {}),
        meta,
        ...(q.excludeSessionIds?.length ? { excludeMeta: { sessionId: q.excludeSessionIds } } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      })
      const cache = new Map<string, Promise<Session | null>>()
      const items: SearchHit[] = []
      for (const entry of res.items) {
        const sessionId = typeof entry.meta.sessionId === 'string' ? entry.meta.sessionId : ''
        if (sessionId && !cache.has(sessionId)) cache.set(sessionId, svc.get(sessionId))
        const session = sessionId ? await cache.get(sessionId)! : null
        items.push({ entry, sessionId, session, snippet: searchSnippet(searchableText(entry.content), q.text, q.allWords) })
      }
      return { items, total: res.total }
    },

    searchSessions: (text, o = {}) =>
      svc.query({ text, ...(o.employeeId ? { employeeId: o.employeeId } : {}), limit: o.limit ?? 50, offset: o.offset ?? 0 }),

    // ─── runs ───

    createRun: (input) =>
      atomic(async (t) => {
        const session = await sessionIn(t.store, input.sessionId)
        const mode = input.mode ?? session.data.defaultRunMode ?? 'continuing'
        const key = mode === 'continuing' ? `continuing:${session.id}` : undefined
        if (mode === 'continuing') {
          const active = await activeContinuingIn(t.store, session.id)
          if (active)
            throw conflict(`session ${session.id} already has an active continuing run ${active.id}`, { runId: active.id })
        }
        const input_ = input.input ?? []
        input_.forEach(checkEntry)
        if (input.priority !== undefined && typeof input.priority !== 'number')
          throw new ValidationError('priority must be a number')
        const id = newId(runSchema.prefix, clock.now())
        const last = await appendChain(t.store, session.data.head, input_, {
          sessionId: session.id,
          employeeId: session.data.employeeId,
          runId: id,
        })
        const data: RunData = {
          sessionId: session.id,
          employeeId: session.data.employeeId,
          rootSessionId: session.data.rootId,
          mode,
          state: 'queued',
          base: session.data.head,
          tip: last?.id ?? null,
          cause: input.cause,
          priority: input.priority ?? 0,
          steps: 0,
          ...(input.requesterId ? { requesterId: input.requesterId } : {}),
        }
        return t.rec.create<RunData>(RUN_KIND, data, { id, ...(key ? { key } : {}), actor: input.actor ?? SYSTEM })
      }),

    getRun: (id) => records.get<RunData>(RUN_KIND, id),
    requireRun: (id) => records.require<RunData>(RUN_KIND, id),

    async runs(q) {
      const where: Condition[] = []
      if (q.sessionId) where.push({ field: 'sessionId', op: 'eq', value: q.sessionId })
      if (q.employeeId) where.push({ field: 'employeeId', op: 'eq', value: q.employeeId })
      if (q.rootSessionId) where.push({ field: 'rootSessionId', op: 'eq', value: q.rootSessionId })
      if (q.state) where.push({ field: 'state', op: 'in', value: Array.isArray(q.state) ? q.state : [q.state] })
      const r = await records.query<RunData>(RUN_KIND, {
        where,
        orderBy: { field: 'createdAt', ...(q.newestFirst ? { dir: 'desc' as const } : {}) },
        limit: q.limit ?? ALL,
        ...(q.offset ? { offset: q.offset } : {}),
      })
      return r.items
    },

    activeContinuingRun: (sessionId) => activeContinuingIn(store, sessionId),

    transition: (runId, from, to, patch) => atomic((t) => transitionIn(t, runId, from, to, patch)),

    async updateRun(runId, patch) {
      if ('state' in patch) throw new ValidationError('updateRun cannot change the state, use transition')
      return atomic(async (t) => {
        await runIn(t.store, runId)
        return t.rec.update<RunData>(RUN_KIND, runId, patch as Partial<RunData>)
      })
    },

    async runHistory(runId) {
      return runPath(store, await svc.requireRun(runId))
    },

    append: (runId, entry) =>
      atomic(async (t) => {
        checkEntry(entry)
        const run = await liveRun(t, runId)
        const e = await appendOne(t.store, run.data.tip ?? run.data.base, entry, runWho(run))
        await moveTip(t, run, e.id)
        return e
      }),

    commit: (runId) =>
      atomic(async (t) => {
        const run = await runIn(t.store, runId)
        const session = await sessionIn(t.store, run.data.sessionId)
        if (run.data.committed) {
          if (run.data.committed.as === 'full') return session
          throw conflict(`run ${runId} was already committed as a summary`)
        }
        if (run.data.tip === null) return session
        if (session.data.head !== run.data.base)
          throw conflict(`session ${session.id} head moved since run ${runId} started`, {
            head: session.data.head,
            base: run.data.base,
          })
        const updated = await headMoved(t, session, run.data.tip, runId)
        await t.rec.update<RunData>(
          RUN_KIND,
          runId,
          { committed: { as: 'full', at: now(), entryId: run.data.tip } },
          { expectedVersion: run.version },
        )
        return updated
      }),

    commitSummary: (runId, summary) =>
      atomic(async (t) => {
        if (!summary?.trim()) throw new ValidationError('a summary is required')
        const run = await runIn(t.store, runId)
        if (run.data.committed) throw conflict(`run ${runId} was already committed`)
        const session = await sessionIn(t.store, run.data.sessionId)
        const content: SummaryContent = {
          text: summary,
          rewoundTo: run.data.base ?? '',
          replacesTip: run.data.tip ?? run.data.base ?? '',
        }
        const entry = await appendOne(
          t.store,
          session.data.head,
          { kind: 'summary', content: content as unknown as Json },
          runWho(run),
          {
            op: 'commitSummary',
          },
        )
        const updated = await headMoved(t, session, entry.id, runId)
        await t.rec.update<RunData>(
          RUN_KIND,
          runId,
          { committed: { as: 'summary', at: now(), entryId: entry.id } },
          { expectedVersion: run.version },
        )
        return updated
      }),

    rewind: (runId, toEntry, summary, o = {}) =>
      atomic(async (t) => rewindIn(t, await liveRun(t, runId), toEntry, summary, 'rewind', o)),

    compact: (runId, summary, o = {}) =>
      atomic(async (t) => {
        const run = await liveRun(t, runId)
        const path = await runPath(t.store, run)
        if (!path.length) throw new ValidationError(`run ${runId} has no history to compact`)
        if (o.keepFrom !== undefined && o.keepFrom === path[0]!.id)
          throw new ValidationError("compaction can't keep the first entry: it stays anyway")
        return rewindIn(t, run, path[0]!.id, summary, 'compact', {
          ...(o.keepFrom !== undefined ? { keepFrom: o.keepFrom } : {}),
          ...(o.meta ? { meta: o.meta } : {}),
        })
      }),

    offload: (runId, entryId, pointer, o = {}) =>
      atomic(async (t) => {
        if (!pointer?.text?.trim()) throw new ValidationError('a pointer needs a text')
        const run = await liveRun(t, runId)
        const path = await runPath(t.store, run)
        const i = path.findIndex((e) => e.id === entryId)
        if (i < 0) throw new ValidationError(`entry ${entryId} is not on the current path of run ${runId}`)
        if (i === 0) throw new ValidationError("the first entry of a history can't be offloaded")
        const target = path[i]!
        if (target.kind === 'pointer') throw new ValidationError(`entry ${entryId} is already a pointer`)
        const result = target.kind === 'tool_result' ? (target.content as { toolCallId?: unknown; name?: unknown }) : null
        const content: PointerContent = {
          text: pointer.text,
          original: entryId,
          ...(pointer.doc ? { doc: pointer.doc } : {}),
          ...(typeof result?.toolCallId === 'string' ? { toolCallId: result.toolCallId } : {}),
          ...(typeof result?.name === 'string' ? { toolName: result.name } : {}),
        }
        const p = await appendOne(t.store, target.parent, { kind: 'pointer', content: content as unknown as Json }, runWho(run), {
          ...(o.meta ?? {}),
          op: 'offload',
          offloadedKind: target.kind,
        })
        const tip = (await copyChain(t.store, p.id, path.slice(i + 1), runWho(run))) ?? p
        await moveTip(t, run, tip.id)
        return tip
      }),

    restore: (runId, pointerEntryId) =>
      atomic(async (t) => {
        const run = await liveRun(t, runId)
        const path = await runPath(t.store, run)
        const i = path.findIndex((e) => e.id === pointerEntryId)
        if (i < 0) throw new ValidationError(`entry ${pointerEntryId} is not on the current path of run ${runId}`)
        const ptr = path[i]!
        if (ptr.kind !== 'pointer') throw new ValidationError(`entry ${pointerEntryId} is not a pointer`)
        const originalId = (ptr.content as unknown as PointerContent).original
        const original = await t.store.entries.get(originalId)
        if (!original) throw new NotFoundError('entry', originalId)
        // The original can go straight back if it hangs off the same parent; otherwise it's re-created there.
        const back = original.parent === ptr.parent ? original : (await copyChain(t.store, ptr.parent, [original], runWho(run)))!
        const tip = (await copyChain(t.store, back.id, path.slice(i + 1), runWho(run))) ?? back
        await moveTip(t, run, tip.id)
        return tip
      }),

    // ─── waiting ───

    suspend: (runId, wait) =>
      atomic(async (t) => {
        checkWait(wait)
        return transitionIn(t, runId, 'running', 'suspended', { wait })
      }),

    async waitersOf(runId) {
      const links = await records.links({ to: runRef(runId), role: SessionRoles.waitsOn })
      const out: Run[] = []
      for (const l of links) {
        const r = await records.get<RunData>(RUN_KIND, l.from.id)
        if (r && r.data.state === 'suspended') out.push(r)
      }
      return out
    },

    async isWaitSatisfied(run) {
      const wait = run.data.wait
      if (!wait) return false
      const t = clock.now()
      if (wait.type === 'timer') return t >= Date.parse(wait.until)
      if (wait.timeoutAt && t >= Date.parse(wait.timeoutAt)) return true
      if (wait.type === 'delivery') return (await store.records.count(INBOX_KIND, inboxWhere(run.data.sessionId))) > 0
      const done = (await svc.waitResults(run)).map((r) => r.done)
      return wait.mode === 'all' ? done.every(Boolean) : done.some(Boolean)
    },

    async waitResults(run) {
      const wait = run.data.wait
      if (wait?.type !== 'runs') return []
      const out: WaitResult[] = []
      for (const id of wait.runIds) {
        const r = await records.get<RunData>(RUN_KIND, id)
        if (!r) {
          out.push({
            runId: id,
            sessionId: '',
            state: 'cancelled',
            result: { status: 'cancelled', error: 'run not found' },
            document: '',
            done: true,
          })
          continue
        }
        const s = await records.get<SessionData>(SESSION_KIND, r.data.sessionId)
        out.push({
          runId: id,
          sessionId: r.data.sessionId,
          state: r.data.state,
          ...(r.data.result ? { result: r.data.result } : {}),
          document: s?.data.document ?? '',
          done: isTerminal(r.data.state),
        })
      }
      return out
    },

    // ─── inbox ───

    async addToInbox(input) {
      const item = input as unknown as InboxItemData
      await svc.require(item.sessionId)
      const data: InboxItemData = { ...item, consumed: false }
      const key = `${item.sessionId}:${item.eventId}`
      let created: InboxItem
      try {
        created = await records.create<InboxItemData>(INBOX_KIND, data, { key })
      } catch (e) {
        // The same event delivered to the same session twice is one inbox item.
        const existing = e instanceof ConflictError ? await records.getByKey<InboxItemData>(INBOX_KIND, key) : null
        if (existing) return existing
        throw e
      }
      opts.bus?.publish(SessionTopics.inboxAdded, { itemId: created.id, sessionId: item.sessionId, eventId: item.eventId })
      return created
    },

    async inbox(sessionId) {
      const r = await records.query<InboxItemData>(INBOX_KIND, {
        where: inboxWhere(sessionId),
        orderBy: { field: 'id' },
        limit: ALL,
      })
      return r.items
    },

    takeInbox: (sessionId, runId) =>
      atomic(async (t) => {
        const run = await runIn(t.store, runId)
        if (run.data.sessionId !== sessionId) throw new ValidationError(`run ${runId} does not belong to session ${sessionId}`)
        const r = await t.store.records.query<InboxItemData>(INBOX_KIND, {
          where: inboxWhere(sessionId),
          orderBy: { field: 'id' },
        })
        const out: InboxItem[] = []
        for (const item of r.items)
          out.push(
            await t.rec.update<InboxItemData>(
              INBOX_KIND,
              item.id,
              { consumed: true, consumedByRun: runId },
              { expectedVersion: item.version },
            ),
          )
        return out
      }),

    // ─── templates ───

    async createTemplate(data, actor) {
      checkTemplate(data)
      return records.create<TemplateData>(TEMPLATE_KIND, data, { actor: actor ?? SYSTEM })
    },
    getTemplate: (id) => records.get<TemplateData>(TEMPLATE_KIND, id),
    async templates() {
      return (await records.query<TemplateData>(TEMPLATE_KIND, { orderBy: { field: 'name' }, limit: ALL })).items
    },
    async updateTemplate(id, patch, actor) {
      const cur = await records.require<TemplateData>(TEMPLATE_KIND, id)
      checkTemplate({ ...cur.data, ...patch })
      return records.update<TemplateData>(TEMPLATE_KIND, id, patch, { actor: actor ?? SYSTEM })
    },

    fromTemplate: (templateId, input) =>
      atomic(async (t) => {
        const tpl = await t.store.records.get<TemplateData>(TEMPLATE_KIND, templateId)
        if (!tpl) throw new NotFoundError('template', templateId)
        const params = input.params ?? {}
        checkRequiredParams(tpl.data.params, params)
        const declared = (tpl.data.params ?? []).map((p) => p.name)
        const fill = (s: string) => fillPlaceholders(s, params, declared)
        return createSessionIn(t, {
          employeeId: input.employeeId,
          title: input.title ?? fill(tpl.data.name),
          slug: input.slug,
          toolset: tpl.data.toolset ?? [],
          document: tpl.data.document !== undefined ? fill(tpl.data.document) : undefined,
          defaultRunMode: tpl.data.defaultRunMode,
          template: { id: tpl.id, version: tpl.version },
          meta: { templateParams: params },
          head: null,
          entries: [...(input.entriesBefore ?? []), { kind: 'system', content: { text: fill(tpl.data.instructions) } }],
          links: (tpl.data.links ?? []).map((l) => ({ ref: l.ref, role: l.role })),
          actor: input.actor ?? SYSTEM,
        })
      }),
  }

  async function activeContinuingIn(s: Store, sessionId: string): Promise<Run | null> {
    const r = await s.records.query<RunData>(RUN_KIND, {
      where: [
        { field: 'sessionId', op: 'eq', value: sessionId },
        { field: 'mode', op: 'eq', value: 'continuing' },
        { field: 'state', op: 'nin', value: [...TERMINAL_RUN_STATES] },
      ],
      orderBy: { field: 'createdAt' },
      limit: 1,
    })
    return r.items[0] ?? null
  }

  function checkTemplate(data: TemplateData) {
    if (!data.name?.trim()) throw new ValidationError('a template needs a name')
    if (typeof data.instructions !== 'string') throw new ValidationError('a template needs instructions')
    const names = (data.params ?? []).map((p) => p.name)
    const bad = names.filter((n) => !/^[A-Za-z0-9_.-]+$/.test(n ?? ''))
    if (bad.length) throw new ValidationError('invalid parameter names', bad)
    const dup = names.filter((n, i) => names.indexOf(n) !== i)
    if (dup.length) throw new ValidationError('duplicate parameter names', dup)
  }

  return svc
}
