import { subscriptionScope } from './subscription-presets.ts'
import { errorMessage, globMatch, type Hooks, type Json } from '@mp/core'
import type { ChatEventPayload } from '@mp/chat'
import { beforeDeliver } from '@mp/router'
import { afterModelCall, afterRun, afterToolCall, beforeFinish, beforeModelCall, beforeToolCall } from '@mp/runner'
import type { AssistantContent, Run, Session, ToolResultContent } from '@mp/sessions'
import type { Entry } from '@mp/store'
import { worktreesOf } from './kit.ts'
import { chatReportOf } from './schedules.ts'
import { authorFor, trailersFor, worktreeFor } from './tools/git.ts'
import type { PolicyConfig, StdlibDeps } from './types.ts'

export const AUTO_COMMIT_MESSAGE = 'Work in progress (auto-commit at end of run)'
/** What the model writes to finish a run that committed code without touching docs. */
export const NO_DOCS_PHRASE = /no docs update needed:\s*\S/i
/** Paths that count as docs when written with git.write_file or git.edit_file. */
export const DOCS_PATH = /(^|\/)docs\/|\.mdx?$/i

/** What the model ends with when it decides a message needs no answer. */
export const NO_REPLY = 'NO_REPLY'
/**
 * `NO_REPLY`, alone or followed by a reason (`NO_REPLY: just a thanks`), at the start of the final text
 * or as its last line: models often think aloud first ("Nothing needed from me here…\n\nNO_REPLY: …"),
 * and that text must not be posted. "No reply from the vendor yet" is still a reply.
 */
export const NO_REPLY_RE = /^\s*\[?no[_ -]?reply\]?\s*(?::|\n|$)|(?:^|\n)\s*\[?no[_ -]?reply\]?\s*(?::[^\n]*)?\s*$/i

/**
 * A router context's final text that is its decision log, not an answer: a decision line in the commit
 * format ("slack:C1/… (#vegan, from Ana): … → NO_REPLY (…)", "… → started @x#y") or a bare
 * acknowledgement ("Logged.", "Decision recorded."). Live, both were posted as replies. A router's plain
 * answer to a quick question is still posted, so the person isn't left without one.
 */
export const ROUTER_LOG_RE =
  /\bNO_REPLY\b|(→|->)\s*(started|forwarded|ran|answered|noted|ignored|skipped)\b|^\s*decision (recorded|logged|committed)\b|^\s*(logged|noted|recorded|done|committed)\.?\s*$/i

/** Whether a session's final text shouldn't be posted as a reply because it's its routing decision. */
export function isRouterLog(session: { data: { meta?: Record<string, unknown> } }, output: string | undefined): boolean {
  const role = session.data.meta?.role
  return (role === 'router' || role === 'router-retired') && !!output && ROUTER_LOG_RE.test(output)
}

/** Tools that answer in chat: a run that used one has already replied somewhere. */
export const CHAT_ANSWER_TOOLS = ['chat.post', 'chat.reply', 'chat.invite']
/** Tools that hand the work to another session: that session answers, not this run. */
export const HANDOFF_TOOLS = ['sessions.fork', 'sessions.loop', 'sessions.create', 'sessions.message', 'procedures.run']

/** Bus topic published when an AI-to-AI streak pauses deliveries in a thread. */
export const AI_STREAK_TOPIC = 'limit.ai_streak'

/** The run's own entries: everything on its current path after its base. */
export async function runEntries(deps: Pick<StdlibDeps, 'sessions'>, run: Run): Promise<Entry[]> {
  const history = await deps.sessions.runHistory(run.id)
  const base = run.data.base
  if (!base) return history
  const i = history.findIndex((e) => e.id === base)
  return i < 0 ? history : history.slice(i + 1)
}

/** The last assistant text in a list of entries. */
function lastAssistantText(entries: Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind !== 'assistant') continue
    const t = (e.content as unknown as AssistantContent).text
    if (t) return t
  }
  return undefined
}

