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
}
