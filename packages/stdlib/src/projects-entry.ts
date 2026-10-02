import type { Json } from '@mp/core'
import type { Contact, Directory, Project } from '@mp/directory'
import type { Sessions } from '@mp/sessions'
import type { Entry } from '@mp/store'

/**
 * "Your projects": the projects an employee works on, as a small system entry
 * added to each new run (docs/spec.md#projects). It goes after the session's
 * history, so the cached prefix (the system prompt and everything before)
 * never changes when someone assigns a project: the employee sees the current
 * list without breaking the prompt cache.
 */

/** Meta key marking the entry; its value is the listed project ids. */
export const PROJECTS_ENTRY_META = 'projectsEntry'
/** The entry's first line. */
export const PROJECTS_HEADER = 'Your projects (current; this replaces any earlier list):'
/** At most this many projects are listed; the rest are counted. */
export const MAX_LISTED_PROJECTS = 20
const DESCRIPTION_CHARS = 140

/** One project the employee works on. */
export interface ProjectLine {
  id: string
  name: string
  /** Its roles on the project, owner first. */
  roles: string[]
  /** Repository URLs: each repository's `url`, then its `httpUrl`. */
  repositories: string[]
  /** The owner's name, `you` when it is the employee itself. */
  owner?: string
  /**
   * Who to ask for decisions and clarifications: the leads, else a human owner, else the human backups.
   * Empty when none of them is set.
   */
  ask: AskLine[]
  description?: string
}

/** A person to ask about a project, with the role they hold and their handles (`system:id`). */
export interface AskLine {
  name: string
  role: 'lead' | 'owner' | 'backup'
  handles: string[]
}

/** What the note says when a project has nobody to ask. */
export const NO_LEAD_TEXT = 'no lead set: ask the requester or an admin'
/** At most this many people to ask are named per project, with this many handles each. */
const MAX_ASK = 3
const MAX_HANDLES = 3

const isPerson = (c: Contact) => (c.data.kind ?? 'person') === 'person'

const askLine = (c: Contact, role: AskLine['role']): AskLine => ({
  name: c.data.name,
  role,
  handles: (c.data.handles ?? []).slice(0, MAX_HANDLES).map((h) => `${h.system}:${h.id}`),
})

/**
 * Who to ask about a project: its leads (people by definition), else its owner when that is a person,
 * else its backups that are people. Empty when there is none.
 */
export async function projectAsk(directory: Directory, projectId: string): Promise<AskLine[]> {
  const leads = await directory.projects.leads(projectId)
  if (leads.length) return leads.slice(0, MAX_ASK).map((c) => askLine(c, 'lead'))
  const owner = await directory.projects.owner(projectId)
  if (owner && isPerson(owner)) return [askLine(owner, 'owner')]
  const backups = (await directory.projects.members(projectId, { role: 'backup' })).map((m) => m.contact).filter(isPerson)
  return backups.slice(0, MAX_ASK).map((c) => askLine(c, 'backup'))
}

/** The "ask:" part of a project line: `Ana Lima (lead; mp:ana)`, or `NO_LEAD_TEXT`. */
export function askText(ask: AskLine[]): string {
  if (!ask.length) return NO_LEAD_TEXT
  return ask
    .map((a) => {
      const role = a.role === 'lead' ? 'lead' : `${a.role}, no lead set`
      return `${a.name} (${[role, ...(a.handles.length ? [a.handles.join(', ')] : [])].join('; ')})`
    })
    .join(', ')
}

const ROLE_ORDER = ['lead', 'owner', 'backup', 'member', 'reviewer', 'stakeholder']
const byRole = (a: string, b: string) => {
  const ia = ROLE_ORDER.indexOf(a)
  const ib = ROLE_ORDER.indexOf(b)
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
}

const oneLine = (s: string | undefined, max: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** The projects an employee works on: the ones its AI contact is linked to (any role). Sorted by name. */
export async function currentProjects(directory: Directory, employeeId: string): Promise<ProjectLine[]> {
  const employee = await directory.employees.require(employeeId)
  const contactId = employee.data.contactId
  const byId = new Map<string, { project: Project; roles: string[] }>()
  for (const m of await directory.projects.forContact(contactId)) byId.set(m.project.id, { project: m.project, roles: m.roles })
  const lines: ProjectLine[] = []
  for (const { project, roles } of byId.values()) {
    const owner = await directory.projects.owner(project.id)
    const repositories = [
      ...new Set((project.data.repositories ?? []).flatMap((r) => [r.url, ...(r.httpUrl ? [r.httpUrl] : [])]).filter(Boolean)),
    ]
    lines.push({
      id: project.id,
      name: project.data.name,
      roles: [...roles].sort(byRole),
      repositories,
      ...(owner ? { owner: owner.id === contactId ? 'you' : owner.data.name } : {}),
      ask: await projectAsk(directory, project.id),
      ...(project.data.description ? { description: oneLine(project.data.description, DESCRIPTION_CHARS) } : {}),
    })
  }
  return lines.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The entry's text. Deterministic for the same projects, so a repeat can be recognised. */
export function projectsText(lines: ProjectLine[]): string {
  if (!lines.length)
    return [
      PROJECTS_HEADER,
      'None: no project is assigned to you yet. If someone asks what you work on, say so plainly, and ask an admin to assign you projects (on your employee page, or when they create a project).',
    ].join('\n')
  const shown = lines.slice(0, MAX_LISTED_PROJECTS).map((p) => {
    const bits = [`your role: ${p.roles.join(', ')}`]
    if (p.owner) bits.push(`owner: ${p.owner}`)
    bits.push(`ask: ${askText(p.ask)}`)
    if (p.repositories.length) bits.push(`repos: ${p.repositories.join(', ')}`)
    return `- ${p.name} (${p.id}); ${bits.join('; ')}${p.description ? `. ${p.description}` : ''}`
  })
  const more = lines.length - shown.length
  return [PROJECTS_HEADER, ...shown, ...(more > 0 ? [`…and ${more} more (directory.projects_of lists them all).`] : [])].join(
    '\n',
  )
}

/** The text of the latest "Your projects" entry in a history, or null. */
export function lastProjectsText(history: Pick<Entry, 'meta' | 'content'>[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!
    if (e.meta?.[PROJECTS_ENTRY_META] === undefined) continue
    const text = (e.content as { text?: unknown } | null)?.text
    return typeof text === 'string' ? text : null
  }
  return null
}

/** A run input entry. */
export interface ProjectsEntry {
  kind: 'system'
  content: { text: string }
  meta: Record<string, Json>
}

/**
 * The "Your projects" entry for a new run of the employee in `sessionId`, or null when the
 * session's history already ends with the same list (nothing changed since it was added).
 */
export async function projectsEntry(
  deps: { directory: Directory; sessions: Pick<Sessions, 'history'> },
  employeeId: string,
  sessionId?: string,
): Promise<ProjectsEntry | null> {
  const lines = await currentProjects(deps.directory, employeeId)
  const text = projectsText(lines)
  if (sessionId && lastProjectsText(await deps.sessions.history(sessionId)) === text) return null
  return { kind: 'system', content: { text }, meta: { [PROJECTS_ENTRY_META]: lines.map((l) => l.id) } }
}
