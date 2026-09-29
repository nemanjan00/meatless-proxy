import type { ApiRecord, EmployeeData, Json } from './resources.ts'

// ─── Employees: creating one, its SSH key, guided integration setup ─────────
//
// Served by packages/server/src/setup. Reads are for everyone signed in (members see the
// status read-only); every write is for admins.

/** `POST /api/employees` body: a new employee, provisioned like the first one. */
export interface CreateEmployeeBody {
  name: string
  /** The `@handle` (a slug). Default: derived from the name. */
  handle?: string
  /** Job title on its contact, e.g. "Billing engineer". */
  role?: string
  /** One paragraph about what it does (its contact's bio). */
  description?: string
  personality?: string
  /** Standing instructions for every session. */
  instructions?: string
  /** Model name. Default: the deployment's `MODEL`. */
  model?: string
  /** Project ids it works on (linked from its contact as `member`). */
  projects?: string[]
  /** Harness chat channel ids it joins (it always joins #general). */
  channels?: string[]
}

/** `POST /api/employees` → the employee, with what provisioning gave it. */
export interface CreatedEmployee {
  employee: ApiRecord<EmployeeData>
  routerSessionId: string
  /** Channel name → id: #general and its own requests channel. */
  channels: Record<string, string>
  /** The trigger routing new messages in its requests channel to its router. */
  triggerId: string
}

/** `GET /api/employees/:id/ssh-key`. All null before a key exists. */
export interface SshKeyInfo {
  /** `ssh-ed25519 AAAA… comment`. */
  publicKey: string | null
  /** `SHA256:…`, as `ssh-keygen -lf` and git hosts show it. */
  fingerprint: string | null
  createdAt: string | null
}

/** `POST /api/employees/:id/ssh-key` → the new public key (the old one stops working). */
export interface RotatedSshKey {
  employeeId: string
  publicKey: string
}

/** A setup step's state, from a real check by the server (never self-reported). */
export type SetupStepStatus = 'done' | 'todo' | 'warning' | 'error'

/** One step of an integration's guided setup. */
export interface SetupStep {
  /** Stable per integration, e.g. `tokens`, `ssh-key`. */
  id: string
  title: string
  status: SetupStepStatus
  /** What the check found, in one or two sentences. */
  detail?: string
  /** Values the step shows or copies (URLs, lists), never secrets. */
  data?: Record<string, Json>
}

/** Overall: no token yet, something to fix or finish, or every step done. */
export type IntegrationState = 'not_set_up' | 'needs_attention' | 'connected'

/** A secret an integration takes on its setup form. */
export interface SetupSecretField {
  name: string
  label: string
  /** Whether the employee has its own value (values are never returned). */
  set: boolean
  /** Set deployment-wide only, and used as the fallback. */
  global: boolean
  placeholder?: string
}

export interface IntegrationSetupStatus {
  /** `slack`, `gitlab`, `linear`. */
  name: string
  label: string
  /** False when the deployment disabled it (`INTEGRATIONS`). */
  enabled: boolean
  state: IntegrationState
  steps: SetupStep[]
  secrets: SetupSecretField[]
  /** Actions `POST …/actions/:action` accepts right now, e.g. `add-ssh-key`. */
  actions: string[]
  checkedAt: string
}

/** `GET /api/employees/:id/integrations?refresh=1` (checks are cached per employee for about 30 s). */
export interface EmployeeIntegrations {
  employeeId: string
  /** `PUBLIC_URL`, or null (webhook URLs then use the address the page was opened on). */
  publicUrl: string | null
  integrations: IntegrationSetupStatus[]
  checkedAt: string
}

/** `POST /api/employees/:id/integrations/:name/secrets` and `…/actions/:action` → what happened, and the new status. */
export interface SetupResult {
  ok: boolean
  message: string
  integration: IntegrationSetupStatus
}

/** `GET /api/employees/:id/integrations/slack/manifest` → the employee's Slack app manifest. */
export interface SlackManifest {
  manifest: Json
  /** Opens Slack's "create app from manifest" with it filled in. */
  createUrl: string
  /** The Events API request URL in the manifest. */
  requestUrl: string
}

