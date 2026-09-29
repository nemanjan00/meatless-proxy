import { ApiRequestError, type GitlabBranchProtection, type GitlabProjectAdded, type GitlabProjectsPage } from '@mp/api'

/** A GitLab project the demo account reaches (fake: git.example.com). */
export interface MockGitlabProject {
  id: number
  path: string
  name: string
  description: string
  web: string
  http: string
  ssh: string
  /** Access level; default Developer (30). */
  level?: number
  /** Default branch; default `main`, null for an empty repository. */
  branch?: string | null
  /** Whether the default branch is left unprotected. */
  unprotected?: boolean
}

const GROUPS = ['acme', 'acme/platform', 'acme/data', 'acme/web', 'acme/mobile', 'tools']
const WORDS = [
  'ledger',
  'checkout',
  'search',
  'notifications',
  'reports',
  'auth',
  'catalog',
  'shipping',
  'pricing',
  'analytics',
  'gateway',
  'scheduler',
  'exports',
  'onboarding',
  'support-desk',
  'docs',
  'design-system',
  'feature-flags',
  'audit-log',
  'webhooks',
  'importer',
  'mailer',
  'rates',
  'tax',
  'cart',
]

/** 150 more projects, so the setup's search and paging have something to page through. */
export function moreGitlabProjects(from = 4, count = 150): MockGitlabProject[] {
  return Array.from({ length: count }, (_, i) => {
    const id = from + i
    const group = GROUPS[i % GROUPS.length]!
    const name = `${WORDS[i % WORDS.length]}${i >= WORDS.length ? `-${Math.floor(i / WORDS.length) + 1}` : ''}`
    const path = `${group}/${name}`
    return {
      id,
      path,
      name,
      description: `The ${name.replace(/-/g, ' ')} service.`,
      web: `https://git.example.com/${path}`,
      http: `https://git.example.com/${path}.git`,
      ssh: `git@git.example.com:${path}.git`,
      ...(id % 13 === 0 ? { level: 40 } : id % 29 === 0 ? { level: 50 } : {}),
      ...(id % 17 === 0 ? { branch: null } : {}),
      ...(id % 9 === 0 ? { unprotected: true } : {}),
    }
  })
}

const ROLE: Record<number, string> = { 10: 'Guest', 20: 'Reporter', 30: 'Developer', 40: 'Maintainer', 50: 'Owner' }

/** One page of `GET …/integrations/gitlab/projects`, searched like GitLab (path and name, case-insensitive). */
export function mockGitlabPage(
  all: readonly MockGitlabProject[],
  q: { search?: string; page?: number; perPage?: number },
  addedOf: (g: MockGitlabProject) => GitlabProjectAdded | null,
  levelOf: (g: MockGitlabProject) => number,
): GitlabProjectsPage {
  const search = (q.search ?? '').trim()
  const page = Math.max(1, Math.floor(q.page ?? 1))
  const perPage = Math.min(100, Math.max(1, Math.floor(q.perPage ?? 50)))
  const s = search.toLowerCase()
  const hits = all.filter((g) => !s || g.path.toLowerCase().includes(s) || g.name.toLowerCase().includes(s))
  const rows = hits.slice((page - 1) * perPage, page * perPage)
  return {
    projects: rows.map((g) => {
      const level = levelOf(g)
      return {
        id: g.id,
        path: g.path,
        name: g.name,
        webUrl: g.web,
        accessLevel: level,
        role: ROLE[level] ?? `level ${level}`,
        defaultBranch: g.branch === undefined ? 'main' : g.branch,
        protected: null,
        warnings: level >= 40 ? [`${ROLE[level]}: it could merge or push to protected branches. Developer is recommended.`] : [],
        added: addedOf(g),
      }
    }),
    search,
    page,
    perPage,
    nextPage: page * perPage < hits.length ? page + 1 : null,
    total: hits.length,
  }
}

/** `GET …/integrations/gitlab/projects/:projectId/protection`. */
export function mockGitlabProtection(all: readonly MockGitlabProject[], projectId: number): GitlabBranchProtection {
  const g = all.find((x) => x.id === projectId)
  if (!g) throw new ApiRequestError(404, 'not_found', `GitLab project ${projectId} not found`)
  const branch = g.branch === undefined ? 'main' : g.branch
  if (!branch) return { projectId, defaultBranch: null, protected: null, warning: null }
  return g.unprotected
    ? {
        projectId,
        defaultBranch: branch,
        protected: false,
        warning: `${branch} isn’t protected: protect it so only people can merge.`,
      }
    : { projectId, defaultBranch: branch, protected: true, warning: null }
}
