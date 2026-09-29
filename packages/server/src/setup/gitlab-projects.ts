import { errorMessage, ValidationError } from '@mp/core'
import type { Project } from '@mp/directory'
import { addProjectPerson, createProject, projectByRepository, repoKey } from '../projects/index.ts'
import { redact, type SetupContext } from './common.ts'
import type { GitlabProject } from './gitlab.ts'

/**
 * GitLab's "Add as project" (docs/spec.md#guided-setup): a GitLab project the employee's account
 * can reach becomes a harness project with its repository (ssh for git, https beside it), and the
 * employee is linked to it as a member, which also registers the webhook. A GitLab project whose
 * repository the harness already knows is only linked, so adding it again changes nothing.
 */

/** At most this many projects per click. */
export const MAX_ADD_PROJECTS = 50

/** Whether a GitLab project is already a harness project, and whether the employee is on it. */
export interface AddedState {
  projectId: string
  name: string
  linked: boolean
}

const urlsOf = (p: GitlabProject) => [p.ssh_url_to_repo, p.http_url_to_repo, p.web_url].filter((u): u is string => !!u)

/** Looks up GitLab projects among the harness's projects by repository (built once per check). */
export async function harnessProjectsByRepo(ctx: SetupContext): Promise<(p: GitlabProject) => AddedState | null> {
  const byKey = new Map<string, Project>()
  for (let offset = 0; ; offset += 200) {
    const page = await ctx.s.directory.projects.list({ limit: 200, offset, orderBy: { field: 'createdAt', dir: 'asc' } })
    for (const p of page.items)
      for (const r of p.data.repositories ?? [])
        for (const k of [r.url, r.httpUrl].map((u) => (u ? repoKey(u) : null))) if (k && !byKey.has(k)) byKey.set(k, p)
    if (page.items.length < 200) break
  }
  const mine = new Set((await ctx.s.directory.projects.forContact(ctx.employee.data.contactId)).map((m) => m.project.id))
  return (g) => {
    for (const k of urlsOf(g).map(repoKey)) {
      const hit = k ? byKey.get(k) : undefined
      if (hit) return { projectId: hit.id, name: hit.data.name, linked: mine.has(hit.id) }
    }
    return null
  }
}

/** A name for the new project: GitLab's name, or its full path when a project already has that name. */
async function nameFor(ctx: SetupContext, g: GitlabProject): Promise<string> {
  const short = g.name?.trim() || g.path_with_namespace.split('/').pop() || g.path_with_namespace
  return (await ctx.s.directory.projects.byName(short)) ? g.path_with_namespace : short
}

let chain: Promise<unknown> = Promise.resolve()
/** One add at a time in this process, so a double click can't create a project twice. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

/**
 * Adds GitLab projects (by id, as the employee's token sees them) as harness projects with the
 * employee as a member. Returns the message to show.
 */
export function addGitlabProjects(
  ctx: SetupContext,
  fetchProject: (id: number | string) => Promise<GitlabProject | null>,
  ids: (number | string)[],
): Promise<string> {
  const unique = [...new Set(ids.map(String))]
  if (unique.length > MAX_ADD_PROJECTS) throw new ValidationError(`Add at most ${MAX_ADD_PROJECTS} projects at a time.`)
  return serial(async () => {
    const created: string[] = []
    const linked: string[] = []
    const already: string[] = []
    const failed: string[] = []
    const contact = await ctx.s.directory.employees.contact(ctx.employee.id)
    for (const id of unique) {
      let g: GitlabProject | null
      try {
        g = await fetchProject(id)
      } catch (err) {
        failed.push(`${id} (${redact(ctx, errorMessage(err))})`)
        continue
      }
      if (!g) {
        failed.push(`${id} (the token can’t see it)`)
        continue
      }
      const urls = urlsOf(g)
      const existing = await projectByRepository(ctx.s, urls)
      if (existing) {
        const on = (await ctx.s.directory.projects.forContact(contact.id)).some((m) => m.project.id === existing.id)
        if (on) already.push(g.path_with_namespace)
        else {
          await addProjectPerson(ctx.s, existing.id, contact, 'member', ctx.actor)
          linked.push(g.path_with_namespace)
        }
        continue
      }
      const url = g.ssh_url_to_repo ?? g.http_url_to_repo ?? g.web_url
      if (!url) {
        failed.push(`${g.path_with_namespace} (GitLab gave no repository URL)`)
        continue
      }
      const httpUrl = g.http_url_to_repo && g.http_url_to_repo !== url ? g.http_url_to_repo : undefined
      await createProject(
        ctx.s,
        {
          name: await nameFor(ctx, g),
          ...(g.description?.trim() ? { description: g.description.trim() } : {}),
          repositories: [
            { url, ...(httpUrl ? { httpUrl } : {}), ...(g.default_branch ? { defaultBranch: g.default_branch } : {}) },
          ],
          members: [{ contactId: contact.id, role: 'member' }],
        },
        ctx.actor,
      )
      created.push(g.path_with_namespace)
    }
    ctx.s.logger.info('gitlab projects added', { employeeId: ctx.employee.id, created: created.length, linked: linked.length })
    const list = (xs: string[]) => xs.join(', ')
    const plural = (k: number) => (k === 1 ? '' : 's')
    const parts = [
      created.length ? `Added ${created.length} project${plural(created.length)}: ${list(created)}.` : '',
      linked.length
        ? `Linked ${ctx.employee.data.name} to ${linked.length} existing project${plural(linked.length)}: ${list(linked)}.`
        : '',
      already.length ? `Already added: ${list(already)}.` : '',
      failed.length ? `Couldn’t add: ${list(failed)}.` : '',
    ].filter(Boolean)
    return parts.join(' ') || 'Nothing to add.'
  })
}