/** `GET /api/integrations/status` (admins): which integrations each employee has, and the GitLab hooks the harness registered. */
export interface IntegrationsOverview {
  enabled: string[]
  gitlabHooks: { enabled: boolean; reason?: string; provisioningToken: boolean; lastRunAt: string | null }
  employees: {
    id: string
    name: string
    integrations: Record<string, { token: boolean; webhookSecret: boolean }>
    gitlabHooks: {
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
    }[]
  }[]
}

/** The routes of this section (merged into `ROUTES`). */
export const SETUP_ROUTES = {
  createEmployee: ['POST', '/api/employees'],
  employeeSshKey: ['GET', '/api/employees/:id/ssh-key'],
  rotateSshKey: ['POST', '/api/employees/:id/ssh-key'],
  employeeIntegrations: ['GET', '/api/employees/:id/integrations'],
  setIntegrationSecrets: ['POST', '/api/employees/:id/integrations/:name/secrets'],
  integrationAction: ['POST', '/api/employees/:id/integrations/:name/actions/:action'],
  slackManifest: ['GET', '/api/employees/:id/integrations/slack/manifest'],
  integrationsStatus: ['GET', '/api/integrations/status'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface SetupApi {
  /**
   * `POST /api/employees` → the employee, provisioned: its router session, #general and its own
   * requests channel with a trigger, and an SSH key (admins). A handle that is taken is 409.
   */
  createEmployee(body: CreateEmployeeBody): Promise<CreatedEmployee>
  /** `GET /api/employees/:id/ssh-key` → the public key, its fingerprint and when it was made. */
  employeeSshKey(id: string): Promise<SshKeyInfo>
  /** `POST /api/employees/:id/ssh-key` → a new keypair (admins). The old key stops working. */
  rotateSshKey(id: string): Promise<RotatedSshKey>
  /** `GET /api/employees/:id/integrations?refresh=` → every integration's setup steps, checked live. */
  employeeIntegrations(id: string, opts?: { refresh?: boolean }): Promise<EmployeeIntegrations>
  /**
   * `POST /api/employees/:id/integrations/:name/secrets` body `{ values: { NAME: value } }` → stores them
   * scoped to the employee after validating them (admins). A rejected token is 422 and is not stored.
   */
  setIntegrationSecrets(id: string, name: string, values: Record<string, string>): Promise<SetupResult>
  /**
   * `POST /api/employees/:id/integrations/:name/actions/:action`, e.g. `add-ssh-key`, `add-trigger` (admins).
   * Some actions take input, e.g. `add-projects` takes `{ projects: [GitLab project ids] }`.
   */
  integrationAction(id: string, name: string, action: string, input?: Record<string, Json>): Promise<SetupResult>
  /** `GET /api/employees/:id/integrations/slack/manifest` (admins). */
  slackManifest(id: string): Promise<SlackManifest>
  /** `GET /api/integrations/status` (admins). */
  integrationsStatus(): Promise<IntegrationsOverview>
}

type Call = <T>(
  route: keyof typeof SETUP_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `SetupApi` half of `createApiClient`. */
export function setupMethods(call: Call): SetupApi {
  return {
    createEmployee: (body) => call('createEmployee', undefined, undefined, body),
    employeeSshKey: (id) => call('employeeSshKey', { id }),
    rotateSshKey: (id) => call('rotateSshKey', { id }, undefined, {}),
    employeeIntegrations: (id, o = {}) => call('employeeIntegrations', { id }, { refresh: o.refresh ? 1 : undefined }),
    setIntegrationSecrets: (id, name, values) => call('setIntegrationSecrets', { id, name }, undefined, { values }),
    integrationAction: (id, name, action, input) => call('integrationAction', { id, name, action }, undefined, input ?? {}),
    slackManifest: (id) => call('slackManifest', { id }),
    integrationsStatus: () => call('integrationsStatus'),
  }
}