/** Tools a router hands work over with, and the verb its decision line uses for each. */
const ROUTER_HANDOFFS: Record<string, string> = {
  'sessions.create': 'started',
  'sessions.fork': 'started',
  'sessions.message': 'forwarded to',
  'procedures.run': 'ran',
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Tools a router only looks things up with: calling them doesn't make a decision worth recording. */
const ROUTER_LOOKUPS =
  /^(sessions\.(list|get|search|tree|look_up)|chat\.(read|search)|memory\.recall|directory\.(find_\w+|get_\w+|projects_of)|docs\.(read|search|list|backlinks)|subscriptions\.list|schedule\.list|skills\.list|time\.now|mcp\.[\w-]+\.(read_thread|read_channel|lookup_user|get_\w+|list_\w+|search_\w+))$/

const results = (entries: Entry[]) =>
  entries.filter((e) => e.kind === 'tool_result').map((e) => e.content as unknown as ToolResultContent)

const outputOf = (r: ToolResultContent): Record<string, unknown> =>
  r.output && typeof r.output === 'object' && !Array.isArray(r.output) ? (r.output as Record<string, unknown>) : {}

/** Whether the run committed code (a successful `git.commit` that produced a commit). */
export const committedCode = (entries: Entry[]) =>
  results(entries).some((r) => r.name === 'git.commit' && !r.isError && typeof outputOf(r).sha === 'string')

/** Whether the run wrote docs: `docs.write`, `docs.write_chapter`, or `git.write_file`/`git.edit_file` on a docs path or markdown file. */
export const wroteDocs = (entries: Entry[]) =>
  results(entries).some(
    (r) =>
      !r.isError &&
      (r.name === 'docs.write' ||
        r.name === 'docs.write_chapter' ||
        ((r.name === 'git.write_file' || r.name === 'git.edit_file') &&
          typeof outputOf(r).path === 'string' &&
          DOCS_PATH.test(outputOf(r).path as string))),
  )

/**
 * Whether a run should have its final text posted where it was asked: it was
 * started by a chat message it was expected to act on, it finished with text,
 * and it neither answered in chat nor handed the work to another session.
 */
export function needsAutoReply(entries: Entry[], output: string | undefined): boolean {
  // The agent decides: it may conclude that nothing needs saying.
  if (!output?.trim() || NO_REPLY_RE.test(output)) return false
  const asked = entries.some(
    (e) => e.kind === 'event' && (e.content as any)?.source === 'chat' && (e.content as any)?.expectedToAct,
  )
  if (!asked) return false
  return !results(entries).some((r) => !r.isError && (CHAT_ANSWER_TOOLS.includes(r.name) || HANDOFF_TOOLS.includes(r.name)))
}

/**
 * A scheduled task's final answer, posted in its report thread (or as a new thread in its report channel)
 * unless the run already answered in chat or ends with NO_REPLY. The session follows the thread afterwards.
 */
async function postReport(
  deps: StdlibDeps,
  run: Run,
  session: Session,
  output: string | undefined,
  report: { channelId: string; threadId?: string },
): Promise<void> {
  if (!output?.trim() || NO_REPLY_RE.test(output)) return
  const entries = await runEntries(deps, run)
  if (results(entries).some((r) => !r.isError && CHAT_ANSWER_TOOLS.includes(r.name))) return
  const msg = await deps.chat.post({
    channelId: report.channelId,
    ...(report.threadId ? { threadId: report.threadId } : {}),
    author: { kind: 'session', id: session.id },
    text: output,
  })
  const subject = { system: 'mp', id: msg.data.threadId ?? msg.id }
  const subs = await deps.events.subscriptions.forSubject(subject)
  if (!subs.some((x) => x.data.sessionId === session.id))
    await deps.events.subscriptions.subscribe(session.id, subject, {
      primary: !subs.some((x) => x.data.primary),
      ...subscriptionScope('mp'),
    })
}

/**
 * The built-in run policies, on the runner's hook points:
 *
 * - checklist gate (`beforeFinish`): no successful finish while required checklist items are open.
 * - docs maintenance (`beforeFinish`): a run that committed code must write docs, or say "no docs update needed: <reason>".
 * - session document (`beforeFinish`, off by default): the run must update its session document.
 * - commit on stop (`afterRun`): uncommitted worktree changes are committed to the session's branch.
 * - router decisions (`beforeFinish`): an ephemeral run of a router context must commit a one-line decision summary.
 * - answer where asked (`afterRun`): a run started by a chat message that ends with a final answer,
 *   without replying or handing the work off, has that answer posted in the thread it was asked in.
 *   The session is subscribed to the thread, so follow-ups come back to it.
 * - tool gates (`beforeToolCall`): `git.push` to a protected branch is denied before it reaches git.
 *   Allow and deny lists are enforced by the runner itself, so there is no duplicate check here.
 *
 * Returns a function that removes them all.
 */
export function registerPolicies(hooks: Hooks, deps: StdlibDeps, config: PolicyConfig = {}): () => void {
  const offs: (() => void)[] = []
  const { sessions } = deps

  // Progress updates: live, a person sent three messages during seven minutes and 40 tool calls of work for
  // them, and heard nothing until the end. After `progressEvery` tool calls without one that reaches people,
  // the next tool result carries a note asking for a one-line update in the thread.
  // Not in a scheduled run nobody has written into since it fired (live, a daily brief was told to post progress
  // to a person who wasn't waiting), and not more often than every PROGRESS_MIN_MS (live, a note came 30 s after
  // the person was told "looking").
  const every = config.progressEvery ?? PROGRESS_EVERY
  const minMs = config.progressMinMs ?? PROGRESS_MIN_MS
  if (every > 0) {
    const quiet = new Map<string, { n: number; since: number; noted: number }>()
    const scheduled = new Map<string, boolean>()
    const unattended = async (run: { id: string; data: { cause?: { eventId?: string }; requests?: unknown[] } }) => {
      if (run.data.requests?.length) return false
      const eventId = run.data.cause?.eventId
      if (!eventId) return false
      if (!scheduled.has(run.id)) {
        if (scheduled.size > 10_000) scheduled.delete(scheduled.keys().next().value!)
        scheduled.set(run.id, (await deps.events.get(eventId))?.data.source === 'schedule')
      }
      return scheduled.get(run.id)!
    }
    offs.push(
      hooks.onTransform(afterToolCall, async (p) => {
        const { run, session, tool } = p
        if (session.data?.meta?.role === 'router' || run.data?.mode === 'ephemeral' || !run.data?.requesterId) return p
        const now = deps.clock.now()
        if (REACHES_PEOPLE.has(tool.name) && !p.result.isError) {
          quiet.set(run.id, { n: 0, since: now, noted: 0 })
          return p
        }
        const q = quiet.get(run.id) ?? { n: 0, since: Date.parse(run.createdAt) || now, noted: 0 }
        q.n++
        quiet.set(run.id, q)
        if (quiet.size > 10_000) quiet.delete(quiet.keys().next().value!)
        if (q.n - q.noted < every || now - q.since < minMs) return p
        if (await unattended(run)) return p
        q.noted = q.n
        const n = q.n
        const note = `[harness note] ${n} tool calls since you last told the person who asked anything. If the work isn't done, post a one-line progress update in their thread now (chat.reply, or the Slack reply tool): what you found so far and what's next. Answer anything they wrote meanwhile.`
        const out = p.result.output
        const output: Json =
          typeof out === 'string'
            ? `${out}\n\n${note}`
            : out && typeof out === 'object' && !Array.isArray(out)
              ? { ...out, harnessNote: note }
              : { result: out ?? null, harnessNote: note }
        return { ...p, result: { ...p.result, output } }
      }),
    )
  }

  if (config.checklistGate !== false)
    offs.push(
      hooks.on(beforeFinish, async ({ session, status }) => {
        if (status !== 'completed') return undefined
        const st = await deps.checklists.status(session.id)
        if (st.complete) return undefined
        const list = st.missing
          .map((i) => {
            const why = !i.checked
              ? 'not checked'
              : i.review === 'requested'
                ? 'waiting for review'
                : i.review === 'failed'
                  ? 'review failed'
                  : 'needs review'
            return `${i.id} "${i.text}" (${why})`
          })
          .join('; ')
        return {
          block: `required checklist items are not done: ${list}. Check each with checklist.check and the tool call ids that show it (request a review where needed), or report plainly that the work is not finished.`,
        }
      }),
    )

  if (config.docsMaintenance !== false)
    offs.push(
      hooks.on(beforeFinish, async ({ run, status, output }) => {
        if (status !== 'completed') return undefined
        const entries = await runEntries(deps, run)
        if (!committedCode(entries) || wroteDocs(entries)) return undefined
        const last = output ?? lastAssistantText(entries) ?? ''
        if (NO_DOCS_PHRASE.test(last)) return undefined
        return {
          block:
            'this run committed code but updated no docs. Update the project docs (docs.write_chapter, or docs/ or *.md files in the checkout, then commit), or say "no docs update needed: <reason>" in your final message.',
        }
      }),
    )

  if (config.sessionDocument === true)
    offs.push(
      hooks.on(beforeFinish, async ({ run, session, status }) => {
        if (status !== 'completed') return undefined
        const entries = await runEntries(deps, run)
        const updated = results(entries).some((r) => {
          const o = outputOf(r)
          return (
            r.name === 'sessions.save_metadata' &&
            !r.isError &&
            o.sessionId === session.id &&
            Array.isArray(o.updated) &&
            o.updated.includes('document')
          )
        })
        return updated
          ? undefined
          : {
              block:
                'update your session document first (sessions.save_metadata with document): purpose, what was done, decisions, and anything left open.',
            }
      }),
    )

  if (config.routerDecisions !== false)
    offs.push(
      // A router run that handed the work over is done: the harness records the decision and ends the run, where
      // the model made two more calls (sessions.commit, then a final text nobody reads).
      hooks.onTransform(afterToolCall, async (p) => {
        const { run, session, tool, result } = p
        if (session.data?.meta?.role !== 'router' || run.data?.mode !== 'ephemeral' || result.isError) return p
        const verb = ROUTER_HANDOFFS[tool.name]
        // A handoff that waits (e.g. for children's results) isn't the end of the run.
        if (!verb || run.data.commitSummary || result.control?.some((c) => c.type === 'suspend')) return p
        const o = (result.output ?? {}) as Record<string, unknown>
        const to = (o.to ?? {}) as Record<string, unknown>
        const str = (x: unknown) => (typeof x === 'string' && x ? x : undefined)
        const handle = (await deps.directory.employees.get(session.data.employeeId))?.key
        const slug = str(o.slug)
        const sessionId = str(o.sessionId) ?? str(to.sessionId)
        // As the router's own lines read: `→ started @meatless#pay-9-refunds (ses_…)`, `→ ran procedure X (ses_…)`.
        const target = [
          str(o.procedure) ? `procedure ${o.procedure}` : slug && handle ? `@${handle}#${slug}` : (str(to.tag) ?? slug),
          sessionId ? `(${sessionId})` : undefined,
        ].filter(Boolean)
        const event = run.data.cause.eventId ? await deps.events.get(run.data.cause.eventId) : null
        const what = event
          ? oneLine(String(event.data.text ?? `${event.data.source} ${event.data.type} ${event.data.subjectKey ?? ''}`), 140)
          : oneLine(run.data.cause.note ?? 'request', 140)
        const summary = `${what} → ${verb}${target.length ? ` ${target.join(' ')}` : ''}`
        return {
          ...p,
          result: {
            ...result,
            control: [
              ...(result.control ?? []),
              { type: 'commit' as const, summary },
              { type: 'end' as const, status: 'completed' as const, output: NO_REPLY },
            ],
          },
        }
      }),
    )
  if (config.routerDecisions !== false)
    offs.push(
      hooks.on(beforeFinish, async ({ run, session, status, output }) => {
        if (status !== 'completed' || session.data.meta?.role !== 'router' || run.data.mode !== 'ephemeral') return undefined
        // The run as it is now: a handoff's commit (above) lands on it after the runner read it.
        if (run.data.commitSummary || (await deps.sessions.getRun(run.id))?.data.commitSummary) return undefined
        // A watched channel's message the router stays out of leaves nothing to record.
        if (run.data.cause.note === 'watch' && output && /\bNO_REPLY\b/.test(output)) return undefined
        // Nor does an event that isn't a message (a merge request, an issue update) it found nothing to do for,
        // having only looked things up. Live, a router committed a line for every ignored event: a second model
        // call each, and a history that grew all day. Asked in a message, staying out is still recorded.
        if (output && NO_REPLY_RE.test(output) && run.data.cause.eventId) {
          const event = await deps.events.get(run.data.cause.eventId)
          const acted = results(await runEntries(deps, run)).some((r) => !r.isError && !ROUTER_LOOKUPS.test(r.name))
          if (event && !event.data.type.startsWith('message.') && !acted) return undefined
          // Asked in a message and staying out: the harness records that line itself, where the model made two more
          // calls (sessions.commit, then its final text again).
          const what = event
            ? oneLine(String(event.data.text ?? `${event.data.source} ${event.data.type} ${event.data.subjectKey ?? ''}`), 140)
            : 'request'
          const why = oneLine(output.replace(/^[\s\S]*?\bNO[_ -]?REPLY\b\]?:?\s*/i, ''), 140)
          await deps.sessions.updateRun(run.id, { commit: true, commitSummary: `${what} → NO_REPLY${why ? ` (${why})` : ''}` })
          return undefined
        }
        return {
          block:
            'you are a router context: record your decision before finishing. Call sessions.commit with a one-line summary: the subject, who asked, what it is about, and what you decided (answered directly / forwarded to @employee#slug / started @employee#slug (ses_…) / ran procedure X). That line is all you keep of this run.',
        }
      }),
    )

  if (config.answerWhereAsked !== false)
    offs.push(
      hooks.on(afterRun, async ({ run, session, result }) => {
        if (result.status !== 'completed') return undefined
        // A router's decision log isn't an answer (a plain answer to a quick question still is).
        if (isRouterLog(session, result.output)) return undefined
        const eventId = run.data.cause.eventId
        if (!eventId) return undefined
        try {
          const event = await deps.events.get(eventId)
          // A scheduled task's run reports where the task says (docs/spec.md#scheduled-tasks).
          const report = await chatReportOf(deps, run)
          if (report) {
            await postReport(deps, run, session, result.output, report)
            return undefined
          }
          const payload = event?.data.payload as ChatEventPayload | undefined
          if (event?.data.source !== 'chat' || !payload?.channelId || !payload.messageId) return undefined
          const entries = await runEntries(deps, run)
          if (!needsAutoReply(entries, result.output)) return undefined
          const threadId = payload.threadId ?? payload.messageId
          await deps.chat.post({
            channelId: payload.channelId,
            threadId,
            author: { kind: 'session', id: session.id },
            text: result.output!,
          })
          // A router context never holds conversations: a follow-up comes back through its trigger,
          // and it decides again (answer, forward, or start a session).
          if (session.data.meta?.role === 'router') return undefined
          const subject = { system: 'mp', id: threadId }
          const subs = await deps.events.subscriptions.forSubject(subject)
          if (!subs.some((x) => x.data.sessionId === session.id))
            await deps.events.subscriptions.subscribe(session.id, subject, {
              primary: !subs.some((x) => x.data.primary),
              ...subscriptionScope('mp'),
            })
        } catch (err) {
          deps.logger.warn('answer where asked: could not post the reply', { runId: run.id, err: errorMessage(err) })
        }
        return undefined
      }),
    )

  if (config.commitOnStop !== false && deps.git) {
    const git = deps.git
    offs.push(
      hooks.on(afterRun, async ({ run, session }) => {
        const fresh = (await sessions.get(session.id)) ?? session
        for (const w of worktreesOf(fresh)) {
          try {
            const st = await git.status(w.path)
            if (st.clean) continue
            const sha = await git.commitAll(w.path, {
              message: AUTO_COMMIT_MESSAGE,
              author: await authorFor(deps, run.data.employeeId),
              trailers: trailersFor(session.id, run.data.requesterId),
            })
            deps.logger.info('auto-committed worktree at end of run', { runId: run.id, sessionId: session.id, path: w.path, sha })
          } catch (err) {
            deps.logger.warn('auto-commit failed', { runId: run.id, sessionId: session.id, path: w.path, err: errorMessage(err) })
          }
        }
        return undefined
      }),
    )
  }

  // Tool gates: defense in depth before the git layer's own check.
  offs.push(
    hooks.on(beforeToolCall, async ({ tool, args, session }) => {
      if (tool.name !== 'git.push') return undefined
      const a = (args ?? {}) as { branch?: unknown; repo?: unknown }
      let branch = typeof a.branch === 'string' && a.branch ? a.branch : undefined
      if (!branch) {
        try {
          const fresh = (await sessions.get(session.id)) ?? session
          branch = worktreeFor(fresh, typeof a.repo === 'string' ? a.repo : undefined).branch
        } catch {
          return undefined // no checkout: the tool reports that itself
        }
      }
      const name = branch.replace(/^refs\/heads\//, '')
      if (deps.config.pushPolicy.protected.some((p) => globMatch(p, name)))
        return {
          deny: `pushing to ${name} is not allowed: it is a protected branch. Push your own branch and open a pull request.`,
        }
      return undefined
    }),
  )

  return () => {
    for (const off of offs) off()
  }
}

/**
 * Budgets: before each model call, pause the run when a token or cost budget
 * that applies is used up; after each call, record its usage.
 */
export function registerUsagePolicies(hooks: Hooks, deps: StdlibDeps): () => void {
  const ctxOf = (run: Run, session: Session) => ({
    employeeId: run.data.employeeId,
    sessionId: session.id,
    rootSessionId: run.data.rootSessionId,
    runId: run.id,
    ...(run.data.requesterId ? { requesterId: run.data.requesterId } : {}),
    ...(session.data.template ? { templateId: session.data.template.id } : {}),
    ...(typeof session.data.meta?.procedureId === 'string' ? { procedureId: session.data.meta.procedureId } : {}),
  })
  const offs = [
    hooks.on(beforeModelCall, async ({ run, session }) => {
      const check = await deps.usage.checkBudget(ctxOf(run, session))
      return check.ok ? undefined : { pause: check.reason }
    }),
    hooks.on(afterModelCall, async ({ run, session, response, model }) => {
      const u = response.usage
      const c = ctxOf(run, session)
      await deps.usage.record({
        runId: c.runId,
        sessionId: c.sessionId,
        rootSessionId: c.rootSessionId,
        employeeId: c.employeeId,
        ...(run.data.requesterId ? { requesterId: run.data.requesterId } : {}),
        ...(c.templateId ? { templateId: c.templateId } : {}),
        ...(c.procedureId ? { procedureId: c.procedureId } : {}),
        model,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        ...(u.cachedTokens !== undefined ? { cachedTokens: u.cachedTokens } : {}),
        ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {}),
        totalTokens: u.totalTokens,
      })
      return undefined
    }),
  ]
  return () => {
    for (const off of offs) off()
  }
}

