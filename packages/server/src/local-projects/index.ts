import type * as Api from '@mp/api'
import { ConflictError, NotFoundError, ValidationError, type Json } from '@mp/core'
import { ProjectRoles, type Project, type Repository } from '@mp/directory'
import {
  LOCAL_GIT_SYSTEM,
  assertRepoSlug,
  isLocalRepoUrl,
  localBranchSubject,
  localRepoSlug,
  localRepoUrl,
  slugifyRepoName,
  type Author,
  type GitAuth,
} from '@mp/git'
import type { Actor } from '@mp/store'
import { type Context, Hono } from 'hono'
import { type Principal, principalOf } from '../auth/guard.ts'
import { BadRequestError, jsonBody, requireString } from '../http/util.ts'
import { actorOf } from '../http/views.ts'
import { createProject, projectByRepository, repoKey } from '../projects/index.ts'
import type { Services } from '../services.ts'
import { sshPrivateKey } from '../ssh.ts'
import { canMerge } from './access.ts'

export { MERGE_ROLES, assertLocalReposUnchanged, assertMayGrantRole, canMerge, mergeGuard } from './access.ts'

/**
 * Local projects (docs/spec.md#local-projects): projects whose repository is a bare git repository
 * the harness hosts itself (`url: 'local:<slug>'`, at `<LOCAL_REPOS_DIR>/<slug>.git`).
 *
 * - Employees check out and push their own branches through the git tools, like any remote; the
 *   push policy refuses protected branches the same way.
 * - People review and merge those branches here. Merging and deleting branches: admins and the
 *   project's owners, backups and reviewers (`MERGE_ROLES`). AI employees never sign in, so no route
 *   is open to them, and no tool merges.
 * - An admin can attach a remote later: every branch is pushed there and the project's repository
 *   becomes that remote. The local repository is kept, as the repository's `previousUrl`.
 */

/** The commit identity of a person merging in the web UI. */
const authorOf = (p: Principal): Author => ({
  name: p.name.replace(/[<>\n\r\0]/g, '').trim() || 'Someone',
  email: p.email && !/[<>\s]/.test(p.email) ? p.email : `${p.contactId}@users.noreply.invalid`,
})

/** The harness itself, as the author of a new repository's first commit when no person asked for it. */
const HARNESS_AUTHOR: Author = { name: 'meatless-proxy', email: 'harness@users.noreply.invalid' }

/** A project's first local repository: its index in `repositories` and slug. */
export function localRepoOf(project: Project): { index: number; slug: string; repo: Repository } | null {
  const list = project.data.repositories ?? []
  for (let index = 0; index < list.length; index++) {
    const repo = list[index]!
    if (!isLocalRepoUrl(repo.url)) continue
    return { index, slug: localRepoSlug(repo.url)!, repo }
  }
  return null
}

async function requireLocal(s: Services, projectId: string) {
  const project = await s.directory.projects.require(projectId)
  const local = localRepoOf(project)
  if (!local) throw new NotFoundError('local repository of project', projectId)
  return { project, ...local }
}

/** A free slug for a project name: the name's slug, then `-2`, `-3`, … */
async function freeSlug(s: Services, name: string, wanted?: string): Promise<string> {
  if (wanted !== undefined) {
    const slug = assertRepoSlug(wanted.trim())
    if (await s.localRepos.exists(slug)) throw new ConflictError(`a local repository named ${slug} already exists`)
    return slug
  }
  const base = slugifyRepoName(name).slice(0, 56).replace(/-+$/, '') || 'project'
  for (let i = 1; i < 1000; i++) {
    const slug = i === 1 ? base : `${base}-${i}`
    if (!(await s.localRepos.exists(slug))) return slug
  }
  throw new ConflictError(`no free repository name for ${name}`)
}

export interface CreateLocalProjectInput {
  name: string
  description?: string
  slug?: string
  owner?: unknown
  members?: unknown
}

/**
 * Creates a local repository and a project on it, with its owner and members (`POST /api/projects/local`,
 * and `projects.create_local` for employees). A name another project has is refused before anything is
 * written; the repository is removed again if the project can't be created.
 */
