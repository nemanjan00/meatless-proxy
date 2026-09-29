import type { IntegrationSetupStatus, Json, SetupStep, SetupStepStatus } from '@mp/api'
import { errorMessage, UnavailableError } from '@mp/core'
import type { Employee } from '@mp/directory'
import type { CreateTriggerInput, Trigger } from '@mp/events'
import { createRedactor, type SecretMeta } from '@mp/secrets'
import type { Actor } from '@mp/store'
import type { HookProvisioning } from '../integrations/index.ts'
import type { Services } from '../services.ts'
import type { WebhookActivity } from './activity.ts'

/** How long one external API call may take during a check. */
export const SETUP_HTTP_TIMEOUT_MS = 10_000

/** What the setup modules get besides the services. */
export interface SetupDeps {
  /** Every external call goes through it (tests pass a fake). */
  fetch: typeof fetch
  /** API base URL per integration (tests, self-hosted GitLab). */
  baseUrls: Record<string, string>
  /** GitLab webhook provisioning (src/integrations/provisioning.ts), when GitLab is enabled. */
  provisioning: () => HookProvisioning | null
  /** Last signed webhook per employee and integration. */
  activity: WebhookActivity
  timeoutMs: number
}

/** One integration's check or write, for one employee. */
export interface SetupContext {
  s: Services
  deps: SetupDeps
  employee: Employee
  /** The employee's `@handle` (its record key). */
  handle: string
  /** `PUBLIC_URL`, else the origin the request came in on. */
  publicUrl: string
  /** Whether `PUBLIC_URL` is set. */
  publicUrlConfigured: boolean
  /** Secret metadata (never values). */
  metas: SecretMeta[]
  /** The integration's resolved secrets: the employee's own, else the global ones. Never returned. */
  values: Record<string, string>
  actor: Actor
}

/** A secret field on an integration's setup form. */
export interface SetupSecretDef {
  name: string
  label: string
  placeholder?: string
}

/** The result of validating secrets before they are stored. */
export interface Validated {
  /** Shown to the admin. */
  message: string
  /** Runs after the values are stored, e.g. recording the account's handle. */
  after?: () => Promise<string | undefined>
}

/** One integration's guided setup (packages/server/src/setup/<name>.ts). */
export interface IntegrationSetupModule {
  name: string
  label: string
  /** The secret holding the token: without it, the integration is "not set up". */
  tokenSecret: string
  secrets: SetupSecretDef[]
  /** Every step, checked live. Steps catch their own failures and report them as `error` or `warning`. */
  check(ctx: SetupContext): Promise<SetupStep[]>
  /**
   * Validates values before they are stored (`ctx.values` already holds them merged over the current ones).
   * Throws `ValidationError` for a value the system rejects, so it isn't stored.
   */
  validate(ctx: SetupContext, given: Record<string, string>): Promise<Validated>
  /** Actions by name. Each returns the message to show. `input` is the request body (`{}` when none). */
  actions: Record<string, (ctx: SetupContext, input: Record<string, unknown>) => Promise<string>>
  /** The actions that make sense given the steps. */
  available(steps: SetupStep[], ctx: SetupContext): string[]
}

export const step = (
  id: string,
  title: string,
  status: SetupStepStatus,
  detail?: string,
  data?: Record<string, Json>,
): SetupStep => ({
  id,
  title,
  status,
  ...(detail ? { detail } : {}),
  ...(data ? { data } : {}),
})

/** Overall state: no token → not set up; every step done (optional ones, `data.optional`, may be todo) → connected; else needs attention. */
export function stateOf(steps: SetupStep[], tokenSet: boolean): IntegrationSetupStatus['state'] {
  if (!tokenSet) return 'not_set_up'
  return steps.every((s) => s.status === 'done' || (s.status === 'todo' && s.data?.optional === true))
    ? 'connected'
    : 'needs_attention'
}

/** Whether the employee has its own value for a secret, or only a global one. */
export function secretState(metas: SecretMeta[], name: string, employeeId: string) {
  return {
    own: metas.some((m) => m.name === name && m.scope.type === 'employee' && m.scope.id === employeeId),
    global: metas.some((m) => m.name === name && m.scope.type === 'global'),
  }
}

