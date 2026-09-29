import { type Clock, errorMessage, type EventBus, type Hooks, type Logger, sleep } from '@mp/core'
import type { Directory } from '@mp/directory'
import type { Events, IngestInput } from '@mp/events'
import type { IntegrationEvent, WebhookRequest } from '@mp/mcp'
import type { SecretStore } from '@mp/secrets'
import type { Sessions } from '@mp/sessions'
import type { ToolRegistry } from '@mp/tools'
import { createActorResolver } from './identity.ts'
import { createInstance, InstanceCache, type IntegrationInstance } from './instances.ts'
import { registerIntegrationPolicies } from './policies.ts'
import { INTEGRATION_SPECS, type IntegrationSpec } from './specs.ts'

export { closingReason, mergeRequestSubject, needsExternalReply } from './policies.ts'
export { INTEGRATION_SPECS, type IntegrationSpec } from './specs.ts'
export type { IntegrationInstance } from './instances.ts'

/** How long a webhook response waits for its events to be ingested before answering anyway. */
export const WEBHOOK_BUDGET_MS: Record<string, number> = { slack: 2000 }
const DEFAULT_WEBHOOK_BUDGET_MS = 5000
/** Attempts per event ingest (the ingest is idempotent by dedupe key). */
const INGEST_ATTEMPTS = 4

/** Options for the integrations, mostly for tests. */
export interface IntegrationsOptions {
  /** Integrations to enable. Default: all first-party ones (`slack`, `linear`, `gitlab`). */
  enabled?: string[]
  /** Replaces `fetch` for every integration API call. */
  fetch?: typeof fetch
  /** API base URL per integration (tests, self-hosted GitLab). */
  baseUrls?: Record<string, string>
  /** How long resolved secrets are reused. Default 60 s; a change to a `secret` record drops them at once. */
  secretsTtlMs?: number
}

export interface IntegrationsDeps {
  tools: ToolRegistry
  hooks: Hooks
  bus: EventBus
  secrets: SecretStore
  /** Ingesting enqueues the event for routing. */
  events: Events
  sessions: Sessions
  directory: Directory
  clock: Clock
  logger: Logger
}

/** What a webhook request gets back. */
export interface WebhookResponse {
  status: number
  body: string
  headers: Record<string, string>
}

export interface Integrations {
  /** The enabled integration specs, by name. */
  readonly specs: Record<string, IntegrationSpec>
  /** Registered tool names (`mcp.<integration>.<tool>`). */
  readonly toolNames: string[]
  /** The instance an employee's calls go through (the deployment-wide one without an employee). */
  instanceFor(name: string, employeeId?: string): Promise<IntegrationInstance>
  /**
   * Handles one webhook: `employeeRef` (an employee id or handle) selects that
   * employee's secrets, and its events carry the employee id. Events are
   * ingested with their actor mapped to a contact.
   */
  handleWebhook(name: string, employeeRef: string | undefined, req: WebhookRequest): Promise<WebhookResponse>
  /** Resolves when every webhook ingest in progress has finished (tests, shutdown). */
  idle(): Promise<void>
  close(): Promise<void>
}

const jsonResponse = (status: number, value: unknown): WebhookResponse => ({
  status,
  body: JSON.stringify(value),
  headers: { 'content-type': 'application/json' },
})

/**
 * The first-party integrations (Slack, Linear, GitLab), per employee
 * (docs/spec.md#integrations):
 *
 * - **Instances** per employee and secret version, from the employee's
 *   secrets with the deployment-wide ones as fallback (`InstanceCache`).
 * - **Tools** `mcp.<integration>.<tool>`, registered once. Each call goes to
 *   the calling employee's instance, over its own in-process MCP client.
 * - **Webhooks** in, verified by the integration, turned into events with the
 *   actor mapped to a contact.
 * - **Policies**: subscription hygiene, Slack replies going back out, and MR
 *   subscriptions after `create_merge_request`.
 */