export async function createLocalProject(
  s: Services,
  body: CreateLocalProjectInput,
  actor: Actor,
  author: Author = HARNESS_AUTHOR,
): Promise<Api.CreatedProject> {
  const name = requireString(body.name, 'name').trim()
  if (body.slug !== undefined && typeof body.slug !== 'string') throw new BadRequestError('slug must be a string')
  if (await s.directory.projects.byName(name)) throw new ConflictError(`a project named ${name} already exists`)
  const slug = await freeSlug(s, name, body.slug as string | undefined)
  const created = await s.localRepos.create(slug, { author, message: `Initial commit of ${name}` })
  try {
    const r = await createProject(
      s,
      {
        name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        repositories: [{ url: created.url, defaultBranch: created.defaultBranch }],
        ...(body.owner !== undefined ? { owner: body.owner } : {}),
        ...(body.members !== undefined ? { members: body.members } : {}),
      },
      actor,
      { allowLocal: true },
    )
    s.logger.info('local project created', { projectId: r.project.id, slug })
    return r
  } catch (err) {
    await s.localRepos.remove(slug).catch(() => {})
    throw err
  }
}

/**
 * `projects.create_local` (the stdlib tool): a local project the calling employee is a member of.
 * Returns what the tool tells the model.
 */
export async function createLocalProjectForEmployee(
  s: Services,
  input: { name: string; description?: string; employeeId: string; actor: Actor },
): Promise<{ projectId: string; name: string; url: string; defaultBranch: string }> {
  const employee = await s.directory.employees.require(input.employeeId)
  const contact = await s.directory.contacts.get(employee.data.contactId)
  const author: Author = {
    name: employee.data.git?.name || contact?.data.name || employee.data.name,
    email: employee.data.git?.email || contact?.data.email || `${employee.key ?? employee.id}@users.noreply.invalid`,
  }
  const r = await createLocalProject(
    s,
    {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      members: [{ employeeId: employee.id, role: ProjectRoles.member }],
    },
    input.actor,
    author,
  )
  const repo = r.project.data.repositories![0]!
  return { projectId: r.project.id, name: r.project.data.name, url: repo.url, defaultBranch: repo.defaultBranch ?? 'main' }
}

export async function localProject(s: Services, projectId: string, p: Principal): Promise<Api.LocalProject> {
  const { project, slug, repo } = await requireLocal(s, projectId)
  return {
    projectId: project.id,
    slug,
    url: repo.url,
    defaultBranch: await s.localRepos.defaultBranch(slug),
    branches: await s.localRepos.branches(slug),
    canMerge: await canMerge(s, p, project.id),
    canAttachRemote: p.access === 'admin',
  }
}

/** Tells the sessions that pushed a branch what happened to it (they subscribed on `git.push`). */
async function branchEvent(
  s: Services,
  type: 'branch.merged' | 'branch.deleted',
  o: { project: Project; slug: string; branch: string; by: Principal; payload: Record<string, Json>; text: string; key: string },
) {
  await s.events
    .ingest({
      source: LOCAL_GIT_SYSTEM,
      type,
      dedupeKey: `${LOCAL_GIT_SYSTEM}:${type}:${o.slug}:${o.branch}:${o.key}`,
      subject: localBranchSubject(o.slug, o.branch),
      actorContactId: o.by.contactId,
      payload: { projectId: o.project.id, project: o.project.data.name, repository: o.slug, branch: o.branch, ...o.payload },
      text: o.text,
    })
    .catch((err) => s.logger.warn('local branch event failed', { err: err instanceof Error ? err.message : String(err) }))
}

