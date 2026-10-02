import type * as Api from '@mp/api'
import { ConflictError, NotFoundError, ValidationError } from '@mp/core'
import { type Contact, type Project, type ProjectData, ProjectRoles, type Repository } from '@mp/directory'
import { LOCAL_MIRROR_HOST, isLocalRepoUrl, isValidRepoSlug } from '@mp/git'
import type { Actor } from '@mp/store'
import { type Context, Hono } from 'hono'
import { principalOf } from '../auth/guard.ts'
import { BadRequestError, jsonBody, requireString } from '../http/util.ts'
import { actorOf } from '../http/views.ts'
import { assertMayGrantRole } from '../local-projects/access.ts'
import type { Services } from '../services.ts'

/**
 * Projects and who works on them (docs/spec.md#projects): creating a project with its owner and
 * members in one step, and assigning employees and people to it. An assignment is a link
 * `contact -> project` with a role; an employee is assigned through its AI contact. That is the
 * same link GitLab webhook provisioning reads, so assigning an employee registers its hooks, and
 * the one the employee's "Your projects" run entry is built from.
 */

/** The longest role name. */
export const MAX_ROLE_LENGTH = 40
/** The `links` system of a project's documentation links. */
export const DOCS_LINK_SYSTEM = 'docs'

const ROLE_ORDER = ['lead', 'owner', 'backup', 'member', 'reviewer', 'stakeholder']
const roleRank = (roles: string[]) => Math.min(...roles.map((r) => (ROLE_ORDER.includes(r) ? ROLE_ORDER.indexOf(r) : 99)))

/**
 * A repository URL reduced to `host/path` (lowercase, no `.git`, no credentials), so the https and
 * ssh URLs of one repository compare equal: `git@gitlab.com:acme/pay.git` and
 * `https://gitlab.com/acme/pay` are both `gitlab.com/acme/pay`. A local repository `local:<slug>` is
 * `harness/<slug>`. Null for something that isn't a URL.
 */
export function repoKey(url: string): string | null {
  const s = url.trim()
  if (!s) return null
  if (isLocalRepoUrl(s)) {
    const slug = s.slice('local:'.length)
    return isValidRepoSlug(slug) ? `${LOCAL_MIRROR_HOST}/${slug}` : null
  }
  const clean = (host: string, path: string) => {
    const p = path
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .replace(/\/-\/.*$/, '')
    return p ? `${host.toLowerCase()}/${decodeURIComponent(p).toLowerCase()}` : null
  }
  const scp = /^[\w.-]+@([^:/]+):(?!\/)(.+)$/.exec(s)
  if (scp) return clean(scp[1]!, scp[2]!)
  try {
    const u = new URL(s)
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol) || !u.hostname) return null
    return clean(u.hostname, u.pathname)
  } catch {
    return null
  }
}

/** Every repository key of a project (its `url` and `httpUrl`). */
const keysOf = (p: Project) =>
  (p.data.repositories ?? [])
    .flatMap((r) => [r.url, r.httpUrl ?? ''])
    .map(repoKey)
    .filter((k): k is string => !!k)

/** The first project with a repository at one of these URLs, or null. */
export async function projectByRepository(s: Services, urls: string[]): Promise<Project | null> {
  const wanted = new Set(urls.map(repoKey).filter((k): k is string => !!k))
  if (!wanted.size) return null
  for (let offset = 0; ; offset += 200) {
    const page = await s.directory.projects.list({ limit: 200, offset, orderBy: { field: 'createdAt', dir: 'asc' } })
    const hit = page.items.find((p) => keysOf(p).some((k) => wanted.has(k)))
    if (hit) return hit
    if (page.items.length < 200) return null
  }
}

/** The contact behind `{ contactId }` or `{ employeeId }`. */
export async function contactOf(s: Services, ref: unknown, what = 'person'): Promise<Contact> {
  const r = (ref ?? {}) as { contactId?: unknown; employeeId?: unknown }
  if (typeof r.employeeId === 'string' && r.employeeId) return s.directory.employees.contact(r.employeeId)
  if (typeof r.contactId === 'string' && r.contactId) return s.directory.contacts.require(r.contactId)
  throw new BadRequestError(`${what} must be { contactId } or { employeeId }`)
}

function roleOf(v: unknown, def: string): string {
  if (v === undefined || v === null || v === '') return def
  if (typeof v !== 'string') throw new BadRequestError('role must be a string')
  const role = v.trim().toLowerCase()
  if (!role) return def
  if (role.length > MAX_ROLE_LENGTH || !/^[a-z][a-z0-9_ -]*$/.test(role))
    throw new ValidationError(`role must be a short word, like owner or member (at most ${MAX_ROLE_LENGTH} characters)`)
  if (role === 'identity' || role === 'applies_to') throw new ValidationError(`${role} is not a project role`)
  return role
}

