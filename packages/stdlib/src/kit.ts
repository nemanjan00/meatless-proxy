import { ConflictError, NotFoundError, ValidationError, isMpError, type Json } from '@mp/core'
import type { Employee } from '@mp/directory'
import type { AssistantContent, Run, Session, SessionData } from '@mp/sessions'
import type { Actor, Entry, Ref } from '@mp/store'
import type { EffectClass, ToolContext, ToolRegistry, ToolResult } from '@mp/tools'
import { checkForkLimits } from '@mp/usage'
import { employeePrompt } from './prompt.ts'
import type { StdlibDeps } from './types.ts'

/** Record kind remembering the output of a tool call by idempotency key, so retries don't repeat the effect. */
export const ONCE_KIND = 'stdlib_once'

/** Session meta keys written by the stdlib itself. `sessions.save_metadata` can't overwrite them. */
export const RESERVED_META = ['worktrees', 'env', 'reviewFor', 'reviews', 'idem', 'skills', 'procedureId', 'realTask'] as const

/** Link roles the stdlib uses. */
export const Roles = {
  requestedBy: 'requested_by',
  createdBy: 'created_by',
  procedureFor: 'procedure_for',
  runsProcedure: 'runs_procedure',
  reviews: 'reviews',
  worksOn: 'works_on',
} as const

/** Where a session's checkout is, as recorded in `session.meta.worktrees`. */
export interface WorktreeMeta {
  key: string
  projectId: string
  repoIndex: number
  url: string
  path: string
  branch: string
  /** The commit the worktree started from. */
  baseSha: string
}

export interface EnvMeta {
  id: string
  name: string
}

