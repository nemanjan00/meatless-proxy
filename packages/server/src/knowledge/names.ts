import type * as Api from '@mp/api'
import type { Contact, ContactData, Employee, EmployeeData, Project, ProjectData } from '@mp/directory'
import type { Actor } from '@mp/store'
import type { Services } from '../services.ts'

/** Reads every record of a kind, page by page. */
export async function readAll<T>(s: Pick<Services, 'records'>, kind: string) {
  const out = []
  for (let offset = 0; ; offset += 1000) {
    const page = await s.records.query<T>(kind, { orderBy: { field: 'createdAt', dir: 'asc' }, limit: 1000, offset })
    out.push(...page.items)
    if (page.items.length < 1000) break
  }
  return out
}

/**
 * The directory, loaded once per request: contacts, employees and projects by id, so the
 * knowledge views name people and projects without a lookup per row.
 */
export class DirectorySnapshot {
  readonly contacts = new Map<string, Contact>()
  readonly employees = new Map<string, Employee>()
  readonly employeeByContact = new Map<string, Employee>()
  readonly projects = new Map<string, Project>()

  static async load(s: Pick<Services, 'records'>): Promise<DirectorySnapshot> {
    const d = new DirectorySnapshot()
    const [contacts, employees, projects] = await Promise.all([
      readAll<ContactData>(s, 'contact'),
      readAll<EmployeeData>(s, 'employee'),
      readAll<ProjectData>(s, 'project'),
    ])
    for (const c of contacts) d.contacts.set(c.id, c as Contact)
    for (const e of employees) {
      d.employees.set(e.id, e as Employee)
      d.employeeByContact.set(e.data.contactId, e as Employee)
    }
    for (const p of projects) d.projects.set(p.id, p as Project)
    return d
  }

  person(contactId: string | undefined | null): Api.KnowledgePerson | null {
    if (!contactId) return null
    const c = this.contacts.get(contactId)
    if (!c) return { contactId, name: contactId, kind: 'person' }
    const e = this.employeeByContact.get(contactId)
    return { contactId, name: c.data.name, kind: c.data.kind ?? 'person', ...(e ? { employeeId: e.id } : {}) }
  }

  /** A contact or project, named; null for anything else or a record that's gone. */
  ref(kind: string, id: string): Api.KnowledgeRef | null {
    if (kind === 'contact') {
      const c = this.contacts.get(id)
      if (!c) return null
      const e = this.employeeByContact.get(id)
      return { kind, id, name: c.data.name, contactKind: c.data.kind ?? 'person', ...(e ? { employeeId: e.id } : {}) }
    }
    if (kind === 'project') {
      const p = this.projects.get(id)
      return p ? { kind, id, name: p.data.name } : null
    }
    return null
  }

  employee(id: string | undefined | null): Api.EmployeeSummary | null {
    if (!id) return null
    return { id, name: this.employees.get(id)?.data.name ?? id }
  }

  /** Who made a change: a person's or an employee's name, a session, or the harness. */
  actorName(a: Actor): string {
    if (a.type === 'contact') return this.contacts.get(a.id)?.data.name ?? a.id
    if (a.type === 'session') return 'an employee session'
    return 'the harness'
  }
}

/** Fields that differ between two versions of a record's data. */
export function changedFields(prev: Record<string, unknown> | null, next: Record<string, unknown> | null): string[] {
  const a = prev ?? {}
  const b = next ?? {}
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}
