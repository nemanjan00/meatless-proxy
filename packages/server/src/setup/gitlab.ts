import type { Json, SetupStep } from '@mp/api'
import { ConflictError, DeniedError, errorMessage, globMatch, UnavailableError, ValidationError } from '@mp/core'
import { GITLAB_HOOK_KIND, type GitlabHookData } from '../integrations/provisioning.ts'
import { addGitlabProjects, harnessProjectsByRepo } from './gitlab-projects.ts'
import { sshFingerprint } from '../ssh.ts'
import {
  addHandle,
  addTrigger,
  ago,
  http,
  type HttpResult,
  type IntegrationSetupModule,
  redact,
  routingStep,
  type SetupContext,
  secretState,
  step,
  webhookUrl,
} from './common.ts'

export const GITLAB_DEFAULT_URL = 'https://gitlab.com'
/** Warn when the token expires sooner than this. */
export const TOKEN_EXPIRY_WARN_DAYS = 30
/** Projects whose protected branches are checked (the most recently active first). */
export const MAX_CHECKED_PROJECTS = 20
/** GitLab access levels. */
export const ACCESS = { guest: 10, reporter: 20, developer: 30, maintainer: 40, owner: 50 } as const
const ROLE: Record<number, string> = {
  5: 'Minimal',
  10: 'Guest',
  15: 'Planner',
  20: 'Reporter',
  30: 'Developer',
  40: 'Maintainer',
  50: 'Owner',
}

export const roleName = (level: number) => ROLE[level] ?? `level ${level}`

/** The title of the employee's SSH key on GitLab. */
export const keyTitle = (handle: string) => `meatless-proxy ${handle}`

/** The instance: an employee (or global) `GITLAB_BASE_URL` secret, else the deployment's, else gitlab.com. */
export function gitlabBase(ctx: SetupContext): { url: string; source: 'secret' | 'config' | 'default' } {
  const secret = ctx.values.GITLAB_BASE_URL?.trim()
  if (secret) return { url: secret.replace(/\/+$/, ''), source: 'secret' }
  const config = ctx.deps.baseUrls.gitlab ?? ctx.s.config.GITLAB_BASE_URL
  if (config) return { url: config.replace(/\/+$/, ''), source: 'config' }
  return { url: GITLAB_DEFAULT_URL, source: 'default' }
}

interface GitlabUser {
  id: number
  username: string
  name?: string
  avatar_url?: string
  web_url?: string
  bot?: boolean
  is_admin?: boolean
  state?: string
}

interface TokenSelf {
  name?: string
  scopes?: string[]
  expires_at?: string | null
  active?: boolean
}

interface GitlabKey {
  id: number
  title?: string
  key: string
}

export interface GitlabProject {
  id: number
  name?: string
  path_with_namespace: string
  description?: string | null
  web_url?: string
  http_url_to_repo?: string
  ssh_url_to_repo?: string
  default_branch?: string | null
  archived?: boolean
  permissions?: {
    project_access?: { access_level?: number } | null
    group_access?: { access_level?: number } | null
  }
}

