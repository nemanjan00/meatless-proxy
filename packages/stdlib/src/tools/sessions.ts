import { subscriptionScope } from '../subscription-presets.ts'
import { ValidationError, type Json } from '@mp/core'
import { internalSubject, subjectKey } from '@mp/events'
import {
  TERMINAL_RUN_STATES,
  contentText,
  snippet,
  type PointerContent,
  type Run,
  type RunMode,
  type Session,
  type SessionData,
  type TreeNode,
} from '@mp/sessions'
import type { Entry, Ref } from '@mp/store'
import { mcpToolName, type ToolContext } from '@mp/tools'
import { RESERVED_META, Roles, checkRef, clip, fail, line, ok, pathValue, sessionBrief, str, type Kit } from '../kit.ts'
import type { TaskSystemConfig } from '../types.ts'

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
  const { sessions, records } = deps

  /** Forks (and new sessions) keep working on the same projects and for the same people. */
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
        'Fan out: fork this session once per item (one child per repository, ticket, contact…) and start each child with the instruction plus its item. Returns the children with their run ids; sessions.wait on them to collect results. Fork depth, fan-out and concurrency limits apply: a loop over the limit is not started at all. With realTasks: true each item also becomes a task in the task system (a "real fork" people can see), which needs the employee\'s taskSystem to be configured.',
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
        'Wait until the given runs finish (mode all, or any), optionally with a timeout: this run is suspended and resumes with their outputs (if they are already done, you get the results right away). Or, with delivery: true instead of runIds, wait for the next reply or event delivered to this session (e.g. the answer to a question asked with mcp.slack.ask); anything that already arrived answers at once. Nothing is lost while you wait; replies and events are delivered afterwards.',
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
      description: 'List your sessions, newest first, optionally by status or by tree (rootId).',
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
      return ok({ sessions: res.items.map(briefWithTime), total: res.total })
    },
  )

  kit.tool(
    {
      name: 'sessions.search',
      description:
        'Full-text search across the histories and documents of your sessions, to find how similar work was done before. Returns matching entries with snippets and matching sessions.',
      effect: 'read',
      params: {
        properties: {
          text: { type: 'string' },
          kinds: { type: 'array', items: { type: 'string' }, description: 'Entry kinds, e.g. ["assistant", "tool_result"].' },
          limit: { type: 'number' },
        },
        required: ['text'],
      },
    },
    async (a, ctx) => {
      const text = str(a.text)
      if (!text) return fail('text is required')
      const limit = Math.min(Math.max(1, a.limit ?? 10), 50)
      const hits = await sessions.search({ text, employeeId: ctx.employeeId, ...(a.kinds ? { kinds: a.kinds } : {}), limit })
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
        sessions: found.items.map((s) => ({ ...sessionBrief(s), snippet: snippet(s.data.document || s.data.title, text) })),
      })
    },
  )

  kit.tool(
    {
      name: 'sessions.tree',
      description:
        "A session's fork tree from its root: every session with its status, and which is which. Default: this session.",
      effect: 'read',
      params: { properties: { sessionId: { type: 'string' } } },
    },
    async (a, ctx) => {
      const s = await kit.ownSession(a.sessionId, ctx)
      const tree = await sessions.tree(s.id)
      let count = 0
      const MAX = 200
      const render = (n: TreeNode): Json => {
        count++
        const children = count < MAX ? n.children.map(render) : []
        return {
          ...sessionBrief(n.session),
          ...(n.session.id === s.id ? { self: true } : {}),
          ...(children.length ? { children } : {}),
          ...(n.children.length > children.length ? { moreChildren: n.children.length - children.length } : {}),
        }
      }
      return ok({ tree: render(tree), ...(count >= MAX ? { note: `showing the first ${MAX} sessions` } : {}) })
    },
  )

  kit.tool(
    {
      name: 'sessions.get',
      description:
        'A session: metadata, its document, checklist status, links and latest runs (with their outputs). Default: this session.',
      effect: 'read',
      params: { properties: { sessionId: { type: 'string' } } },
    },
    async (a, ctx) => {
      const s = await kit.ownSession(a.sessionId, ctx)
      const status = await deps.checklists.status(s.id)
      const links = await records.links({ touching: sessionRef(s.id) })
      const runs = (await sessions.runs({ sessionId: s.id, limit: 1000 })).slice(-5)
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
        runs: runs.map((r) => ({
          runId: r.id,
          state: r.data.state,
          mode: r.data.mode,
          ...(r.data.result?.output ? { output: clip(r.data.result.output, 1000) } : {}),
          ...(r.data.result?.error ? { error: clip(r.data.result.error, 500) } : {}),
          ...(r.data.pauseReason ? { pauseReason: r.data.pauseReason } : {}),
        })),
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
        "Jump back to an earlier entry of this run's history and continue from there with a summary of everything since (what you tried, found, decided, and what is open). Nothing is lost: the detail stays in the database. Use it instead of letting the context grow.",
      effect: 'idempotent',
      params: {
        properties: { toEntry: { type: 'string', description: 'Entry id to rewind to.' }, summary: { type: 'string' } },
        required: ['toEntry', 'summary'],
      },
    },
    async (a, ctx) => {
      if (!str(a.summary)) return fail('summary is required')
      const path = await runPath(ctx)
      if (!path.some((e) => e.id === a.toEntry)) return fail(`entry ${a.toEntry} is not in the current history`)
      return { output: { rewindTo: a.toEntry }, control: [{ type: 'rewind', toEntry: a.toEntry, summary: a.summary }] }
    },
  )

  kit.tool(
    {
      name: 'sessions.offload',
      description:
        'Replace one big message in the history (a long doc, a big tool output, a finished discussion) with a pointer to a docs chapter. Give content to write the chapter first (into docId, or a new doc of this session). The original stays in the database and can be restored with sessions.restore.',
      effect: 'idempotent',
      params: {
        properties: {
          entryId: { type: 'string' },
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
      const idx = path.findIndex((e) => e.id === a.entryId)
      if (idx < 0) return fail(`entry ${a.entryId} is not in the current history`)
      if (idx === 0) return fail("the first entry of a history can't be offloaded")
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
      return {
        output: { offloaded: a.entryId, ...(pointer ? { doc: pointer } : {}) },
        control: [{ type: 'offload', entryId: a.entryId, pointer: { text, ...(pointer ? { doc: pointer } : {}) } }],
      }
    },
  )

  kit.tool(
    {
      name: 'sessions.restore',
      description: 'Put an offloaded message back into the history, in place of its pointer.',
      effect: 'idempotent',
      params: { properties: { pointerEntryId: { type: 'string' } }, required: ['pointerEntryId'] },
    },
    async (a, ctx) => {
      const path = await runPath(ctx)
      const p = path.find((e) => e.id === a.pointerEntryId)
      if (p?.kind !== 'pointer') return fail(`${a.pointerEntryId} is not a pointer in the current history`)
      return { output: { restoring: (p!.content as any).original }, control: [{ type: 'restore', pointerEntryId: p!.id }] }
    },
  )

  kit.tool(
    {
      name: 'sessions.compact',
      description:
        'Real compaction, only when even a rewound context is too big: replace the whole history after the first entry with a summary of everything. Prefer sessions.rewind or sessions.offload.',
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
        'End this run now with an output (your final answer or report). Policies may refuse (e.g. open checklist items); you then get the reason and can fix it.',
      effect: 'idempotent',
      params: {
        properties: {
          output: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'failed'], description: 'Default completed.' },
        },
        required: ['output'],
      },
    },
    async (a) => {
      const status = a.status ?? 'completed'
      if (status !== 'completed' && status !== 'failed') return fail('status must be completed or failed')
      return { output: { finishing: status }, control: [{ type: 'end', status, output: String(a.output) }] }
    },
  )
}

/** Used by the checklist review: the readable text of entries. */
export function entriesText(entries: Entry[], max = 2000): string {
  return entries.map((e) => `[${e.kind} ${e.id}]\n${clip(contentText(e.content), max)}`).join('\n\n')
}
