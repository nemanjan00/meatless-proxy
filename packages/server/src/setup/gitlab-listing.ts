import type { GitlabBranchProtection, GitlabProjectRow, GitlabProjectsPage } from '@mp/api'
import { errorMessage, NotFoundError, UnavailableError, ValidationError } from '@mp/core'
import { redact, type SetupContext } from './common.ts'
import {
  accessOf,
  accessWarning,
  type GitlabProject,
  gitlabApi,
  isProtected,
  PROJECTS_TIMEOUT_MS,
  roleName,
  totalOf,
  unprotectedWarning,
} from './gitlab.ts'
import { harnessProjectsByRepo } from './gitlab-projects.ts'

/**
 * The GitLab projects step's own listing (docs/spec.md#guided-setup), apart from the cached status check:
 * GitLab searches and pages the account's projects, and the default branch check runs per row, on demand.
 *
 * A full `/projects` listing is GitLab's slowest call for an account in many groups, so the page is a
 * `simple=true` listing, and the access level (which only a full project carries, in `permissions`) is
 * fetched for the rows on the page alone, a few at a time.
 */

export const GITLAB_PAGE_DEFAULT = 50
export const GITLAB_PAGE_MAX = 100
/** Longest search passed to GitLab. */
export const GITLAB_SEARCH_MAX = 200
/** Per-row lookups in flight at once. */
const ROW_CONCURRENCY = 8

export interface GitlabListQuery {
  search?: string
  page?: number
  perPage?: number
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const tokenOf = (ctx: SetupContext) => {
  const token = ctx.values.GITLAB_TOKEN
  if (!token) throw new ValidationError('Paste the account’s token first.')
  return token
}

/** A failed GitLab answer as a typed error, with every secret masked. */
function failure(ctx: SetupContext, what: string, status: number): Error {
  if (status === 401) return new ValidationError('GitLab rejected the token: it was revoked, expired or mistyped.')
  return new UnavailableError(redact(ctx, `GitLab answered ${what} with HTTP ${status}`))
}

const pageHeader = (v: string | null) => {
  const n = v ? Number(v) : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/** One page of the account's projects, searched by GitLab, with access levels and whether each is added. */
export async function listGitlabProjects(ctx: SetupContext, q: GitlabListQuery): Promise<GitlabProjectsPage> {
  const token = tokenOf(ctx)
  const search = (q.search ?? '').trim().slice(0, GITLAB_SEARCH_MAX)
  const page = Math.max(1, Math.floor(q.page ?? 1))
  const perPage = Math.min(GITLAB_PAGE_MAX, Math.max(1, Math.floor(q.perPage ?? GITLAB_PAGE_DEFAULT)))
  const params = new URLSearchParams({
    membership: 'true',
    archived: 'false',
    simple: 'true',
    order_by: 'last_activity_at',
    page: String(page),
    per_page: String(perPage),
  })
  // With the namespace searched too, "acme/bill" finds acme/billing.
  if (search) {
    params.set('search', search)
    params.set('search_namespaces', 'true')
  }
  const timeoutMs = Math.max(ctx.deps.timeoutMs, PROJECTS_TIMEOUT_MS)
  let r: Awaited<ReturnType<typeof gitlabApi>>
  try {
    r = await gitlabApi(ctx, token, `/projects?${params}`, { timeoutMs })
  } catch (err) {
    throw new UnavailableError(redact(ctx, `Couldn't list the projects: ${errorMessage(err)}`))
  }
  if (!r.ok) throw failure(ctx, 'GET /projects', r.status)
  const listed = (Array.isArray(r.json) ? r.json : []) as GitlabProject[]
  const [known, levels] = await Promise.all([
    harnessProjectsByRepo(ctx),
    // A simple listing has no permissions: one project read per row gives the access level.
    mapLimit(listed, ROW_CONCURRENCY, async (p) => {
      const one = await gitlabApi(ctx, token, `/projects/${p.id}`).catch(() => null)
      return one?.ok && one.json ? accessOf(one.json as GitlabProject) : null
    }),
  ])
  const projects = listed.map((p, i): GitlabProjectRow => {
    const level = levels[i] ?? null
    const warning = level === null ? null : accessWarning(ctx, level)
    return {
      id: p.id,
      path: p.path_with_namespace,
      name: p.name ?? p.path_with_namespace.split('/').pop() ?? p.path_with_namespace,
      webUrl: p.web_url ?? null,
      accessLevel: level,
      role: level === null ? null : roleName(level),
      defaultBranch: p.default_branch ?? null,
      protected: null,
      warnings: warning ? [warning] : [],
      added: known(p),
    }
  })
  return {
    projects,
    search,
    page,
    perPage,
    nextPage: pageHeader(r.headers.get('x-next-page')),
    total: totalOf(r),
  }
}

/** Whether a project's default branch is protected (one row of the listing, checked on demand). */
export async function gitlabBranchProtection(ctx: SetupContext, projectId: number): Promise<GitlabBranchProtection> {
  const token = tokenOf(ctx)
  const [p, b] = await Promise.all([
    gitlabApi(ctx, token, `/projects/${projectId}`),
    gitlabApi(ctx, token, `/projects/${projectId}/protected_branches?per_page=100`),
  ]).catch((err) => {
    throw new UnavailableError(redact(ctx, `Couldn't check the project: ${errorMessage(err)}`))
  })
  if (p.status === 404 || p.status === 403) throw new NotFoundError('GitLab project', String(projectId))
  if (!p.ok) throw failure(ctx, `GET /projects/${projectId}`, p.status)
  const branch = (p.json as GitlabProject | undefined)?.default_branch ?? null
  // Listing protected branches needs Maintainer on some instances: then GitLab can't say (null).
  if (!branch || !b.ok) return { projectId, defaultBranch: branch, protected: null, warning: null }
  const on = isProtected(
    branch,
    ((Array.isArray(b.json) ? b.json : []) as { name: string }[]).map((x) => x.name),
  )
  return { projectId, defaultBranch: branch, protected: on, warning: on ? null : unprotectedWarning(branch) }
}
