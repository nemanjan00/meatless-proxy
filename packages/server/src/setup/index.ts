import type * as Api from '@mp/api'
import { errorMessage, NotFoundError } from '@mp/core'
import type { Employee } from '@mp/directory'
import type { Actor } from '@mp/store'
import { type Context, Hono } from 'hono'
import { principalOf } from '../auth/guard.ts'
import { actorOf } from '../http/views.ts'
import { BadRequestError, boolParam, intParam, jsonBody, requireString } from '../http/util.ts'
import type { HookProvisioning, IntegrationsOptions } from '../integrations/index.ts'
import { createEmployee } from '../provision.ts'
import type { Services } from '../services.ts'
import { sshFingerprint } from '../ssh.ts'
import { createWebhookActivity, type WebhookActivity } from './activity.ts'
import { type IntegrationSetupModule, SETUP_HTTP_TIMEOUT_MS, type SetupContext, type SetupDeps, stateOf, step } from './common.ts'
import { gitlabSetup } from './gitlab.ts'
import {
  GITLAB_PAGE_DEFAULT,
  GITLAB_PAGE_MAX,
  type GitlabListQuery,
  gitlabBranchProtection,
  listGitlabProjects,
} from './gitlab-listing.ts'
import { linearSetup } from './linear.ts'
import { manifestFor, slackSetup } from './slack.ts'

export { createWebhookActivity, type WebhookActivity } from './activity.ts'
export { slackManifest } from './slack.ts'

/** How long an employee's checks are reused before the external APIs are asked again. */
export const SETUP_CACHE_MS = 30_000

/** The guided setups, in the order the page shows them. */
export const SETUP_MODULES: IntegrationSetupModule[] = [slackSetup, gitlabSetup, linearSetup]

export interface SetupOptions {
  /** The integrations' options: their `fetch` and base URLs are used for the checks too. */
  integrations?: IntegrationsOptions
  /** GitLab webhook provisioning, once the app has built it. */
  provisioning?: () => HookProvisioning | null
  /** Default 30 s. */
  cacheMs?: number
  timeoutMs?: number
}

export interface Setup {
  activity: WebhookActivity
  /** Every integration's steps for an employee, cached for `cacheMs` unless `refresh`. */
  status(employeeId: string, o: { origin: string; refresh?: boolean; actor: Actor }): Promise<Api.EmployeeIntegrations>
  /** Validates and stores an integration's secrets, scoped to the employee. */
  setSecrets(
    employeeId: string,
    name: string,
    values: Record<string, string>,
    o: { origin: string; actor: Actor },
  ): Promise<Api.SetupResult>
  /** Runs an action; `o.input` is its input, e.g. `{ projects: [ids] }` for GitLab's `add-projects`. */
  action(
    employeeId: string,
    name: string,
    action: string,
    o: { origin: string; actor: Actor; input?: Record<string, unknown> },
  ): Promise<Api.SetupResult>
  slackManifest(employeeId: string, o: { origin: string; actor: Actor }): Promise<Api.SlackManifest>
  /** One page of the GitLab projects the employee's account reaches, searched by GitLab (not cached). */
  gitlabProjects(employeeId: string, q: GitlabListQuery, o: { origin: string; actor: Actor }): Promise<Api.GitlabProjectsPage>
  /** Whether one GitLab project's default branch is protected. */
  gitlabProjectProtection(
    employeeId: string,
    projectId: number,
    o: { origin: string; actor: Actor },
  ): Promise<Api.GitlabBranchProtection>
  /** Drops cached checks (one employee, or all). */
  invalidate(employeeId?: string): void
  close(): void
}

