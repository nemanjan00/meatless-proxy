import { Hono } from 'hono'
import type { Services } from '../services.ts'
import { GITLAB_HOOK_KIND, type GitlabHookData, HOOKS_TOKEN_SECRET, type HookProvisioning } from './provisioning.ts'

/** Whether one integration is set up for an employee (its own secret, or the deployment-wide fallback). */
export interface IntegrationSetup {
  /** The token resolves, so its tools work. */
  token: boolean
  /** The webhook secret for `/webhooks/<integration>/<employee>` resolves. */
  webhookSecret: boolean
}

export interface GitlabHookStatus {
  gitlabProject: string
  repository?: string
  projectIds: string[]
  url?: string
  hookId?: number
  status: 'ok' | 'error'
  error?: string
  lastAction?: string
  lastAttemptAt: string
  lastOkAt?: string
}

/** `GET /api/integrations/status` (admins). */
export interface IntegrationsStatus {
  enabled: string[]
  gitlabHooks: {
    enabled: boolean
    /** Why provisioning is off. */
    reason?: string
    /** Whether `GITLAB_HOOKS_TOKEN` (the provisioning token) is set deployment-wide. */
    provisioningToken: boolean
    lastRunAt: string | null
  }
  employees: {
    id: string
    name: string
    integrations: Record<string, IntegrationSetup>
    gitlabHooks: GitlabHookStatus[]
  }[]
}

/** Builds the status from secret metadata (values are never read) and the `gitlab_hook` records. */
export async function integrationsStatus(s: Services, provisioning: HookProvisioning | null): Promise<IntegrationsStatus> {
  const specs = Object.values(s.integrations?.specs ?? {})
  const metas = await s.secrets.list()
  const has = (name: string, employeeId: string) =>
    metas.some(
      (m) => m.name === name && (m.scope.type === 'global' || (m.scope.type === 'employee' && m.scope.id === employeeId)),
    )
  const hooks = (await s.records.query<GitlabHookData>(GITLAB_HOOK_KIND, {})).items
  const employees = (await s.directory.employees.list()).items.map((e) => ({
    id: e.id,
    name: e.data.name,
    integrations: Object.fromEntries(
      specs.map((spec) => [spec.name, { token: has(spec.tokenSecret, e.id), webhookSecret: has(spec.webhookSecret, e.id) }]),
    ),
    gitlabHooks: hooks
      .filter((h) => h.data.employeeId === e.id)
      .sort((a, b) => a.data.gitlabProject.localeCompare(b.data.gitlabProject))
      .map((h) => ({
        gitlabProject: h.data.gitlabProject,
        projectIds: h.data.projectIds ?? [],
        status: h.data.status,
        lastAttemptAt: h.data.lastAttemptAt,
        ...(h.data.repository ? { repository: h.data.repository } : {}),
        ...(h.data.url ? { url: h.data.url } : {}),
        ...(h.data.hookId !== undefined ? { hookId: h.data.hookId } : {}),
        ...(h.data.error ? { error: h.data.error } : {}),
        ...(h.data.lastAction ? { lastAction: h.data.lastAction } : {}),
        ...(h.data.lastOkAt ? { lastOkAt: h.data.lastOkAt } : {}),
      })),
  }))
  return {
    enabled: specs.map((x) => x.name),
    gitlabHooks: {
      enabled: !!provisioning?.enabled,
      ...(provisioning
        ? provisioning.reason
          ? { reason: provisioning.reason }
          : {}
        : { reason: 'the GitLab integration is disabled (INTEGRATIONS)' }),
      provisioningToken: metas.some((m) => m.name === HOOKS_TOKEN_SECRET && m.scope.type === 'global'),
      lastRunAt: provisioning?.lastRunAt() ?? null,
    },
    employees,
  }
}

/** `GET /api/integrations/status`: admins only (see `GUARD_RULES`). */
export function integrationStatusRoutes(s: Services, provisioning: () => HookProvisioning | null): Hono {
  const app = new Hono()
  app.get('/api/integrations/status', async (c) => c.json(await integrationsStatus(s, provisioning())))
  return app
}
