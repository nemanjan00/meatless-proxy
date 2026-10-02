import { subscriptionScope } from '../subscription-presets.ts'
import { ValidationError, type Json } from '@mp/core'
import { internalSubject, subjectKey } from '@mp/events'
import {
  TERMINAL_RUN_STATES,
  contentText,
  snippet,
  type AssistantContent,
  type PointerContent,
  type Run,
  type RunMode,
  type Session,
  type SessionData,
  type TreeNode,
} from '@mp/sessions'
import type { Entry, Ref } from '@mp/store'
import { LOADED_TOOLS_META, loadedToolsOf, mcpToolName, type ToolContext } from '@mp/tools'
import { RESERVED_META, Roles, checkRef, clip, fail, line, ok, pathValue, sessionBrief, str, type Kit } from '../kit.ts'
import type { TaskSystemConfig } from '../types.ts'
import { outcomeCache, runView, sessionOutcome } from '../session-outcomes.ts'
import { registerSessionContents } from './session-contents.ts'

/** The most characters sessions.restore returns in one piece. */
const PIECE_MAX = 20_000
/** The most characters of a structured result (sessions.finish { result }). */
const RESULT_MAX = 20_000
/** Runs sessions.get lists by default, and at most. */
const RUNS_DEFAULT = 10
const RUNS_MAX = 50

/** The tool call an entry answers: a tool result, or a pointer standing for one. */
const answeredCall = (e: Entry): string | undefined =>
  e.kind === 'tool_result' || e.kind === 'pointer' ? ((e.content as { toolCallId?: string }).toolCallId ?? undefined) : undefined

/** An entry of a path by its id, or by the id of a tool call (the latest result of that call, or the pointer standing for it). */
const entryOrCall = (path: Entry[], id: string): Entry | undefined =>
  path.find((e) => e.id === id) ?? path.findLast((e) => answeredCall(e) === id)

/** The tool calls an assistant entry makes (none for other entries). */
const callsOf = (e: Entry): { id: string; name: string }[] =>
  e.kind === 'assistant' ? ((e.content as unknown as AssistantContent).toolCalls ?? []) : []

/** The index of the assistant entry that made a call, or -1. */
const callIndex = (path: Entry[], callId: string): number => path.findLastIndex((e) => callsOf(e).some((c) => c.id === callId))

/** The last index of the turn that starts at the assistant entry `i`: its results follow it. */
const turnEnd = (path: Entry[], i: number): number => {
  let j = i
  while (j + 1 < path.length && answeredCall(path[j + 1]!)) j++
  return j
}

/** The index of an entry named by its id or by a tool call id (the assistant entry that made the call), or -1. */
const turnIndex = (path: Entry[], id: string): number => {
  const i = path.findIndex((e) => e.id === id)
  if (i < 0) return callIndex(path, id)
  // A result stands for its call: the turn starts at the assistant entry.
  const answers = answeredCall(path[i]!)
  if (!answers) return i
  const j = callIndex(path.slice(0, i), answers)
  return j < 0 ? i : j
}

/**
 * Where a jump back "to a tool call" lands: after the last result of the assistant turn that made the call, so
 * the turn stays whole. An entry id lands on that entry, or on the end of its turn when it's part of one.
 */
const rewindPoint = (path: Entry[], id: string): Entry | undefined => {
  const i = turnIndex(path, id)
  if (i < 0) return undefined
  return path[callsOf(path[i]!).length ? turnEnd(path, i) : i]
}

/** Characters of an entry in a request, roughly: what the context estimates use. */
const entryChars = (e: Entry): number => JSON.stringify(e.content).length

/** The text a model saw for an entry (a tool result's output as it is rendered). */
const entryText = (e: Entry): string => {
  const c = e.content as Record<string, unknown> | null
  if (e.kind === 'tool_result') {
    const out = c?.output as Json
    const body = typeof out === 'string' ? out : JSON.stringify(out)
    return c?.isError ? `ERROR: ${body}` : body
  }
  if (c && typeof c.text === 'string') return c.text
  return JSON.stringify(c)
}

/** How far back sessions.message looks at the exchange between two sessions. */
const MESSAGE_WINDOW_MS = 15 * 60_000
/** The most two sessions may send each other within the window, in messages and characters. */
const MESSAGE_BUDGET = { count: 20, chars: 40_000 }

const LINK_KINDS = ['contact', 'project', 'session', 'procedure']
const modeProp = {
  type: 'string',
  enum: ['continuing', 'ephemeral'],
  description: 'continuing (default): the run is kept in the new session. ephemeral: discarded unless it commits.',
}
const refProp = (what: string) => ({
  type: 'object',
  description: what,
  properties: { kind: { type: 'string', enum: LINK_KINDS }, id: { type: 'string' } },
  required: ['kind', 'id'],
})
const linksProp = {
  type: 'array',
  description: 'Links to create: [{kind: contact|project|session|procedure, id, role}], e.g. role works_on or requested_by.',
  items: {
    type: 'object',
    properties: { kind: { type: 'string', enum: LINK_KINDS }, id: { type: 'string' }, role: { type: 'string' } },
    required: ['kind', 'id', 'role'],
  },
}

const checkMode = (m: unknown): RunMode | undefined => {
  if (m === undefined) return undefined
  if (m !== 'continuing' && m !== 'ephemeral') throw new ValidationError('mode must be continuing or ephemeral')
  return m
}

const parseLinks = (links: unknown): { ref: Ref; role: string }[] => {
  if (links === undefined) return []
  if (!Array.isArray(links)) throw new ValidationError('links must be a list')
  return links.map((l, i) => {
    const role = str(l?.role)
    if (!role) throw new ValidationError(`links[${i}].role is required`)
    return { ref: checkRef(l, LINK_KINDS, `links[${i}]`), role }
  })
}

const sessionRef = (id: string): Ref => ({ kind: 'session', id })

function taskTool(ts: TaskSystemConfig): string | null {
  if (ts.tool) return ts.tool
  if (ts.server && ts.createTool) return mcpToolName(ts.server, ts.createTool)
  return null
}

/** The created task's id from an MCP tool's output (JSON text, structured content, or a bare id). */
function taskIdFrom(output: Json, idPath?: string): string | null {
  let value: unknown = output
  if (typeof output === 'string') {
    try {
      value = JSON.parse(output)
    } catch {
      const t = output.trim()
      return t && !/\s/.test(t) && t.length <= 100 ? t : null
    }
  }
  const candidates = idPath ? [idPath] : ['id', 'identifier', 'issue.id', 'task.id']
  for (const p of candidates) {
    const v = pathValue(value, p)
    if (typeof v === 'string' && v) return v
    if (typeof v === 'number') return String(v)
  }
  return null
}