/**
 * Router policies. AI-to-AI streak: deliveries of a harness chat message are
 * paused (the run is created paused) once more than `maxAiStreak` messages in
 * a row in its thread were written by sessions or AI contacts (employees'
 * or local agents'), with no person posting in between. `maxAiStreak` comes from the config, else from the
 * limits of the receiving employee, else 20.
 */
export function registerRouterPolicies(hooks: Hooks, deps: StdlibDeps, config: PolicyConfig = {}): () => void {
  const isAi = new Map<string, boolean>()
  const aiContact = async (id: string) => {
    // AI employees' contacts and local agents connected over MCP both count as AI.
    if (!isAi.has(id)) {
      const kind = (await deps.directory.contacts.get(id))?.data.kind
      isAi.set(id, kind === 'ai' || kind === 'agent')
    }
    return isAi.get(id)!
  }
  return hooks.on(beforeDeliver, async ({ event, delivery }) => {
    if (event.data.source !== 'chat') return undefined
    const p = event.data.payload as unknown as ChatEventPayload | undefined
    if (!p?.messageId || !p.author) return undefined
    if (p.author.kind === 'contact' && !(await aiContact(p.author.id))) return undefined
    let max = config.maxAiStreak
    if (max === undefined) {
      const target = await deps.sessions.get(delivery.sessionId)
      const eff = target ? await deps.usage.limits.effective({ employeeId: target.data.employeeId }) : null
      max = eff?.maxAiStreak ?? 20
    }
    const thread = await deps.chat.thread(p.threadId ?? p.messageId)
    let end = thread.findIndex((m) => m.id === p.messageId)
    if (end < 0) end = thread.length - 1
    let streak = 0
    for (let i = end; i >= 0; i--) {
      const a = thread[i]!.data.author
      if (a.kind === 'contact' && !(await aiContact(a.id))) break
      streak++
    }
    if (streak <= max) return undefined
    deps.bus?.publish(AI_STREAK_TOPIC, { threadId: thread[0]!.id, streak, max, sessionId: delivery.sessionId, eventId: event.id })
    return {
      pause: `${streak} messages between AI employees in thread ${thread[0]!.id} without a person (limit ${max}). Paused until a person resumes it.`,
    }
  })
}