/** One GitLab API call as the token's account. */
async function api(
  ctx: SetupContext,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const base = gitlabBase(ctx).url
  const r = await http(ctx.deps, `${base}/api/v4${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'private-token': token,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (r.status === 429) throw new UnavailableError('GitLab is rate limiting the harness; try again in a minute')
  if (r.status >= 500) throw new UnavailableError(`GitLab answered ${path.split('?')[0]} with HTTP ${r.status}`)
  return r
}

/** `GET /user`, or why not. */
async function currentUser(ctx: SetupContext, token: string): Promise<{ user: GitlabUser } | { status: number }> {
  const r = await api(ctx, token, '/user')
  if (r.ok && r.json?.username) return { user: r.json as GitlabUser }
  return { status: r.status }
}

const days = (iso: string, now: number) => Math.floor((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - now) / 86_400_000)

/** The token's scopes and expiry; null when the instance can't say (older GitLab). */
async function tokenSelf(ctx: SetupContext, token: string): Promise<TokenSelf | null> {
  const r = await api(ctx, token, '/personal_access_tokens/self')
  return r.ok && r.json ? (r.json as TokenSelf) : null
}

async function listKeys(ctx: SetupContext, token: string): Promise<GitlabKey[]> {
  const r = await api(ctx, token, '/user/keys?per_page=100')
  if (!r.ok) throw new UnavailableError(`GitLab answered GET /user/keys with HTTP ${r.status}`)
  return (r.json ?? []) as GitlabKey[]
}

const accessOf = (p: GitlabProject) =>
  Math.max(p.permissions?.project_access?.access_level ?? 0, p.permissions?.group_access?.access_level ?? 0)

/** Whether a branch is covered by one of the protected branch names (which may be wildcards like `release/*`). */
export const isProtected = (branch: string, names: string[]) =>
  names.some((n) => n === branch || (n.includes('*') && globMatch(n.replace(/\*/g, '**'), branch)))

/** GitLab's guided setup: instance, service account, token, SSH key, projects, webhooks, routing. */
export const gitlabSetup: IntegrationSetupModule = {
  name: 'gitlab',
  label: 'GitLab',
  tokenSecret: 'GITLAB_TOKEN',
  secrets: [
    { name: 'GITLAB_TOKEN', label: 'Personal access token (api scope)', placeholder: 'glpat-…' },
    { name: 'GITLAB_BASE_URL', label: 'Instance URL (self-hosted only)', placeholder: GITLAB_DEFAULT_URL },
  ],

  async check(ctx) {
    const id = ctx.employee.id
    const now = ctx.s.clock.now()
    const base = gitlabBase(ctx)
    const token = ctx.values.GITLAB_TOKEN
    const tokenState = secretState(ctx.metas, 'GITLAB_TOKEN', id)
    const steps: SetupStep[] = []

    // (a) The instance.
    steps.push(
      step(
        'instance',
        'GitLab instance',
        'done',
        base.source === 'default'
          ? 'gitlab.com. For a self-hosted instance, set its URL below or GITLAB_BASE_URL on the server.'
          : `${base.url} (from ${base.source === 'secret' ? 'the GITLAB_BASE_URL secret' : 'the server’s GITLAB_BASE_URL'}).`,
        {
          baseUrl: base.url,
          source: base.source,
          adminUsersUrl: `${base.url}/admin/users/new`,
          serviceAccountsDocs: 'https://docs.gitlab.com/user/profile/service_accounts/',
        },
      ),
    )

    // (b, c) The account and its token.
    let user: GitlabUser | null = null
    if (!token) {
      steps.push(
        step(
          'account',
          'A service account for the employee',
          'todo',
          'Create an account for the employee, then paste its token below.',
        ),
      )
      steps.push(step('token', 'Paste its access token', 'todo', 'A personal access token of the account, with the api scope.'))
    } else {
      try {
        const u = await currentUser(ctx, token)
        if ('status' in u) {
          const msg =
            u.status === 401
              ? 'GitLab rejected the token: it was revoked, expired or mistyped.'
              : `GitLab answered /user with HTTP ${u.status}.`
          steps.push(step('account', 'A service account for the employee', 'todo', 'Needs a working token.'))
          steps.push(step('token', 'Paste its access token', 'error', msg))
        } else {
          user = u.user
          const accountProblems = [
            ...(user.is_admin ? ['The account is an administrator: give the employee an account without admin rights.'] : []),
            ...(user.state && user.state !== 'active' ? [`The account is ${user.state}.`] : []),
          ]
          steps.push(
            step(
              'account',
              'A service account for the employee',
              accountProblems.length ? 'warning' : 'done',
              `@${user.username}${user.bot ? ', a service account' : ', a regular user (fine if it’s dedicated to the employee)'}.${accountProblems.length ? ` ${accountProblems.join(' ')}` : ''}`,
              {
                username: user.username,
                name: user.name ?? null,
                avatarUrl: user.avatar_url ?? null,
                webUrl: user.web_url ?? null,
                serviceAccount: !!user.bot,
              },
            ),
          )
          const self = await tokenSelf(ctx, token).catch(() => null)
          const problems: string[] = []
          let status: SetupStep['status'] = 'done'
          if (self?.scopes && !self.scopes.includes('api')) {
            problems.push(`The token lacks the api scope (it has ${self.scopes.join(', ') || 'none'}): make a new one with api.`)
            status = 'error'
          }
          const left = self?.expires_at ? days(self.expires_at, now) : null
          if (left !== null && left < TOKEN_EXPIRY_WARN_DAYS) {
            problems.push(
              left < 0
                ? 'The token has expired.'
                : `The token expires in ${left} day${left === 1 ? '' : 's'} (${self!.expires_at}): rotate it.`,
            )
            if (status === 'done') status = left < 0 ? 'error' : 'warning'
          }
          if (!tokenState.own) {
            problems.push('It uses the deployment-wide token: paste this employee’s own, so its work shows as its own account.')
            if (status === 'done') status = 'warning'
          }
          steps.push(
            step(
              'token',
              'Paste its access token',
              status,
              problems.length
                ? problems.join(' ')
                : `Works, with the api scope${self?.expires_at ? `; expires ${self.expires_at}` : ''}.`,
              {
                scopes: (self?.scopes ?? null) as Json,
                expiresAt: self?.expires_at ?? null,
                ...(left !== null ? { daysLeft: left } : {}),
              },
            ),
          )
        }
      } catch (err) {
        steps.push(step('account', 'A service account for the employee', 'todo', 'Needs a working token.'))
        steps.push(
          step('token', 'Paste its access token', 'warning', redact(ctx, `Couldn't check the token: ${errorMessage(err)}`)),
        )
      }
    }

    // (d) The employee's SSH key on the account.
    const publicKey = typeof ctx.employee.data.sshPublicKey === 'string' ? ctx.employee.data.sshPublicKey : null
    const fingerprint = publicKey ? sshFingerprint(publicKey) : null
    const keyData = { publicKey, fingerprint, title: keyTitle(ctx.handle) }
    if (!publicKey)
      steps.push(step('ssh-key', 'Add its SSH key', 'error', 'The employee has no SSH key yet: rotate it to make one.', keyData))
    else if (!user || !token)
      steps.push(step('ssh-key', 'Add its SSH key', 'todo', 'Needs a working token, or add the key by hand.', keyData))
    else {
      try {
        const keys = await listKeys(ctx, token)
        const found = keys.find((k) => sshFingerprint(k.key) === fingerprint)
        steps.push(
          found
            ? step('ssh-key', 'Add its SSH key', 'done', `On @${user.username} as “${found.title ?? 'untitled'}”.`, {
                ...keyData,
                keyId: found.id,
              })
            : step(
                'ssh-key',
                'Add its SSH key',
                'todo',
                `Not on @${user.username} yet. Add it, so the employee can push over SSH.`,
                keyData,
              ),
        )
      } catch (err) {
        steps.push(
          step(
            'ssh-key',
            'Add its SSH key',
            'warning',
            redact(ctx, `Couldn't list the account's keys: ${errorMessage(err)}`),
            keyData,
          ),
        )
      }
    }

    // (e) Projects, access levels and protected default branches.
    if (!user || !token) steps.push(step('projects', 'Give it access to projects', 'todo', 'Needs a working token.'))
    else {
      try {
        const r = await api(ctx, token, '/projects?membership=true&archived=false&per_page=100&order_by=last_activity_at')
        if (!r.ok) throw new UnavailableError(`GitLab answered GET /projects with HTTP ${r.status}`)
        const projects = (r.json ?? []) as GitlabProject[]
        // Which of them the harness already has as a project, and whether the employee is on it.
        const known = await harnessProjectsByRepo(ctx)
        const checked = await Promise.all(
          projects.map(async (p, i) => {
            const level = accessOf(p)
            const warnings: string[] = []
            if (level >= ACCESS.maintainer)
              warnings.push(`${roleName(level)}: it could merge or push to protected branches. Developer is recommended.`)
            let protectedDefault: boolean | null = null
            if (p.default_branch && i < MAX_CHECKED_PROJECTS) {
              const b = await api(ctx, token, `/projects/${p.id}/protected_branches?per_page=100`).catch(() => null)
              if (b?.ok) {
                protectedDefault = isProtected(
                  p.default_branch,
                  ((b.json ?? []) as { name: string }[]).map((x) => x.name),
                )
                if (!protectedDefault) warnings.push(`${p.default_branch} isn’t protected: protect it so only people can merge.`)
              }
            }
            const added = known(p)
            return {
              id: p.id,
              path: p.path_with_namespace,
              webUrl: p.web_url ?? null,
              added,
              accessLevel: level,
              role: roleName(level),
              defaultBranch: p.default_branch ?? null,
              protected: protectedDefault,
              warnings,
            }
          }),
        )
        const warned = checked.filter((p) => p.warnings.length)
        const notAdded = checked.filter((p) => !p.added?.linked).length
        const addNote = notAdded
          ? ` ${notAdded} ${notAdded === 1 ? 'isn’t' : 'aren’t'} a harness project of the employee yet: add ${notAdded === 1 ? 'it' : 'them'} so it knows it works on ${notAdded === 1 ? 'it' : 'them'}.`
          : ''
        steps.push(
          step(
            'projects',
            'Give it access to projects',
            !checked.length ? 'todo' : warned.length ? 'warning' : 'done',
            !checked.length
              ? `@${user.username} isn’t a member of any project. Add it as Developer to the projects it works on.`
              : warned.length
                ? `${warned.length} of ${checked.length} project${checked.length === 1 ? '' : 's'} need attention.${addNote}`
                : `Developer on ${checked.length} project${checked.length === 1 ? '' : 's'}, with protected default branches.${addNote}`,
            { projects: checked as unknown as Json, notAdded },
          ),
        )
      } catch (err) {
        steps.push(
          step(
            'projects',
            'Give it access to projects',
            'warning',
            redact(ctx, `Couldn't list its projects: ${errorMessage(err)}`),
          ),
        )
      }
    }

    // (f) Webhooks: registered by the harness (src/integrations/provisioning.ts), and when they last arrived.
    const provisioning = ctx.deps.provisioning()
    const hooks = ctx.s.records.kinds.has(GITLAB_HOOK_KIND)
      ? (await ctx.s.records.query<GitlabHookData>(GITLAB_HOOK_KIND, { where: { employeeId: id }, limit: 200 })).items
      : []
    const activity = await ctx.deps.activity.get(id, 'gitlab')
    const hookRows = hooks
      .map((h) => ({
        project: h.data.gitlabProject,
        status: h.data.status,
        error: h.data.error ?? null,
        url: h.data.url ?? null,
        lastOkAt: h.data.lastOkAt ?? null,
        lastReceivedAt: activity?.projects?.[h.data.gitlabProject] ?? null,
      }))
      .sort((a, b) => a.project.localeCompare(b.project))
    const failed = hookRows.filter((h) => h.status === 'error')
    const hookData = {
      url: webhookUrl(ctx, 'gitlab'),
      hooks: hookRows as unknown as Json,
      provisioning: !!provisioning?.enabled,
      reason: provisioning ? (provisioning.reason ?? null) : 'the GitLab integration is disabled',
      lastReceivedAt: activity?.lastAt ?? null,
    }
    if (failed.length)
      steps.push(
        step(
          'webhooks',
          'Webhooks',
          'warning',
          `${failed.length} webhook${failed.length === 1 ? '' : 's'} couldn’t be registered: ${failed[0]!.error ?? 'unknown error'}`,
          hookData,
        ),
      )
    else if (activity)
      steps.push(step('webhooks', 'Webhooks', 'done', `The last event arrived ${ago(activity.lastAt, now)}.`, hookData))
    else if (hookRows.length)
      steps.push(
        step(
          'webhooks',
          'Webhooks',
          'todo',
          `Registered on ${hookRows.length} project${hookRows.length === 1 ? '' : 's'}; no event has arrived yet.`,
          hookData,
        ),
      )
    else
      steps.push(
        step(
          'webhooks',
          'Webhooks',
          'todo',
          !provisioning?.enabled
            ? `The harness registers them itself, but can’t now: ${hookData.reason ?? 'provisioning is off'}.`
            : 'The harness registers them on every GitLab repository of the projects the employee is on. Link a repository to one of its projects.',
          hookData,
        ),
      )

    // (g) Routing.
    steps.push(
      await routingStep(
        ctx,
        'gitlab',
        'GitLab',
        'The recommended trigger sends open issues assigned to it to the router context.',
      ),
    )
    return steps
  },

  async validate(ctx, given) {
    if (given.GITLAB_BASE_URL !== undefined) {
      let u: URL
      try {
        u = new URL(given.GITLAB_BASE_URL.trim())
      } catch {
        throw new ValidationError('The instance URL must be a URL, like https://git.example.com')
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ValidationError('The instance URL must be http(s)')
    }
    const token = ctx.values.GITLAB_TOKEN
    if (!token) return { message: 'Instance URL saved.' }
    let u: { user: GitlabUser } | { status: number }
    try {
      u = await currentUser(ctx, token)
    } catch (err) {
      if (given.GITLAB_TOKEN === undefined) return { message: 'Instance URL saved.' }
      return { message: redact(ctx, `Saved, but GitLab couldn't be reached to check it: ${errorMessage(err)}`) }
    }
    if ('status' in u) {
      if (given.GITLAB_TOKEN === undefined)
        throw new ValidationError(`The token doesn’t work on ${gitlabBase(ctx).url} (HTTP ${u.status}). Nothing was saved.`)
      throw new ValidationError(
        u.status === 401
          ? 'GitLab rejected the token (401). It was not saved.'
          : `GitLab answered /user with HTTP ${u.status}. The token was not saved.`,
      )
    }
    const user = u.user
    const self = await tokenSelf(ctx, token).catch(() => null)
    if (self?.scopes && !self.scopes.includes('api'))
      throw new ValidationError(`The token needs the api scope (it has ${self.scopes.join(', ') || 'none'}). It was not saved.`)
    return {
      message: `Connected as @${user.username}.`,
      after: async () => {
        const note = await addHandle(ctx, 'gitlab', user.username)
        ctx.deps.provisioning()?.schedule(ctx.employee.id)
        return note
      },
    }
  },

  actions: {
    async 'add-ssh-key'(ctx) {
      const token = ctx.values.GITLAB_TOKEN
      if (!token) throw new ValidationError('Paste the account’s token first.')
      const publicKey = typeof ctx.employee.data.sshPublicKey === 'string' ? ctx.employee.data.sshPublicKey : null
      const fingerprint = publicKey ? sshFingerprint(publicKey) : null
      if (!publicKey || !fingerprint) throw new ValidationError('The employee has no SSH key: rotate it to make one.')
      const u = await currentUser(ctx, token)
      if ('status' in u) throw new ValidationError(`GitLab rejected the token (HTTP ${u.status}).`)
      const title = keyTitle(ctx.handle)
      const keys = await listKeys(ctx, token)
      const stale = keys.filter((k) => k.title === title && sshFingerprint(k.key) !== fingerprint)
      const removeStale = async () => {
        for (const k of stale) await api(ctx, token, `/user/keys/${k.id}`, { method: 'DELETE' }).catch(() => null)
        return stale.length ? ` Removed the old key “${title}”.` : ''
      }
      if (keys.some((k) => sshFingerprint(k.key) === fingerprint))
        return `The key is already on @${u.user.username}.${await removeStale()}`
      const r = await api(ctx, token, '/user/keys', { method: 'POST', body: { title, key: publicKey.trim() } })
      if (r.status === 201 || r.ok) return `Added the key to @${u.user.username} as “${title}”.${await removeStale()}`
      const message = JSON.stringify(r.json?.message ?? r.json?.error ?? '')
      if (r.status === 400 && /taken/i.test(message))
        throw new ConflictError(
          'GitLab says this key is already in use on another account. Remove it there (or rotate this employee’s key), then add it again.',
        )
      if (r.status === 401 || r.status === 403)
        throw new DeniedError(`GitLab refused to add the key (HTTP ${r.status}): the token needs the api scope.`)
      throw new UnavailableError(redact(ctx, `GitLab couldn’t add the key (HTTP ${r.status}${message ? `: ${message}` : ''}).`))
    },

    /** `{ projects: [GitLab project ids] }`: each becomes a harness project with the employee as a member (idempotent). */
    async 'add-projects'(ctx, input) {
      const token = ctx.values.GITLAB_TOKEN
      if (!token) throw new ValidationError('Paste the account’s token first.')
      const ids = input.projects
      if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'number' && typeof x !== 'string'))
        throw new ValidationError('Pick the GitLab projects to add.')
      const fetchProject = async (projectId: number | string) => {
        const r = await api(ctx, token, `/projects/${encodeURIComponent(String(projectId))}`)
        if (r.status === 404 || r.status === 403) return null
        if (!r.ok) throw new UnavailableError(`GitLab answered GET /projects/${projectId} with HTTP ${r.status}`)
        return r.json as GitlabProject
      }
      return addGitlabProjects(ctx, fetchProject, ids as (number | string)[])
    },

    async 'register-webhooks'(ctx) {
      const p = ctx.deps.provisioning()
      if (!p) throw new ValidationError('The GitLab integration is disabled.')
      if (!p.enabled) throw new ValidationError(`Webhooks can’t be registered: ${p.reason ?? 'provisioning is off'}.`)
      const r = await p.run(ctx.employee.id)
      const failed = r.hooks.filter((h) => h.data.status === 'error')
      if (r.outcome === 'not_set_up')
        return `Nothing to register: ${r.reason ?? 'the employee has no GitLab token or repositories'}.`
      if (r.outcome === 'failed' || failed.length)
        return `Registered ${r.hooks.length - failed.length} of ${r.hooks.length} webhooks${r.reason ? `: ${r.reason}` : ''}.`
      return `Webhooks are in place on ${r.hooks.length} project${r.hooks.length === 1 ? '' : 's'}.`
    },

    async 'add-trigger'(ctx) {
      const token = ctx.values.GITLAB_TOKEN
      if (!token)
        throw new ValidationError('Paste the account’s token first: the trigger matches issues assigned to its username.')
      const u = await currentUser(ctx, token)
      if ('status' in u) throw new ValidationError(`GitLab rejected the token (HTTP ${u.status}).`)
      return addTrigger(ctx, 'gitlab', {
        name: `GitLab: issues assigned to @${u.user.username}`,
        match: {
          source: 'integration:gitlab',
          type: 'issue.*',
          filter: { 'payload.assignees': u.user.username, 'payload.state': 'opened' },
        },
        target: { type: 'router' },
        fork: false,
        mode: 'ephemeral',
      })
    },
  },

  available(steps, ctx) {
    const out: string[] = []
    const status = (id: string) => steps.find((s) => s.id === id)?.status
    const tokenOk = status('token') === 'done' || status('token') === 'warning'
    if (tokenOk && status('ssh-key') !== 'done') out.push('add-ssh-key')
    const projects = steps.find((x) => x.id === 'projects')?.data?.projects
    if (ctx.values.GITLAB_TOKEN && Array.isArray(projects) && projects.length) out.push('add-projects')
    if (ctx.deps.provisioning()?.enabled && ctx.values.GITLAB_TOKEN) out.push('register-webhooks')
    if (status('routing') !== 'done' && ctx.values.GITLAB_TOKEN) out.push('add-trigger')
    return out
  },
}
