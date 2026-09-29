import {
  type ApiRecord,
  ApiRequestError,
  type ContactData,
  type EmployeeData,
  type ProjectData,
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

const ROLE_ORDER = ['owner', 'backup', 'member', 'reviewer', 'stakeholder']
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
    return { projectId, people: list }
  }

  const roleOf = (v: unknown, def: string) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : def)

  return {
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
    projectPeople(id) {
      if (!get('project', id)) return fail(404, 'not_found', 'project not found')
      return delay(people(id))
    },
    addProjectPerson(id, body) {
      if (!get('project', id)) return fail(404, 'not_found', 'project not found')
      const c = contactOf(body)
      if (!c) return fail(400, 'bad_request', 'give { contactId } or { employeeId }')
      const role = roleOf(body.role, 'member')
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
          }
        })
        .filter((x) => x !== null)
        .sort((a, b) => a.project.data.name.localeCompare(b.project.data.name))
      return delay({ employeeId: id, contactId, projects })
    },
  }
}
