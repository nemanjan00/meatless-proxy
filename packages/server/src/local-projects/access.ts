import { DeniedError } from '@mp/core'
import { ProjectRoles, type Repository } from '@mp/directory'
import { isLocalRepoUrl } from '@mp/git'
import { atLeast } from '../auth/access.ts'
import type { GuardContext, Principal } from '../auth/guard.ts'
import type { Services } from '../services.ts'

/**
 * Who may merge into a local project (docs/spec.md#local-projects). Kept apart from the routes so the
 * project and records APIs can check it too: project roles are knowledge that members can edit, so
 * on a local project the roles that merge are only handed out by someone who can already merge, and
 * only admins point a project at a local repository.
 */

/** Project roles that may merge and delete branches of a local project (admins may too). */
export const MERGE_ROLES: readonly string[] = [ProjectRoles.lead, ProjectRoles.owner, ProjectRoles.backup, ProjectRoles.reviewer]

/** The local repository urls of a list of repositories, sorted. */
export const localUrlsOf = (repos: Repository[] | undefined): string[] =>
  (repos ?? [])
    .map((r) => r?.url)
    .filter((u): u is string => typeof u === 'string' && isLocalRepoUrl(u))
    .map((u) => u.trim().toLowerCase())
    .sort()

/** Whether a project has a local repository. */
async function isLocalProject(s: Services, projectId: string): Promise<boolean> {
  const p = await s.directory.projects.get(projectId)
  return !!p && localUrlsOf(p.data.repositories).length > 0
}

/** Whether a signed-in person may merge and delete branches of a project: admins, or members with a merge role. */
export async function canMerge(s: Services, p: Principal, projectId: string): Promise<boolean> {
  if (p.access === 'admin') return true
  if (!atLeast(p.access, 'member')) return false
  const members = await s.directory.projects.members(projectId)
  const roles = members.find((m) => m.contact.id === p.contactId)?.roles ?? []
  return roles.some((r) => MERGE_ROLES.includes(r))
}

/** The guard check of the merge and delete-branch routes (see `GUARD_RULES`). */
export async function mergeGuard({ s, principal, params }: GuardContext): Promise<void> {
  if (!(await s.directory.projects.get(params.id ?? ''))) return // the handler answers 404
  if (!(await canMerge(s, principal, params.id ?? '')))
    throw new DeniedError(
      `only admins and the project's ${MERGE_ROLES.join(', ')}s can merge or delete branches: ask one of them, or an admin to give you one of those roles`,
    )
}

/** Refuses giving a merge role on a local project to someone, unless the caller can merge there already. */
export async function assertMayGrantRole(s: Services, p: Principal, projectId: string, role: string): Promise<void> {
  if (!MERGE_ROLES.includes(role) || !(await isLocalProject(s, projectId))) return
  if (await canMerge(s, p, projectId)) return
  throw new DeniedError(
    `${role} can merge into this project's local repository: only admins and its ${MERGE_ROLES.join(', ')}s can give that role`,
  )
}

/** Refuses a change to a project's local repositories (adding, removing or renaming one) by anyone but an admin. */
export async function assertLocalReposUnchanged(
  s: Services,
  p: Principal,
  projectId: string | null,
  repositories: unknown,
): Promise<void> {
  if (p.access === 'admin') return
  const next = localUrlsOf(Array.isArray(repositories) ? (repositories as Repository[]) : [])
  const current = projectId ? localUrlsOf((await s.directory.projects.get(projectId))?.data.repositories) : []
  if (next.join('\n') !== current.join('\n'))
    throw new DeniedError('only admins can point a project at a local repository, or change which one it has')
}
