import { errorMessage, type EventBus, type Hooks, type Json, type Logger } from '@mp/core'
import type { Events, MpEvent, Subject } from '@mp/events'
import { afterRun, afterToolCall } from '@mp/runner'
import type { AssistantContent, Run, Session, Sessions, ToolResultContent } from '@mp/sessions'
import type { Entry } from '@mp/store'
import type { IntegrationInstance } from './instances.ts'
import type { IntegrationSpec } from './specs.ts'

/** The project path of a GitLab repository URL (ssh or https), or null for anything else (local: repositories). */
export function gitlabProjectPath(url: string): string | null {
  const ssh = /^[\w.-]+@[^:/]+:(.+?)(?:\.git)?\/?$/.exec(url.trim())
  if (ssh) return ssh[1]!
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'ssh:') return null
    return (
      u.pathname
        .replace(/^\/+/, '')
        .replace(/\.git\/?$/, '')
        .replace(/\/+$/, '') || null
    )
  } catch {
    return null
  }
}

/** A router's decision log, not an answer (the stdlib's ROUTER_LOG_RE; this package doesn't depend on it). */
const ROUTER_LOG_RE =
  /\bNO_REPLY\b|(→|->)\s*(started|forwarded|ran|answered|noted|ignored|skipped)\b|^\s*decision (recorded|logged|committed)\b|^\s*(logged|noted|recorded|done|committed)\.?\s*$/i

/** What the model ends with when it decides a message needs no answer (the stdlib's convention). */
const NO_REPLY_RE = /^\s*\[?no[_ -]?reply\]?\s*(?::|\n|$)|(?:^|\n)\s*\[?no[_ -]?reply\]?\s*(?::[^\n]*)?\s*$/i
/** Tools that hand the work to another session: that session answers, not this run. */
const HANDOFF_TOOLS = ['sessions.fork', 'sessions.loop', 'sessions.create', 'sessions.message', 'procedures.run']

/**
 * Whether an event closes its subject, so subscriptions to it end: a GitLab
 * merge request merged or closed, a Linear issue removed or moved to a
 * completed or canceled state. Returns the reason, or null.
 */
export function closingReason(event: Pick<MpEvent['data'], 'source' | 'type' | 'payload' | 'subject'>): string | null {
  if (!event.subject) return null
  const p = (event.payload ?? {}) as { stateType?: unknown }
  if (event.source === 'integration:gitlab') {
    if (event.type === 'merge_request.merged') return 'merge request merged'
    if (event.type === 'merge_request.closed') return 'merge request closed'
  }
  if (event.source === 'integration:linear') {
    if (event.type === 'issue.removed') return 'issue removed'
    if (event.type === 'issue.state_changed' && (p.stateType === 'completed' || p.stateType === 'canceled'))
      return `issue ${p.stateType}`
  }
  return null
}

/** The MR subject (`gitlab:<project path>!<iid>`) of a `create_merge_request` result, from its `web_url`. */
export function mergeRequestSubject(output: Json, gitlabBaseUrl?: string): Subject | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  const o = output as { iid?: unknown; web_url?: unknown }
  if (typeof o.web_url !== 'string') return null
  let path: string
  try {
    path = decodeURIComponent(new URL(o.web_url).pathname)
  } catch {
    return null
  }
  const m = /^\/*(.+?)\/-\/merge_requests\/(\d+)\/?$/.exec(path)
  if (!m) return null
  let project = m[1]!
  // A self-hosted GitLab under a sub-path (`https://git.example.com/gitlab`): the project path starts after it.
  if (gitlabBaseUrl) {
    try {
      const base = new URL(gitlabBaseUrl).pathname.replace(/^\/+|\/+$/g, '')
      if (base && project.startsWith(`${base}/`)) project = project.slice(base.length + 1)
    } catch {}
  }
  const iid = typeof o.iid === 'number' || typeof o.iid === 'string' ? String(o.iid) : m[2]!
  return { system: 'gitlab', id: `${project}!${iid}` }
}

const results = (entries: Entry[]) =>
  entries.filter((e) => e.kind === 'tool_result').map((e) => e.content as unknown as ToolResultContent)

/**
 * Whether a run caused by an external chat event (`source`) should have its
 * final text posted back there: it was expected to act, it ended with text
 * that isn't NO_REPLY, and it neither answered with one of `answerTools` nor
 * handed the work to another session. Mirrors the stdlib's `needsAutoReply`
 * for harness chat.
 */