export async function mergeLocalBranch(
  s: Services,
  projectId: string,
  branch: string,
  by: Principal,
): Promise<Api.LocalMergeResult> {
  const { project, slug } = await requireLocal(s, projectId)
  const r = await s.localRepos.merge(slug, branch, { author: authorOf(by) })
  s.logger.info('local branch merged', { projectId, slug, branch: r.branch, mode: r.mode, by: by.contactId })
  await branchEvent(s, 'branch.merged', {
    project,
    slug,
    branch: r.branch,
    by,
    key: r.sha,
    payload: { into: r.into, sha: r.sha, mode: r.mode },
    text: `${by.name} merged ${r.branch} into ${r.into} of ${project.data.name} (${r.mode === 'fast-forward' ? 'fast-forward' : 'merge commit'} ${r.sha.slice(0, 12)}).`,
  })
  return r
}

export async function deleteLocalBranch(
  s: Services,
  projectId: string,
  branch: string,
  by: Principal,
): Promise<Api.LocalProject> {
  const { project, slug } = await requireLocal(s, projectId)
  const before = (await s.localRepos.branches(slug)).find((b) => b.name === branch)
  await s.localRepos.deleteBranch(slug, branch)
  s.logger.info('local branch deleted', { projectId, slug, branch, by: by.contactId })
  await branchEvent(s, 'branch.deleted', {
    project,
    slug,
    branch,
    by,
    key: before?.sha ?? String(s.clock.now()),
    payload: { ...(before ? { sha: before.sha, merged: before.ahead === 0 } : {}) },
    text: `${by.name} deleted the branch ${branch} of ${project.data.name}${before && before.ahead > 0 ? ` (${before.ahead} unmerged commit${before.ahead === 1 ? '' : 's'})` : ''}.`,
  })
  return localProject(s, projectId, by)
}

/** A remote URL a person may attach: ssh, https, scp-style or file://, never with credentials in it. */
function remoteUrlOf(v: unknown): string {
  const url = requireString(v, 'url').trim()
  if (isLocalRepoUrl(url)) throw new ValidationError('attach a remote repository, not a local one')
  if (/\s/.test(url) || url.startsWith('-')) throw new ValidationError(`${url} isn't a repository URL`)
  let parsed: URL | null = null
  try {
    parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? new URL(url) : null
  } catch {
    throw new ValidationError(`${url} isn't a repository URL`)
  }
  if (parsed?.password || ((parsed?.protocol === 'https:' || parsed?.protocol === 'http:') && parsed.username))
    throw new ValidationError(
      "don't put credentials in the URL (it is stored and shown): use an ssh URL with an employee's SSH key, or the harness's own credentials",
    )
  if (parsed?.protocol === 'file:') return url
  if (!repoKey(url)) throw new ValidationError(`${url} isn't a repository URL (use git@host:path, ssh:// or https://)`)
  return url
}

/** Whose SSH key pushes: the chosen employee, else the project's owner, else its first member that is an employee with a key. */
async function pusherFor(
  s: Services,
  projectId: string,
  employeeId: unknown,
): Promise<{ auth?: GitAuth; as: { employeeId: string; name: string } | null }> {
  if (employeeId !== undefined && employeeId !== null && employeeId !== '') {
    if (typeof employeeId !== 'string') throw new BadRequestError('employeeId must be a string')
    const e = await s.directory.employees.require(employeeId)
    const key = await sshPrivateKey(s, e.id)
    if (!key) throw new ValidationError(`${e.data.name} has no SSH key: generate one on its page, or push without one`)
    return { auth: { sshPrivateKey: key }, as: { employeeId: e.id, name: e.data.name } }
  }
  const members = await s.directory.projects.members(projectId)
  const ordered = [...members].sort((a, b) => Number(b.roles.includes('owner')) - Number(a.roles.includes('owner')))
  for (const m of ordered) {
    if (m.contact.data.kind !== 'ai') continue
    const e = await s.directory.employees.byContact(m.contact.id)
    const key = e ? await sshPrivateKey(s, e.id) : null
    if (e && key) return { auth: { sshPrivateKey: key }, as: { employeeId: e.id, name: e.data.name } }
  }
  return { as: null }
}

/**
 * Attaches a remote to a local project (admins): pushes every branch and tag of the local repository
 * to it, then makes it the project's repository, so checkouts fetch from it and reviews move to the
 * git host. The local repository stays on disk, named in the repository's `previousUrl`.
 */
