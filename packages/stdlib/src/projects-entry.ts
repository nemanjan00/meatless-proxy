import type { Json } from '@mp/core'
import type { Directory, Project } from '@mp/directory'
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
  description?: string
}

const ROLE_ORDER = ['owner', 'backup', 'member', 'reviewer', 'stakeholder']
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