/** Everyone on a project, owners first, then by name. */
export async function projectPeople(s: Services, projectId: string): Promise<Api.ProjectPeople> {
  await s.directory.projects.require(projectId)
  const members = await s.directory.projects.members(projectId)
  const people: Api.ProjectPerson[] = []
  for (const m of members) {
    const kind = m.contact.data.kind ?? 'person'
    const employee = kind === 'ai' ? await s.directory.employees.byContact(m.contact.id) : null
    people.push({
      contactId: m.contact.id,
      name: m.contact.data.name,
      kind,
      ...(employee ? { employeeId: employee.id, ...(employee.key ? { handle: employee.key } : {}) } : {}),
      roles: [...m.roles].sort((a, b) => roleRank([a]) - roleRank([b]) || a.localeCompare(b)),
    })
  }
  people.sort((a, b) => roleRank(a.roles) - roleRank(b.roles) || a.name.localeCompare(b.name))
  return { projectId, people, leads: await projectLeadsOf(s, projectId) }
}

/** A project's leads (people only), earliest first. */
export async function projectLeadsOf(s: Services, projectId: string): Promise<Api.ProjectLead[]> {
  return (await s.directory.projects.leads(projectId)).map((c) => ({ contactId: c.id, name: c.data.name }))
}

/** Every project's leads, by project id (`GET /api/projects/leads`): one query over the `lead` links. */
export async function allProjectLeads(s: Services): Promise<Api.ProjectLeads> {
  const leads: Record<string, Api.ProjectLead[]> = {}
  const links = await s.records.links({ from: { kind: 'contact' }, to: { kind: 'project' }, role: ProjectRoles.lead })
  for (const l of links) {
    if (l.from.kind !== 'contact' || l.to.kind !== 'project') continue
    const c = await s.directory.contacts.get(l.from.id)
    if (!c || (c.data.kind ?? 'person') !== 'person') continue
    ;(leads[l.to.id] ??= []).push({ contactId: c.id, name: c.data.name })
  }
  return { leads }
}

/** Gives a contact a role on a project. `owner` makes it the only owner. */
export async function addProjectPerson(
  s: Services,
  projectId: string,
  contact: Contact,
  role: string,
  actor: Actor,
): Promise<void> {
  await s.directory.projects.require(projectId)
  if (role === 'owner') await s.directory.projects.setOwner(projectId, contact.id, { actor })
  else await s.directory.projects.addMember(projectId, contact.id, role, {}, { actor })
}

/**
 * Takes a role (or every role) away. For an employee losing its last role, the project also
 * leaves its older `scope.projects`, so the assignment is really gone.
 */
export async function removeProjectPerson(
  s: Services,
  projectId: string,
  contactId: string,
  role: string | undefined,
  actor: Actor,
): Promise<void> {
  await s.directory.projects.require(projectId)
  await s.directory.contacts.require(contactId)
  await s.directory.projects.removeMember(projectId, contactId, role, { actor })
  const left = (await s.directory.projects.forContact(contactId)).some((m) => m.project.id === projectId)
  if (left) return
  const employee = await s.directory.employees.byContact(contactId)
  const scoped = employee?.data.scope?.projects ?? []
  if (employee && scoped.includes(projectId))
    await s.directory.employees.update(
      employee.id,
      { scope: { ...employee.data.scope, projects: scoped.filter((p) => p !== projectId) } },
      { actor },
    )
}

/** The projects an employee works on, with its roles and each project's owner. */
export async function employeeProjects(s: Services, employeeId: string): Promise<Api.EmployeeProjects> {
  const employee = await s.directory.employees.require(employeeId)
  const list = await s.directory.projects.forContact(employee.data.contactId)
  const projects: Api.ProjectAssignment[] = []
  for (const m of list) {
    const owner = await s.directory.projects.owner(m.project.id)
    projects.push({
      project: m.project as unknown as Api.ApiRecord<Api.ProjectData>,
      roles: [...m.roles].sort((a, b) => roleRank([a]) - roleRank([b]) || a.localeCompare(b)),
      owner: owner ? { contactId: owner.id, name: owner.data.name } : null,
      leads: await projectLeadsOf(s, m.project.id),
    })
  }
  projects.sort((a, b) => a.project.data.name.localeCompare(b.project.data.name))
  return { employeeId, contactId: employee.data.contactId, projects }
}

/** One repository from the request: a URL, or `{ url, httpUrl?, defaultBranch?, path? }`. */
function repositoryOf(r: unknown): Repository {
  if (typeof r === 'string') return { url: r.trim() }
  if (!r || typeof r !== 'object' || typeof (r as Repository).url !== 'string')
    throw new BadRequestError('each repository must be a URL or { url }')
  const o = r as Record<string, unknown>
  const opt = (k: 'httpUrl' | 'defaultBranch' | 'path') =>
    typeof o[k] === 'string' && o[k] ? { [k]: (o[k] as string).trim() } : {}
  return { url: (o.url as string).trim(), ...opt('httpUrl'), ...opt('defaultBranch'), ...opt('path') }
}

