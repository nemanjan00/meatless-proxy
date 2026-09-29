import { isMpError } from '@mp/core'
import { DEFAULT_BASE_URL, type GitlabClient, projectRef } from './client.ts'

/**
 * Project webhooks, managed by the harness (docs/spec.md#integrations: "Webhooks set themselves up").
 * This is harness-side API only: it is never exposed as an MCP tool, so the model can't touch hooks.
 */

/** The hook event flags the integration handles (`true`) or deliberately ignores (`false`). */
export const HOOK_EVENTS = {
  push_events: true,
  note_events: true,
  issues_events: true,
  merge_requests_events: true,
  job_events: true,
  pipeline_events: true,
  tag_push_events: false,
} as const

export type HookEvents = Partial<Record<string, boolean>>

/** A project hook as GitLab returns it (the token is never returned). */
export interface ProjectHook {
  id: number
  url: string
  project_id?: number
  enable_ssl_verification?: boolean
  push_events_branch_filter?: string | null
  [flag: string]: unknown
}

export interface EnsureHookInput {
  /** The hook's URL. Ours is found by this URL. */
  url: string
  /** The secret token GitLab sends as `X-Gitlab-Token`. */
  token: string
  /** Event flags; default `HOOK_EVENTS`. */
  events?: HookEvents
  /**
   * The id of the hook whose token is known to equal `token` (from a previous `ensureProjectHook`).
   * GitLab never returns tokens, so any other existing hook gets the token set again. Omit it to always set it.
   */
  tokenKnownFor?: number
}

export interface EnsureHookResult {
  action: 'created' | 'updated' | 'unchanged'
  hook: ProjectHook
  /** What was repaired on an update: flag names, `enable_ssl_verification`, `push_events_branch_filter`, `token`. */
  changed: string[]
  /** Ids of duplicate hooks with the same URL that were removed. */
  removedDuplicates: number[]
}

/** Project hook management, over a client whose token has Maintainer on the project. */
export interface GitlabHooks {
  listProjectHooks(project: string | number): Promise<ProjectHook[]>
  /** Creates our hook, or repairs its events, SSL verification and token, and removes duplicates. Never creates a second one. */
  ensureProjectHook(project: string | number, input: EnsureHookInput): Promise<EnsureHookResult>
  /** Removes a hook by id, or every hook with this URL. Missing hooks are fine. Returns how many were removed. */
  removeProjectHook(project: string | number, hook: number | { url: string }): Promise<number>
}

/** SSL verification is on unless the URL is plain http. */
export const sslVerificationFor = (url: string) => !/^http:/i.test(url)

const normUrl = (u: string) => u.trim().replace(/\/+$/, '')

/** The fields to send so a hook has these events. Push has no branch filter. */
function desiredFields(url: string, events: HookEvents): Record<string, unknown> {
  return { ...events, enable_ssl_verification: sslVerificationFor(url) }
}

/** What differs between a hook and the desired settings (the token isn't visible). */
function drift(hook: ProjectHook, url: string, events: HookEvents): string[] {
  const out: string[] = []
  for (const [flag, want] of Object.entries(events)) if (want !== undefined && !!hook[flag] !== want) out.push(flag)
  if (!!hook.enable_ssl_verification !== sslVerificationFor(url)) out.push('enable_ssl_verification')
  if (events.push_events && hook.push_events_branch_filter) out.push('push_events_branch_filter')
  return out
}

export function createGitlabHooks(client: GitlabClient): GitlabHooks {
  const base = (project: string | number) => `/projects/${projectRef(project)}/hooks`

  const hooks: GitlabHooks = {
    listProjectHooks: (project) => client.paginate<ProjectHook>(base(project), {}, 1000),

    async ensureProjectHook(project, input) {
      const url = normUrl(input.url)
      const events = input.events ?? HOOK_EVENTS
      const ours = (await hooks.listProjectHooks(project)).filter((h) => normUrl(h.url) === url)
      if (!ours.length) {
        const hook = await client.post<ProjectHook>(base(project), { url, token: input.token, ...desiredFields(url, events) })
        return { action: 'created', hook, changed: [], removedDuplicates: [] }
      }
      // Keep the one whose token we know, else the oldest; remove the rest.
      const keep = ours.find((h) => h.id === input.tokenKnownFor) ?? [...ours].sort((a, b) => a.id - b.id)[0]!
      const removedDuplicates: number[] = []
      for (const h of ours) {
        if (h.id === keep.id) continue
        await hooks.removeProjectHook(project, h.id)
        removedDuplicates.push(h.id)
      }
      const changed = drift(keep, url, events)
      const resetToken = input.tokenKnownFor === undefined || keep.id !== input.tokenKnownFor
      if (resetToken) changed.push('token')
      if (!changed.length) return { action: 'unchanged', hook: keep, changed, removedDuplicates }
      const body: Record<string, unknown> = { url, ...desiredFields(url, events) }
      if (changed.includes('push_events_branch_filter')) body.push_events_branch_filter = ''
      if (resetToken) body.token = input.token
      const hook = await client.put<ProjectHook>(`${base(project)}/${keep.id}`, body)
      return { action: 'updated', hook, changed, removedDuplicates }
    },

    async removeProjectHook(project, hook) {
      const ids =
        typeof hook === 'number'
          ? [hook]
          : (await hooks.listProjectHooks(project)).filter((h) => normUrl(h.url) === normUrl(hook.url)).map((h) => h.id)
      let removed = 0
      for (const id of ids) {
        try {
          await client.request('DELETE', `${base(project)}/${id}`)
          removed++
        } catch (e) {
          if (!(isMpError(e, 'integration_request') && e.details?.status === 404)) throw e
        }
      }
      return removed
    },
  }
  return hooks
}

/**
 * The GitLab project path of a repository URL on this instance, or null when it's elsewhere.
 * Accepts `https://host[/sub-path]/group/sub/repo(.git)`, `git@host:group/repo.git` and
 * `ssh://git@host[:port]/group/repo.git`. `gitlab.com` always counts as GitLab.
 */
export function gitlabProjectPath(repoUrl: string, baseUrl: string = DEFAULT_BASE_URL): string | null {
  const s = repoUrl.trim()
  const base = new URL(baseUrl)
  const basePath = base.pathname.replace(/\/+$/, '')
  const hosts = new Set([base.hostname.toLowerCase(), 'gitlab.com'])
  const clean = (p: string) => {
    const path = p
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/, '')
      .replace(/\/-\/.*$/, '')
    return path.includes('/') ? decodeURIComponent(path) : null
  }
  const scp = /^[\w.-]+@([^:/]+):(?!\/)(.+)$/.exec(s)
  if (scp) return hosts.has(scp[1]!.toLowerCase()) ? clean(scp[2]!) : null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (!hosts.has(host)) return null
  if (u.protocol === 'ssh:') return clean(u.pathname)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  let path = u.pathname
  if (host === base.hostname.toLowerCase() && basePath && (path === basePath || path.startsWith(`${basePath}/`)))
    path = path.slice(basePath.length)
  return clean(path)
}
