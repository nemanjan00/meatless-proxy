import { errorMessage, MpError, ValidationError } from '@mp/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type GitlabClient, projectRef } from './client.ts'
import * as f from './format.ts'

export const SERVER_NAME = 'gitlab'
export const SERVER_VERSION = '0.0.0'

/** Default and maximum sizes, so results stay small enough for a model's context. */
export const LIMITS = {
  fileBytes: 100_000,
  changesBytes: 60_000,
  diffFileBytes: 20_000,
  jobLogKb: 32,
  jobLogMaxKb: 512,
  listDefault: 20,
  listMax: 100,
}

/** The tools this server exposes. There is deliberately no merge, approve or auto-merge tool. */
export const TOOL_NAMES = [
  'get_project',
  'list_branches',
  'get_file',
  'list_tree',
  'create_merge_request',
  'update_merge_request',
  'get_merge_request',
  'list_merge_requests',
  'merge_request_changes',
  'comment_merge_request',
  'reply_discussion',
  'pipeline_status',
  'job_log',
  'get_issue',
  'create_issue',
  'comment_issue',
  'current_user',
] as const

const projectArg = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe('Project id (e.g. 42) or full path (e.g. "group/sub/repo")')
const iidArg = (what: string) =>
  z.number().int().positive().describe(`The ${what} number within the project (iid, e.g. 12 for !12)`)
const limitArg = z
  .number()
  .int()
  .min(1)
  .max(LIMITS.listMax)
  .optional()
  .describe(`Maximum results (default ${LIMITS.listDefault})`)

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (value: unknown): Result => ({ content: [{ type: 'text', text: JSON.stringify(f.compact(value)) }] })
const fail = (e: unknown): Result => {
  const status = e instanceof MpError ? e.details?.status : undefined
  const code = e instanceof MpError ? e.code : 'error'
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(e), code, ...(status ? { status } : {}) }) }],
    isError: true,
  }
}