/** "3 minutes ago", for step details. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return `${d} days ago`
}

export interface HttpResult {
  status: number
  ok: boolean
  /** The parsed JSON body, or undefined. */
  json: any
  headers: Headers
}

/**
 * One external API call with a timeout. Network failures and timeouts become `UnavailableError`
 * (the message never carries the request's headers, so no token leaks into it).
 */
export async function http(
  deps: SetupDeps,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<HttpResult> {
  let res: Response
  try {
    res = await deps.fetch(url, {
      method: init.method ?? 'GET',
      headers: { accept: 'application/json', ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? deps.timeoutMs),
    })
  } catch (err) {
    throw new UnavailableError(`couldn't reach ${new URL(url).host}: ${errorMessage(err)}`)
  }
  const text = await res.text().catch(() => '')
  let json: any
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { status: res.status, ok: res.ok, json, headers: res.headers }
}

/** Masks every secret value of the context in a message from an external system. */
export function redact(ctx: Pick<SetupContext, 'values'>, message: string): string {
  return createRedactor(Object.values(ctx.values))(message)
}

/** The webhook URL of an employee's own identity in an integration (it takes the employee id). */
export const webhookUrl = (ctx: Pick<SetupContext, 'publicUrl' | 'employee'>, integration: string) =>
  `${ctx.publicUrl.replace(/\/+$/, '')}/webhooks/${integration}/${ctx.employee.id}`

/** The employee's triggers on events from an integration. */
export async function integrationTriggers(ctx: SetupContext, integration: string): Promise<Trigger[]> {
  return (await ctx.s.events.triggers.list({ employeeId: ctx.employee.id })).filter(
    (t) => t.data.match?.source === `integration:${integration}`,
  )
}

/** The routing step: green when an enabled trigger takes this integration's events. */
export async function routingStep(
  ctx: SetupContext,
  integration: string,
  label: string,
  recommended: string,
): Promise<SetupStep> {
  const triggers = await integrationTriggers(ctx, integration)
  const on = triggers.filter((t) => t.data.enabled !== false)
  if (on.length)
    return step(
      'routing',
      'Route events to the employee',
      'done',
      `${on.map((t) => t.data.name).join(', ')} ${on.length === 1 ? 'routes' : 'route'} ${label} events to it.`,
      { triggers: on.map((t) => ({ id: t.id, name: t.data.name })) },
    )
  if (triggers.length)
    return step('routing', 'Route events to the employee', 'warning', `Its ${label} triggers are all disabled.`, {
      recommended,
    })
  return step('routing', 'Route events to the employee', 'todo', `No trigger takes ${label} events yet.`, {
    recommended,
  })
}

/** Adds a trigger unless one on the same source already exists (idempotent). */
export async function addTrigger(ctx: SetupContext, integration: string, input: Omit<CreateTriggerInput, 'employeeId'>) {
  const existing = await integrationTriggers(ctx, integration)
  if (existing.length) return `Already routed by ${existing.map((t) => t.data.name).join(', ')}.`
  const t = await ctx.s.events.triggers.create({ ...input, employeeId: ctx.employee.id }, ctx.actor)
  return `Added the trigger "${t.data.name}": ${integration} events now go to the router context.`
}

/** Adds `{system, id}` to the employee's contact handles. Returns a note when another contact has it. */
export async function addHandle(ctx: SetupContext, system: string, id: string): Promise<string | undefined> {
  const contact = await ctx.s.directory.contacts.require(ctx.employee.data.contactId)
  const handles = contact.data.handles ?? []
  if (handles.some((h) => h.system === system && h.id.toLowerCase() === id.toLowerCase())) return undefined
  try {
    await ctx.s.directory.contacts.update(
      contact.id,
      { handles: [...handles.filter((h) => h.system !== system), { system, id }] },
      {
        actor: ctx.actor,
      },
    )
    return `Added the handle ${system}:${id} to ${ctx.employee.data.name}.`
  } catch (err) {
    return `Couldn't add the handle ${system}:${id}: ${errorMessage(err)}`
  }
}
