import type { Directory } from '@mp/directory'
import type { MpEvent } from '@mp/events'
import type { Records } from '@mp/records'
import type { Sessions } from '@mp/sessions'

/** GitLab events about builds and branches: the session that pushed follows them by subscription, nobody else acts on them. */
const GITLAB_BUILD_NOISE = /^(push|pipeline\.|job\.)/

const lower = (x: unknown) => (typeof x === 'string' ? x.toLowerCase() : undefined)
const listed = (v: unknown, name: string) => Array.isArray(v) && v.some((x) => lower(x) === name)

/** Whether a text mentions `@name` (GitLab usernames: letters, digits, `.`, `_`, `-`). */
export function mentionsUser(text: unknown, name: string): boolean {
  if (typeof text !== 'string' || !name) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w.-])@${escaped}(?![\\w-]|\\.\\w)`, 'i').test(text)
}

/**
 * Whether a GitLab event nobody claimed (no subscription, trigger or tag took it) is worth a router run
 * of the employee with GitLab username `username`. Live, nearly every unclaimed push, pipeline, job and
 * merge request update ended in "nothing to route", each a full model call. Worth it: a merge request
 * or issue assigned to it or asking its review, a comment that mentions it. Never its own actions, nor
 * builds and pushes. Without a username (GitLab not set up for it) only builds and pushes are dropped.
 * A trigger still gets any of them to a session: triggers run before the fallback.
 */
export function gitlabWantsRouter(event: Pick<MpEvent['data'], 'type' | 'payload'>, username: string | undefined): boolean {
  if (GITLAB_BUILD_NOISE.test(event.type)) return false
  const name = lower(username)
  if (!name) return true
  const p = (event.payload ?? {}) as Record<string, unknown>
  if (lower(p.actor) === name) return false
  if (event.type === 'comment.created') return p.system !== true && mentionsUser(p.body, name)
  if (/^(merge_request|issue)\./.test(event.type))
    return listed(p.assignees, name) || listed(p.reviewers, name) || mentionsUser(p.description, name)
  return true
}

/** Who the employee is in Linear: its user id, and the names a comment may `@`-mention it by. */
export interface LinearSelf {
  id: string | undefined
  names: string[]
}

/** What the harness has seen of a Linear issue: whether it's assigned to the employee, whether it commented on it. */
export interface LinearIssueSeen {
  assignedToMe: boolean
  iCommented: boolean
}

/**
 * Whether a Linear event nobody claimed is worth a router run of the employee. Live, every unclaimed
 * update, state change and comment edit went to the router and ended in "just a status change", one
 * model call or more each, ten at once for a bulk edit. Worth it: the issue assigned to the employee,
 * a new comment that mentions it, or a new comment on an issue assigned to it or that it commented on.
 * Never its own actions. A session that follows an issue still gets everything by subscription, and a
 * trigger still gets any of them to a session: both run before the fallback.
 */
export function linearWantsRouter(
  event: Pick<MpEvent['data'], 'type' | 'payload'>,
  me: LinearSelf,
  seen: LinearIssueSeen,
): boolean {
  const p = (event.payload ?? {}) as Record<string, unknown>
  const idOf = (v: unknown) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : undefined)
  if (me.id && (idOf(p.actor) === me.id || (event.type.startsWith('comment.') && idOf(p.author) === me.id))) return false
  if (event.type === 'issue.assigned') return !!me.id && idOf(p.assignee) === me.id
  if (event.type === 'comment.created')
    return me.names.some((n) => mentionsUser(p.body, n)) || seen.assignedToMe || seen.iCommented
  return false
}

/** What a source's rule knows of the employee whose router would get the event. */
export interface FallbackContext {
  /** Its handle in a system (`gitlab`, `linear`, `mp`…), from its contact. */
  handle(system: string): string | undefined
  /** The names a message may `@`-mention it by: its chat handle, its key, its name. */
  names: string[]
  records: Records
}

/**
 * Per event source: whether an event nobody claimed is worth a router run of the employee. A source
 * without a rule always is. A new integration with noisy events adds its rule here.
 */
export const FALLBACK_RULES: Record<string, (event: MpEvent, ctx: FallbackContext) => Promise<boolean> | boolean> = {
  'integration:gitlab': (event, ctx) => gitlabWantsRouter(event.data, ctx.handle('gitlab')),
  'integration:linear': async (event, ctx) => {
    const me = { id: ctx.handle('linear'), names: ctx.names }
    return linearWantsRouter(event.data, me, await linearIssueSeen(ctx.records, event, me.id))
  },
}

/** What the stored Linear events of the issue say: its latest assignee, whether the employee commented on it. */
async function linearIssueSeen(records: Records, event: MpEvent, myId: string | undefined): Promise<LinearIssueSeen> {
  const seen = { assignedToMe: false, iCommented: false }
  const issue = event.data.subject?.id
  if (!myId || !issue || event.data.type !== 'comment.created') return seen
  const past = await records.query<MpEvent['data']>('event', {
    where: { source: event.data.source, 'subject.id': issue },
    orderBy: { field: 'receivedAt', dir: 'desc' },
    limit: 200,
  })
  const idOf = (v: unknown) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : undefined)
  const payload = (e: { data: MpEvent['data'] } | undefined) => (e?.data.payload ?? {}) as Record<string, unknown>
  const latestIssue = past.items.find((e) => e.data.type.startsWith('issue.') && e.id !== event.id)
  seen.assignedToMe = idOf(payload(latestIssue).assignee) === myId
  seen.iCommented = past.items.some((e) => e.data.type === 'comment.created' && idOf(payload(e).author) === myId)
  return seen
}

/** The router's `wantsFallback`: the event source's rule (FALLBACK_RULES), with the router's employee as context. */
export function createWantsFallback(d: { sessions: Sessions; directory: Directory; records: Records }) {
  return async (event: MpEvent, routerSessionId: string): Promise<boolean> => {
    const rule = FALLBACK_RULES[event.data.source]
    if (!rule) return true
    const employeeId = (await d.sessions.get(routerSessionId))?.data.employeeId
    const employee = employeeId ? await d.directory.employees.get(employeeId) : null
    const contact = employee ? await d.directory.contacts.get(employee.data.contactId) : null
    const handle = (system: string) => contact?.data.handles?.find((h) => h.system === system)?.id
    const names = [handle('mp'), employee?.key, contact?.data.name].filter((n): n is string => !!n)
    return rule(event, { handle, names, records: d.records })
  }
}
