import { isMpError, type Json } from '@mp/core'
import { localRepoSlug } from '@mp/git'
import { fail, ok, str, type Kit } from '../kit.ts'
import type { StdlibDeps } from '../types.ts'
import { readView } from './git.ts'

/** projects.read_file: files over this many bytes come without content. */
const READ_MAX_BYTES = 1_000_000
/** projects.list_files: the most entries one call lists. */
const LIST_MAX = 500

const repoIndexProp = { type: 'number', description: "Index into the project's repositories. Default 0." }

/**
 * `projects.create_local`: a new project on a repository the harness hosts itself (docs/spec.md#local-projects),
 * for work that has no repository on a git host yet. The employee becomes a member. It pushes its own branches
 * there with git.push; people review and merge them in the web UI. There is no merge tool.
 */
export function registerProjectTools(kit: Kit, localProjects: NonNullable<StdlibDeps['localProjects']>): void {
  kit.tool(
    {
      name: 'projects.create_local',
      description:
        "Create a project with a new git repository hosted by the harness itself (one empty commit on main), and make you a member of it. Use it only when the work needs a repository and none exists on the git host: check directory.find_project first. Then git.checkout it, commit, and git.push your branch; a person reviews and merges it in the web UI (you can't merge or push main). You get told when it's merged.",
      effect: 'idempotent',
      params: {
        properties: {
          name: { type: 'string', description: 'The project name, e.g. "Invoice parser".' },
          description: { type: 'string', description: 'One paragraph: what it is for.' },
        },
        required: ['name'],
      },
    },
    async (a, ctx) => {
      const name = str(a.name)?.trim()
      if (!name) return fail('name is required')
      const description = str(a.description)?.trim()
      const r = await kit.once('projects.create_local', ctx, async () =>
        localProjects.create({
          name,
          ...(description ? { description } : {}),
          employeeId: ctx.employeeId,
          actor: kit.actor(ctx),
        }),
      )
      return ok({
        ...(r as Record<string, unknown>),
        role: 'member',
        next: 'git.checkout with this projectId, then commit and git.push your branch. A person merges it in the web UI.',
      })
    },
  )

  kit.tool(
    {
      name: 'projects.branches',
      description:
        "List a project's branches with their last commit and how far each is ahead of and behind the default branch, straight from the repository: no checkout and no environment needed. A branch ahead of it and not behind is waiting to be merged. Local projects (repositories the harness hosts); for a project on GitLab use mcp.gitlab.list_branches.",
      effect: 'read',
      params: { properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    },
    async (a) => {
      const project = await kit.deps.directory.projects.get(String(a.projectId ?? ''))
      if (!project) return fail(`no project ${a.projectId}`)
      const repos = (project.data.repositories ?? []).map((r) => ({ url: r.url, slug: localRepoSlug(r.url) }))
      const local = repos.filter((r): r is { url: string; slug: string } => !!r.slug)
      if (!local.length)
        return fail(`${project.data.name} has no repository hosted by the harness: for GitLab use mcp.gitlab.list_branches`, {
          repositories: repos.map((r) => r.url),
        })
      if (!localProjects.branches) return fail('branch listing is not available in this deployment')
      const out = []
      for (const r of local) {
        const b = await localProjects.branches(r.slug)
        out.push({
          url: r.url,
          defaultBranch: b.defaultBranch,
          branches: b.branches.map((x) => ({ ...x, waitingForReview: x.name !== b.defaultBranch && x.ahead > 0 })),
        })
      }
      return ok({ project: project.data.name, repositories: out })
    },
  )

  /** The local repository of a project (by index), or why it can't be read here. */
  const localRepoOf = async (projectId: unknown, index: unknown, hostTools: string) => {
    const project = await kit.deps.directory.projects.get(String(projectId ?? ''))
    if (!project) return { failure: fail(`no project ${projectId}`) }
    const i = typeof index === 'number' ? index : 0
    const repo = project.data.repositories?.[i]
    if (!repo) return { failure: fail(`project ${project.data.name} has no repository #${i}`) }
    const slug = localRepoSlug(repo.url)
    if (!slug)
      return {
        failure: fail(
          `${project.data.name}'s repository is on a git host, not hosted by the harness: read it with ${hostTools}, or git.checkout it`,
          { repository: repo.url },
        ),
      }
    return { project, url: repo.url, slug }
  }

  /**
   * Said when a read of the default branch found nothing: a local project's work sits on unmerged branches
   * until a person merges it, so its default branch may be empty. Names the branches waiting for review.
   */
  const defaultBranchHint = async (slug: string, what?: string): Promise<string | undefined> => {
    if (!localProjects.branches) return undefined
    const b = await localProjects.branches(slug)
    const waiting = b.branches.filter((x) => x.name !== b.defaultBranch && x.ahead > 0)
    if (!waiting.length) return undefined
    const empty = localProjects.tree ? (await localProjects.tree(slug).catch(() => null))?.entries.length === 0 : false
    const list = waiting
      .slice(0, 5)
      .map((x) => `${x.name} (ahead ${x.ahead})`)
      .join(', ')
    const more = waiting.length > 5 ? ` and ${waiting.length - 5} more (projects.branches)` : ''
    return empty
      ? `${b.defaultBranch} is empty; work is on ${list}${more}, waiting for review: pass ref`
      : `${what ?? 'it'} is not on ${b.defaultBranch}; branches waiting for review: ${list}${more}: pass ref to read one`
  }

  /** A missing ref or path, said plainly, with the hint when the default branch was read. */
  const notFound = async (err: unknown, slug: string, ref: string | undefined, what: string) => {
    if (!isMpError(err, 'not_found')) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (/^ref /.test(message)) return fail(`no branch or commit ${ref}: projects.branches lists the branches`)
    const hint = ref ? undefined : await defaultBranchHint(slug, what)
    return fail(`${what} not found${ref ? ` on ${ref}` : ''}`, hint ? { hint } : {})
  }

  kit.tool(
    {
      name: 'projects.read_file',
      description:
        "Read a file of a project's repository on any branch or commit, straight from the repository: no checkout and no environment needed (your own checkout stays on your branch). ref: a branch (e.g. one projects.branches says is waiting for review) or a commit; default: the default branch. A local project's default branch may be empty until its work is merged: the result then names the branches to read. For a big file, read the part you need with offset and limit (lines, numbered in the result). Local projects (repositories the harness hosts); for a project on GitLab use mcp.gitlab.get_file.",
      effect: 'read',
      params: {
        properties: {
          projectId: { type: 'string' },
          path: { type: 'string', description: 'Relative to the repository root, e.g. README.md.' },
          ref: { type: 'string', description: 'Branch or commit. Default: the default branch.' },
          offset: { type: 'number', description: 'First line to read (1-based).' },
          limit: { type: 'number', description: 'How many lines. Default: to the end, at most 2000.' },
          repo: repoIndexProp,
        },
        required: ['projectId', 'path'],
      },
    },
    async (a) => {
      const path = str(a.path)?.replace(/^\/+/, '')
      if (!path) return fail('path is required: a file, relative to the repository root')
      const found = await localRepoOf(a.projectId, a.repo, 'mcp.gitlab.get_file')
      if ('failure' in found) return found.failure!
      if (!localProjects.readFile) return fail('reading repositories is not available in this deployment')
      const ref = str(a.ref)
      let f: Awaited<ReturnType<NonNullable<typeof localProjects.readFile>>>
      try {
        f = await localProjects.readFile(found.slug, { path, ...(ref ? { ref } : {}), maxBytes: READ_MAX_BYTES })
      } catch (err) {
        return notFound(err, found.slug, ref, path)
      }
      const head = { project: found.project.data.name, path: f.path, ref: f.ref }
      if (f.binary) return ok({ ...head, size: f.size, binary: true, note: 'a binary file: its content is not shown' })
      if (f.tooLarge || f.content === null)
        return ok({
          ...head,
          size: f.size,
          tooLarge: true,
          note: `over ${READ_MAX_BYTES} bytes: read it in an environment (env.up { repos: [{ project, ref }] }, then env.exec)`,
        })
      return ok({ ...head, ...readView(f.content, a.offset, a.limit) })
    },
  )

  kit.tool(
    {
      name: 'projects.list_files',
      description:
        "List a directory of a project's repository on any branch or commit, straight from the repository: no checkout needed. ref default: the default branch; a local project's default branch may be empty until its work is merged, and the result then names the branches to look at. Local projects; for a project on GitLab use mcp.gitlab.list_tree.",
      effect: 'read',
      params: {
        properties: {
          projectId: { type: 'string' },
          path: { type: 'string', description: 'A directory relative to the repository root. Default: the root.' },
          ref: { type: 'string', description: 'Branch or commit. Default: the default branch.' },
          repo: repoIndexProp,
        },
        required: ['projectId'],
      },
    },
    async (a) => {
      const found = await localRepoOf(a.projectId, a.repo, 'mcp.gitlab.list_tree')
      if ('failure' in found) return found.failure!
      if (!localProjects.tree) return fail('reading repositories is not available in this deployment')
      const ref = str(a.ref)
      const path = (str(a.path) ?? '').replace(/^\/+|\/+$/g, '')
      let t: Awaited<ReturnType<NonNullable<typeof localProjects.tree>>>
      try {
        t = await localProjects.tree(found.slug, { ...(ref ? { ref } : {}), ...(path ? { path } : {}) })
      } catch (err) {
        return notFound(err, found.slug, ref, path || '/')
      }
      const hint = !ref && !path && !t.entries.length ? await defaultBranchHint(found.slug) : undefined
      const out: Record<string, Json> = {
        project: found.project.data.name,
        ref: t.ref,
        path: t.path || '.',
        entries: t.entries.slice(0, LIST_MAX).map((e) => (e.type === 'dir' ? `${e.name}/` : e.name)),
      }
      if (t.entries.length > LIST_MAX) out.note = `showing ${LIST_MAX} of ${t.entries.length}`
      if (hint) out.hint = hint
      return ok(out)
    },
  )
}