/** The guided integration setup of the employee page (docs/spec.md#integrations). */
export function createSetup(s: Services, opts: SetupOptions = {}): Setup {
  const activity = createWebhookActivity(s)
  const deps: SetupDeps = {
    fetch: opts.integrations?.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)),
    baseUrls: {
      ...(s.config.GITLAB_BASE_URL ? { gitlab: s.config.GITLAB_BASE_URL } : {}),
      ...(opts.integrations?.baseUrls ?? {}),
    },
    provisioning: opts.provisioning ?? (() => null),
    activity,
    timeoutMs: opts.timeoutMs ?? SETUP_HTTP_TIMEOUT_MS,
  }
  const cacheMs = opts.cacheMs ?? SETUP_CACHE_MS
  const cache = new Map<string, { at: number; value: Promise<Api.EmployeeIntegrations> }>()
  // A secret set anywhere (Settings → Secrets too) makes the checks stale.
  const off = s.bus.subscribe<{ kind: string }>('record.changed', (m) => {
    if (m.payload.kind === 'secret' || m.payload.kind === 'trigger') cache.clear()
  })

  const moduleOf = (name: string) => {
    const m = SETUP_MODULES.find((x) => x.name === name)
    if (!m) throw new NotFoundError('integration', name)
    return m
  }

  const contextFor = async (
    employee: Employee,
    m: IntegrationSetupModule,
    origin: string,
    actor: Actor,
  ): Promise<SetupContext> => {
    const names = m.secrets.map((x) => x.name)
    return {
      s,
      deps,
      employee,
      handle: employee.key ?? employee.id.toLowerCase(),
      publicUrl: (s.config.PUBLIC_URL ?? origin).replace(/\/+$/, ''),
      publicUrlConfigured: !!s.config.PUBLIC_URL,
      metas: await s.secrets.list(),
      values: await s.secrets.resolve(names, { employeeId: employee.id }),
      actor,
    }
  }

  const enabled = (m: IntegrationSetupModule) => !!s.integrations?.specs[m.name]

  const checkOne = async (
    employee: Employee,
    m: IntegrationSetupModule,
    origin: string,
    actor: Actor,
  ): Promise<Api.IntegrationSetupStatus> => {
    const at = s.clock.iso()
    const ctx = await contextFor(employee, m, origin, actor)
    const secrets = m.secrets.map((f) => {
      const own = ctx.metas.some((x) => x.name === f.name && x.scope.type === 'employee' && x.scope.id === employee.id)
      const global = ctx.metas.some((x) => x.name === f.name && x.scope.type === 'global')
      return { name: f.name, label: f.label, set: own, global, ...(f.placeholder ? { placeholder: f.placeholder } : {}) }
    })
    if (!enabled(m))
      return {
        name: m.name,
        label: m.label,
        enabled: false,
        state: 'not_set_up',
        steps: [step('enabled', `${m.label} is disabled`, 'error', `The server's INTEGRATIONS setting leaves ${m.label} out.`)],
        secrets,
        actions: [],
        checkedAt: at,
      }
    let steps: Api.SetupStep[]
    try {
      steps = await m.check(ctx)
    } catch (err) {
      s.logger.warn('integration check failed', { integration: m.name, employeeId: employee.id, err: errorMessage(err) })
      steps = [step('check', 'Check', 'error', `The check failed: ${errorMessage(err)}`)]
    }
    return {
      name: m.name,
      label: m.label,
      enabled: true,
      state: stateOf(steps, !!ctx.values[m.tokenSecret]),
      steps,
      secrets,
      actions: m.available(steps, ctx),
      checkedAt: at,
    }
  }

  const statusOf = async (employeeId: string, origin: string, actor: Actor): Promise<Api.EmployeeIntegrations> => {
    const employee = await s.directory.employees.require(employeeId)
    const integrations = await Promise.all(SETUP_MODULES.map((m) => checkOne(employee, m, origin, actor)))
    return { employeeId, publicUrl: s.config.PUBLIC_URL ?? null, integrations, checkedAt: s.clock.iso() }
  }

  const fresh = async (employeeId: string, name: string, origin: string, actor: Actor) => {
    cache.delete(employeeId)
    return checkOne(await s.directory.employees.require(employeeId), moduleOf(name), origin, actor)
  }

  return {
    activity,
    status(employeeId, o) {
      const hit = cache.get(employeeId)
      if (hit && !o.refresh && s.clock.now() - hit.at < cacheMs) return hit.value
      // Concurrent callers share one check; a failed one isn't kept.
      const value = statusOf(employeeId, o.origin, o.actor)
      const entry = { at: s.clock.now(), value }
      cache.set(employeeId, entry)
      value.catch(() => {
        if (cache.get(employeeId) === entry) cache.delete(employeeId)
      })
      return value
    },

    async setSecrets(employeeId, name, values, o) {
      const m = moduleOf(name)
      const employee = await s.directory.employees.require(employeeId)
      const allowed = new Set(m.secrets.map((x) => x.name))
      const given: Record<string, string> = {}
      for (const [k, v] of Object.entries(values)) {
        if (!allowed.has(k)) throw new BadRequestError(`${m.label} takes ${[...allowed].join(', ')}, not ${k}`)
        if (typeof v !== 'string') throw new BadRequestError(`${k} must be a string`)
        if (v.trim()) given[k] = v.trim()
      }
      if (!Object.keys(given).length) throw new BadRequestError('paste at least one value')
      const ctx = await contextFor(employee, m, o.origin, o.actor)
      ctx.values = { ...ctx.values, ...given }
      const validated = await m.validate(ctx, given)
      for (const [k, v] of Object.entries(given)) await s.secrets.set(k, v, { type: 'employee', id: employeeId }, o.actor.id)
      s.logger.info('integration secrets set', { integration: name, employeeId, names: Object.keys(given) })
      const note = await validated.after?.().catch((err) => `(${errorMessage(err)})`)
      return {
        ok: true,
        message: [validated.message, note].filter(Boolean).join(' '),
        integration: await fresh(employeeId, name, o.origin, o.actor),
      }
    },

    async action(employeeId, name, action, o) {
      const m = moduleOf(name)
      const run = m.actions[action]
      if (!run) throw new NotFoundError(`${m.label} action`, action)
      const employee = await s.directory.employees.require(employeeId)
      const message = await run(await contextFor(employee, m, o.origin, o.actor), o.input ?? {})
      s.logger.info('integration setup action', { integration: name, action, employeeId })
      return { ok: true, message, integration: await fresh(employeeId, name, o.origin, o.actor) }
    },

    async slackManifest(employeeId, o) {
      const employee = await s.directory.employees.require(employeeId)
      return manifestFor(await contextFor(employee, slackSetup, o.origin, o.actor))
    },

    async gitlabProjects(employeeId, q, o) {
      if (!enabled(gitlabSetup)) throw new NotFoundError('integration', 'gitlab')
      const employee = await s.directory.employees.require(employeeId)
      return listGitlabProjects(await contextFor(employee, gitlabSetup, o.origin, o.actor), q)
    },

    async gitlabProjectProtection(employeeId, projectId, o) {
      if (!enabled(gitlabSetup)) throw new NotFoundError('integration', 'gitlab')
      const employee = await s.directory.employees.require(employeeId)
      return gitlabBranchProtection(await contextFor(employee, gitlabSetup, o.origin, o.actor), projectId)
    },

    invalidate(employeeId) {
      if (employeeId) cache.delete(employeeId)
      else cache.clear()
    },
    close() {
      off()
    },
  }
}

