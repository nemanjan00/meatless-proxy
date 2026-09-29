import { createHash } from 'node:crypto'
import { ConflictError, NotFoundError, ValidationError, isMpError, type Json } from '@mp/core'
import type { Procedure, ProcedureData } from '@mp/directory'
import type { Run, Session } from '@mp/sessions'
import type { Actor } from '@mp/store'
import type { ToolRegistry } from '@mp/tools'
import { Roles, createKit, type Kit } from './kit.ts'
import type { StdlibDeps } from './types.ts'

/** Role of the link from a procedure context (a session) to its procedure. */
export const CONTEXT_OF = 'context_of'
/** The first line of a procedure context's procedure entry. */
export const PROCEDURE_CONTEXT_MARK = 'You are the context for the procedure'

/** The fields of a procedure that go into its context. A change to any of them makes the context out of date. */
export const CONTEXT_FIELDS = ['name', 'applies', 'body', 'ownerId', 'approvals', 'skills', 'checklist'] as const

/** What a context was built from, as a short digest (stored in the context's `meta.procedureDigest`). */
export function procedureDigest(data: ProcedureData): string {
  const picked: Record<string, unknown> = {}
  for (const f of CONTEXT_FIELDS) picked[f] = data[f] ?? null
  return createHash('sha256').update(JSON.stringify(picked)).digest('hex').slice(0, 16)
}

/** Whether a procedure is archived (its runs are refused, its triggers are off). */
export const isArchived = (p: Procedure) => p.data.archived === true

/**
 * The procedure entry of a procedure context: when it applies, who owns it, who approves at
 * which step, and the steps. `names` turns contact ids into names (ids stay, for tools).
 */
export function procedureContextText(p: Procedure, names: Map<string, string> = new Map()): string {
  const who = (id: string) => (names.get(id) ? `${names.get(id)} (${id})` : id)
  const approvals = (p.data.approvals ?? [])
    .map((a) => {
      const by = a.contactId ? who(a.contactId) : a.role ? `someone with the role ${a.role}` : ''
      const step = typeof a.step === 'string' && a.step.trim() ? `, at: ${a.step.trim()}` : ''
      return by ? `- ${by}${step}` : ''
    })
    .filter(Boolean)
  return [
    `${PROCEDURE_CONTEXT_MARK} "${p.data.name}" (${p.id}). Every fork of you carries out one instance of it.`,
    '',
    `Applies when: ${p.data.applies}`,
    ...(p.data.ownerId ? [`Owner (ask when it's unclear or out of date): ${who(p.data.ownerId)}`] : []),
    ...(approvals.length ? ['Approvals needed (ask in a thread, and wait for an explicit yes):', ...approvals] : []),
    ...(p.data.skills?.length ? [`Skills its steps use: ${p.data.skills.join(', ')}`] : []),
    ...(p.data.checklist?.length ? [`Checklist: ${p.data.checklist.map((i) => i.text).join('; ')}`] : []),
    '',
    '## Steps',
    '',
    p.data.body?.trim() || '(no steps written down: ask the owner)',
  ].join('\n')
}

/** The state of a procedure's context. */
export interface ProcedureContextState {
  /** `ready`, `stale` (built from an older version of the procedure) or `missing` (not built yet). */
  state: 'ready' | 'stale' | 'missing'
  session: Session | null
  /** When the context was built. */
  builtAt: string | null
  /** The procedure version it was built from, when it recorded one. */
  builtFromVersion: number | null
  /** Why it's out of date, in plain words. */
  reason?: string
}

export interface StartProcedureInput {
  /** Who runs it when the context has to be built first (default: the context's employee). */
  employeeId?: string
  /** What to do, for this instance. Default: "run the procedure". */
  work?: string
  title?: string
  requesterId?: string
  actor: Actor
  /** A note on the run's cause, e.g. `run now by con_…`. */
  note?: string
}

export interface StartedProcedure {
  sessionId: string
  slug: string
  runId: string
  contextSessionId: string
}

