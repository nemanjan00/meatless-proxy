import type { ApiRecord, ProjectData } from './resources.ts'

// ─── Projects: creating one, and who works on it ────────────────────────────
//
// Served by packages/server/src/projects. Assignments are links `contact -> project` with a
// role (`owner`, `member`, …); an employee is assigned through its AI contact. Reads are for
// everyone signed in; writes for members and admins, like the records API.

/** A role on a project. `owner` and `member` are the usual ones; any other string works too. */
export type ProjectRole = 'owner' | 'member' | (string & {})

/** Someone on a project: `{ contactId }`, or `{ employeeId }` for an AI employee (its contact is used). */
export type ProjectPersonRef = { contactId: string; employeeId?: undefined } | { employeeId: string; contactId?: undefined }

/** `POST /api/projects` body: a project, and who works on it, in one step. */
export interface CreateProjectBody {
  name: string
  description?: string
  /** Repository URLs (https or ssh), or repository objects. */
  repositories?: (string | { url: string; httpUrl?: string; defaultBranch?: string; path?: string })[]
  /** Documentation links, stored as the project's `links` with system `docs`. */
  docs?: string[]
  /** The owner: an employee or a person. */
  owner?: ProjectPersonRef
  /** More people on it, each with a role (default `member`). */
  members?: (ProjectPersonRef & { role?: ProjectRole })[]
}

/** One person or employee on a project, with every role they hold on it. */
export interface ProjectPerson {
  contactId: string
  name: string
  /** `person`, `ai` (an AI employee) or `agent`. */
  kind: 'person' | 'ai' | 'agent'
  /** Set for AI employees. */
  employeeId?: string
  /** Its `@handle`, for AI employees. */
  handle?: string
  roles: string[]
}

/** `GET /api/projects/:id/people` → the project's owner(s) first, then everyone else. */
export interface ProjectPeople {
  projectId: string
  people: ProjectPerson[]
}

/** A project someone works on, with their roles and the project's owner. */
export interface ProjectAssignment {
  project: ApiRecord<ProjectData>
  roles: string[]
  owner: { contactId: string; name: string } | null
}

/** `GET /api/employees/:id/projects` → the projects the employee works on. */
export interface EmployeeProjects {
  employeeId: string
  contactId: string
  projects: ProjectAssignment[]
}

/** `POST /api/projects` → the project and its people. */
export interface CreatedProject {
  project: ApiRecord<ProjectData>
  people: ProjectPerson[]
}

// ─── Local projects: repositories the harness hosts itself ──────────────────
//
// A project whose repository url is `local:<slug>` (docs/spec.md#local-projects). Employees push their
// own branches there; people review and merge them here. Merging and deleting branches: admins and
// the project's owners, backups and reviewers. Creating one and attaching a remote: admins.

/** `POST /api/projects/local` body: a new project with a new local repository. */
export interface CreateLocalProjectBody {
  name: string
  description?: string
  /** The repository's name (`[a-z0-9-]`). Default: from the project name. */
  slug?: string
  owner?: ProjectPersonRef
  members?: (ProjectPersonRef & { role?: ProjectRole })[]
}

/** A branch of a local repository, compared with its default branch. */
export interface LocalBranchInfo {
  name: string
  sha: string
  /** Commits the default branch doesn't have yet. 0: merged (or nothing new). */
  ahead: number
  /** Commits on the default branch the branch doesn't have. */
  behind: number
  subject: string
  author: string
  date: string
}

/** `GET /api/projects/:id/local` → the local repository and its branches. */
export interface LocalProject {
  projectId: string
  slug: string
  /** `local:<slug>`. */
  url: string
  defaultBranch: string
  branches: LocalBranchInfo[]
  /** Whether the signed-in person may merge and delete branches (admins, owners, backups, reviewers). */
  canMerge: boolean
  /** Whether they may attach a remote (admins). */
  canAttachRemote: boolean
}

/** `GET /api/projects/:id/local/compare?branch=` → a branch against the default branch. */
export interface LocalComparison {
  branch: string
  base: string
  ahead: number
  behind: number
  commits: { sha: string; subject: string; author: string; date: string }[]
  files: { status: string; path: string }[]
  diff: string
  truncated: boolean
  fastForward: boolean
}

/** `POST /api/projects/:id/local/merge` → what happened. */
export interface LocalMergeResult {
  branch: string
  into: string
  sha: string
  mode: 'fast-forward' | 'merge-commit'
}

/** `GET /api/projects/:id/local/tree?path=&ref=` → one directory. */
export interface LocalTree {
  path: string
  ref: string
  entries: { name: string; type: 'file' | 'dir'; size?: number }[]
}

/** `GET /api/projects/:id/local/file?path=&ref=` → one file (no content when binary or too large). */
export interface LocalFile {
  path: string
  ref: string
  size: number
  binary: boolean
  tooLarge: boolean
  content: string | null
}

/** `POST /api/projects/:id/local/remote` body: the remote to push everything to and switch the project to. */
export interface AttachRemoteBody {
  /** The new, empty remote (ssh or https, no credentials in it). */
  url: string
  /** Its https URL, when `url` is ssh. */
  httpUrl?: string
  /** Push with this employee's SSH key. Default: the project's owner or first member that is an employee with a key. */
  employeeId?: string
}

