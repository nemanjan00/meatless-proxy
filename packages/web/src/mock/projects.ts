import {
  type ApiRecord,
  ApiRequestError,
  type ContactData,
  type EmployeeData,
  type LocalBranchInfo,
  type LocalProject,
  type ProjectData,
  type ProjectLead,
  type ProjectPeople,
  type ProjectPerson,
  type ProjectPersonRef,
  type ProjectsApi,
} from '@mp/api'
import { type MockDb, mockId } from './data.ts'

/** What the projects mock borrows from the mock API. */
export interface MockProjectsHelpers {
  db: MockDb
  iso(): string
  delay<T>(v: T): Promise<T>
  write<T extends Record<string, unknown>>(kind: string, id: string, data: T): ApiRecord<T>
  get<T>(kind: string, id: string): ApiRecord<T> | undefined
  all<T>(kind: string): ApiRecord<T>[]
}

const ROLE_ORDER = ['lead', 'owner', 'backup', 'member', 'reviewer', 'stakeholder']
const rank = (r: string) => (ROLE_ORDER.includes(r) ? ROLE_ORDER.indexOf(r) : 99)
const rankOf = (roles: string[]) => Math.min(...roles.map(rank))

/** A repository URL's host and path: `git@host:path`, or any URL with a host. */
function hostAndPath(url: string): [string, string] | null {
  const scp = /^[\w.-]+@([^:/]+):(?!\/)(.+)$/.exec(url)
  if (scp) return [scp[1]!, scp[2]!]
  try {
    const u = new URL(url)
    return u.hostname ? [u.hostname, u.pathname] : null
  } catch {
    return null
  }
}

/** `host/path` of a repository URL, so https and ssh compare equal (like the server's `repoKey`). */
export function mockRepoKey(url: string): string | null {
  const parts = hostAndPath(url.trim())
  if (!parts) return null
  const path = parts[1].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  return path ? `${parts[0].toLowerCase()}/${path.toLowerCase()}` : null
}

/** A branch of a mock local repository: what it adds on top of the default branch. */
export interface MockLocalBranch extends LocalBranchInfo {
  /** Files the branch adds or changes: path -> content. */
  files: Record<string, string>
}

/** A mock local repository: its branches and the default branch's files. */
export interface MockLocalRepo {
  slug: string
  main: Record<string, string>
  mainSha: string
  branches: Map<string, MockLocalBranch>
}

const localRepos = new WeakMap<MockDb, Map<string, MockLocalRepo>>()

/** The mock local repositories of a mock database, by project id (tests push branches into them). */
export function mockLocalRepos(db: MockDb): Map<string, MockLocalRepo> {
  let m = localRepos.get(db)
  if (!m) {
    m = new Map()
    localRepos.set(db, m)
  }
  return m
}

/** Adds a branch to a mock local repository, as an employee's push would. */
export function mockPushBranch(
  db: MockDb,
  projectId: string,
  name: string,
  files: Record<string, string>,
  subject = 'Work',
): void {
  const repo = mockLocalRepos(db).get(projectId)
  if (!repo) throw new Error(`no local repository for ${projectId}`)
  const conflicts = Object.keys(files).some((f) => f in repo.main)
  repo.branches.set(name, {
    name,
    sha: Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40),
    ahead: 1,
    behind: 0,
    subject,
    author: 'Billing Bot <billing-bot@example.com>',
    date: new Date().toISOString(),
    files,
    ...(conflicts ? { behind: 1 } : {}),
  })
}