/** Builds, checks and starts procedure contexts. Shared by `procedures.run` and the server's procedures API. */
export interface ProcedureContexts {
  /**
   * The procedure's context, built the first time it's needed for `employeeId`, with `toolset`
   * (default: the employee's router toolset). Concurrent callers get the same context.
   */
  ensure(procedureId: string, employeeId: string, opts?: { toolset?: string[]; actor?: Actor }): Promise<Session>
  /**
   * Builds a fresh context from the current procedure, the same way the first one was built, and
   * points the procedure at it. The old context is marked done; forks already running carry on.
   * Its employee and toolset are kept unless given.
   */
  rebuild(procedureId: string, opts?: { employeeId?: string; toolset?: string[]; actor?: Actor }): Promise<Session>
  /** Whether the context is built and current. */
  state(procedure: Procedure): Promise<ProcedureContextState>
  /**
   * Starts one instance, the way a trigger or `procedures.run` would: a fork of the context
   * (built first when missing), the procedure's checklist copied into it, links to the procedure,
   * its projects and the requester, and a queued run with `work` as its instruction.
   */
  start(procedureId: string, input: StartProcedureInput): Promise<StartedProcedure>
}

/** The procedure contexts service over the standard library's dependencies. */
export function createProcedureContexts(registry: ToolRegistry, deps: StdlibDeps, kit: Kit = createKit(registry, deps)) {
  const { directory, sessions, records } = deps

  const names = async (p: Procedure) => {
    const ids = [p.data.ownerId, ...(p.data.approvals ?? []).map((a) => a.contactId)].filter((x): x is string => !!x)
    const out = new Map<string, string>()
    for (const id of new Set(ids)) {
      const c = await directory.contacts.get(id)
      if (c) out.set(id, c.data.name)
    }
    return out
  }

  /** The router toolset of the employee: its router context's tools, the ones procedure forks inherit from it. */
  const defaultToolset = async (employeeId: string): Promise<string[]> => {
    const e = await directory.employees.require(employeeId)
    const router = e.data.routerSessionId ? await sessions.get(e.data.routerSessionId) : null
    return router?.data.toolset ?? []
  }

  const build = async (p: Procedure, employeeId: string, toolset: string[] | undefined, actor?: Actor) => {
    const prompt = await kit.promptFor(employeeId, p.data.projectIds ?? [])
    return sessions.create({
      employeeId,
      title: `Procedure: ${p.data.name}`,
      toolset: toolset ?? (await defaultToolset(employeeId)),
      document: `Procedure context for [[procedure:${p.id}|${p.data.name}]].`,
      entries: [
        { kind: 'system', content: { text: prompt } },
        { kind: 'system', content: { text: procedureContextText(p, await names(p)) } },
      ],
      links: [{ ref: { kind: 'procedure', id: p.id }, role: CONTEXT_OF }],
      meta: { procedureId: p.id, procedureContext: true, procedureVersion: p.version, procedureDigest: procedureDigest(p.data) },
      ...(actor ? { actor } : {}),
    })
  }

  const ensure: ProcedureContexts['ensure'] = async (procedureId, employeeId, opts = {}) => {
    let p = await directory.procedures.require(procedureId)
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = p.data.contextSessionId
      const existing = id ? await sessions.get(id) : null
      if (existing) return existing
      const s = await build(p, employeeId, opts.toolset, opts.actor)
      try {
        await directory.procedures.update(p.id, { contextSessionId: s.id }, { expectedVersion: p.version })
        return s
      } catch (e) {
        if (!isMpError(e, 'conflict')) throw e
        // Someone else created one at the same time: use theirs.
        await sessions.update(s.id, { status: 'abandoned' })
        p = await directory.procedures.require(p.id)
      }
    }
    throw new NotFoundError('procedure context', procedureId)
  }

  const rebuild: ProcedureContexts['rebuild'] = async (procedureId, opts = {}) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const p = await directory.procedures.require(procedureId)
      const old = p.data.contextSessionId ? await sessions.get(p.data.contextSessionId) : null
      const employeeId = opts.employeeId ?? old?.data.employeeId
      if (!employeeId) throw new ValidationError('the procedure has no context yet: say which employee runs it')
      const s = await build(p, employeeId, opts.toolset ?? old?.data.toolset, opts.actor)
      try {
        await directory.procedures.update(
          p.id,
          { contextSessionId: s.id },
          { expectedVersion: p.version, ...(opts.actor ? { actor: opts.actor } : {}) },
        )
      } catch (e) {
        await sessions.update(s.id, { status: 'abandoned' })
        if (!isMpError(e, 'conflict')) throw e
        continue
      }
      if (old && old.id !== s.id) await sessions.update(old.id, { status: 'done' }, opts.actor)
      return s
    }
    throw new ConflictError(`procedure ${procedureId} kept changing while its context was rebuilt`)
  }

  const state: ProcedureContexts['state'] = async (p) => {
    const session = p.data.contextSessionId ? await sessions.get(p.data.contextSessionId) : null
    if (!session) return { state: 'missing', session: null, builtAt: null, builtFromVersion: null }
    const meta = session.data.meta ?? {}
    const builtFromVersion = typeof meta.procedureVersion === 'number' ? meta.procedureVersion : null
    const base = { session, builtAt: session.createdAt, builtFromVersion }
    if (typeof meta.procedureDigest === 'string')
      return meta.procedureDigest === procedureDigest(p.data)
        ? { state: 'ready', ...base }
        : { state: 'stale', ...base, reason: 'The procedure changed after its context was built.' }
    // Contexts built before digests were recorded: did any context field change after it was built?
    const revs = await records.revisions('procedure', p.id)
    let prev: Record<string, unknown> | null = null
    for (const r of revs) {
      const data = r.data as Record<string, unknown> | null
      if (
        prev &&
        data &&
        r.at >= session.createdAt &&
        CONTEXT_FIELDS.some((f) => JSON.stringify(prev![f]) !== JSON.stringify(data[f]))
      )
        return { state: 'stale', ...base, reason: `The procedure changed on ${r.at.slice(0, 10)}, after its context was built.` }
      prev = data
    }
    return { state: 'ready', ...base }
  }

  const start: ProcedureContexts['start'] = async (procedureId, input) => {
    const p = await directory.procedures.require(procedureId)
    if (isArchived(p)) throw new ConflictError(`procedure "${p.data.name}" is archived`)
    const current = p.data.contextSessionId ? await sessions.get(p.data.contextSessionId) : null
    const employeeId = current?.data.employeeId ?? input.employeeId
    if (!employeeId) throw new ValidationError('say which employee runs this procedure (employeeId)')
    const context = current ?? (await ensure(p.id, employeeId, { actor: input.actor }))
    await kit.checkLimits(context.data.employeeId, context, 1)
    const work = input.work?.trim() || 'Run this procedure now.'
    const fork = await sessions.fork(context.id, {
      title: input.title?.trim() || `${p.data.name}: ${oneLine(input.work?.trim() || 'run now', 60)}`,
      actor: input.actor,
    })
    await kit.patchMeta(fork.id, (m) => ({ ...m, procedureId: p.id }))
    if (p.data.checklist?.length)
      await deps.checklists.fromTemplate(
        fork.id,
        p.data.checklist.map((i) => ({ ...i, addedBy: `procedure:${p.id}` })),
      )
    const act = { actor: input.actor }
    const from = { kind: 'session', id: fork.id }
    await records.link(from, { kind: 'procedure', id: p.id }, Roles.runsProcedure, {}, act)
    for (const pid of p.data.projectIds ?? []) await records.link(from, { kind: 'project', id: pid }, Roles.worksOn, {}, act)
    if (input.requesterId && (await records.get('contact', input.requesterId)))
      await records.link(from, { kind: 'contact', id: input.requesterId }, Roles.requestedBy, {}, act)
    const run: Run = await sessions.createRun({
      sessionId: fork.id,
      cause: { type: 'manual', ...(input.note ? { note: input.note } : { note: `procedure ${p.id}` }) },
      ...(input.requesterId ? { requesterId: input.requesterId } : {}),
      input: [{ kind: 'user', content: { text: `Run this procedure for the following work:\n\n${work}` } as Json }],
      actor: input.actor,
    })
    await deps.enqueueRun(run.id)
    return { sessionId: fork.id, slug: fork.data.slug, runId: run.id, contextSessionId: context.id }
  }

  return { ensure, rebuild, state, start } satisfies ProcedureContexts
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}
