import { errorMessage, globMatch, type Hooks } from '@mp/core'
import type { ChatEventPayload } from '@mp/chat'
import { beforeDeliver } from '@mp/router'
import { afterModelCall, afterRun, beforeFinish, beforeModelCall, beforeToolCall } from '@mp/runner'
import type { AssistantContent, Run, Session, ToolResultContent } from '@mp/sessions'
import type { Entry } from '@mp/store'
import { worktreesOf } from './kit.ts'
import { authorFor, trailersFor, worktreeFor } from './tools/git.ts'
import type { PolicyConfig, StdlibDeps } from './types.ts'

export const AUTO_COMMIT_MESSAGE = 'Work in progress (auto-commit at end of run)'
/** What the model writes to finish a run that committed code without touching docs. */
export const NO_DOCS_PHRASE = /no docs update needed:\s*\S/i
/** Paths that count as docs when written with git.write_file. */
export const DOCS_PATH = /(^|\/)docs\/|\.mdx?$/i

/** What the model ends with when it decides a message needs no answer. */
export const NO_REPLY = 'NO_REPLY'
/** `NO_REPLY`, alone or followed by a reason (`NO_REPLY: just a thanks`). */
export const NO_REPLY_RE = /^\s*\[?no[_ -]?reply\]?\s*(?::.*)?$/is

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

const results = (entries: Entry[]) =>
  entries.filter((e) => e.kind === 'tool_result').map((e) => e.content as unknown as ToolResultContent)

const outputOf = (r: ToolResultContent): Record<string, unknown> =>
  r.output && typeof r.output === 'object' && !Array.isArray(r.output) ? (r.output as Record<string, unknown>) : {}

/** Whether the run committed code (a successful `git.commit` that produced a commit). */
export const committedCode = (entries: Entry[]) =>
  results(entries).some((r) => r.name === 'git.commit' && !r.isError && typeof outputOf(r).sha === 'string')

/** Whether the run wrote docs: `docs.write`, `docs.write_chapter`, or `git.write_file` on a docs path or markdown file. */
export const wroteDocs = (entries: Entry[]) =>
  results(entries).some(
    (r) =>
      !r.isError &&
      (r.name === 'docs.write' ||
        r.name === 'docs.write_chapter' ||
        (r.name === 'git.write_file' && typeof outputOf(r).path === 'string' && DOCS_PATH.test(outputOf(r).path as string))),
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
      hooks.on(beforeFinish, async ({ run, session, status }) => {
        if (status !== 'completed' || session.data.meta?.role !== 'router' || run.data.mode !== 'ephemeral') return undefined
        if (run.data.commitSummary) return undefined
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
        const eventId = run.data.cause.eventId
        if (!eventId) return undefined
        try {
          const event = await deps.events.get(eventId)
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
            await deps.events.subscriptions.subscribe(session.id, subject, { primary: !subs.some((x) => x.data.primary) })
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
 * a row in its thread were written by sessions or AI contacts, with no person
 * posting in between. `maxAiStreak` comes from the config, else from the
 * limits of the receiving employee, else 20.
 */
export function registerRouterPolicies(hooks: Hooks, deps: StdlibDeps, config: PolicyConfig = {}): () => void {
  const isAi = new Map<string, boolean>()
  const aiContact = async (id: string) => {
    if (!isAi.has(id)) isAi.set(id, (await deps.directory.contacts.get(id))?.data.kind === 'ai')
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