/** `POST /api/projects/:id/local/remote` → the updated project and what was pushed. */
export interface AttachedRemote {
  project: ApiRecord<ProjectData>
  branches: string[]
  /** Whose SSH key pushed, if any. */
  pushedAs: { employeeId: string; name: string } | null
}

/** The routes of this section (merged into `ROUTES`). */
export const PROJECT_ROUTES = {
  createProject: ['POST', '/api/projects'],
  projectPeople: ['GET', '/api/projects/:id/people'],
  addProjectPerson: ['POST', '/api/projects/:id/people'],
  removeProjectPerson: ['DELETE', '/api/projects/:id/people/:contactId'],
  employeeProjects: ['GET', '/api/employees/:id/projects'],
  createLocalProject: ['POST', '/api/projects/local'],
  localProject: ['GET', '/api/projects/:id/local'],
  compareLocalBranch: ['GET', '/api/projects/:id/local/compare'],
  mergeLocalBranch: ['POST', '/api/projects/:id/local/merge'],
  deleteLocalBranch: ['POST', '/api/projects/:id/local/branches/delete'],
  localTree: ['GET', '/api/projects/:id/local/tree'],
  localFile: ['GET', '/api/projects/:id/local/file'],
  attachRemote: ['POST', '/api/projects/:id/local/remote'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface ProjectsApi {
  /**
   * `POST /api/projects` → a new project with its repositories and docs links, its owner and
   * members linked in the same step (members and admins). Assigning an employee also makes the
   * harness register GitLab webhooks on its repositories.
   */
  createProject(body: CreateProjectBody): Promise<CreatedProject>
  /** `GET /api/projects/:id/people` → the employees and people on a project, with their roles. */
  projectPeople(id: string): Promise<ProjectPeople>
  /**
   * `POST /api/projects/:id/people` body `{ contactId | employeeId, role }` → adds a role
   * (default `member`; `owner` replaces the current owner). Idempotent.
   */
  addProjectPerson(id: string, body: ProjectPersonRef & { role?: ProjectRole }): Promise<ProjectPeople>
  /** `DELETE /api/projects/:id/people/:contactId?role=` → removes one role, or all of them. */
  removeProjectPerson(id: string, contactId: string, role?: string): Promise<ProjectPeople>
  /** `GET /api/employees/:id/projects` → the projects an employee works on. */
  employeeProjects(id: string): Promise<EmployeeProjects>
  /**
   * `POST /api/projects/local` → a new project with a new local repository (one empty commit on
   * `main`), its owner and members linked (admins).
   */
  createLocalProject(body: CreateLocalProjectBody): Promise<CreatedProject>
  /** `GET /api/projects/:id/local` → the project's local repository and its branches. 404 without one. */
  localProject(id: string): Promise<LocalProject>
  /** `GET /api/projects/:id/local/compare?branch=` → the branch's commits and diff against the default branch. */
  compareLocalBranch(id: string, branch: string): Promise<LocalComparison>
  /**
   * `POST /api/projects/:id/local/merge` body `{ branch }` → merges it into the default branch (fast-forward,
   * or a merge commit). Conflicts are a 409 listing the files; nothing changes. Admins, owners, backups, reviewers.
   */
  mergeLocalBranch(id: string, branch: string): Promise<LocalMergeResult>
  /** `POST /api/projects/:id/local/branches/delete` body `{ branch }` → deletes a branch (not the default one). */
  deleteLocalBranch(id: string, branch: string): Promise<LocalProject>
  /** `GET /api/projects/:id/local/tree?path=&ref=` → a directory of the default branch (or `ref`). */
  localTree(id: string, path?: string, ref?: string): Promise<LocalTree>
  /** `GET /api/projects/:id/local/file?path=&ref=` → a file of the default branch (or `ref`). */
  localFile(id: string, path: string, ref?: string): Promise<LocalFile>
  /**
   * `POST /api/projects/:id/local/remote` → pushes every branch to a new, empty remote and makes it the
   * project's repository (admins). The local repository is kept, as the repository's `previousUrl`.
   */
  attachRemote(id: string, body: AttachRemoteBody): Promise<AttachedRemote>
}

type Call = <T>(
  route: keyof typeof PROJECT_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `ProjectsApi` half of `createApiClient`. */
export function projectsMethods(call: Call): ProjectsApi {
  return {
    createProject: (body) => call('createProject', undefined, undefined, body),
    projectPeople: (id) => call('projectPeople', { id }),
    addProjectPerson: (id, body) => call('addProjectPerson', { id }, undefined, body),
    removeProjectPerson: (id, contactId, role) => call('removeProjectPerson', { id, contactId }, { role }),
    employeeProjects: (id) => call('employeeProjects', { id }),
    createLocalProject: (body) => call('createLocalProject', undefined, undefined, body),
    localProject: (id) => call('localProject', { id }),
    compareLocalBranch: (id, branch) => call('compareLocalBranch', { id }, { branch }),
    mergeLocalBranch: (id, branch) => call('mergeLocalBranch', { id }, undefined, { branch }),
    deleteLocalBranch: (id, branch) => call('deleteLocalBranch', { id }, undefined, { branch }),
    localTree: (id, path, ref) => call('localTree', { id }, { path, ref }),
    localFile: (id, path, ref) => call('localFile', { id }, { path, ref }),
    attachRemote: (id, body) => call('attachRemote', { id }, undefined, body),
  }
}
