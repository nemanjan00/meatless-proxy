import { localRepoSlug } from '@mp/git'
import { fail, ok, str, type Kit } from '../kit.ts'
import type { StdlibDeps } from '../types.ts'

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
}