export interface ParamSpec {
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolSpecInput {
  name: string
  description: string
  effect: EffectClass
  params?: ParamSpec
}

export type Handler = (args: any, ctx: ToolContext) => Promise<ToolResult>

/** Everything the tool modules share. */
export interface Kit {
  deps: StdlibDeps
  registry: ToolRegistry
  names: string[]
  tool(spec: ToolSpecInput, handler: Handler): void
  actor(ctx: ToolContext): Actor
  /** Runs `fn` once per tool call: a retry of the same call (same idempotency key) returns the first output. */
  once(name: string, ctx: ToolContext, fn: () => Promise<Json>): Promise<Json>
  /** A session of the calling employee (`NotFoundError` for anything else, so nothing leaks). */
  ownSession(id: string | undefined, ctx: ToolContext): Promise<Session>
  /** Read-modify-write of a session's meta, compare-and-swap, retried. */
  patchMeta(sessionId: string, fn: (meta: Record<string, Json>) => Record<string, Json>): Promise<Session>
  employee(id: string): Promise<Employee>
  /** The system prompt for a new session of an employee. */
  promptFor(employeeId: string, projectIds?: string[]): Promise<string>
  /** Projects linked to a session (plus the employee's scope). */
  projectsOf(session: Session): Promise<string[]>
  contactsOf(session: Session): Promise<string[]>
  /** Where to fork "at the current point": the run's tip, minus the assistant message that made this call. */
  currentPoint(ctx: ToolContext): Promise<string | null>
  /** Throws `ValidationError` when forking would break the fork limits. */
  checkLimits(employeeId: string, parent: Session | null, newChildren: number): Promise<void>
  /** Creates a run with a user instruction and queues it. */
  startRun(
    sessionId: string,
    ctx: ToolContext,
    opts: { instruction?: string; type: 'fork' | 'loop'; mode?: 'continuing' | 'ephemeral'; note?: string },
  ): Promise<Run>
}

/** A successful result. Outputs are plain JSON-able objects. */
export const ok = (output: unknown): ToolResult => ({ output: output as Json })
export const fail = (error: string, extra: Record<string, Json> = {}): ToolResult => ({
  output: { error, ...extra },
  isError: true,
})

/** Truncates long text with a note saying how much was left out. */
export function clip(text: string | null | undefined, max = 2000): string {
  const t = text ?? ''
  if (t.length <= max) return t
  return `${t.slice(0, max)}\n… [truncated: ${t.length - max} more characters]`
}

/** One line, at most `max` characters. */
export function line(text: string | null | undefined, max = 160): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

export function sessionBrief(s: Session): Record<string, Json> {
  return {
    id: s.id,
    title: s.data.title,
    slug: s.data.slug,
    status: s.data.status,
    ...(s.data.parent ? { parentId: s.data.parent.sessionId } : {}),
  }
}

export function checkRef(ref: unknown, kinds: string[], what = 'ref'): Ref {
  const r = ref as Ref
  if (!r || typeof r !== 'object' || typeof r.kind !== 'string' || typeof r.id !== 'string' || !r.id)
    throw new ValidationError(`${what} must be { kind, id }`)
  if (!kinds.includes(r.kind)) throw new ValidationError(`${what}.kind must be one of ${kinds.join(', ')}`)
  return { kind: r.kind, id: r.id }
}

export const worktreesOf = (s: Session): WorktreeMeta[] =>
  Array.isArray(s.data.meta?.worktrees) ? (s.data.meta!.worktrees as unknown as WorktreeMeta[]) : []

export const envOf = (s: Session): EnvMeta | null => {
  const e = s.data.meta?.env as unknown as EnvMeta | undefined
  return e && typeof e === 'object' && typeof e.id === 'string' ? e : null
}

/** A value at a dot path. */
export function pathValue(obj: unknown, path: string): unknown {
  let cur: any = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

const ACTIVE_STATES = ['queued', 'running', 'suspended', 'paused'] as const

export function createKit(registry: ToolRegistry, deps: StdlibDeps): Kit {
  const { records, sessions, directory } = deps
  if (!records.kinds.has(ONCE_KIND))
    records.kinds.define({
      kind: ONCE_KIND,
      prefix: 'onc',
      description: 'The output of a stdlib tool call, by idempotency key, so a retried call returns it instead of acting again.',
      core: [
        { name: 'tool', type: 'string', required: true },
        { name: 'runId', type: 'string' },
        { name: 'output', type: 'json' },
      ],
    })

  const names: string[] = []

  const kit: Kit = {
    deps,
    registry,
    names,

    tool(spec, handler) {
      registry.register(
        {
          name: spec.name,
          description: spec.description,
          effect: spec.effect,
          source: 'stdlib',
          parameters: {
            type: 'object',
            properties: spec.params?.properties ?? {},
            ...(spec.params?.required?.length ? { required: spec.params.required } : {}),
            additionalProperties: false,
          },
        },
        handler,
      )
      names.push(spec.name)
    },

    actor: (ctx) => ({ type: 'session', id: ctx.sessionId }),

    async once(name, ctx, fn) {
      const key = `${name}:${ctx.idempotencyKey}`
      const hit = await records.getByKey<{ output: Json }>(ONCE_KIND, key)
      if (hit) return hit.data.output
      const output = await fn()
      try {
        await records.create(ONCE_KIND, { tool: name, runId: ctx.runId, output }, { key })
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e
      }
      return output
    },

    async ownSession(id, ctx) {
      const sid = id ?? ctx.sessionId
      const s = await sessions.get(sid)
      if (!s || s.data.employeeId !== ctx.employeeId) throw new NotFoundError('session', sid)
      return s
    },

    async patchMeta(sessionId, fn) {
      for (let attempt = 1; ; attempt++) {
        const s = await sessions.require(sessionId)
        const meta = fn(structuredClone((s.data.meta ?? {}) as Record<string, Json>))
        try {
          return await records.update<SessionData>('session', sessionId, { meta }, { expectedVersion: s.version })
        } catch (e) {
          if (!isMpError(e, 'conflict') || attempt >= 10) throw e
        }
      }
    },

    employee: (id) => directory.employees.require(id),

    async promptFor(employeeId, projectIds = []) {
      const employee = await directory.employees.require(employeeId)
      const contact = await directory.contacts.require(employee.data.contactId)
      const scope = employee.data.scope ?? {}
      const pids = [...new Set([...(scope.projects ?? []), ...projectIds])]
      const projects = (await Promise.all(pids.map((p) => directory.projects.get(p)))).filter((p) => p !== null)
      const procedures = (await Promise.all((scope.procedures ?? []).map((p) => directory.procedures.get(p)))).filter(
        (p) => p !== null,
      )
      const skills = await deps.skills.available({ projectIds: pids })
      return employeePrompt({ employee, contact, projects, procedures, skills, now: deps.clock.iso() })
    },

    async projectsOf(session) {
      const linked = await records.linked({ kind: 'session', id: session.id }, { direction: 'out', kind: 'project' })
      const emp = await directory.employees.get(session.data.employeeId)
      return [...new Set([...linked.map((l) => l.record.id), ...(emp?.data.scope?.projects ?? [])])]
    },

    async contactsOf(session) {
      const linked = await records.linked({ kind: 'session', id: session.id }, { direction: 'out', kind: 'contact' })
      return [...new Set(linked.map((l) => l.record.id))]
    },

    async currentPoint(ctx) {
      const run = await sessions.getRun(ctx.runId)
      if (!run || run.data.sessionId !== ctx.sessionId) return (await sessions.require(ctx.sessionId)).data.head
      const path: Entry[] = await sessions.runHistory(run.id)
      for (let i = path.length - 1; i >= 0; i--) {
        const e = path[i]!
        if (e.kind !== 'assistant') continue
        const calls = (e.content as unknown as AssistantContent).toolCalls ?? []
        if (calls.some((c) => c.id === ctx.callId)) return e.parent
        break
      }
      return path.at(-1)?.id ?? run.data.base
    },

    async checkLimits(employeeId, parent, newChildren) {
      const eff = await deps.usage.limits.effective({
        employeeId,
        ...(parent ? { sessionId: parent.id, rootSessionId: parent.data.rootId } : {}),
        ...(parent?.data.template ? { templateId: parent.data.template.id } : {}),
        ...(typeof parent?.data.meta?.procedureId === 'string' ? { procedureId: parent.data.meta.procedureId } : {}),
      })
      const d = deps.config.defaults ?? {}
      const limits = {
        ...eff,
        ...(eff.maxDepth === undefined && d.maxDepth !== undefined ? { maxDepth: d.maxDepth } : {}),
        ...(eff.maxFanOut === undefined && d.maxFanOut !== undefined ? { maxFanOut: d.maxFanOut } : {}),
        ...(eff.maxConcurrentSessions === undefined && d.maxConcurrentSessions !== undefined
          ? { maxConcurrentSessions: d.maxConcurrentSessions }
          : {}),
      }
      let running = 0
      if (limits.maxConcurrentSessions !== undefined) {
        const runs = await sessions.runs({ employeeId, state: [...ACTIVE_STATES], limit: 100_000 })
        running = new Set(runs.map((r) => r.data.sessionId)).size
      }
      const children = parent && newChildren === 1 ? (await sessions.children(parent.id)).length : 0
      const check = checkForkLimits({
        depth: parent ? parent.data.depth + 1 : 0,
        fanOut: newChildren === 1 ? children + 1 : newChildren,
        runningSessions: running + newChildren,
        limits,
      })
      if (!check.ok)
        throw new ValidationError(`limit reached: ${check.reason}. Ask the requester or owner to raise it, or do less.`)
    },

    async startRun(sessionId, ctx, o) {
      const run = await sessions.createRun({
        sessionId,
        ...(o.mode ? { mode: o.mode } : {}),
        cause: { type: o.type, parentRunId: ctx.runId, ...(o.note ? { note: o.note } : {}) },
        ...(ctx.requesterId ? { requesterId: ctx.requesterId } : {}),
        ...(o.instruction ? { input: [{ kind: 'user', content: { text: o.instruction } }] } : {}),
        actor: kit.actor(ctx),
      })
      await deps.enqueueRun(run.id)
      return run
    },
  }
  return kit
}
