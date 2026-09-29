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

/** The routes of this section (merged into `ROUTES`). */
export const PROJECT_ROUTES = {
  createProject: ['POST', '/api/projects'],
  projectPeople: ['GET', '/api/projects/:id/people'],
  addProjectPerson: ['POST', '/api/projects/:id/people'],
  removeProjectPerson: ['DELETE', '/api/projects/:id/people/:contactId'],
  employeeProjects: ['GET', '/api/employees/:id/projects'],
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
  }
}