/**
 * The request's repositories: empty ones dropped, each checked to be a URL, duplicates (by `repoKey`) removed.
 * Local repositories (`local:<slug>`) only with `allowLocal`: they are made by `POST /api/projects/local`.
 */
function repositoriesOf(v: unknown, allowLocal = false): Repository[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new BadRequestError('repositories must be a list of URLs')
  const out: Repository[] = []
  const seen = new Set<string>()
  for (const repo of v.map(repositoryOf)) {
    if (!repo.url) continue
    if (isLocalRepoUrl(repo.url) && !allowLocal)
      throw new ValidationError('a local repository is created with the project (New project → Local repository), not linked')
    const key = repoKey(repo.url)
    if (!key) throw new ValidationError(`${repo.url} isn't a repository URL (use https://… or git@host:path)`)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(repo)
  }
  return out
}

function docsOf(v: unknown): { system: string; ref: string }[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new BadRequestError('docs must be a list of URLs')
  return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))].map((ref) => {
    try {
      const u = new URL(ref)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error()
    } catch {
      throw new ValidationError(`${ref} isn't a link (use https://…)`)
    }
    return { system: DOCS_LINK_SYSTEM, ref }
  })
}

/**
 * Creates a project with its repositories and docs links, and links its owner and members, in one
 * step (`POST /api/projects`). Everyone is checked before anything is written. A repository
 * another project already has is a `ConflictError` naming that project.
 */
export async function createProject(
  s: Services,
  body: Record<string, unknown>,
  actor: Actor,
  opts: { allowLocal?: boolean } = {},
): Promise<Api.CreatedProject> {
  const name = requireString(body.name, 'name').trim()
  if (!name) throw new ValidationError('name is required')
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string')
    throw new BadRequestError('description must be a string')
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  const repositories = repositoriesOf(body.repositories, opts.allowLocal)
  const docs = docsOf(body.docs)
  const owner = body.owner ? await contactOf(s, body.owner, 'owner') : null
  if (body.members !== undefined && !Array.isArray(body.members)) throw new BadRequestError('members must be a list')
  const members: { contact: Contact; role: string }[] = []
  for (const m of (body.members as unknown[] | undefined) ?? [])
    members.push({ contact: await contactOf(s, m, 'each member'), role: roleOf((m as { role?: unknown })?.role, 'member') })
  if (await s.directory.projects.byName(name)) throw new ConflictError(`a project named ${name} already exists`)
  const taken = repositories.length
    ? await projectByRepository(
        s,
        repositories.map((r) => r.url),
      )
    : null
  if (taken) throw new ConflictError(`project ${taken.data.name} already has that repository`, { projectId: taken.id })

  const data: ProjectData = {
    name,
    status: 'active',
    ...(description ? { description } : {}),
    ...(repositories.length ? { repositories } : {}),
    ...(docs.length ? { links: docs } : {}),
  }
  const project = await s.directory.projects.create(data, { actor })
  try {
    if (owner) await s.directory.projects.setOwner(project.id, owner.id, { actor })
    for (const m of members) await addProjectPerson(s, project.id, m.contact, m.role, actor)
  } catch (err) {
    await s.records.delete('project', project.id, { cascade: true }).catch(() => {})
    throw err
  }
  s.logger.info('project created', { projectId: project.id, owner: owner?.id, members: members.length })
  return {
    project: project as unknown as Api.ApiRecord<Api.ProjectData>,
    people: (await projectPeople(s, project.id)).people,
  }
}

/**
 * The project API (packages/api/src/projects.ts). Reads are for everyone signed in; writes for
 * members and admins, like links on the records API (see `GUARD_RULES`).
 */
export function projectRoutes(s: Services): Hono {
  const app = new Hono()
  const actor = (c: Context): Actor => actorOf(principalOf(c).contactId)

  app.post('/api/projects', async (c) => c.json(await createProject(s, await jsonBody(c), actor(c)), 201))

  app.get('/api/projects/leads', async (c) => c.json(await allProjectLeads(s)))

  app.get('/api/projects/:id/people', async (c) => c.json(await projectPeople(s, c.req.param('id'))))

  app.post('/api/projects/:id/people', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    const id = c.req.param('id')
    await s.directory.projects.require(id)
    const role = roleOf(body.role, 'member')
    await assertMayGrantRole(s, principalOf(c), id, role)
    await addProjectPerson(s, id, await contactOf(s, body), role, actor(c))
    return c.json(await projectPeople(s, id))
  })

  app.delete('/api/projects/:id/people/:contactId', async (c) => {
    const id = c.req.param('id')
    const role = c.req.query('role')
    await removeProjectPerson(s, id, c.req.param('contactId'), role ? roleOf(role, '') : undefined, actor(c))
    return c.json(await projectPeople(s, id))
  })

  app.get('/api/employees/:id/projects', async (c) => {
    const id = c.req.param('id')
    if (!(await s.directory.employees.get(id))) throw new NotFoundError('employee', id)
    return c.json(await employeeProjects(s, id))
  })

  return app
}