export function needsExternalReply(entries: Entry[], output: string | undefined, source: string, answerTools: string[]): boolean {
  if (!output?.trim() || NO_REPLY_RE.test(output)) return false
  const asked = entries.some(
    (e) => e.kind === 'event' && (e.content as any)?.source === source && (e.content as any)?.expectedToAct === true,
  )
  if (!asked) return false
  return !results(entries).some((r) => !r.isError && (answerTools.includes(r.name) || HANDOFF_TOOLS.includes(r.name)))
}

/** The run's own entries: everything on its current path after its base. */
async function runEntries(sessions: Sessions, run: Run): Promise<Entry[]> {
  const history = await sessions.runHistory(run.id)
  const base = run.data.base
  if (!base) return history
  const i = history.findIndex((e) => e.id === base)
  return i < 0 ? history : history.slice(i + 1)
}

function lastAssistantText(entries: Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind !== 'assistant') continue
    const t = (e.content as unknown as AssistantContent).text
    if (t) return t
  }
  return undefined
}

/** A router context, current or retired: its runs decide where work goes, they don't answer. */
const isRouter = (session: Session) => {
  const role = session.data.meta?.role
  return role === 'router' || role === 'router-retired'
}

/** Subscribes a session to a subject, unless it already is. Router contexts never hold conversations. */
export async function subscribeOnce(events: Events, session: Session, subject: Subject, primary: boolean) {
  if (session.data.meta?.role === 'router') return false
  const subs = await events.subscriptions.forSubject(subject)
  if (subs.some((s) => s.data.sessionId === session.id)) return false
  await events.subscriptions.subscribe(session.id, subject, { primary: primary || !subs.some((s) => s.data.primary) })
  return true
}

export interface IntegrationPolicyDeps {
  hooks: Hooks
  bus: EventBus
  events: Events
  sessions: Sessions
  logger: Logger
  /** The instance an employee's calls go through. */
  instanceFor(spec: IntegrationSpec, employeeId: string): Promise<IntegrationInstance>
  specs: Record<string, IntegrationSpec>
}

/**
 * The integration policies:
 *
 * - subscription hygiene (bus `event.routed`): a merged or closed MR, or a
 *   finished or removed Linear issue, ends the subscriptions to its subject
 *   after the event itself was delivered.
 * - replies go back out (`afterRun`): a run caused by a Slack event it was
 *   expected to act on, which ends with a final answer without posting in
 *   Slack, has that answer posted in the event's thread with the employee's
 *   Slack bot, and the session is subscribed to the thread.
 * - MR subscriptions (`afterToolCall`): a successful
 *   `mcp.gitlab.create_merge_request` subscribes the session to the MR as
 *   its primary subscriber, so pipelines and reviews come back to it.
 *
 * Returns a function that removes them.
 */