export function registerSessionTools(kit: Kit): void {
  const { deps } = kit
  registerSessionContents(kit)
  const { sessions, records } = deps

  /** Forks (and new sessions) keep working on the same projects and for the same people. */
  /** A fork knows what its parent knew, including the tools it loaded (tools on demand). */
  const inheritLoadedTools = async (from: Session, to: Session) => {
    const loaded = loadedToolsOf((await sessions.get(from.id))?.data.meta ?? from.data.meta)
    if (!loaded.length) return
    await kit.patchMeta(to.id, (m) => ({ ...m, [LOADED_TOOLS_META]: [...new Set([...loadedToolsOf(m), ...loaded])].sort() }))
  }

  const copyLinks = async (from: Session, to: Session, ctx: ToolContext) => {
    for (const l of await records.links({ from: sessionRef(from.id) })) {
      if (l.to.kind !== 'contact' && l.to.kind !== 'project') continue
      await records.link(sessionRef(to.id), l.to, l.role, {}, { actor: kit.actor(ctx) })
    }
  }

  const linkRequester = async (s: Session, ctx: ToolContext) => {
    if (!ctx.requesterId) return
    if (!(await records.get('contact', ctx.requesterId))) return
    await records.link(
      sessionRef(s.id),
      { kind: 'contact', id: ctx.requesterId },
      Roles.requestedBy,
      {},
      { actor: kit.actor(ctx) },
    )
  }

  const runPath = async (ctx: ToolContext): Promise<Entry[]> => {
    const run = await sessions.getRun(ctx.runId)
    if (!run || run.data.sessionId !== ctx.sessionId)
      throw new ValidationError('this tool needs to be called from a run of this session')
    return sessions.runHistory(run.id)
  }

  /**
   * Work started from a router context doesn't inherit the router's instructions and decision log:
   * it forks at the router's first entry (the employee prompt), and gets its context from the
   * instruction. The prompt prefix stays shared, so it's still cached.
   */
  /**
   * The toolset for work started from `parent`: from a router context, the employee's full toolset (the
   * router's own is routing-only, without git, environments or files); otherwise the parent's.
   */
  const workToolset = async (parent: Session): Promise<string[] | undefined> =>
    parent.data.meta?.role === 'router' && deps.toolsetFor ? deps.toolsetFor(parent.data.employeeId) : undefined

  /**
   * The run mode for work started from `parent`. Work a router context starts owns its subject, so it keeps
   * its work (continuing): a requested ephemeral mode would roll back the conversation it's meant to hold.
   */
  const workMode = (parent: Session, mode: ReturnType<typeof checkMode>) =>
    parent.data.meta?.role === 'router' ? undefined : mode

  const routerForkPoint = async (parent: Session): Promise<string | null> => {
    if (parent.data.meta?.role !== 'router') return null
    const [first] = await sessions.history(parent.id)
    return first?.id ?? null
  }

  kit.tool(
    {
      name: 'sessions.create',
      description:
        'Start a new session (not a fork: it does not see this conversation), blank or from a template, and start a run in it with an instruction. Give the new session everything it needs in the instruction. Returns sessionId and runId; use sessions.wait on the runId to get its result.',
      effect: 'idempotent',
      params: {
        properties: {
          title: { type: 'string', description: 'Short title. Defaults to the template name.' },
          instruction: { type: 'string', description: 'What the new session should do. Required without a template.' },
          templateId: { type: 'string', description: 'Create from this template (tpl_…).' },
          params: { type: 'object', description: 'Template parameters, name -> string value.' },
          links: linksProp,
          document: { type: 'string', description: 'Initial session document (markdown).' },
          slug: { type: 'string', description: 'Readable name for @employee#slug tags. Generated from the title.' },
          mode: modeProp,
        },
      },
    },
    async (a, ctx) => {
      const instruction = str(a.instruction)
      if (!a.templateId && !instruction) return fail('give an instruction (or a templateId)')
      if (!a.templateId && !str(a.title)) return fail('give a title')
      const mode = checkMode(a.mode)
      const links = parseLinks(a.links)
      const output = await kit.once('sessions.create', ctx, async () => {
        const caller = await kit.ownSession(undefined, ctx)
        await kit.checkLimits(ctx.employeeId, null, 1)
        const projectIds = links.filter((l) => l.ref.kind === 'project').map((l) => l.ref.id)
        const prompt = await kit.promptFor(ctx.employeeId, projectIds)
        let s: Session
        if (a.templateId) {
          const tpl = await sessions.getTemplate(a.templateId)
          if (!tpl) throw new ValidationError(`template ${a.templateId} not found`)
          const params: Record<string, string> = {}
          for (const [k, v] of Object.entries((a.params ?? {}) as Record<string, unknown>)) params[k] = String(v)
          s = await sessions.fromTemplate(tpl.id, {
            employeeId: ctx.employeeId,
            params,
            ...(str(a.title) ? { title: a.title } : {}),
            ...(str(a.slug) ? { slug: a.slug } : {}),
            actor: kit.actor(ctx),
            entriesBefore: [{ kind: 'system', content: { text: prompt } }],
          })
          if (!tpl.data.toolset?.length)
            s = await records.update<SessionData>(
              'session',
              s.id,
              { toolset: (await workToolset(caller)) ?? caller.data.toolset },
              { actor: kit.actor(ctx) },
            )
          if (tpl.data.checklist?.length)
            await deps.checklists.fromTemplate(
              s.id,
              tpl.data.checklist.map((i) => ({ ...i, addedBy: `template:${tpl.id}` })),
            )
          for (const l of links) await records.link(sessionRef(s.id), l.ref, l.role, {}, { actor: kit.actor(ctx) })
          if (typeof a.document === 'string') s = await sessions.update(s.id, { document: a.document }, kit.actor(ctx))
        } else {
          s = await sessions.create({
            employeeId: ctx.employeeId,
            title: a.title,
            ...(str(a.slug) ? { slug: a.slug } : {}),
            toolset: (await workToolset(caller)) ?? caller.data.toolset,
            ...(typeof a.document === 'string' ? { document: a.document } : {}),
            entries: [{ kind: 'system', content: { text: prompt } }],
            links,
            actor: kit.actor(ctx),
          })
        }
        await records.link(sessionRef(s.id), sessionRef(caller.id), Roles.createdBy, {}, { actor: kit.actor(ctx) })
        await linkRequester(s, ctx)
        const run = await kit.startRun(s.id, ctx, {
          ...(instruction ? { instruction } : {}),
          type: 'fork',
          note: 'create',
          ...(workMode(caller, mode) ? { mode: workMode(caller, mode) } : {}),
        })
        return { sessionId: s.id, slug: s.data.slug, title: s.data.title, runId: run.id }
      })
      return ok(output)
    },
  )

  kit.tool(
    {
      name: 'sessions.fork',
      description:
        'Fork this session at the current point (or at atEntry) and start a run in the fork with an instruction. The fork knows everything this session knew up to that point; this session is not affected. Returns sessionId and runId; call sessions.wait with the runId when you need the result, or keep working.',
      effect: 'idempotent',
      params: {
        properties: {
          instruction: { type: 'string', description: 'What the fork should do.' },
          title: { type: 'string' },
          atEntry: { type: 'string', description: 'Entry id to fork at. Default: the current point.' },
          sessionId: { type: 'string', description: 'Fork another of your sessions (at its head) instead of this one.' },
          mode: modeProp,
        },
        required: ['instruction'],
      },
    },
    async (a, ctx) => {
      const instruction = str(a.instruction)
      if (!instruction) return fail('instruction is required')
      const mode = checkMode(a.mode)
      const output = await kit.once('sessions.fork', ctx, async () => {
        const parent = await kit.ownSession(a.sessionId, ctx)
        await kit.checkLimits(ctx.employeeId, parent, 1)
        const at =
          a.atEntry ??
          (await routerForkPoint(parent)) ??
          (parent.id === ctx.sessionId ? await kit.currentPoint(ctx) : parent.data.head)
        const toolset = await workToolset(parent)
        const fork = await sessions.fork(parent.id, {
          atEntry: at,
          title: str(a.title) ?? `${parent.data.title}: ${line(instruction, 60)}`,
          ...(toolset ? { toolset } : {}),
          actor: kit.actor(ctx),
        })
        await copyLinks(parent, fork, ctx)
        await inheritLoadedTools(parent, fork)
        await linkRequester(fork, ctx)
        const forkMode = workMode(parent, mode)
        const run = await kit.startRun(fork.id, ctx, { instruction, type: 'fork', ...(forkMode ? { mode: forkMode } : {}) })
        return { sessionId: fork.id, slug: fork.data.slug, runId: run.id }
      })
      return ok(output)
    },
  )

  kit.tool(
    {
      name: 'sessions.loop',
      description:
        'Fan out: fork this session once per item (one child per repository, ticket, contact…) and start each child with the instruction plus its item. Returns the children with their run ids; sessions.wait on them to collect results. For results you can use without parsing text, tell the children to end with sessions.finish { output, result } and the JSON shape you want: sessions.wait returns each child\'s result as is. Fork depth, fan-out and concurrency limits apply: a loop over the limit is not started at all. With realTasks: true each item also becomes a task in the task system (a "real fork" people can see), which needs the employee\'s taskSystem to be configured.',
      effect: 'non_idempotent',
      params: {
        properties: {
          items: { type: 'array', description: 'One child per item (strings or objects).' },
          instruction: { type: 'string', description: 'What every child should do with its item.' },
          titlePrefix: { type: 'string' },
          atEntry: { type: 'string', description: 'Entry id to fork at. Default: the current point.' },
          mode: modeProp,
          realTasks: { type: 'boolean', description: 'Also create a task per item in the task system.' },
          parentTaskId: { type: 'string', description: 'With realTasks: the parent task the new tasks belong to.' },
        },
        required: ['items', 'instruction'],
      },
    },
    async (a, ctx) => {
      const items = a.items as Json[]
      const instruction = str(a.instruction)
      if (!items.length) return fail('items is empty')
      if (!instruction) return fail('instruction is required')
      const mode = checkMode(a.mode)
      const parent = await kit.ownSession(undefined, ctx)
      let ts: TaskSystemConfig | null = null
      let tool: string | null = null
      if (a.realTasks) {
        const emp = await kit.employee(ctx.employeeId)
        ts = (emp.data.taskSystem ?? null) as TaskSystemConfig | null
        tool = ts ? taskTool(ts) : null
        if (!ts || !tool)
          return fail(
            'real forks are not configured: this employee has no taskSystem (a task-creating tool). Use a plain loop, or ask an admin to configure the task system.',
          )
        if (!kit.registry.get(tool)) return fail(`the task system tool ${tool} is not registered (is its MCP server connected?)`)
      }
      await kit.checkLimits(ctx.employeeId, parent, items.length)
      const n = items.length
      const itemText = (item: Json) => (typeof item === 'string' ? item : JSON.stringify(item, null, 2))

      // Real forks: create the tasks first, so a failure starts nothing.
      const tasks: ({ system: string; id: string } | null)[] = items.map(() => null)
      if (ts && tool) {
        const system = ts.subjectSystem ?? ts.server ?? tool.split('.')[1] ?? 'tasks'
        for (const [i, item] of items.entries()) {
          const args: Record<string, unknown> = {
            ...(ts.args ?? {}),
            [ts.titleArg ?? 'title']: `${str(a.titlePrefix) ?? parent.data.title}: ${line(itemText(item), 80)}`,
            [ts.descriptionArg ?? 'description']:
              `${instruction}\n\nItem ${i + 1} of ${n}:\n${itemText(item)}\n\n(Worked on by an AI employee in harness session forked from ${parent.id}.)`,
            ...(a.parentTaskId && ts.parentArg ? { [ts.parentArg]: a.parentTaskId } : {}),
          }
          const res = await kit.registry.execute(tool, args, {
            ...ctx,
            callId: `${ctx.callId}:task${i}`,
            idempotencyKey: `${ctx.idempotencyKey}:task${i}`,
          })
          const id = res.isError ? null : taskIdFrom(res.output, ts.idPath)
          if (!id)
            return fail(`creating the task for item ${i + 1} failed; no sessions were started`, {
              toolOutput: clip(typeof res.output === 'string' ? res.output : JSON.stringify(res.output), 500),
              createdTasks: tasks.filter((t) => t !== null).map((t) => t!.id),
            })
          tasks[i] = { system, id }
        }
      }

      const at = a.atEntry ?? (await routerForkPoint(parent)) ?? (await kit.currentPoint(ctx))
      const children = await sessions.loop(parent.id, items, {
        atEntry: at,
        titlePrefix: str(a.titlePrefix) ?? parent.data.title,
        render: (item, i) => `${instruction}\n\nYour item (${i + 1} of ${n}):\n${itemText(item)}`,
        actor: kit.actor(ctx),
      })
      const toolset = await workToolset(parent)
      const out: Json[] = []
      for (const [i, child] of children.entries()) {
        if (toolset) await records.update<SessionData>('session', child.id, { toolset }, { actor: kit.actor(ctx) })
        await copyLinks(parent, child, ctx)
        await inheritLoadedTools(parent, child)
        await linkRequester(child, ctx)
        const task = tasks[i]
        if (task) {
          await deps.events.subscriptions.subscribe(child.id, task, {
            primary: true,
            ...subscriptionScope(task.system),
            actor: kit.actor(ctx),
          })
          await kit.patchMeta(child.id, (m) => ({ ...m, realTask: task }))
        }
        const childMode = workMode(parent, mode)
        const run = await kit.startRun(child.id, ctx, { type: 'loop', ...(childMode ? { mode: childMode } : {}) })
        out.push({ index: i, sessionId: child.id, slug: child.data.slug, runId: run.id, ...(task ? { task } : {}) })
      }
      return ok({ children: out, runIds: out.map((c: any) => c.runId) })
    },
  )

  kit.tool(
    {
      name: 'sessions.wait',
      description:
        "Wait until the given runs finish (mode all, or any), optionally with a timeout: this run is suspended and resumes with their outputs, and each one's structured result (sessions.finish { result }) as is (if they are already done, you get the results right away). Or, with delivery: true instead of runIds, wait for the next reply or event delivered to this session (e.g. the answer to a question asked with mcp.slack.ask); anything that already arrived answers at once. Nothing is lost while you wait; replies and events are delivered afterwards.",
      effect: 'read',
      params: {
        properties: {
          runIds: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', enum: ['all', 'any'], description: 'Default all.' },
          delivery: {
            type: 'boolean',
            description: 'Wait for the next delivery to this session (a reply, an answer, a subscribed event) instead of runs.',
          },
          timeoutSeconds: { type: 'number', description: 'Resume anyway after this long.' },
        },
      },
    },
    async (a, ctx) => {
      if (a.delivery === true) {
        if (a.runIds?.length) return fail('pass runIds or delivery, not both')
        let timeoutAt: string | undefined
        if (a.timeoutSeconds !== undefined) {
          if (!(a.timeoutSeconds > 0)) return fail('timeoutSeconds must be positive')
          timeoutAt = new Date(deps.clock.now() + a.timeoutSeconds * 1000).toISOString()
        }
        const run = await sessions.getRun(ctx.runId)
        if (run?.data.mode !== 'continuing')
          return fail('only a continuing run can wait for a delivery: end your turn instead, and the delivery starts a new run')
        return {
          output: { waitingFor: 'delivery', ...(timeoutAt ? { timeoutAt } : {}) },
          control: [{ type: 'suspend', wait: { type: 'delivery', ...(timeoutAt ? { timeoutAt } : {}) } }],
        }
      }
      if (!Array.isArray(a.runIds)) return fail('pass runIds, or delivery: true')
      const runIds = [...new Set((a.runIds as unknown[]).filter((x): x is string => typeof x === 'string'))]
      if (!runIds.length) return fail('runIds is empty')
      if (runIds.includes(ctx.runId)) return fail("a run can't wait for itself")
      const mode = a.mode ?? 'all'
      if (mode !== 'all' && mode !== 'any') return fail('mode must be all or any')
      const runs: Run[] = []
      for (const id of runIds) {
        const r = await sessions.getRun(id)
        if (!r || r.data.employeeId !== ctx.employeeId) return fail(`run ${id} not found`)
        runs.push(r)
      }
      // Already satisfied: answer right away instead of suspending.
      const done = runs.filter((r) => TERMINAL_RUN_STATES.includes(r.data.state))
      if (mode === 'all' ? done.length === runs.length : done.length > 0) {
        const results: Json[] = []
        for (const r of runs) {
          const finished = TERMINAL_RUN_STATES.includes(r.data.state)
          const doc = finished ? (await sessions.get(r.data.sessionId))?.data.document : undefined
          results.push({
            runId: r.id,
            sessionId: r.data.sessionId,
            done: finished,
            state: r.data.state,
            ...(r.data.result?.output ? { output: clip(r.data.result.output, 4000) } : {}),
            ...(r.data.result?.error ? { error: clip(r.data.result.error, 1000) } : {}),
            ...(r.data.result?.result !== undefined ? { result: r.data.result.result } : {}),
            ...(doc ? { document: clip(doc, 2000) } : {}),
          })
        }
        return ok({ finished: true, mode, results })
      }
      let timeoutAt: string | undefined
      if (a.timeoutSeconds !== undefined) {
        if (!(a.timeoutSeconds > 0)) return fail('timeoutSeconds must be positive')
        timeoutAt = new Date(deps.clock.now() + a.timeoutSeconds * 1000).toISOString()
      }
      return {
        output: { waitingFor: runIds, mode, ...(timeoutAt ? { timeoutAt } : {}) },
        control: [{ type: 'suspend', wait: { type: 'runs', runIds, mode, ...(timeoutAt ? { timeoutAt } : {}) } }],
      }
    },
  )

  const briefWithTime = (s: Session): Json => ({ ...sessionBrief(s), updatedAt: s.updatedAt })

  kit.tool(
    {
      name: 'sessions.look_up',
      description:
        'Find your sessions by id, slug (#slug), status, text in their title or document, or a link (e.g. every session linked to a project or contact). Returns ids, titles, slugs and statuses.',
      effect: 'read',
      params: {
        properties: {
          id: { type: 'string' },
          slug: { type: 'string' },
          text: { type: 'string', description: 'Text in the title, document or metadata.' },
          status: { type: 'string', enum: ['active', 'waiting', 'done', 'abandoned'] },
          linkedTo: refProp('Sessions linked to this record.'),
          role: { type: 'string', description: 'With linkedTo: only links with this role.' },
          limit: { type: 'number' },
        },
      },
    },
    async (a, ctx) => {
      const limit = Math.min(Math.max(1, a.limit ?? 20), 100)
      if (a.id) return ok({ sessions: [briefWithTime(await kit.ownSession(a.id, ctx))], total: 1 })
      if (a.slug) {
        const slug = String(a.slug).replace(/^.*#/, '')
        const s = await sessions.bySlug(ctx.employeeId, slug)
        return ok({ sessions: s ? [briefWithTime(s)] : [], total: s ? 1 : 0 })
      }
      if (a.linkedTo) {
        const ref = checkRef(a.linkedTo, LINK_KINDS, 'linkedTo')
        const linked = await records.linked<any>(ref, { direction: 'both', kind: 'session', ...(a.role ? { role: a.role } : {}) })
        const found = new Map<string, Session>()
        for (const l of linked)
          if (l.record.data.employeeId === ctx.employeeId && (!a.status || l.record.data.status === a.status))
            found.set(l.record.id, l.record as Session)
        const list = [...found.values()].slice(0, limit)
        return ok({ sessions: list.map(briefWithTime), total: found.size })
      }
      const res = await sessions.query({
        employeeId: ctx.employeeId,
        ...(a.status ? { status: a.status } : {}),
        ...(a.text ? { text: a.text } : {}),
        limit,
      })
      return ok({ sessions: res.items.map(briefWithTime), total: res.total })
    },
  )

  kit.tool(
    {
      name: 'sessions.list',
      description:
        "List your sessions, newest first, optionally by status or by tree (rootId). Each comes with its outcome: the last run's outcome, what it produced (merge requests, branches, shared files), its document's first line, and what it's waiting for (a review of its branch or merge request, a suspended run's wait).",
      effect: 'read',
      params: {
        properties: {
          status: { type: 'string', enum: ['active', 'waiting', 'done', 'abandoned'] },
          rootId: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
    async (a, ctx) => {
      const res = await sessions.query({
        employeeId: ctx.employeeId,
        ...(a.status ? { status: a.status } : {}),
        ...(a.rootId ? { rootId: a.rootId } : {}),
        limit: Math.min(Math.max(1, a.limit ?? 20), 100),
        offset: Math.max(0, a.offset ?? 0),
      })
      const cache = outcomeCache()
      const list: Json[] = []
      for (const x of res.items)
        list.push({ ...sessionBrief(x), updatedAt: x.updatedAt, ...(await sessionOutcome(deps, x, cache)) } as Json)
      return ok({ sessions: list, total: res.total })
    },
  )

  kit.tool(
    {
      name: 'sessions.search',
      description:
        "Full-text search across the histories and documents of your other sessions, to find how similar work was done before: what was said, tool call arguments (e.g. the files you wrote with git.write_file) and tool results. Every word must appear, in any order. Newest first; this session's own entries are left out (you have them) unless includeThisSession. Returns matching entries with snippets and matching sessions; read one with sessions.get.",
      effect: 'read',
      params: {
        properties: {
          text: { type: 'string', description: 'Words to find, e.g. "README parser".' },
          kinds: { type: 'array', items: { type: 'string' }, description: 'Entry kinds, e.g. ["assistant", "tool_result"].' },
          limit: { type: 'number' },
          includeThisSession: { type: 'boolean', description: "Also search this session's own entries." },
        },
        required: ['text'],
      },
    },
    async (a, ctx) => {
      const text = str(a.text)
      if (!text) return fail('text is required')
      const limit = Math.min(Math.max(1, a.limit ?? 10), 50)
      const own = a.includeThisSession === true
      const query = { text, allWords: true, employeeId: ctx.employeeId, ...(a.kinds ? { kinds: a.kinds } : {}) }
      const hits = await sessions.search({ ...query, ...(own ? {} : { excludeSessionIds: [ctx.sessionId] }), limit })
      const inThis = own ? 0 : (await sessions.search({ ...query, sessionIds: [ctx.sessionId], limit: 1 })).total
      const found = await sessions.searchSessions(text, { employeeId: ctx.employeeId, limit })
      return ok({
        entries: hits.items.map((h) => ({
          entryId: h.entry.id,
          kind: h.entry.kind,
          sessionId: h.sessionId,
          ...(h.session ? { sessionTitle: h.session.data.title } : {}),
          snippet: h.snippet,
        })),
        totalEntries: hits.total,
        ...(inThis
          ? { inThisSession: inThis, note: `${inThis} more in this session's own history: includeThisSession to list them` }
          : {}),
        sessions: found.items.map((s) => ({ ...sessionBrief(s), snippet: snippet(s.data.document || s.data.title, text) })),
      })
    },
  )

  kit.tool(
    {
      name: 'sessions.tree',
      description:
        "A session's fork tree from its root: every session with its status and outcome (the last run's outcome, what it produced, its document's first line, what it's waiting for), and which is which. Default: this session.",
      effect: 'read',
      params: { properties: { sessionId: { type: 'string' } } },
    },
    async (a, ctx) => {
      const s = await kit.ownSession(a.sessionId, ctx)
      const tree = await sessions.tree(s.id)
      let count = 0
      const MAX = 200
      const cache = outcomeCache()
      const render = async (n: TreeNode): Promise<Json> => {
        count++
        const children: Json[] = []
        for (const c of n.children) {
          if (count >= MAX) break
          children.push(await render(c))
        }
        return {
          ...sessionBrief(n.session),
          ...(await sessionOutcome(deps, n.session, cache)),
          ...(n.session.id === s.id ? { self: true } : {}),
          ...(children.length ? { children } : {}),
          ...(n.children.length > children.length ? { moreChildren: n.children.length - children.length } : {}),
        }
      }
      return ok({ tree: await render(tree), ...(count >= MAX ? { note: `showing the first ${MAX} sessions` } : {}) })
    },
  )

  kit.tool(
    {
      name: 'sessions.get',
      description:
        "A session: metadata, its document, checklist status, links, its outcome (what it produced, what it's waiting for) and its recent runs, newest first: when, who asked (name and handles), the request in one line, the outcome, and later requests that reached a run while it worked. It's the record of who asked for what: use it to answer questions about your past work. Default: this session, the last 10 runs.",
      effect: 'read',
      params: {
        properties: {
          sessionId: { type: 'string' },
          runs: { type: 'number', description: `How many runs to list (default ${RUNS_DEFAULT}, at most ${RUNS_MAX}).` },
          runsOffset: { type: 'number', description: 'Skip this many of the newest runs (paging back).' },
        },
      },
    },
    async (a, ctx) => {
      const s = await kit.ownSession(a.sessionId, ctx)
      const status = await deps.checklists.status(s.id)
      const links = await records.links({ touching: sessionRef(s.id) })
      const limit = Math.min(Math.max(1, Math.floor(Number(a.runs ?? RUNS_DEFAULT)) || RUNS_DEFAULT), RUNS_MAX)
      const runsOffset = Math.max(0, Math.floor(Number(a.runsOffset ?? 0)) || 0)
      const page = await sessions.runs({ sessionId: s.id, newestFirst: true, offset: runsOffset, limit: limit + 1 })
      const cache = outcomeCache()
      const runs: Json[] = []
      for (const r of page.slice(0, limit)) runs.push(await runView(deps, r, cache))
      const meta = { ...(s.data.meta ?? {}) }
      return ok({
        ...sessionBrief(s),
        depth: s.data.depth,
        rootId: s.data.rootId,
        ...(s.data.template ? { template: s.data.template } : {}),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        document: clip(s.data.document, 4000),
        meta:
          JSON.stringify(meta).length <= 1500 ? meta : { keys: Object.keys(meta), note: 'meta is large; showing its keys only' },
        checklist: {
          complete: status.complete,
          done: status.done,
          total: status.total,
          missing: status.missing.map((i) => ({ id: i.id, text: i.text })),
        },
        links: links
          .filter((l) => l.role !== 'mentions')
          .slice(0, 50)
          .map((l) => (l.from.id === s.id ? { role: l.role, to: l.to } : { role: l.role, from: l.from })),
        ...(await sessionOutcome(deps, s, cache)),
        runs,
        ...(page.length > limit
          ? { moreRuns: `older runs: sessions.get { runs: ${limit}, runsOffset: ${runsOffset + limit} }` }
          : {}),
      })
    },
  )

  kit.tool(
    {
      name: 'sessions.save_metadata',
      description:
        "Update a session's title, status, document (markdown: purpose, what was done, decisions, open items) or meta fields (merged). Default: this session. Keep your document current as you work.",
      effect: 'idempotent',
      params: {
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['active', 'waiting', 'done', 'abandoned'] },
          document: { type: 'string', description: 'The whole new document.' },
          meta: { type: 'object', description: 'Fields merged into the metadata; null removes a field.' },
        },
      },
    },
    async (a, ctx) => {
      const s = await kit.ownSession(a.sessionId, ctx)
      const patch: Record<string, unknown> = {}
      if (a.title !== undefined) patch.title = a.title
      if (a.status !== undefined) patch.status = a.status
      if (a.document !== undefined) patch.document = a.document
      const updated: string[] = Object.keys(patch)
      if (Object.keys(patch).length) await sessions.update(s.id, patch, kit.actor(ctx))
      if (a.meta !== undefined) {
        const bad = Object.keys(a.meta).filter((k) => (RESERVED_META as readonly string[]).includes(k))
        if (bad.length) return fail(`these meta fields are managed by the harness: ${bad.join(', ')}`)
        await kit.patchMeta(s.id, (m) => {
          for (const [k, v] of Object.entries(a.meta as Record<string, Json>)) {
            if (v === null) delete m[k]
            else m[k] = v
          }
          return m
        })
        updated.push('meta')
      }
      if (!updated.length) return fail('nothing to update')
      return ok({ sessionId: s.id, updated })
    },
  )

  const linkTool = (unlink: boolean) =>
    kit.tool(
      {
        name: unlink ? 'sessions.unlink' : 'sessions.link',
        description: unlink
          ? 'Remove a link between a session (default: this one) and a contact, project, procedure or session.'
          : 'Link a session (default: this one) to a contact, project, procedure or another session, with a role, e.g. requested_by, waiting_on, reviewer, works_on, affects, related, follows_up, blocks.',
        effect: 'idempotent',
        params: {
          properties: { ref: refProp('What to link to.'), role: { type: 'string' }, sessionId: { type: 'string' } },
          required: ['ref', 'role'],
        },
      },
      async (a, ctx) => {
        const s = await kit.ownSession(a.sessionId, ctx)
        const ref = checkRef(a.ref, LINK_KINDS)
        const role = str(a.role)
        if (!role) return fail('role is required')
        if (ref.kind === 'session' && ref.id === s.id) return fail("a session can't link to itself")
        if (unlink) await records.unlink(sessionRef(s.id), ref, role, { actor: kit.actor(ctx) })
        else await records.link(sessionRef(s.id), ref, role, {}, { actor: kit.actor(ctx) })
        return ok({ sessionId: s.id, [unlink ? 'unlinked' : 'linked']: { ...ref, role } })
      },
    )
  linkTool(false)
  linkTool(true)

  kit.tool(
    {
      name: 'sessions.save_template',
      description:
        'Turn a session (default: this one) into a template for new sessions: instructions with {{param}} placeholders, its checklist, links and tools.',
      effect: 'non_idempotent',
      params: {
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          instructions: { type: 'string', description: 'Default: the session document.' },
          params: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, description: { type: 'string' }, required: { type: 'boolean' } },
              required: ['name'],
            },
          },
          includeChecklist: { type: 'boolean', description: 'Copy the checklist items. Default true.' },
          sessionId: { type: 'string' },
        },
        required: ['name'],
      },
    },
    async (a, ctx) => {
      const s = await kit.ownSession(a.sessionId, ctx)
      const instructions = str(a.instructions) ?? str(s.data.document) ?? s.data.title
      const checklist =
        a.includeChecklist === false
          ? []
          : (await deps.checklists.forSession(s.id)).data.items.map((i) => ({
              text: i.text,
              required: i.required,
              review: i.needsReview,
            }))
      const links = (await records.links({ from: sessionRef(s.id) }))
        .filter((l) => l.to.kind === 'contact' || l.to.kind === 'project')
        .map((l) => ({ ref: l.to, role: l.role }))
      const tpl = await sessions.createTemplate(
        {
          name: a.name,
          ...(a.description ? { description: a.description } : {}),
          instructions,
          ...(a.params ? { params: a.params } : {}),
          toolset: s.data.toolset,
          ...(checklist.length ? { checklist } : {}),
          ...(links.length ? { links } : {}),
          ...(s.data.defaultRunMode ? { defaultRunMode: s.data.defaultRunMode } : {}),
        },
        kit.actor(ctx),
      )
      return ok({ templateId: tpl.id, name: tpl.data.name, version: tpl.version })
    },
  )

  kit.tool(
    {
      name: 'sessions.commit',
      description:
        'Keep this run: when it ends, its history becomes part of the session (optionally as a summary instead of the full history). Continuing runs commit by default; use this in ephemeral runs worth keeping.',
      effect: 'idempotent',
      params: { properties: { summary: { type: 'string', description: 'Commit this summary instead of the full history.' } } },
    },
    async (a) => ({
      output: { commit: true, ...(str(a.summary) ? { asSummary: true } : {}) },
      control: [{ type: 'commit', ...(str(a.summary) ? { summary: a.summary } : {}) }],
    }),
  )

  kit.tool(
    {
      name: 'sessions.discard',
      description: "Don't keep this run in the session's history when it ends. Its effects on the outside world stay.",
      effect: 'idempotent',
    },
    async () => ({ output: { discard: true }, control: [{ type: 'discard' }] }),
  )

  kit.tool(
    {
      name: 'sessions.rewind',
      description:
        'Shrink your context by replacing part of your history with a summary. The detail stays in the database. ' +
        'Collapse a stretch you are done with (the common case): give from and to, and everything from the turn of from through the results of to becomes your summary, while everything after it (later messages, your replies) stays word for word. ' +
        'E.g. you read many files: from = the id of your first read call, to = the id of the last one, summary = what you learned from them. ' +
        'Jump back after a dead end: give only from, and everything after it (after its results, for a tool call) is dropped, replaced by your summary; that includes messages after it, so put what still matters in the summary. ' +
        'from and to are ids of your earlier tool calls, in this run or earlier ones: each tool result starts with [call <id>] (entry ids work too). ' +
        "The summary is all that's left of the stretch: put in every fact, id, path, decision and open item you still need, verbatim where the rest of the work needs it (exact line numbers, quotes, figures). " +
        'The harness names finished stretches worth collapsing, with their ids, when the context grows. ' +
        'For a long-lived session, also put decisions and the current state in the session document (sessions.save_metadata { document }): it outlasts the conversation.',
      effect: 'idempotent',
      params: {
        properties: {
          from: {
            type: 'string',
            description:
              'The id of an earlier tool call of yours, as in the [call <id>] its result starts with (or an entry id): where the stretch starts, or where to jump back to.',
          },
          to: {
            type: 'string',
            description:
              'The id of a later tool call of yours (or an entry id): the stretch ends after its results. Leave it out to jump back instead.',
          },
          summary: { type: 'string', description: 'What the stretch did and found: everything from it you still need.' },
          toEntry: { type: 'string', description: 'Older name of from, for a jump back.' },
        },
        required: ['summary'],
      },
    },
    async (a, ctx) => {
      const summary = str(a.summary)
      if (!summary) return fail('summary is required')
      const fromId = str(a.from) ?? str(a.toEntry)
      if (!fromId) return fail('from is required: the id of one of your earlier tool calls, or an entry id')
      const toId = str(a.to)
      if (fromId === ctx.callId || toId === ctx.callId)
        return fail('that is this sessions.rewind call; name an earlier tool call')
      const run = await sessions.getRun(ctx.runId)
      const path = await runPath(ctx)
      // The turn making this call (-1 when the call isn't in the history, e.g. called from outside a turn).
      const current = callIndex(path, ctx.callId)
      const last = run?.data.context
      const perChar = last && last.chars > 0 && last.tokens > 0 ? last.tokens / last.chars : 1 / 3.5
      const total = path.reduce((n, e) => n + entryChars(e), 0)
      const before = last?.tokens ?? Math.ceil(total * perChar)
      const context = (removed: Entry[]) => ({
        tokensBefore: before,
        tokensAfter: Math.max(
          0,
          before - Math.round((removed.reduce((n, e) => n + entryChars(e), 0) - summary.length) * perChar),
        ),
        ...(last?.window ? { window: last.window } : {}),
      })
      const ephemeral: Record<string, Json> =
        run?.data.mode === 'ephemeral' && run.data.commit !== true
          ? {
              ephemeral:
                "This run is ephemeral: the change lasts for the rest of this run only, and the session's history stays as it was unless the run commits (sessions.commit).",
            }
          : {}
      const reminder =
        'Your summary is all that is left of what was replaced: it must hold every fact, id, path, decision and open item from it you still need.'
      const unknown = (id: string) => fail(`${id} is not a tool call or entry in this run's history`)

      if (!toId) {
        const point = rewindPoint(path, fromId)
        if (!point) return unknown(fromId)
        const i = path.indexOf(point)
        if (current >= 0 && i >= current)
          return fail(`${fromId} is in this turn: jump back to a tool call of an earlier turn, or collapse with from and to`)
        const dropped = path.slice(i + 1)
        return {
          output: {
            rewindTo: point.id,
            dropped: { entries: dropped.length, toolCalls: dropped.flatMap(callsOf).filter((c) => c.id !== ctx.callId).length },
            note: 'Everything after that point is dropped, including this call and its result.',
            context: context(dropped),
            reminder,
            ...ephemeral,
          },
          control: [{ type: 'rewind', toEntry: point.id, summary }],
        }
      }

      const start = turnIndex(path, fromId)
      if (start < 0) return unknown(fromId)
      if (start === 0) return fail('the first entry of the history stays; start the stretch at a later tool call')
      const toAt = turnIndex(path, toId)
      if (toAt < 0) return unknown(toId)
      // The end: the results of `to`'s turn. In the current turn (the one making this call), only up to `to`'s
      // own result: the calls after it, this one included, stay after the summary with their results.
      let end = callsOf(path[toAt]!).length ? turnEnd(path, toAt) : toAt
      if (toAt === current && current >= 0) {
        const isCall = callsOf(path[current]!).some((c) => c.id === toId)
        const named = isCall ? toId : answeredCall(path.find((e) => e.id === toId) ?? path[current]!)
        if (named) {
          const r = path.findLastIndex((e) => answeredCall(e) === named)
          if (r < 0) return fail(`${toId} has no result yet; name a call that has finished`)
          end = r
        }
      } else if (callsOf(path[toAt]!).some((c) => c.id === toId) && !path.some((e) => answeredCall(e) === toId))
        return fail(`${toId} has no result yet; name a call that has finished`)
      if (end < start) return fail(`${toId} comes before ${fromId}: from is where the stretch starts, to where it ends`)
      const stretch = path.slice(start, end + 1)
      const answeredLater = new Set(path.slice(end + 1).map(answeredCall))
      const toolCalls = stretch.flatMap(callsOf).filter((c) => c.id !== ctx.callId && !answeredLater.has(c.id)).length
      return {
        output: {
          collapsed: { from: stretch[0]!.id, to: stretch[stretch.length - 1]!.id, entries: stretch.length, toolCalls },
          // What follows the stretch, plus this call's result (and, when the stretch ends in this turn, a copy of it).
          keptEntries: path.length - end + (current >= 0 && end >= current ? 1 : 0),
          note: 'Everything after the stretch stays word for word, this call and its result included.',
          context: context(stretch),
          reminder,
          ...ephemeral,
        },
        control: [{ type: 'rewind', toEntry: path[start - 1]!.id, summary, keepAfter: stretch[stretch.length - 1]!.id }],
      }
    },
  )

  kit.tool(
    {
      name: 'sessions.offload',
      description:
        'Replace one big message in the history (a big tool result you have already used, a long doc, a finished discussion) with a short pointer. Name it by the id of the tool call whose result it is (each tool result starts with [call <id>]), or by an entry id. Optionally write what matters to a docs chapter first (content, into docId or a new doc of this session). The original stays in the database: sessions.restore reads it back.',
      effect: 'idempotent',
      params: {
        properties: {
          entryId: { type: 'string', description: 'The id of the tool call whose result to offload, or an entry id.' },
          text: { type: 'string', description: 'One line saying what the pointer stands for.' },
          docId: { type: 'string' },
          chapter: { type: 'string', description: 'Chapter heading in the doc.' },
          content: { type: 'string', description: 'Chapter text to write before offloading.' },
        },
        required: ['entryId', 'text'],
      },
    },
    async (a, ctx) => {
      const text = str(a.text)
      if (!text) return fail('text is required')
      const path = await runPath(ctx)
      const target = entryOrCall(path, String(a.entryId ?? ''))
      if (!target) return fail(`${a.entryId} is not a tool call or entry in the current history`)
      if (target.id === path[0]?.id) return fail("the first entry of a history can't be offloaded")
      if (target.kind === 'pointer') return fail(`${a.entryId} is already offloaded`)
      let docId: string | undefined = str(a.docId)
      const chapter = str(a.chapter)
      if (a.content !== undefined) {
        if (!chapter) return fail('give a chapter heading for the content')
        if (!docId) {
          const owner = sessionRef(ctx.sessionId)
          const existing = await deps.docs.forOwner(owner, 'offloaded')
          docId =
            existing[0]?.id ??
            (await deps.docs.create({ title: 'Offloaded notes', body: '', owner, path: 'offloaded' }, kit.actor(ctx))).id
        }
        await deps.docs.writeChapter(docId, chapter, a.content, kit.actor(ctx))
      } else if (docId && !(await deps.docs.get(docId))) return fail(`doc ${docId} not found`)
      const pointer: PointerContent['doc'] | undefined = docId ? { id: docId, ...(chapter ? { chapter } : {}) } : undefined
      const pointerText = `${text} (the original is entry ${target.id}: sessions.restore reads it back)`
      return {
        output: { offloaded: target.id, ...(pointer ? { doc: pointer } : {}) },
        control: [{ type: 'offload', entryId: target.id, pointer: { text: pointerText, ...(pointer ? { doc: pointer } : {}) } }],
      }
    },
  )

  kit.tool(
    {
      name: 'sessions.restore',
      description:
        "Two things, and only these. Without offset and length: puts an offloaded entry (offloaded by you with sessions.offload, or by the harness when a tool result was too big) back into the history in place of its pointer (it costs context). With offset and length: reads a piece of the text of one entry of this session (or its fork tree) by its id and changes nothing: an offloaded original, a big result in parts, or one entry of a collapsed or compacted stretch (sessions.contents { item } lists them with their ids). A collapsed or compacted stretch can't be put back whole, and nothing else of your history can be reopened: to find where something happened, use sessions.contents (every collapse, compaction and offload) or sessions.search { text, includeThisSession: true }.",
      effect: 'idempotent',
      params: {
        properties: {
          entryId: {
            type: 'string',
            description:
              'The original entry id (pointers name it), the pointer entry id, or the id of the tool call whose result was offloaded.',
          },
          pointerEntryId: { type: 'string', description: 'The pointer entry id (same as entryId; kept for older calls).' },
          offset: { type: 'number', description: 'Character to start reading at (0 is the start).' },
          length: { type: 'number', description: `Characters to read (at most ${PIECE_MAX.toLocaleString('en-US')}).` },
        },
      },
    },
    async (a, ctx) => {
      const id = str(a.entryId) ?? str(a.pointerEntryId)
      if (!id) return fail('entryId is required')
      const path = await runPath(ctx)
      const pointer =
        path.find((e) => e.kind === 'pointer' && (e.id === id || (e.content as unknown as PointerContent).original === id)) ??
        path.findLast((e) => e.kind === 'pointer' && answeredCall(e) === id)
      const piece = a.offset !== undefined || a.length !== undefined
      if (piece) {
        const originalId = pointer ? (pointer.content as unknown as PointerContent).original : id
        const original = await records.store.entries.get(originalId)
        // An entry of this session, or of another session of its fork tree (a parent whose history it inherited).
        const owner = original && typeof original.meta.sessionId === 'string' ? await sessions.get(original.meta.sessionId) : null
        const me = owner ? await sessions.get(ctx.sessionId) : null
        if (!original || !owner || owner.data.employeeId !== ctx.employeeId || owner.data.rootId !== me?.data.rootId)
          return fail(`${id} is not an entry of this session or its fork tree`)
        const text = entryText(original)
        const offset = Math.max(0, Math.floor(Number(a.offset ?? 0)) || 0)
        const length = Math.min(PIECE_MAX, Math.max(1, Math.floor(Number(a.length ?? PIECE_MAX)) || PIECE_MAX))
        const end = Math.min(text.length, offset + length)
        return ok({
          entryId: original.id,
          offset,
          end,
          total: text.length,
          ...(end < text.length ? { next: `call again with offset ${end} for more` } : { done: true }),
          text: text.slice(offset, end),
        })
      }
      if (!pointer)
        return fail(
          `${id} is not offloaded in the current history: only offloaded entries can be put back. Read an entry with offset: 0; sessions.contents lists what was collapsed, compacted or offloaded`,
        )
      const original = (pointer.content as unknown as PointerContent).original
      return { output: { restoring: original }, control: [{ type: 'restore', pointerEntryId: pointer.id }] }
    },
  )

  kit.tool(
    {
      name: 'sessions.compact',
      description:
        'Replace the whole history after the first entry with your summary of everything, for a long session that must go on. Prefer sessions.rewind (collapse a stretch you are done with, from and to, or jump back after a dead end) or sessions.offload (a big result you have used). The summary must hold the goal, decisions, the current state, what is still to do, and verbatim everything the rest of the work needs (exact line numbers, quotes, figures, ids, paths, links). Also put decisions and the current state in the session document (sessions.save_metadata { document }), so a long-lived session keeps them outside the conversation. The harness also compacts automatically near the end of the context window.',
      effect: 'idempotent',
      params: { properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
    async (a) => {
      if (!str(a.summary)) return fail('summary is required')
      return { output: { compacting: true }, control: [{ type: 'compact', summary: a.summary }] }
    },
  )

  /**
   * Messages between two sessions (both ways) within the window: AIs talking to each other can loop, or
   * relay whole files as chat text, and burn millions of tokens before a person notices.
   */
  const exchangeWith = async (me: string, other: string) => {
    const since = new Date(deps.clock.now() - MESSAGE_WINDOW_MS).toISOString()
    const sent = async (from: string, to: string) =>
      (
        await deps.events.query({ type: 'session.message', subjectKey: subjectKey(internalSubject(to)), since, limit: 500 })
      ).filter((e) => (e.data.payload as { fromSessionId?: string } | undefined)?.fromSessionId === from)
    const all = [...(await sent(me, other)), ...(await sent(other, me))]
    const chars = all.reduce((n, e) => n + String((e.data.payload as { text?: unknown } | undefined)?.text ?? '').length, 0)
    return { count: all.length, chars }
  }

  kit.tool(
    {
      name: 'sessions.message',
      description:
        'Send a message straight into another session: `@employee#slug`, `#slug` (one of yours) or a session id. It is delivered to that session as an expected message it should act on. For replies, the other side messages you back the same way.',
      effect: 'idempotent',
      params: {
        properties: { to: { type: 'string' }, text: { type: 'string' } },
        required: ['to', 'text'],
      },
    },
    async (a, ctx) => {
      const text = str(a.text)
      if (!text) return fail('text is required')
      const to = String(a.to).trim()
      let target: Session | null = null
      const tag = /^@?([A-Za-z0-9][A-Za-z0-9._-]*)#([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(to)
      if (/^ses_/.test(to)) target = await sessions.get(to)
      else if (tag && to.startsWith('@')) {
        const emp = await deps.directory.employees.byHandle(tag[1]!)
        target = emp ? await sessions.bySlug(emp.id, tag[2]!) : null
      } else {
        const slug = to.replace(/^#/, '')
        target = await sessions.bySlug(ctx.employeeId, slug)
      }
      if (!target) return fail(`no session ${to}`)
      if (target.id === ctx.sessionId) return fail("can't message yourself")
      const sofar = await exchangeWith(ctx.sessionId, target.id)
      if (sofar.count >= MESSAGE_BUDGET.count || sofar.chars + text.length > MESSAGE_BUDGET.chars)
        return fail(
          `not sent: this session and ${to} have exchanged ${sofar.count} messages (${sofar.chars} characters) in the last ${MESSAGE_WINDOW_MS / 60_000} minutes, the most the harness allows. Stop, and tell the person who asked what's blocking and who can unblock it. To hand over files, don't paste them: put them in your filesystem (/files in an environment) and fs.share them.`,
          { limited: true },
        )
      const me = await sessions.require(ctx.sessionId)
      const myEmp = await deps.directory.employees.get(ctx.employeeId)
      const targetEmp = await deps.directory.employees.get(target.data.employeeId)
      const from = `@${myEmp?.key ?? ctx.employeeId}#${me.data.slug}`
      const raw = `@${targetEmp?.key ?? target.data.employeeId}#${target.data.slug}`
      const { event } = await deps.events.ingest({
        source: 'session',
        type: 'session.message',
        dedupeKey: `session.message:${ctx.idempotencyKey}`,
        subject: internalSubject(target.id),
        employeeId: target.data.employeeId,
        payload: {
          text,
          fromSessionId: ctx.sessionId,
          author: { kind: 'session', id: ctx.sessionId },
          tags: [{ raw, type: 'session', employeeId: target.data.employeeId, sessionId: target.id }],
        },
        text: `Message from ${from} (reply with sessions.message to ${from}):\n${text}`,
      })
      return ok({ eventId: event.id, to: { sessionId: target.id, tag: raw } })
    },
  )

  kit.tool(
    {
      name: 'sessions.finish',
      description:
        'End this run now with an output (your final answer or report), and optionally a structured result (a JSON object) stored on the run: a parent waiting on this run (sessions.wait, sessions.loop) gets it as is. Policies may refuse (e.g. open checklist items); you then get the reason and can fix it.',
      effect: 'idempotent',
      params: {
        properties: {
          output: { type: 'string' },
          result: {
            type: 'object',
            description: 'Structured result, a JSON object (e.g. the fields the parent asked for), stored on the run as is.',
          },
          status: { type: 'string', enum: ['completed', 'failed'], description: 'Default completed.' },
        },
        required: ['output'],
      },
    },
    async (a) => {
      const status = a.status ?? 'completed'
      if (status !== 'completed' && status !== 'failed') return fail('status must be completed or failed')
      const result = a.result as Json | undefined
      if (result !== undefined && JSON.stringify(result).length > RESULT_MAX)
        return fail(
          `result is too big (over ${RESULT_MAX.toLocaleString('en-US')} characters): keep the data in a file and return its path`,
        )
      return {
        output: { finishing: status, ...(result !== undefined ? { result: true } : {}) },
        control: [{ type: 'end', status, output: String(a.output), ...(result !== undefined ? { result } : {}) }],
      }
    },
  )
}

/** Used by the checklist review: the readable text of entries. */
export function entriesText(entries: Entry[], max = 2000): string {
  return entries.map((e) => `[${e.kind} ${e.id}]\n${clip(contentText(e.content), max)}`).join('\n\n')
}