/** The origin a request came in on, for webhook URLs when `PUBLIC_URL` isn't set. */
function originOf(c: Context, s: Services): string {
  const url = new URL(c.req.url)
  const host = (s.config.TRUST_PROXY && c.req.header('x-forwarded-host')) || c.req.header('host') || url.host
  const proto = (s.config.TRUST_PROXY && c.req.header('x-forwarded-proto')) || url.protocol.replace(':', '')
  return `${proto}://${host}`
}

/**
 * The employee page's API (packages/api/src/setup.ts): creating employees, their SSH key, and
 * the guided integration setup. Also records webhook activity, so mount it before the webhook
 * routes. Reads need a signed-in viewer, writes an admin (see `GUARD_RULES`).
 */
export function setupRoutes(s: Services, setup: Setup): Hono {
  const app = new Hono()
  const actor = (c: Context): Actor => actorOf(principalOf(c).contactId)
  const ctxOf = (c: Context) => ({ origin: originOf(c, s), actor: actor(c) })

  app.use('/webhooks/*', setup.activity.middleware)

  app.post('/api/employees', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    const str = (k: string) => {
      const v = body[k]
      if (v === undefined || v === null) return undefined
      if (typeof v !== 'string') throw new BadRequestError(`${k} must be a string`)
      return v
    }
    const ids = (k: string) => {
      const v = body[k]
      if (v === undefined || v === null) return undefined
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new BadRequestError(`${k} must be a list of ids`)
      return v as string[]
    }
    const input = {
      name: requireString(body.name, 'name'),
      ...Object.fromEntries(
        ['handle', 'role', 'description', 'personality', 'instructions', 'model']
          .map((k) => [k, str(k)] as const)
          .filter(([, v]) => v !== undefined),
      ),
      ...(ids('projects') ? { projects: ids('projects')! } : {}),
      ...(ids('channels') ? { channels: ids('channels')! } : {}),
    }
    for (const p of input.projects ?? []) await s.records.require('project', p)
    const r = await createEmployee(s, input, actor(c))
    return c.json(
      {
        employee: r.employee as unknown as Api.CreatedEmployee['employee'],
        routerSessionId: r.routerSessionId,
        channels: r.channels,
        triggerId: r.triggerId,
      } satisfies Api.CreatedEmployee,
      201,
    )
  })

  app.get('/api/employees/:id/ssh-key', async (c) => {
    const e = await s.directory.employees.require(c.req.param('id'))
    const publicKey = typeof e.data.sshPublicKey === 'string' ? e.data.sshPublicKey : null
    return c.json({
      publicKey,
      fingerprint: publicKey ? sshFingerprint(publicKey) : null,
      createdAt: typeof e.data.sshKeyCreatedAt === 'string' ? e.data.sshKeyCreatedAt : null,
    } satisfies Api.SshKeyInfo)
  })

  app.get('/api/employees/:id/integrations', async (c) =>
    c.json(await setup.status(c.req.param('id'), { ...ctxOf(c), refresh: boolParam(c.req.query('refresh')) })),
  )

  app.get('/api/employees/:id/integrations/slack/manifest', async (c) =>
    c.json(await setup.slackManifest(c.req.param('id'), ctxOf(c))),
  )

  // Admins only: the rows name every project the account reaches (the `/api/employees/*` guard rule).
  app.get('/api/employees/:id/integrations/gitlab/projects', async (c) =>
    c.json(
      await setup.gitlabProjects(
        c.req.param('id'),
        {
          search: c.req.query('search') ?? '',
          page: intParam(c.req.query('page'), 'page', 1, 100_000, 1),
          perPage: intParam(c.req.query('perPage'), 'perPage', GITLAB_PAGE_DEFAULT, GITLAB_PAGE_MAX, 1),
        },
        ctxOf(c),
      ),
    ),
  )

  app.get('/api/employees/:id/integrations/gitlab/projects/:projectId/protection', async (c) =>
    c.json(
      await setup.gitlabProjectProtection(
        c.req.param('id'),
        intParam(c.req.param('projectId'), 'projectId', 0, Number.MAX_SAFE_INTEGER, 1),
        ctxOf(c),
      ),
    ),
  )

  app.post('/api/employees/:id/integrations/:name/secrets', async (c) => {
    const body = await jsonBody<{ values?: unknown }>(c)
    if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values))
      throw new BadRequestError('values must be an object of secret names to values')
    return c.json(await setup.setSecrets(c.req.param('id'), c.req.param('name'), body.values as Record<string, string>, ctxOf(c)))
  })

  app.post('/api/employees/:id/integrations/:name/actions/:action', async (c) => {
    const text = await c.req.text()
    let input: unknown = {}
    try {
      input = text.trim() ? JSON.parse(text) : {}
    } catch {
      throw new BadRequestError('the body must be JSON')
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestError('the body must be a JSON object')
    return c.json(
      await setup.action(c.req.param('id'), c.req.param('name'), c.req.param('action'), {
        ...ctxOf(c),
        input: input as Record<string, unknown>,
      }),
    )
  })

  return app
}