/** The projects API over the mock data: assignments are `contact -> project` links, like on the server. */
export function createMockProjectsApi({ db, iso, delay, write, get, all }: MockProjectsHelpers): ProjectsApi {
  const fail = (status: number, code: 'bad_request' | 'validation' | 'not_found' | 'conflict', message: string) =>
    Promise.reject(new ApiRequestError(status, code, message))

  const contactOf = (ref: Partial<ProjectPersonRef> | undefined): ApiRecord<ContactData> | null => {
    if (ref?.employeeId) {
      const e = get<EmployeeData>('employee', ref.employeeId)
      return e?.data.contactId ? (get<ContactData>('contact', e.data.contactId) ?? null) : null
    }
    return ref?.contactId ? (get<ContactData>('contact', ref.contactId) ?? null) : null
  }
  const employeeOf = (contactId: string) => all<EmployeeData>('employee').find((e) => e.data.contactId === contactId)

  const link = (contactId: string, projectId: string, role: string) => {
    if (db.links.some((l) => l.from.id === contactId && l.to.id === projectId && l.role === role)) return
    db.links.push({
      id: mockId('lnk', ++db.seq),
      from: { kind: 'contact', id: contactId },
      to: { kind: 'project', id: projectId },
      role,
      data: {},
      createdAt: iso(),
    })
  }
  const unlink = (contactId: string, projectId: string, role?: string) => {
    db.links = db.links.filter(
      (l) => !(l.from.id === contactId && l.to.id === projectId && l.from.kind === 'contact' && (!role || l.role === role)),
    )
  }
  const setOwner = (projectId: string, contactId: string) => {
    db.links = db.links.filter((l) => !(l.to.id === projectId && l.role === 'owner' && l.from.id !== contactId))
    link(contactId, projectId, 'owner')
    const p = get<ProjectData>('project', projectId)
    if (p) write('project', projectId, { ...p.data, owner: contactId })
  }

  const people = (projectId: string): ProjectPeople => {
    const by = new Map<string, ProjectPerson>()
    for (const l of db.links) {
      if (l.to.id !== projectId || l.from.kind !== 'contact') continue
      const c = get<ContactData>('contact', l.from.id)
      if (!c) continue
      const kind = c.data.kind ?? (c.data.ai ? 'ai' : 'person')
      const e = kind === 'ai' ? employeeOf(c.id) : undefined
      const p = by.get(c.id) ?? {
        contactId: c.id,
        name: c.data.name,
        kind,
        ...(e ? { employeeId: e.id, ...(e.key ? { handle: e.key } : {}) } : {}),
        roles: [],
      }
      if (!p.roles.includes(l.role)) p.roles.push(l.role)
      by.set(c.id, p)
    }
    const list = [...by.values()].map((p) => ({ ...p, roles: [...p.roles].sort((a, b) => rank(a) - rank(b)) }))
    list.sort((a, b) => rankOf(a.roles) - rankOf(b.roles) || a.name.localeCompare(b.name))
    return { projectId, people: list, leads: leadsOf(projectId) }
  }

  /** A project's leads (people only), like the server's `projectLeadsOf`. */
  const leadsOf = (projectId: string): ProjectLead[] =>
    db.links
      .filter((l) => l.to.id === projectId && l.from.kind === 'contact' && l.role === 'lead')
      .map((l) => get<ContactData>('contact', l.from.id))
      .filter((c): c is ApiRecord<ContactData> => !!c && (c.data.kind ?? (c.data.ai ? 'ai' : 'person')) === 'person')
      .map((c) => ({ contactId: c.id, name: c.data.name }))

  /** Refuses an AI as a lead (the server's 422). */
  const leadProblem = (c: ApiRecord<ContactData>, role: string) =>
    role === 'lead' && (c.data.kind ?? (c.data.ai ? 'ai' : 'person')) !== 'person'
      ? `${c.data.name} is an AI, and a project's lead must be a person: make a person the lead`
      : null

  const localView = (projectId: string, repo: MockLocalRepo): LocalProject => ({
    projectId,
    slug: repo.slug,
    url: `local:${repo.slug}`,
    defaultBranch: 'main',
    branches: [...repo.branches.values()].map(({ files: _files, ...b }) => b),
    canMerge: true,
    canAttachRemote: true,
  })

  const roleOf = (v: unknown, def: string) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : def)

  const projectsApi: ProjectsApi = {
    createProject(body) {
      const name = body.name?.trim()
      if (!name) return fail(422, 'validation', 'name is required')
      if (all<ProjectData>('project').some((p) => p.data.name.toLowerCase() === name.toLowerCase()))
        return fail(409, 'conflict', `a project named ${name} already exists`)
      const repositories = (body.repositories ?? [])
        .map((r) => (typeof r === 'string' ? { url: r.trim() } : r))
        .filter((r) => r.url)
      for (const r of repositories)
        if (!mockRepoKey(r.url))
          return fail(422, 'validation', `${r.url} isn't a repository URL (use https://… or git@host:path)`)
      const owner = body.owner ? contactOf(body.owner) : null
      if (body.owner && !owner) return fail(404, 'not_found', 'owner not found')
      const members = (body.members ?? []).map((m) => ({ contact: contactOf(m), role: roleOf(m.role, 'member') }))
      if (members.some((m) => !m.contact)) return fail(404, 'not_found', 'member not found')
      const bad = members.map((m) => leadProblem(m.contact!, m.role)).find(Boolean)
      if (bad) return fail(422, 'validation', bad)
      const id = mockId('pro', `n${++db.seq}`)
      const rec = write<ProjectData>('project', id, {
        name,
        description: body.description?.trim() ?? '',
        status: 'active',
        ...(repositories.length ? { repositories } : {}),
        ...(body.docs?.length ? { links: body.docs.map((ref) => ({ system: 'docs', ref })) } : {}),
      })
      if (owner) setOwner(id, owner.id)
      for (const m of members) link(m.contact!.id, id, m.role)
      return delay({ project: get<ProjectData>('project', id) ?? rec, people: people(id).people })
    },
    projectLeads() {
      const leads: Record<string, ProjectLead[]> = {}
      for (const p of all<ProjectData>('project')) {
        const l = leadsOf(p.id)
        if (l.length) leads[p.id] = l
      }
      return delay({ leads })
    },
    projectPeople(id) {
      if (!get('project', id)) return fail(404, 'not_found', 'project not found')
      return delay(people(id))
    },
    addProjectPerson(id, body) {
      if (!get('project', id)) return fail(404, 'not_found', 'project not found')
      const c = contactOf(body)
      if (!c) return fail(400, 'bad_request', 'give { contactId } or { employeeId }')
      const role = roleOf(body.role, 'member')
      const problem = leadProblem(c, role)
      if (problem) return fail(422, 'validation', problem)
      if (role === 'owner') setOwner(id, c.id)
      else link(c.id, id, role)
      return delay(people(id))
    },
    removeProjectPerson(id, contactId, role) {
      if (!get('project', id)) return fail(404, 'not_found', 'project not found')
      unlink(contactId, id, role)
      return delay(people(id))
    },
    employeeProjects(id) {
      const e = get<EmployeeData>('employee', id)
      if (!e?.data.contactId) return fail(404, 'not_found', 'employee not found')
      const contactId = e.data.contactId
      const byProject = new Map<string, string[]>()
      for (const l of db.links)
        if (l.from.id === contactId && l.to.kind === 'project')
          byProject.set(l.to.id, [...(byProject.get(l.to.id) ?? []), l.role])
      const projects = [...byProject]
        .map(([pid, roles]) => {
          const project = get<ProjectData>('project', pid)
          if (!project) return null
          const ownerId = db.links.find((l) => l.to.id === pid && l.role === 'owner')?.from.id
          const owner = ownerId ? get<ContactData>('contact', ownerId) : undefined
          return {
            project,
            roles: [...new Set(roles)].sort((a, b) => rank(a) - rank(b)),
            owner: owner ? { contactId: owner.id, name: owner.data.name } : null,
            leads: leadsOf(pid),
          }
        })
        .filter((x) => x !== null)
        .sort((a, b) => a.project.data.name.localeCompare(b.project.data.name))
      return delay({ employeeId: id, contactId, projects })
    },

    // Local projects: repositories the harness hosts (a small in-memory model of one).
    async createLocalProject(body) {
      const slug = (body.slug ?? body.name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (!slug) return fail(422, 'validation', 'name is required')
      const r = await projectsApi.createProject({
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.owner ? { owner: body.owner } : {}),
        ...(body.members ? { members: body.members } : {}),
      })
      const data = { ...r.project.data, repositories: [{ url: `local:${slug}`, defaultBranch: 'main' }] }
      const project = write<ProjectData>('project', r.project.id, data)
      mockLocalRepos(db).set(project.id, { slug, main: {}, mainSha: '0'.repeat(40), branches: new Map() })
      return { ...r, project }
    },
    localProject(id) {
      const repo = mockLocalRepos(db).get(id)
      if (!repo) return fail(404, 'not_found', 'this project has no local repository')
      return delay(localView(id, repo))
    },
    compareLocalBranch(id, branch) {
      const repo = mockLocalRepos(db).get(id)
      const b = repo?.branches.get(branch)
      if (!repo || !b) return fail(404, 'not_found', `branch ${branch} not found`)
      const diff = Object.entries(b.files)
        .map(([path, content]) =>
          [
            `diff --git a/${path} b/${path}`,
            `--- a/${path}`,
            `+++ b/${path}`,
            '@@ -0,0 +1 @@',
            ...content.split('\n').map((l) => `+${l}`),
          ].join('\n'),
        )
        .join('\n')
      return delay({
        branch,
        base: 'main',
        ahead: b.ahead,
        behind: b.behind,
        commits: b.ahead ? [{ sha: b.sha, subject: b.subject, author: b.author, date: b.date }] : [],
        files: Object.keys(b.files).map((path) => ({ status: path in repo.main ? 'M' : 'A', path })),
        diff: b.ahead ? diff : '',
        truncated: false,
        fastForward: b.behind === 0,
      })
    },
    mergeLocalBranch(id, branch) {
      const repo = mockLocalRepos(db).get(id)
      const b = repo?.branches.get(branch)
      if (!repo || !b) return fail(404, 'not_found', `branch ${branch} not found`)
      if (b.ahead === 0) return fail(422, 'validation', `${branch} has nothing to merge: main already has it`)
      const conflicted = Object.keys(b.files).filter((f) => f in repo.main && repo.main[f] !== b.files[f])
      if (b.behind > 0 && conflicted.length)
        return Promise.reject(
          new ApiRequestError(
            409,
            'conflict',
            `${branch} can't be merged into main automatically: ${conflicted.join(', ')} conflict. Nothing was changed.`,
            {
              files: conflicted,
            },
          ),
        )
      Object.assign(repo.main, b.files)
      const mode = b.behind === 0 ? ('fast-forward' as const) : ('merge-commit' as const)
      repo.mainSha = mode === 'fast-forward' ? b.sha : Math.random().toString(16).slice(2).padEnd(40, '1').slice(0, 40)
      b.ahead = 0
      b.behind = 0
      return delay({ branch, into: 'main', sha: repo.mainSha, mode })
    },
    deleteLocalBranch(id, branch) {
      const repo = mockLocalRepos(db).get(id)
      if (!repo) return fail(404, 'not_found', 'this project has no local repository')
      if (branch === 'main') return fail(422, 'validation', "main is the default branch: it can't be deleted")
      if (!repo.branches.delete(branch)) return fail(404, 'not_found', `branch ${branch} not found`)
      return delay(localView(id, repo))
    },
    localTree(id, path) {
      const repo = mockLocalRepos(db).get(id)
      if (!repo) return fail(404, 'not_found', 'this project has no local repository')
      const prefix = path ? `${path.replace(/\/+$/, '')}/` : ''
      const entries = new Map<string, { name: string; type: 'file' | 'dir'; size?: number }>()
      for (const [f, content] of Object.entries(repo.main)) {
        if (!f.startsWith(prefix)) continue
        const [head, ...rest] = f.slice(prefix.length).split('/')
        entries.set(head!, rest.length ? { name: head!, type: 'dir' } : { name: head!, type: 'file', size: content.length })
      }
      return delay({ path: path ?? '', ref: 'main', entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)) })
    },
    localFile(id, path) {
      const repo = mockLocalRepos(db).get(id)
      const content = repo?.main[path]
      if (content === undefined) return fail(404, 'not_found', `file ${path} not found`)
      return delay({ path, ref: 'main', size: content.length, binary: false, tooLarge: false, content })
    },
    attachRemote(id, body) {
      const repo = mockLocalRepos(db).get(id)
      const p = get<ProjectData>('project', id)
      if (!repo || !p) return fail(404, 'not_found', 'this project has no local repository')
      if (!mockRepoKey(body.url)) return fail(422, 'validation', `${body.url} isn't a repository URL`)
      const project = write<ProjectData>('project', id, {
        ...p.data,
        repositories: [
          {
            url: body.url,
            ...(body.httpUrl ? { httpUrl: body.httpUrl } : {}),
            defaultBranch: 'main',
            previousUrl: `local:${repo.slug}`,
          },
        ],
      })
      mockLocalRepos(db).delete(id)
      return delay({ project, branches: ['main', ...repo.branches.keys()], pushedAs: null })
    },
  }
  return projectsApi
}
