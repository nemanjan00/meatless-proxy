import { ConflictError, ValidationError, validateRecord } from '@mp/core'
import type { LinkedRecord, Records } from '@mp/records'
import type { Actor, Link, Page, RecordQuery, StoredRecord } from '@mp/store'
import {
  APPLIES_TO,
  IDENTITY,
  MP_SYSTEM,
  ProjectRoles,
  contactRef,
  directorySchemas,
  invalidNetwork,
  projectRef,
  type ContactData,
  type EmployeeData,
  type Handle,
  type ProcedureData,
  type ProjectData,
} from './schemas.ts'
import { keywords, scoreText, slugify } from './text.ts'

/** `Omit` that keeps known keys of types with an index signature. */
type Without<T, K extends PropertyKey> = { [P in keyof T as P extends K ? never : P]: T[P] }

export interface WriteOpts {
  actor?: Actor
}

export interface UpdateOpts extends WriteOpts {
  expectedVersion?: number
}

export type Contact = StoredRecord<ContactData>
export type Employee = StoredRecord<EmployeeData>
export type Project = StoredRecord<ProjectData>
export type Procedure = StoredRecord<ProcedureData>

/** A new contact. `kind` defaults to `person`. */
export type ContactInput = Without<ContactData, 'kind'> & { kind?: ContactData['kind'] }

/** A new employee. Its AI contact is created from `name` plus the optional `contact` fields. */
export type EmployeeInput = Without<EmployeeData, 'contactId'> & {
  /** Extra fields for the employee's contact (e.g. more handles, email, role, bio). */
  contact?: Partial<Without<ContactData, 'kind' | 'name'>>
  /** Its `@handle` and record key. Default: the slug of `name`. */
  handle?: string
}

export interface Scored<T> {
  record: T
  score: number
}

export interface Contacts {
  create(data: ContactInput, opts?: WriteOpts): Promise<Contact>
  get(id: string): Promise<Contact | null>
  require(id: string): Promise<Contact>
  update(id: string, patch: Partial<ContactData>, opts?: UpdateOpts): Promise<Contact>
  list(q?: RecordQuery): Promise<Page<ContactData>>
  /** Keyword search over name, email, handles, role, team and bio, best first. */
  search(text: string, opts?: { limit?: number }): Promise<Contact[]>
  /** Identity resolution: the contact with this handle in this system, or null. */
  byHandle(system: string, id: string): Promise<Contact | null>
  byEmail(email: string): Promise<Contact | null>
}

export interface Employees {
  /** Creates the employee and its AI contact (handle `{mp, <slug of handle or name>}`), linked with role `identity`. */
  create(data: EmployeeInput, opts?: WriteOpts): Promise<Employee>
  get(id: string): Promise<Employee | null>
  require(id: string): Promise<Employee>
  list(q?: RecordQuery): Promise<Page<EmployeeData>>
  /** Renaming also renames its contact and its `mp` handle. */
  update(id: string, patch: Partial<Without<EmployeeData, 'contactId'>>, opts?: UpdateOpts): Promise<Employee>
  byContact(contactId: string): Promise<Employee | null>
  /** Resolves `@name`, `name` or a display name to an employee. */
  byHandle(name: string): Promise<Employee | null>
  /** The employee's own contact. */
  contact(employeeId: string): Promise<Contact>
}

export interface Member {
  contact: Contact
  roles: string[]
  links: Link[]
}

export interface Membership {
  project: Project
  roles: string[]
  links: Link[]
}

export interface Projects {
  create(data: ProjectData, opts?: WriteOpts): Promise<Project>
  get(id: string): Promise<Project | null>
  require(id: string): Promise<Project>
  update(id: string, patch: Partial<ProjectData>, opts?: UpdateOpts): Promise<Project>
  list(q?: RecordQuery): Promise<Page<ProjectData>>
  /** Keyword search over name, aliases and description, best first. */
  search(text: string, opts?: { limit?: number }): Promise<Project[]>
  /** The project whose name or an alias equals `name` (case-insensitive), or null. */
  byName(name: string): Promise<Project | null>
  /** Links the contact to the project with a role (default `member`). A contact can hold several roles. */
  addMember(projectId: string, contactId: string, role?: string, data?: Record<string, unknown>, opts?: WriteOpts): Promise<Link>
  /** Removes one role, or every role when `role` is omitted. */
  removeMember(projectId: string, contactId: string, role?: string, opts?: WriteOpts): Promise<void>
  /** Makes `contactId` the only owner. */
  setOwner(projectId: string, contactId: string, opts?: WriteOpts): Promise<Link>
  /** The accountable owner (the earliest owner link), or null. */
  owner(projectId: string): Promise<Contact | null>
  members(projectId: string, opts?: { role?: string }): Promise<Member[]>
  /** The projects a contact is linked to, with their roles, e.g. "what does Ana own?". */
  forContact(contactId: string, opts?: { role?: string }): Promise<Membership[]>
}

