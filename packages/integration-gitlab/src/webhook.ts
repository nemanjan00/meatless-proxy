import { createHash, timingSafeEqual } from 'node:crypto'
import type { Json } from '@mp/core'
import type { IntegrationEvent, WebhookRequest, WebhookResult } from '@mp/mcp'
import { truncate } from './format.ts'

export const SOURCE = 'integration:gitlab'
export const SYSTEM = 'gitlab'

/**
 * Constant-time check of `X-Gitlab-Token` against the configured secret.
 * GitLab sends the secret as-is (it doesn't sign bodies or timestamps), so both
 * sides are hashed first: equal lengths, and nothing leaks through timing.
 */
export function verifyGitlabToken(header: string | undefined, secret: string): boolean {
  if (!secret || typeof header !== 'string' || header === '') return false
  const a = createHash('sha256').update(header).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** The dedupe key: GitLab's event UUID, else the webhook UUID plus the body hash, else the body hash. */
export function dedupeKey(headers: Record<string, string>, body: string, kind: string): string {
  const event = headers['x-gitlab-event-uuid']
  if (event) return `gitlab:${kind}:${event}`
  const hook = headers['x-gitlab-webhook-uuid']
  return `gitlab:${kind}:${hook ? `${hook}:` : ''}${sha256(body).slice(0, 32)}`
}

const json = (status: number, value: unknown): Pick<WebhookResult, 'status' | 'body' | 'headers'> => ({
  status,
  body: JSON.stringify(value),
  headers: { 'content-type': 'application/json' },
})

/** Verifies and maps one GitLab webhook delivery. Unknown or uninteresting events are acknowledged with no events. */
export function handleGitlabWebhook(req: WebhookRequest, secret: string): WebhookResult {
  if (req.method.toUpperCase() !== 'POST') return { ...json(405, { error: 'method not allowed' }), events: [] }
  if (!verifyGitlabToken(req.headers['x-gitlab-token'], secret)) return { ...json(401, { error: 'invalid token' }), events: [] }
  let body: any
  try {
    body = JSON.parse(req.body)
  } catch {
    return { ...json(400, { error: 'invalid JSON' }), events: [] }
  }
  if (!body || typeof body !== 'object') return { ...json(400, { error: 'invalid payload' }), events: [] }
  const kind = String(body.object_kind ?? body.event_name ?? 'unknown')
  const event = mapGitlabEvent(body)
  const events = event ? [{ ...event, dedupeKey: dedupeKey(req.headers, req.body, kind) }] : []
  return { ...json(200, { ok: true, events: events.length }), events }
}

type Mapped = Omit<IntegrationEvent, 'dedupeKey'>

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined
const names = (list: unknown, key = 'username'): string[] =>
  Array.isArray(list) ? list.map((x: any) => x?.[key]).filter((x): x is string => typeof x === 'string') : []

/** `group/repo` from the payload, falling back to the repository homepage path. */
function projectPath(b: any): string {
  const p = str(b.project?.path_with_namespace)
  if (p) return p
  const home = str(b.repository?.homepage) ?? str(b.project?.web_url)
  if (home) {
    try {
      return new URL(home).pathname.replace(/^\/+|\/+$/g, '')
    } catch {}
  }
  return str(b.project_id) ?? str(b.project?.id) ?? 'unknown'
}

/** The MR iid of a merge request pipeline ref like `refs/merge-requests/12/head`. */
export function mrIidFromRef(ref: string | undefined): number | undefined {
  const m = ref?.match(/^refs\/merge-requests\/(\d+)\/(head|merge|train)$/)
  return m ? Number(m[1]) : undefined
}

const branchOf = (ref: string | undefined) => (ref ?? '').replace(/^refs\/heads\//, '')
const mrSubject = (path: string, iid: number | string) => ({ system: SYSTEM, id: `${path}!${iid}` })
const issueSubject = (path: string, iid: number | string) => ({ system: SYSTEM, id: `${path}#${iid}` })
const refSubject = (path: string, ref: string) => ({ system: SYSTEM, id: `${path}@${ref}` })
const actorOf = (username: unknown) => {
  const id = str(username)
  return id ? { actor: { system: SYSTEM, id } } : {}
}

const MR_ACTIONS: Record<string, string> = {
  open: 'opened',
  reopen: 'opened',
  update: 'updated',
  approved: 'approved',
  approval: 'approved',
  unapproved: 'unapproved',
  unapproval: 'unapproved',
  merge: 'merged',
  close: 'closed',
}
const ISSUE_ACTIONS: Record<string, string> = { open: 'opened', reopen: 'opened', update: 'updated', close: 'closed' }
const PIPELINE_STATUSES: Record<string, string> = {
  success: 'succeeded',
  failed: 'failed',
  running: 'running',
  canceled: 'canceled',
  cancelled: 'canceled',
}
const VERB: Record<string, string> = {
  opened: 'opened',
  updated: 'updated',
  approved: 'approved',
  unapproved: 'unapproved',
  merged: 'merged',
  closed: 'closed',
}

/** Maps a parsed GitLab webhook body to an event (without its dedupe key), or null when it isn't one we route. */
export function mapGitlabEvent(b: any): Mapped | null {
  switch (b.object_kind) {
    case 'merge_request':
      return mapMergeRequest(b)
    case 'note':
      return mapNote(b)
    case 'pipeline':
      return mapPipeline(b)
    case 'build':
      return mapJob(b)
    case 'push':
      return mapPush(b)
    case 'issue':
      return mapIssue(b)
    default:
      return null
  }
}

function mapMergeRequest(b: any): Mapped | null {
  const a = b.object_attributes ?? {}
  const path = projectPath(b)
  const action = MR_ACTIONS[String(a.action ?? 'update')] ?? 'updated'
  const who = str(b.user?.username)
  const changed = b.changes && typeof b.changes === 'object' ? Object.keys(b.changes) : []
  const pushed = action === 'updated' && !!a.oldrev
  const detail = pushed ? 'new commits pushed' : action === 'updated' && changed.length ? `${changed.join(', ')} changed` : ''
  return {
    source: SOURCE,
    type: `merge_request.${action}`,
    subject: mrSubject(path, a.iid),
    ...actorOf(who),
    text: `GitLab ${path}!${a.iid} "${truncate(a.title, 120)}": merge request ${VERB[action]}${detail ? ` (${detail})` : ''}${who ? ` by @${who}` : ''}`,
    payload: {
      project: path,
      iid: a.iid ?? null,
      title: a.title ?? null,
      url: a.url ?? null,
      action: a.action ?? null,
      state: a.state ?? null,
      draft: a.draft ?? a.work_in_progress ?? false,
      source_branch: a.source_branch ?? null,
      target_branch: a.target_branch ?? null,
      merge_status: a.detailed_merge_status ?? a.merge_status ?? null,
      last_commit: a.last_commit ? { id: str(a.last_commit.id) ?? null, title: a.last_commit.title ?? null } : null,
      new_commits: pushed,
      changed,
      labels: names(b.labels, 'title'),
      assignees: names(b.assignees),
      reviewers: names(b.reviewers),
      actor: who ?? null,
    } as Json,
  }
}

function mapNote(b: any): Mapped | null {
  const a = b.object_attributes ?? {}
  const path = projectPath(b)
  const who = str(b.user?.username)
  let subject: { system: string; id: string }
  let ref: string
  let title: string | undefined
  if (a.noteable_type === 'MergeRequest' && b.merge_request) {
    subject = mrSubject(path, b.merge_request.iid)
    ref = `${path}!${b.merge_request.iid}`
    title = b.merge_request.title
  } else if (a.noteable_type === 'Issue' && b.issue) {
    subject = issueSubject(path, b.issue.iid)
    ref = `${path}#${b.issue.iid}`
    title = b.issue.title
  } else {
    return null
  }
  const pos = a.position ?? null
  return {
    source: SOURCE,
    type: 'comment.created',
    subject,
    ...actorOf(who),
    text: `GitLab ${ref} "${truncate(title, 120)}": comment${who ? ` by @${who}` : ''}: ${truncate(String(a.note ?? '').replace(/\s+/g, ' '), 200)}`,
    payload: {
      project: path,
      on: a.noteable_type === 'MergeRequest' ? 'merge_request' : 'issue',
      iid: (b.merge_request ?? b.issue).iid ?? null,
      title: title ?? null,
      note_id: a.id ?? null,
      discussion_id: a.discussion_id ?? null,
      body: truncate(a.note, 4000),
      url: a.url ?? null,
      author: who ?? null,
      actor: who ?? null,
      system: !!a.system,
      path: pos ? (pos.new_path ?? pos.old_path ?? null) : null,
      line: pos ? (pos.new_line ?? pos.old_line ?? null) : null,
    } as Json,
  }
}

function mapPipeline(b: any): Mapped | null {
  const a = b.object_attributes ?? {}
  const status = PIPELINE_STATUSES[String(a.status)]
  if (!status) return null
  const path = projectPath(b)
  const mrIid = b.merge_request?.iid ?? mrIidFromRef(a.ref)
  const failed = Array.isArray(b.builds)
    ? b.builds.filter((j: any) => j.status === 'failed' && !j.allow_failure).map((j: any) => String(j.name))
    : []
  const where =
    mrIid !== undefined
      ? `${path}!${mrIid}${b.merge_request?.title ? ` "${truncate(b.merge_request.title, 120)}"` : ''}`
      : `${path}@${a.ref}`
  const onJob =
    status === 'failed' && failed.length ? ` on job ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''}` : ''
  return {
    source: SOURCE,
    type: `pipeline.${status}`,
    subject: mrIid !== undefined ? mrSubject(path, mrIid) : refSubject(path, String(a.ref ?? '')),
    ...actorOf(b.user?.username),
    text: `GitLab ${where}: pipeline ${a.id} ${status}${onJob}`,
    payload: {
      project: path,
      pipeline_id: a.id ?? null,
      status: a.status ?? null,
      ref: a.ref ?? null,
      sha: a.sha ?? null,
      source: a.source ?? null,
      url: a.url ?? null,
      duration: a.duration ?? null,
      merge_request_iid: mrIid ?? null,
      actor: str(b.user?.username) ?? null,
      failed_jobs: failed,
      jobs: Array.isArray(b.builds)
        ? b.builds
            .slice(0, 50)
            .map((j: any) => ({ id: j.id ?? null, name: j.name ?? null, stage: j.stage ?? null, status: j.status ?? null }))
        : [],
    } as Json,
  }
}

function mapJob(b: any): Mapped | null {
  if (b.build_status !== 'failed') return null
  const path = projectPath(b)
  const mrIid = mrIidFromRef(b.ref)
  return {
    source: SOURCE,
    type: 'job.failed',
    subject: mrIid !== undefined ? mrSubject(path, mrIid) : refSubject(path, String(b.ref ?? '')),
    ...actorOf(b.user?.username),
    text: `GitLab ${mrIid !== undefined ? `${path}!${mrIid}` : `${path}@${b.ref}`}: job ${b.build_name} (${b.build_stage}) failed${b.build_failure_reason ? `: ${b.build_failure_reason}` : ''}${b.build_allow_failure ? ' (allowed to fail)' : ''}`,
    payload: {
      project: path,
      job_id: b.build_id ?? null,
      name: b.build_name ?? null,
      stage: b.build_stage ?? null,
      status: b.build_status ?? null,
      failure_reason: b.build_failure_reason ?? null,
      allow_failure: !!b.build_allow_failure,
      pipeline_id: b.pipeline_id ?? null,
      ref: b.ref ?? null,
      sha: b.sha ?? null,
      merge_request_iid: mrIid ?? null,
      actor: str(b.user?.username) ?? null,
    } as Json,
  }
}

const ZERO_SHA = /^0+$/

function mapPush(b: any): Mapped | null {
  if (!String(b.ref ?? '').startsWith('refs/heads/')) return null
  const path = projectPath(b)
  const branch = branchOf(b.ref)
  const who = str(b.user_username)
  const created = ZERO_SHA.test(String(b.before ?? ''))
  const deleted = ZERO_SHA.test(String(b.after ?? ''))
  const count = Number(b.total_commits_count ?? (Array.isArray(b.commits) ? b.commits.length : 0))
  const what = deleted ? 'deleted the branch' : `pushed ${count} commit${count === 1 ? '' : 's'}${created ? ' (new branch)' : ''}`
  return {
    source: SOURCE,
    type: 'push',
    subject: refSubject(path, branch),
    ...actorOf(who),
    text: `GitLab ${path}@${branch}: ${who ? `@${who} ` : ''}${what}`,
    payload: {
      project: path,
      branch,
      before: b.before ?? null,
      after: b.after ?? null,
      created,
      deleted,
      total_commits: count,
      commits: Array.isArray(b.commits)
        ? b.commits.slice(0, 20).map((c: any) => ({
            id: String(c.id ?? '').slice(0, 8),
            title: c.title ?? String(c.message ?? '').split('\n')[0] ?? null,
            author: c.author?.name ?? null,
          }))
        : [],
      actor: who ?? null,
    } as Json,
  }
}

function mapIssue(b: any): Mapped | null {
  const a = b.object_attributes ?? {}
  const action = ISSUE_ACTIONS[String(a.action ?? 'update')] ?? 'updated'
  const path = projectPath(b)
  const who = str(b.user?.username)
  const changed = b.changes && typeof b.changes === 'object' ? Object.keys(b.changes) : []
  const detail = action === 'updated' && changed.length ? ` (${changed.join(', ')} changed)` : ''
  return {
    source: SOURCE,
    type: `issue.${action}`,
    subject: issueSubject(path, a.iid),
    ...actorOf(who),
    text: `GitLab ${path}#${a.iid} "${truncate(a.title, 120)}": issue ${action}${detail}${who ? ` by @${who}` : ''}`,
    payload: {
      project: path,
      iid: a.iid ?? null,
      title: a.title ?? null,
      description: truncate(a.description, 4000),
      state: a.state ?? null,
      action: a.action ?? null,
      url: a.url ?? null,
      confidential: !!a.confidential,
      changed,
      labels: names(b.labels, 'title'),
      assignees: names(b.assignees),
      actor: who ?? null,
    } as Json,
  }
}