export function registerIntegrationPolicies(deps: IntegrationPolicyDeps): () => void {
  const { events, logger } = deps
  const offs: (() => void)[] = []

  if (deps.specs.gitlab || deps.specs.linear)
    offs.push(
      deps.bus.subscribe<{ eventId: string }>('event.routed', async (m) => {
        const event = await events.get(m.payload.eventId)
        if (!event?.data.subject) return
        const reason = closingReason(event.data)
        if (!reason) return
        try {
          const n = await events.subscriptions.endForSubject(event.data.subject, reason)
          if (n) logger.info('subscriptions ended', { subject: event.data.subjectKey, reason, count: n })
        } catch (err) {
          logger.warn('could not end subscriptions', { subject: event.data.subjectKey, err: errorMessage(err) })
        }
      }),
    )

  const slack = deps.specs.slack
  if (slack)
    offs.push(
      // An instant "on it": as soon as a Slack message sets someone to work (a run started or woken),
      // the employee's bot reacts :eyes: to it, without waiting for a model call.
      deps.bus.subscribe<{ eventId: string; deliveries?: { outcome?: string; runId?: string }[] }>('event.routed', async (m) => {
        const working = (m.payload.deliveries ?? []).some((d) => d.outcome === 'run' || d.outcome === 'woke')
        if (!working) return
        try {
          const event = await events.get(m.payload.eventId)
          if (event?.data.source !== `integration:${slack.name}` || !event.data.employeeId) return
          if (!/^message\./.test(event.data.type)) return
          const p = (event.data.payload ?? {}) as { channel?: unknown; ts?: unknown }
          if (typeof p.channel !== 'string' || typeof p.ts !== 'string') return
          const instance = await deps.instanceFor(slack, event.data.employeeId)
          if (!instance.hasToken) return
          const r = await instance.callTool('react', { channel: p.channel, ts: p.ts, name: 'eyes' })
          if (r.isError) logger.debug('slack: could not react to acknowledge', { eventId: event.id, output: r.output })
        } catch (err) {
          logger.debug('slack: could not react to acknowledge', { eventId: m.payload.eventId, err: errorMessage(err) })
        }
      }),
    )
  if (slack)
    offs.push(
      deps.hooks.on(afterRun, async ({ run, session, result }) => {
        if (result.status !== 'completed') return undefined
        const eventId = run.data.cause.eventId
        if (!eventId) return undefined
        try {
          const event = await events.get(eventId)
          const source = `integration:${slack.name}`
          if (event?.data.source !== source || event.data.subject?.system !== 'slack') return undefined
          const entries = await runEntries(deps.sessions, run)
          const output = result.output ?? lastAssistantText(entries)
          // A router's decision log ("Logged.", "… → NO_REPLY (…)") isn't an answer: live, both were posted.
          if (isRouter(session) && output && ROUTER_LOG_RE.test(output)) return undefined
          const answerTools = (slack.answerTools ?? []).map((t) => `mcp.${slack.name}.${t}`)
          if (!needsExternalReply(entries, output, source, answerTools)) return undefined
          const [channel, threadTs] = event.data.subject.id.split('/')
          if (!channel || !threadTs) return undefined
          const instance = await deps.instanceFor(slack, run.data.employeeId)
          if (!instance.hasToken) {
            logger.warn('slack reply not posted: Slack is not set up for this employee', { runId: run.id })
            return undefined
          }
          const r = await instance.callTool('reply', { channel, thread_ts: threadTs, text: output! })
          if (r.isError) {
            logger.warn('slack reply failed', { runId: run.id, output: r.output })
            return undefined
          }
          await subscribeOnce(events, session, event.data.subject, false)
        } catch (err) {
          logger.warn('slack reply: could not post the answer', { runId: run.id, err: errorMessage(err) })
        }
        return undefined
      }),
    )

  const gitlab = deps.specs.gitlab
  if (gitlab) {
    // A push to a GitLab repository subscribes the session to its branch, so the branch's pipelines and pushes
    // reach it directly (they used to fall through to the router, which forwarded them with a model call).
    offs.push(
      deps.hooks.onTransform(afterToolCall, async (p) => {
        if (p.tool.name !== 'git.push' || p.result.isError) return p
        const out = (p.result.output ?? {}) as { url?: unknown; pushed?: unknown }
        const path = typeof out.url === 'string' ? gitlabProjectPath(out.url) : null
        if (!path || typeof out.pushed !== 'string') return p
        try {
          await subscribeOnce(events, p.session, { system: 'gitlab', id: `${path}@${out.pushed}` }, true)
        } catch (err) {
          logger.warn('could not subscribe to the pushed branch', { sessionId: p.session.id, err: errorMessage(err) })
        }
        return p
      }),
    )
    const tool = `mcp.${gitlab.name}.create_merge_request`
    offs.push(
      deps.hooks.onTransform(afterToolCall, async (p) => {
        if (p.tool.name !== tool || p.result.isError) return p
        let subject: Subject | null = null
        try {
          subject = mergeRequestSubject(p.result.output, (await deps.instanceFor(gitlab, p.run.data.employeeId)).baseUrl)
        } catch (err) {
          logger.warn('create_merge_request: could not read the MR subject', { runId: p.run.id, err: errorMessage(err) })
        }
        if (!subject) {
          logger.warn('create_merge_request: no MR subject in the result, not subscribed', { runId: p.run.id })
          return p
        }
        try {
          if (await subscribeOnce(events, p.session, subject, true))
            logger.info('subscribed to the merge request', {
              sessionId: p.session.id,
              subject: `${subject.system}:${subject.id}`,
            })
        } catch (err) {
          logger.warn('could not subscribe to the merge request', { sessionId: p.session.id, err: errorMessage(err) })
        }
        return p
      }),
    )
  }

  return () => {
    for (const off of offs) off()
  }
}
