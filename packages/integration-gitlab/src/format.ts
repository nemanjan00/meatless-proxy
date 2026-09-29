/** Compact shapes for tool results: what the model needs, not raw API dumps. */

export const truncate = (s: string | null | undefined, max: number): string => {
  const t = s ?? ''
  return t.length > max ? `${t.slice(0, max)}… [truncated, ${t.length - max} more chars]` : t
}

const DRAFT_RE = /^\s*(\[draft\]|\(draft\)|draft:|draft\s-|draft\s|wip:|\[wip\])\s*/i

export const isDraftTitle = (title: string) => DRAFT_RE.test(title)
export const stripDraft = (title: string) => title.replace(DRAFT_RE, '')
export const withDraft = (title: string, draft: boolean) => (draft ? `Draft: ${stripDraft(title)}` : stripDraft(title))

const usernames = (list: any): string[] | undefined =>
  Array.isArray(list) ? list.map((u) => u?.username).filter((u): u is string => typeof u === 'string') : undefined

export function project(p: any) {
  return {
    id: p.id,
    path: p.path_with_namespace,
    name: p.name,
    description: p.description ? truncate(p.description, 500) : undefined,
    default_branch: p.default_branch,
    visibility: p.visibility,
    web_url: p.web_url,
    ssh_url: p.ssh_url_to_repo,
    http_url: p.http_url_to_repo,
    archived: p.archived || undefined,
    last_activity_at: p.last_activity_at,
  }
}

export function branch(b: any) {
  return {
    name: b.name,
    default: b.default || undefined,
    protected: b.protected || undefined,
    merged: b.merged || undefined,
    commit: b.commit ? commit(b.commit) : undefined,
  }
}

export function commit(c: any) {
  return {
    id: c.short_id ?? String(c.id ?? '').slice(0, 8),
    title: c.title,
    author: c.author_name,
    date: c.committed_date ?? c.created_at,
  }
}

export function pipeline(p: any) {
  if (!p) return undefined
  return {
    id: p.id,
    status: p.status,
    ref: p.ref,
    sha: p.sha ? String(p.sha).slice(0, 8) : undefined,
    source: p.source,
    web_url: p.web_url,
    created_at: p.created_at,
    updated_at: p.updated_at,
    duration: p.duration ?? undefined,
  }
}

export function job(j: any) {
  return {
    id: j.id,
    name: j.name,
    stage: j.stage,
    status: j.status,
    allow_failure: j.allow_failure || undefined,
    failure_reason: j.failure_reason ?? undefined,
    duration: j.duration ?? undefined,
    web_url: j.web_url,
  }
}

export function mergeRequest(m: any) {
  return {
    iid: m.iid,
    project_id: m.project_id,
    title: m.title,
    state: m.state,
    draft: m.draft ?? m.work_in_progress ?? isDraftTitle(m.title ?? ''),
    author: m.author?.username,
    source_branch: m.source_branch,
    target_branch: m.target_branch,
    labels: m.labels,
    assignees: usernames(m.assignees),
    reviewers: usernames(m.reviewers),
    merge_status: m.detailed_merge_status ?? m.merge_status,
    has_conflicts: m.has_conflicts || undefined,
    web_url: m.web_url,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }
}

export function issue(i: any) {
  return {
    iid: i.iid,
    project_id: i.project_id,
    title: i.title,
    state: i.state,
    author: i.author?.username,
    assignees: usernames(i.assignees),
    labels: i.labels,
    milestone: i.milestone?.title,
    confidential: i.confidential || undefined,
    web_url: i.web_url,
    created_at: i.created_at,
    updated_at: i.updated_at,
  }
}

export function note(n: any) {
  return {
    id: n.id,
    author: n.author?.username,
    body: truncate(n.body, 2000),
    created_at: n.created_at,
    system: n.system || undefined,
  }
}

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

/** Removes ANSI colour codes and GitLab's collapsible section markers from a job trace. */
export function cleanTrace(s: string): string {
  return s
    .replace(ANSI_RE, '')
    .replace(/section_(start|end):\d+:[A-Za-z0-9_.-]+(\[[^\]]*\])?\r?/g, '')
    .replace(/\r(?!\n)/g, '\n')
}

/** Counts added and removed lines in a unified diff. */
export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

/** Drops undefined fields, so results stay compact. */
export function compact<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