export interface Procedures {
  create(data: ProcedureData, opts?: WriteOpts): Promise<Procedure>
  get(id: string): Promise<Procedure | null>
  require(id: string): Promise<Procedure>
  update(id: string, patch: Partial<ProcedureData>, opts?: UpdateOpts): Promise<Procedure>
  list(q?: RecordQuery): Promise<Page<ProcedureData>>
  /**
   * Procedures that may apply to a piece of work, best first: keyword scoring
   * over name, `applies` and body. With `projectIds`, only procedures for those
   * projects or for all projects. Archived procedures are left out.
   */
  find(text: string, opts?: { projectIds?: string[]; limit?: number }): Promise<Scored<Procedure>[]>
}

export interface Directory {
  contacts: Contacts
  employees: Employees
  projects: Projects
  procedures: Procedures
}

export interface DirectoryDeps {
  records: Records
}

const MAX_SEARCH_WORDS = 8

const normHandle = (h: Handle): Handle => ({ system: h.system.trim().toLowerCase(), id: h.id.trim() })
const normEmail = (e: string) => e.trim().toLowerCase()
const actorOpt = (o: WriteOpts | undefined) => (o?.actor ? { actor: o.actor } : {})

/** Registers the directory kinds on `records.kinds` and returns the service. */
export function createDirectory({ records }: DirectoryDeps): Directory {
  for (const s of directorySchemas) records.kinds.define(s)

  /** Union of per-keyword text queries, scored and sorted. */
  const search = async <T>(
    kind: string,
    text: string,
    score: (words: string[], r: StoredRecord<T>) => number,
    limit = 20,
    where?: RecordQuery['where'],
  ): Promise<Scored<StoredRecord<T>>[]> => {
    const words = keywords(text).slice(0, MAX_SEARCH_WORDS)
    if (!words.length) return []
    const byId = new Map<string, StoredRecord<T>>()
    for (const w of words) {
      for (const r of (await records.query<T>(kind, { text: w, ...(where ? { where } : {}) })).items) byId.set(r.id, r)
    }
    return [...byId.values()]
      .map((r) => ({ record: r, score: score(words, r) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : 1))
      .slice(0, limit)
  }

  const normalizeContact = <T extends Partial<ContactData>>(d: T): T => {
    const out: any = { ...d }
    if (d.handles) out.handles = d.handles.map(normHandle)
    if (typeof d.email === 'string') out.email = normEmail(d.email)
    return out
  }

  const assertHandlesFree = async (handles: Handle[] | undefined, self?: string) => {
    for (const h of handles ?? []) {
      const other = await contacts.byHandle(h.system, h.id)
      if (other && other.id !== self)
        throw new ConflictError(`handle ${h.system}:${h.id} already belongs to ${other.id}`, { contactId: other.id })
    }
  }

  const contacts: Contacts = {
    async create(data, opts) {
      const d = normalizeContact({ ...data, kind: data.kind ?? 'person' }) as ContactData
      await assertHandlesFree(d.handles)
      return records.create<ContactData>('contact', d, actorOpt(opts))
    },
    get: (id) => records.get<ContactData>('contact', id),
    require: (id) => records.require<ContactData>('contact', id),
    async update(id, patch, opts) {
      const p = normalizeContact(patch)
      if (p.handles) await assertHandlesFree(p.handles, id)
      return records.update<ContactData>('contact', id, p, {
        ...actorOpt(opts),
        ...(opts?.expectedVersion ? { expectedVersion: opts.expectedVersion } : {}),
      })
    },
    list: (q) => records.query<ContactData>('contact', q),
    async search(text, opts) {
      const hits = await search<ContactData>(
        'contact',
        text,
        (w, r) =>
          scoreText(w, [
            [r.data.name, 4],
            [r.data.email, 2],
            [(r.data.handles ?? []).map((h) => h.id).join(' '), 2],
            [r.data.role, 1],
            [r.data.team, 1],
            [r.data.bio, 1],
          ]),
        opts?.limit,
      )
      return hits.map((h) => h.record)
    },
    async byHandle(system, id) {
      const h = normHandle({ system, id })
      const q = (value: Handle) =>
        records.query<ContactData>('contact', { where: [{ field: 'handles', op: 'contains', value: { ...value } }], limit: 1 })
      let found = (await q(h)).items[0]
      // `mp` handles are slugs, so `@Ana` finds `ana`.
      if (!found && h.system === MP_SYSTEM) found = (await q({ system: MP_SYSTEM, id: slugify(h.id) })).items[0]
      return found ?? null
    },
    async byEmail(email) {
      return (await records.query<ContactData>('contact', { where: { email: normEmail(email) }, limit: 1 })).items[0] ?? null
    },
  }

  const employees: Employees = {
    async create(input, opts) {
      const { contact: extra, handle, ...data } = input
      const slug = slugify(handle?.replace(/^@/, '') || data.name || '')
      if (!slug) throw new ValidationError(`employee ${handle ? 'handle' : 'name'} must contain letters or digits`)
      const badNetwork = invalidNetwork(data.network)
      if (badNetwork) throw new ValidationError(badNetwork)
      validateRecord(records.kinds.get('employee'), { ...data, contactId: 'con_pending' })
      if (await records.getByKey('employee', slug)) throw new ConflictError(`an employee named ${slug} already exists`)
      const handles = [
        { system: MP_SYSTEM, id: slug },
        ...(extra?.handles ?? []).filter((h) => normHandle(h).system !== MP_SYSTEM),
      ]
      const contact = await contacts.create({ status: 'active', ...extra, name: data.name, kind: 'ai', handles }, opts)
      try {
        const emp = await records.create<EmployeeData>(
          'employee',
          { ...data, contactId: contact.id },
          { key: slug, ...actorOpt(opts) },
        )
        await records.link({ kind: 'employee', id: emp.id }, contactRef(contact.id), IDENTITY, {}, actorOpt(opts))
        return emp
      } catch (e) {
        await records.delete('contact', contact.id, { cascade: true }).catch(() => {})
        throw e
      }
    },
    get: (id) => records.get<EmployeeData>('employee', id),
    require: (id) => records.require<EmployeeData>('employee', id),
    list: (q) => records.query<EmployeeData>('employee', q),
    async update(id, patch, opts) {
      if ('contactId' in patch) throw new ValidationError("an employee's contact can't be changed")
      const badNetwork = 'network' in patch ? invalidNetwork(patch.network) : null
      if (badNetwork) throw new ValidationError(badNetwork)
      const current = await employees.require(id)
      const o = { ...actorOpt(opts), ...(opts?.expectedVersion ? { expectedVersion: opts.expectedVersion } : {}) }
      if (patch.name === undefined || patch.name === current.data.name)
        return records.update<EmployeeData>('employee', id, patch, o)
      const slug = slugify(patch.name)
      if (!slug) throw new ValidationError('employee name must contain letters or digits')
      const clash = slug !== current.key ? await records.getByKey('employee', slug) : null
      if (clash) throw new ConflictError(`an employee named ${slug} already exists`)
      const contact = await contacts.require(current.data.contactId)
      const handles = [{ system: MP_SYSTEM, id: slug }, ...(contact.data.handles ?? []).filter((h) => h.system !== MP_SYSTEM)]
      await assertHandlesFree(handles, contact.id)
      const updated = await records.update<EmployeeData>('employee', id, patch, { ...o, key: slug })
      await contacts.update(contact.id, { name: patch.name, handles }, actorOpt(opts))
      return updated
    },
    async byContact(contactId) {
      return (await records.query<EmployeeData>('employee', { where: { contactId }, limit: 1 })).items[0] ?? null
    },
    async byHandle(name) {
      const slug = slugify(name.replace(/^@/, ''))
      if (!slug) return null
      const byKey = await records.getByKey<EmployeeData>('employee', slug)
      if (byKey) return byKey
      const c = await contacts.byHandle(MP_SYSTEM, slug)
      return c ? employees.byContact(c.id) : null
    },
    async contact(employeeId) {
      return contacts.require((await employees.require(employeeId)).data.contactId)
    },
  }

  const group = <T>(linked: LinkedRecord<T>[]) => {
    const by = new Map<string, { record: StoredRecord<T>; roles: string[]; links: Link[] }>()
    for (const l of linked.sort((a, b) =>
      a.link.createdAt < b.link.createdAt ? -1 : a.link.createdAt > b.link.createdAt ? 1 : 0,
    )) {
      const g = by.get(l.record.id) ?? { record: l.record, roles: [], links: [] }
      if (!g.roles.includes(l.link.role)) g.roles.push(l.link.role)
      g.links.push(l.link)
      by.set(l.record.id, g)
    }
    return [...by.values()]
  }

  const projects: Projects = {
    create: (data, opts) => records.create<ProjectData>('project', data, actorOpt(opts)),
    get: (id) => records.get<ProjectData>('project', id),
    require: (id) => records.require<ProjectData>('project', id),
    update: (id, patch, opts) =>
      records.update<ProjectData>('project', id, patch, {
        ...actorOpt(opts),
        ...(opts?.expectedVersion ? { expectedVersion: opts.expectedVersion } : {}),
      }),
    list: (q) => records.query<ProjectData>('project', q),
    async search(text, opts) {
      const hits = await search<ProjectData>(
        'project',
        text,
        (w, r) =>
          scoreText(w, [
            [r.data.name, 4],
            [(r.data.aliases ?? []).join(' '), 3],
            [r.data.description, 1],
          ]),
        opts?.limit,
      )
      return hits.map((h) => h.record)
    },
    async byName(name) {
      const n = name.trim().toLowerCase()
      if (!n) return null
      const { items } = await records.query<ProjectData>('project', { text: n })
      return (
        items.find((p) => p.data.name.toLowerCase() === n || (p.data.aliases ?? []).some((a) => a.toLowerCase() === n)) ?? null
      )
    },
    async addMember(projectId, contactId, role = ProjectRoles.member, data, opts) {
      if (!role.trim()) throw new ValidationError('role is required')
      return records.link(contactRef(contactId), projectRef(projectId), role, data ?? {}, actorOpt(opts))
    },
    async removeMember(projectId, contactId, role, opts) {
      if (role) return records.unlink(contactRef(contactId), projectRef(projectId), role, actorOpt(opts))
      for (const l of await records.links({ from: contactRef(contactId), to: projectRef(projectId) }))
        await records.unlink(l.from, l.to, l.role, actorOpt(opts))
    },
    async setOwner(projectId, contactId, opts) {
      await projects.require(projectId)
      await contacts.require(contactId)
      for (const l of await records.links({ to: projectRef(projectId), role: ProjectRoles.owner }))
        if (l.from.id !== contactId) await records.unlink(l.from, l.to, l.role, actorOpt(opts))
      return projects.addMember(projectId, contactId, ProjectRoles.owner, {}, opts)
    },
    async owner(projectId) {
      const [first] = await projects.members(projectId, { role: ProjectRoles.owner })
      return first?.contact ?? null
    },
    async members(projectId, opts) {
      const linked = await records.linked<ContactData>(projectRef(projectId), {
        direction: 'in',
        kind: 'contact',
        ...(opts?.role ? { role: opts.role } : {}),
      })
      return group(linked).map((g) => ({ contact: g.record, roles: g.roles, links: g.links }))
    },
    async forContact(contactId, opts) {
      const linked = await records.linked<ProjectData>(contactRef(contactId), {
        direction: 'out',
        kind: 'project',
        ...(opts?.role ? { role: opts.role } : {}),
      })
      return group(linked).map((g) => ({ project: g.record, roles: g.roles, links: g.links }))
    },
  }

  const syncAppliesTo = async (id: string, projectIds: string[] | undefined, opts?: WriteOpts) => {
    const from = { kind: 'procedure', id }
    const wanted = new Set(projectIds ?? [])
    for (const l of await records.links({ from, role: APPLIES_TO }))
      if (!wanted.has(l.to.id)) await records.unlink(l.from, l.to, APPLIES_TO, actorOpt(opts))
    for (const p of wanted) await records.link(from, projectRef(p), APPLIES_TO, {}, actorOpt(opts))
  }

  const assertProjects = async (ids: string[] | undefined) => {
    for (const p of ids ?? []) await projects.require(p)
  }

  const procedures: Procedures = {
    async create(data, opts) {
      await assertProjects(data.projectIds)
      const r = await records.create<ProcedureData>('procedure', data, actorOpt(opts))
      await syncAppliesTo(r.id, r.data.projectIds, opts)
      return r
    },
    get: (id) => records.get<ProcedureData>('procedure', id),
    require: (id) => records.require<ProcedureData>('procedure', id),
    async update(id, patch, opts) {
      await assertProjects(patch.projectIds)
      const r = await records.update<ProcedureData>('procedure', id, patch, {
        ...actorOpt(opts),
        ...(opts?.expectedVersion ? { expectedVersion: opts.expectedVersion } : {}),
      })
      if ('projectIds' in patch) await syncAppliesTo(id, r.data.projectIds, opts)
      return r
    },
    list: (q) => records.query<ProcedureData>('procedure', q),
    async find(text, opts) {
      const hits = await search<ProcedureData>(
        'procedure',
        text,
        (w, r) =>
          scoreText(w, [
            [r.data.name, 3],
            [r.data.applies, 2],
            [r.data.body, 1],
          ]),
        Number.MAX_SAFE_INTEGER,
      )
      const scoped = opts?.projectIds
      return hits
        .filter((h) => h.record.data.archived !== true)
        .filter((h) => !scoped || !h.record.data.projectIds?.length || h.record.data.projectIds.some((p) => scoped.includes(p)))
        .slice(0, opts?.limit ?? 10)
    },
  }

  return { contacts, employees, projects, procedures }
}