/** Builds the GitLab MCP server over a client. A new server per connection. */
export function createGitlabMcpServer(api: GitlabClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const tool = <S extends z.ZodRawShape>(
    name: (typeof TOOL_NAMES)[number],
    description: string,
    shape: S,
    run: (args: any) => Promise<unknown>,
  ) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: any) => {
      try {
        return ok(await run(args))
      } catch (e) {
        return fail(e)
      }
    }) as any)

  const p = (project: string | number) => `/projects/${projectRef(project)}`
  const defaultBranch = async (project: string | number): Promise<string> => {
    const proj = await api.get(p(project))
    if (!proj?.default_branch) throw new ValidationError(`project ${project} has no default branch`)
    return proj.default_branch
  }
  const userIds = async (names: string[] | undefined): Promise<number[] | undefined> => {
    if (!names?.length) return undefined
    return Promise.all(
      names.map(async (raw) => {
        const username = raw.replace(/^@/, '')
        const found = await api.get('/users', { username })
        const id = Array.isArray(found) ? found[0]?.id : undefined
        if (!id) throw new ValidationError(`no GitLab user @${username}`)
        return id as number
      }),
    )
  }
  const mrPath = (project: string | number, iid: number) => `${p(project)}/merge_requests/${iid}`

  tool(
    'get_project',
    'Get a GitLab project: its path, default branch, clone URLs (use ssh_url with git) and visibility.',
    { project: projectArg },
    async ({ project }) => f.project(await api.get(p(project))),
  )

  tool(
    'list_branches',
    'List branches of a project, with their latest commit and whether they are protected or the default.',
    { project: projectArg, search: z.string().optional().describe('Only branches whose name contains this'), limit: limitArg },
    async ({ project, search, limit }) =>
      (await api.paginate(`${p(project)}/repository/branches`, { search }, limit ?? LIMITS.listDefault)).map(f.branch),
  )

  tool(
    'get_file',
    'Read one file from the repository at a branch, tag or commit (default: the default branch). Large files are truncated.',
    {
      project: projectArg,
      path: z.string().min(1).describe('File path in the repository, e.g. "src/app.ts"'),
      ref: z.string().optional().describe('Branch, tag or commit sha (default: the default branch)'),
      max_bytes: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe(`Truncate after this many characters (default ${LIMITS.fileBytes})`),
    },
    async ({ project, path, ref, max_bytes }) => {
      const at = ref ?? (await defaultBranch(project))
      const clean = String(path).replace(/^\/+/, '')
      const text = await api.getText(`${p(project)}/repository/files/${encodeURIComponent(clean)}/raw`, { ref: at })
      if (text.includes('\u0000')) return { path: clean, ref: at, binary: true, size: text.length }
      const max = max_bytes ?? LIMITS.fileBytes
      return { path: clean, ref: at, size: text.length, truncated: text.length > max || undefined, content: text.slice(0, max) }
    },
  )

  tool(
    'list_tree',
    'List files and directories in the repository at a path and ref (default: the root of the default branch).',
    {
      project: projectArg,
      path: z.string().optional().describe('Directory to list (default: the repository root)'),
      ref: z.string().optional().describe('Branch, tag or commit sha (default: the default branch)'),
      recursive: z.boolean().optional().describe('Include everything below the path'),
      limit: z.number().int().min(1).max(1000).optional().describe('Maximum entries (default 200)'),
    },
    async ({ project, path, ref, recursive, limit }) => {
      const entries = await api.paginate(`${p(project)}/repository/tree`, { path, ref, recursive }, limit ?? 200)
      return entries.map((e: any) => ({ path: e.path, type: e.type === 'tree' ? 'dir' : e.type === 'blob' ? 'file' : e.type }))
    },
  )

  tool(
    'create_merge_request',
    'Open a merge request from a branch you pushed (with git over SSH) into the target branch. ' +
      'You can never merge it yourself: CI or people do that. Mark it draft while work is unfinished.',
    {
      project: projectArg,
      source_branch: z.string().min(1).describe('Your branch, already pushed'),
      target_branch: z.string().optional().describe("Default: the project's default branch"),
      title: z.string().min(1),
      description: z.string().optional().describe('Markdown: what changed, why, and how it was tested'),
      draft: z.boolean().optional().describe('Open as a draft (title prefixed "Draft:")'),
      labels: z.array(z.string()).optional(),
      reviewers: z.array(z.string()).optional().describe('GitLab usernames to request review from'),
      assignees: z.array(z.string()).optional().describe('GitLab usernames to assign'),
    },
    async (a) => {
      const [target, reviewerIds, assigneeIds] = await Promise.all([
        a.target_branch ? a.target_branch : defaultBranch(a.project),
        userIds(a.reviewers),
        userIds(a.assignees),
      ])
      const mr = await api.post(`${p(a.project)}/merge_requests`, {
        source_branch: a.source_branch,
        target_branch: target,
        title: a.draft === undefined ? a.title : f.withDraft(a.title, a.draft),
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.labels?.length ? { labels: a.labels.join(',') } : {}),
        ...(reviewerIds ? { reviewer_ids: reviewerIds } : {}),
        ...(assigneeIds ? { assignee_ids: assigneeIds } : {}),
      })
      return f.mergeRequest(mr)
    },
  )

  tool(
    'update_merge_request',
    'Change a merge request: title, description, labels or draft state. It cannot merge, approve or set auto-merge.',
    {
      project: projectArg,
      iid: iidArg('merge request'),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      labels: z.array(z.string()).optional().describe('Replace all labels'),
      add_labels: z.array(z.string()).optional(),
      remove_labels: z.array(z.string()).optional(),
      draft: z.boolean().optional().describe('true: mark as draft; false: mark as ready for review'),
    },
    async (a) => {
      const body: Record<string, unknown> = {}
      let title: string | undefined = a.title
      if (a.draft !== undefined) {
        title ??= (await api.get(mrPath(a.project, a.iid))).title as string
        title = f.withDraft(title, a.draft)
      }
      if (title !== undefined) body.title = title
      if (a.description !== undefined) body.description = a.description
      if (a.labels) body.labels = a.labels.join(',')
      if (a.add_labels?.length) body.add_labels = a.add_labels.join(',')
      if (a.remove_labels?.length) body.remove_labels = a.remove_labels.join(',')
      if (!Object.keys(body).length) throw new ValidationError('nothing to update')
      return f.mergeRequest(await api.put(mrPath(a.project, a.iid), body))
    },
  )

  tool(
    'get_merge_request',
    'Get a merge request with its diff stats, latest pipeline status and unresolved review discussions (with ids for reply_discussion).',
    { project: projectArg, iid: iidArg('merge request') },
    async ({ project, iid }) => {
      const [mr, diffs, discussions] = await Promise.all([
        api.get(mrPath(project, iid)),
        api.paginate(`${mrPath(project, iid)}/diffs`, {}, 500),
        api.paginate(`${mrPath(project, iid)}/discussions`, {}, 500),
      ])
      const stats = diffs.reduce(
        (acc: { additions: number; deletions: number }, d: any) => {
          const s = f.diffStats(d.diff ?? '')
          return { additions: acc.additions + s.additions, deletions: acc.deletions + s.deletions }
        },
        { additions: 0, deletions: 0 },
      )
      const unresolved = discussions.filter((d: any) => (d.notes ?? []).some((n: any) => n.resolvable && !n.resolved))
      const pl = mr.head_pipeline ?? mr.pipeline
      return {
        ...f.mergeRequest(mr),
        description: f.truncate(mr.description, 4000),
        diff: { files: diffs.length, ...stats },
        pipeline: pl ? { id: pl.id, status: pl.status, web_url: pl.web_url } : null,
        unresolved_discussions: unresolved.length,
        discussions: unresolved.slice(0, 20).map((d: any) => {
          const first = d.notes[0]
          return {
            id: d.id,
            author: first?.author?.username,
            body: f.truncate(first?.body, 500),
            path: first?.position?.new_path ?? first?.position?.old_path,
            line: first?.position?.new_line ?? first?.position?.old_line,
            replies: d.notes.length - 1,
          }
        }),
      }
    },
  )

  tool(
    'list_merge_requests',
    'List merge requests in a project, newest first, filtered by state, author or source branch.',
    {
      project: projectArg,
      state: z.enum(['opened', 'closed', 'merged', 'locked', 'all']).optional().describe('Default: opened'),
      author: z.string().optional().describe('GitLab username of the author'),
      source_branch: z.string().optional(),
      target_branch: z.string().optional(),
      search: z.string().optional().describe('Text in the title or description'),
      limit: limitArg,
    },
    async (a) =>
      (
        await api.paginate(
          `${p(a.project)}/merge_requests`,
          {
            state: a.state ?? 'opened',
            author_username: a.author?.replace(/^@/, ''),
            source_branch: a.source_branch,
            target_branch: a.target_branch,
            search: a.search,
            order_by: 'created_at',
            sort: 'desc',
          },
          a.limit ?? LIMITS.listDefault,
        )
      ).map(f.mergeRequest),
  )

  tool(
    'merge_request_changes',
    'Read the diffs of a merge request, file by file. Long diffs are truncated; pass path to read one file.',
    {
      project: projectArg,
      iid: iidArg('merge request'),
      path: z.string().optional().describe('Only this file (old or new path)'),
      max_bytes: z
        .number()
        .int()
        .min(1000)
        .max(500_000)
        .optional()
        .describe(`Total diff budget (default ${LIMITS.changesBytes})`),
    },
    async ({ project, iid, path, max_bytes }) => {
      const all = await api.paginate(`${mrPath(project, iid)}/diffs`, {}, 1000)
      const diffs = path ? all.filter((d: any) => d.new_path === path || d.old_path === path) : all
      let budget = max_bytes ?? LIMITS.changesBytes
      let truncated = false
      const files = diffs.map((d: any) => {
        const diff = String(d.diff ?? '')
        const room = Math.max(0, Math.min(budget, path ? budget : LIMITS.diffFileBytes))
        const cut = diff.length > room
        if (cut) truncated = true
        budget -= Math.min(diff.length, room)
        return {
          path: d.new_path,
          old_path: d.old_path !== d.new_path ? d.old_path : undefined,
          status: d.new_file ? 'added' : d.deleted_file ? 'deleted' : d.renamed_file ? 'renamed' : 'modified',
          ...f.diffStats(diff),
          diff: cut ? (room ? `${diff.slice(0, room)}\n… [diff truncated]` : '[omitted: budget used up]') : diff,
          too_large: d.too_large || d.collapsed || undefined,
        }
      })
      return { iid, files: files.length, truncated: truncated || undefined, changes: files }
    },
  )

  tool(
    'comment_merge_request',
    'Post a comment (a note) on a merge request. To answer a review thread, use reply_discussion instead.',
    { project: projectArg, iid: iidArg('merge request'), body: z.string().min(1).describe('Markdown') },
    async ({ project, iid, body }) => f.note(await api.post(`${mrPath(project, iid)}/notes`, { body })),
  )

  tool(
    'reply_discussion',
    'Reply in an existing discussion thread on a merge request (default) or an issue. Discussion ids come from get_merge_request or events.',
    {
      project: projectArg,
      iid: iidArg('merge request or issue'),
      discussion_id: z.string().min(1),
      body: z.string().min(1).describe('Markdown'),
      on: z.enum(['merge_request', 'issue']).optional().describe('Default: merge_request'),
    },
    async ({ project, iid, discussion_id, body, on }) => {
      const kind = on === 'issue' ? 'issues' : 'merge_requests'
      const n = await api.post(`${p(project)}/${kind}/${iid}/discussions/${encodeURIComponent(discussion_id)}/notes`, { body })
      return { discussion_id, ...f.note(n) }
    },
  )

  tool(
    'pipeline_status',
    'The latest pipeline of a merge request (pass iid) or of a branch or tag (pass ref; default: the default branch), with its jobs.',
    {
      project: projectArg,
      iid: iidArg('merge request').optional(),
      ref: z.string().optional().describe('Branch or tag, when not asking about a merge request'),
    },
    async ({ project, iid, ref }) => {
      let latest: any
      if (iid !== undefined) {
        const list = await api.get(`${mrPath(project, iid)}/pipelines`, { per_page: 1 })
        latest = Array.isArray(list) ? list[0] : undefined
      } else {
        const at = ref ?? (await defaultBranch(project))
        const list = await api.get(`${p(project)}/pipelines`, { ref: at, per_page: 1, order_by: 'id', sort: 'desc' })
        latest = Array.isArray(list) ? list[0] : undefined
      }
      if (!latest) return { pipeline: null }
      const [full, jobs] = await Promise.all([
        api.get(`${p(project)}/pipelines/${latest.id}`),
        api.paginate(`${p(project)}/pipelines/${latest.id}/jobs`, {}, 200),
      ])
      const failed = jobs.filter((j: any) => j.status === 'failed' && !j.allow_failure).map((j: any) => j.name)
      return { pipeline: f.pipeline(full), failed_jobs: failed.length ? failed : undefined, jobs: jobs.map(f.job) }
    },
  )

  tool(
    'job_log',
    'Read the end of a CI job log (ANSI colours removed). Use it to see why a job failed.',
    {
      project: projectArg,
      job_id: z.number().int().positive(),
      tail_kb: z
        .number()
        .int()
        .min(1)
        .max(LIMITS.jobLogMaxKb)
        .optional()
        .describe(`Last N KB of the log (default ${LIMITS.jobLogKb})`),
    },
    async ({ project, job_id, tail_kb }) => {
      const text = f.cleanTrace(await api.getText(`${p(project)}/jobs/${job_id}/trace`))
      const max = (tail_kb ?? LIMITS.jobLogKb) * 1024
      const cut = text.length > max
      return { job_id, bytes: text.length, truncated: cut || undefined, log: cut ? text.slice(-max) : text }
    },
  )

  tool(
    'get_issue',
    'Get an issue with its description and recent comments.',
    { project: projectArg, iid: iidArg('issue') },
    async ({ project, iid }) => {
      const [i, notes] = await Promise.all([
        api.get(`${p(project)}/issues/${iid}`),
        api.paginate(`${p(project)}/issues/${iid}/notes`, { sort: 'desc', order_by: 'created_at' }, 50),
      ])
      const human = notes.filter((n: any) => !n.system).slice(0, 20)
      return { ...f.issue(i), description: f.truncate(i.description, 4000), comments: human.reverse().map(f.note) }
    },
  )

  tool(
    'create_issue',
    'Create an issue in a project.',
    {
      project: projectArg,
      title: z.string().min(1),
      description: z.string().optional().describe('Markdown'),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional().describe('GitLab usernames'),
      confidential: z.boolean().optional(),
    },
    async (a) => {
      const assigneeIds = await userIds(a.assignees)
      const i = await api.post(`${p(a.project)}/issues`, {
        title: a.title,
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.labels?.length ? { labels: a.labels.join(',') } : {}),
        ...(assigneeIds ? { assignee_ids: assigneeIds } : {}),
        ...(a.confidential !== undefined ? { confidential: a.confidential } : {}),
      })
      return f.issue(i)
    },
  )

  tool(
    'comment_issue',
    'Post a comment on an issue.',
    { project: projectArg, iid: iidArg('issue'), body: z.string().min(1).describe('Markdown') },
    async ({ project, iid, body }) => f.note(await api.post(`${p(project)}/issues/${iid}/notes`, { body })),
  )

  tool('current_user', 'Who you are on GitLab: your own username, name and id.', {}, async () => {
    const u = await api.get('/user')
    return { id: u.id, username: u.username, name: u.name, public_email: u.public_email || undefined, bot: u.bot || undefined }
  })

  return server
}