export async function attachRemote(
  s: Services,
  projectId: string,
  body: Record<string, unknown>,
  actor: Actor,
): Promise<Api.AttachedRemote> {
  const { project, slug, index, repo } = await requireLocal(s, projectId)
  const url = remoteUrlOf(body.url)
  const httpUrl =
    body.httpUrl === undefined || body.httpUrl === null || body.httpUrl === '' ? undefined : remoteUrlOf(body.httpUrl)
  const taken = await projectByRepository(s, [url, ...(httpUrl ? [httpUrl] : [])])
  if (taken && taken.id !== project.id)
    throw new ConflictError(`project ${taken.data.name} already has that repository`, { projectId: taken.id })
  const pusher = await pusherFor(s, project.id, body.employeeId)
  const defaultBranch = await s.localRepos.defaultBranch(slug)
  const { branches } = await s.localRepos.pushAll(slug, url, pusher.auth)
  const repositories = [...(project.data.repositories ?? [])]
  repositories[index] = {
    url,
    ...(httpUrl ? { httpUrl } : {}),
    defaultBranch,
    ...(repo.path ? { path: repo.path } : {}),
    previousUrl: localRepoUrl(slug),
  }
  const updated = await s.directory.projects.update(project.id, { repositories }, { actor })
  s.logger.info('remote attached to a local project', { projectId, slug, branches: branches.length, as: pusher.as?.employeeId })
  return {
    project: updated as unknown as Api.ApiRecord<Api.ProjectData>,
    branches,
    pushedAs: pusher.as,
  }
}

/**
 * The local project API (packages/api/src/projects.ts). Reads are for everyone signed in; merging and
 * deleting branches for admins and the project's owners, backups and reviewers; creating one and
 * attaching a remote for admins (see `GUARD_RULES`).
 */
export function localProjectRoutes(s: Services): Hono {
  const app = new Hono()
  const actor = (c: Context): Actor => actorOf(principalOf(c).contactId)
  const branchOf = (v: unknown) => requireString(v, 'branch').trim()

  app.post('/api/projects/local', async (c) => {
    const p = principalOf(c)
    const body = await jsonBody<Record<string, unknown>>(c)
    return c.json(await createLocalProject(s, body as unknown as CreateLocalProjectInput, actor(c), authorOf(p)), 201)
  })

  app.get('/api/projects/:id/local', async (c) => c.json(await localProject(s, c.req.param('id'), principalOf(c))))

  app.get('/api/projects/:id/local/compare', async (c) => {
    const { slug } = await requireLocal(s, c.req.param('id'))
    return c.json(await s.localRepos.compare(slug, branchOf(c.req.query('branch'))))
  })

  app.post('/api/projects/:id/local/merge', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    return c.json(await mergeLocalBranch(s, c.req.param('id'), branchOf(body.branch), principalOf(c)))
  })

  app.post('/api/projects/:id/local/branches/delete', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    return c.json(await deleteLocalBranch(s, c.req.param('id'), branchOf(body.branch), principalOf(c)))
  })

  app.get('/api/projects/:id/local/tree', async (c) => {
    const { slug } = await requireLocal(s, c.req.param('id'))
    const path = c.req.query('path')
    const ref = c.req.query('ref')
    return c.json(await s.localRepos.tree(slug, { ...(path ? { path } : {}), ...(ref ? { ref } : {}) }))
  })

  app.get('/api/projects/:id/local/file', async (c) => {
    const { slug } = await requireLocal(s, c.req.param('id'))
    const ref = c.req.query('ref')
    return c.json(
      await s.localRepos.readFile(slug, { path: requireString(c.req.query('path'), 'path'), ...(ref ? { ref } : {}) }),
    )
  })

  app.post('/api/projects/:id/local/remote', async (c) =>
    c.json(await attachRemote(s, c.req.param('id'), await jsonBody<Record<string, unknown>>(c), actor(c))),
  )

  return app
}