/** A router context shows its model at least this many of its latest decision lines. */
export const ROUTER_LOG_KEEP = 40
/** Older decision lines are dropped this many at a time, so the prompt's start stays the same (and cached) in between. */
export const ROUTER_LOG_CHUNK = 40

/**
 * What a router context's model is shown of its history: every entry, but of the decision lines its runs
 * committed (`commitSummary`) only the latest ROUTER_LOG_KEEP to ROUTER_LOG_KEEP + ROUTER_LOG_CHUNK - 1. Live,
 * a day of requests added some 250 lines, a third more prompt on every routing call, while routing needs the
 * recent ones (a follow-up to something routed a while ago comes through its thread's subscription). The
 * oldest go in whole chunks, so the cached prefix breaks once per chunk, not on every request.
 */
export function routerLogView<E extends { kind: string; meta: Record<string, unknown> }>(history: E[]): E[] {
  const isLine = (e: E) => e.kind === 'summary' && e.meta.op === 'commitSummary'
  const lines = history.filter(isLine).length
  const drop = Math.max(0, Math.floor((lines - ROUTER_LOG_KEEP) / ROUTER_LOG_CHUNK) * ROUTER_LOG_CHUNK)
  if (!drop) return history
  let dropped = 0
  return history.filter((e) => !(isLine(e) && dropped++ < drop))
}

/** Tool calls between progress reminders (see registerPolicies). */
export const PROGRESS_EVERY = 12
/** The least time since the person last heard anything before a progress note. */
export const PROGRESS_MIN_MS = 2 * 60_000

/** Tools whose call reaches the people a run works for: a reply, a post, a comment, a reaction. */
export const REACHES_PEOPLE: ReadonlySet<string> = new Set([
  'chat.reply',
  'chat.post',
  'chat.react',
  'mcp.slack.reply',
  'mcp.slack.post_message',
  'mcp.slack.post_blocks',
  'mcp.slack.react',
  'mcp.slack.ask',
  'mcp.slack.update_message',
  'mcp.linear.comment',
  'mcp.gitlab.comment_merge_request',
  'mcp.gitlab.reply_discussion',
])