export async function createIntegrations(deps: IntegrationsDeps, opts: IntegrationsOptions = {}): Promise<Integrations> {
  const logger = deps.logger.child({ component: 'integrations' })
  const enabled = opts.enabled ?? Object.keys(INTEGRATION_SPECS)
  const specs: Record<string, IntegrationSpec> = {}
  for (const name of enabled) {
    const spec = INTEGRATION_SPECS[name]
    if (spec) specs[name] = spec
    else logger.warn('unknown integration, ignored', { integration: name })
  }
  const factoryDeps = (spec: IntegrationSpec) => ({
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.baseUrls?.[spec.name] ? { baseUrl: opts.baseUrls[spec.name] } : {}),
  })
  const cache = new InstanceCache({
    secrets: deps.secrets,
    clock: deps.clock,
    logger,
    factoryDeps,
    ...(opts.secretsTtlMs !== undefined ? { secretsTtlMs: opts.secretsTtlMs } : {}),
  })
  const offSecrets = deps.bus.subscribe<{ kind: string }>('record.changed', (m) => {
    if (m.payload.kind === 'secret') cache.invalidate()
  })
  const actors = createActorResolver({ directory: deps.directory, clock: deps.clock, logger })
  const instanceFor = (spec: IntegrationSpec, employeeId: string | undefined) => cache.get(spec, employeeId)

  // ── Tools: definitions from an instance with placeholder secrets, calls to the caller's instance ──
  const toolNames: string[] = []
  for (const spec of Object.values(specs)) {
    const definitions = createInstance(spec, undefined, {}, { clock: deps.clock, logger, ...factoryDeps(spec) })
    try {
      for (const t of await definitions.listTools()) {
        const name = `mcp.${spec.name}.${t.name}`
        deps.tools.register(
          {
            name,
            description: t.description,
            parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
            effect: spec.effects[t.name] ?? 'non_idempotent',
            source: 'mcp',
            server: spec.name,
            // Declared so the runner redacts the values from outputs and records their use.
            secrets: [spec.tokenSecret],
          },
          async (args, ctx) => {
            const instance = await instanceFor(spec, ctx.employeeId)
            if (!instance.hasToken)
              return {
                output: { error: `${spec.label} isn't set up for this employee: set the ${spec.tokenSecret} secret` },
                isError: true,
              }
            const r = await instance.callTool(t.name, (args ?? {}) as Record<string, unknown>, ctx.signal)
            return r.isError ? { output: r.output, isError: true } : { output: r.output }
          },
          { replace: true },
        )
        toolNames.push(name)
      }
    } finally {
      await definitions.close()
    }
  }
  toolNames.sort()

  const offPolicies = registerIntegrationPolicies({
    hooks: deps.hooks,
    bus: deps.bus,
    events: deps.events,
    sessions: deps.sessions,
    logger,
    specs,
    instanceFor: (spec, employeeId) => instanceFor(spec, employeeId),
  })

  // ── Webhooks ──────────────────────────────────────────────────────────────
  const pending = new Set<Promise<void>>()

  const resolveEmployee = async (ref: string) =>
    (await deps.directory.employees.get(ref)) ?? (await deps.directory.employees.byHandle(ref))

  const ingestOne = async (instance: IntegrationInstance, e: IntegrationEvent, employeeId: string | undefined) => {
    const input: IngestInput = {
      source: e.source,
      type: e.type,
      dedupeKey: e.dedupeKey,
      ...(e.subject ? { subject: e.subject } : {}),
      ...(e.text ? { text: e.text } : {}),
      payload: e.payload,
      ...(employeeId ? { employeeId } : {}),
    }
    const contactId = await actors.contactFor(instance.integration, e.actor)
    if (contactId) input.actorContactId = contactId
    for (let attempt = 1; ; attempt++) {
      try {
        const { event, created } = await deps.events.ingest(input)
        logger.debug('webhook event ingested', { integration: instance.spec.name, type: e.type, eventId: event.id, created })
        return
      } catch (err) {
        if (attempt >= INGEST_ATTEMPTS) throw err
        await sleep(100 * 2 ** attempt)
      }
    }
  }

  const handleWebhook: Integrations['handleWebhook'] = async (name, employeeRef, req) => {
    const spec = specs[name]
    if (!spec) return jsonResponse(404, { error: `no integration ${name}` })
    let employeeId: string | undefined
    if (employeeRef !== undefined) {
      const employee = await resolveEmployee(employeeRef)
      if (!employee) return jsonResponse(404, { error: `no employee ${employeeRef}` })
      employeeId = employee.id
    }
    const instance = await instanceFor(spec, employeeId)
    if (!instance.hasWebhookSecret)
      return jsonResponse(404, {
        error: `${spec.label} webhooks aren't set up ${employeeId ? 'for this employee' : 'for the deployment'}: set the ${spec.webhookSecret} secret`,
      })
    const result = await instance.integration.handleWebhook(req)
    const response: WebhookResponse = {
      status: result.status,
      body: result.body ?? '',
      headers: result.headers ?? {},
    }
    if (result.status >= 300 || !result.events.length) return response

    // Ingest after verifying. Answer once it's done, or when the budget runs out (Slack wants an
    // answer within 3 s), in which case the ingest finishes in the background.
    const work = (async () => {
      for (const e of result.events) await ingestOne(instance, e, employeeId)
    })()
    const tracked = work.catch((err) =>
      logger.error('webhook events could not be ingested', { integration: name, employeeId, err: errorMessage(err) }),
    )
    pending.add(tracked)
    void tracked.finally(() => pending.delete(tracked))
    const budget = WEBHOOK_BUDGET_MS[name] ?? DEFAULT_WEBHOOK_BUDGET_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      work.then(
        () => 'done' as const,
        () => 'failed' as const,
      ),
      new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), budget)
      }),
    ])
    clearTimeout(timer)
    // The sender retries a failed delivery, and the dedupe keys make that safe.
    if (outcome === 'failed') return jsonResponse(500, { error: 'the events could not be stored; retry' })
    if (outcome === 'late') logger.warn('webhook answered before its events were stored', { integration: name, budget })
    return response
  }

  return {
    specs,
    toolNames,
    instanceFor: (name, employeeId) => {
      const spec = specs[name]
      if (!spec) throw new Error(`no integration ${name}`)
      return instanceFor(spec, employeeId)
    },
    handleWebhook,
    async idle() {
      while (pending.size) await Promise.all([...pending])
    },
    async close() {
      offSecrets()
      offPolicies()
      await Promise.all([...pending])
      await cache.close()
    },
  }
}
