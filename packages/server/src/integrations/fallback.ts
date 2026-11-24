import type { MpEvent } from '@mp/events'

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
