import { type Clock, errorMessage, type Logger, silentLogger, systemClock } from '@mp/core'
import type { ExternalUser, Integration, WebhookRequest, WebhookResult } from '@mp/mcp'
import { createLinearApi } from './api.ts'
import { createLinearClient, type LinearClientOptions } from './client.ts'
import { createLinearMcpServer } from './tools.ts'
import { bodyHash, type LinearWebhookPayload, MAX_SKEW_MS, mapWebhook, SYSTEM, verifySignature } from './webhook.ts'

export interface LinearIntegrationOptions {
  secrets: {
    /** A personal API key (sent as is) or `Bearer <OAuth access token>`. */
    apiKey: string
    /** The signing secret of the Linear webhook. Without it every webhook is rejected. */
    webhookSecret?: string
  }
  fetch?: typeof fetch
  /** The GraphQL endpoint. Default `https://api.linear.app/graphql`. */
  baseUrl?: string
  clock?: Clock
  logger?: Logger
  /** Retry tuning for the API client (tests use small values). */
  retry?: Pick<LinearClientOptions, 'maxRetries' | 'retryBaseMs' | 'retryMaxMs' | 'timeoutMs' | 'sleep'>
}

const json = (status: number, body: Record<string, unknown>): WebhookResult => ({
  status,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  events: [],
})

/**
 * The Linear integration: MCP tools over the GraphQL API, signed webhooks turned into
 * events (subjects `linear:<identifier>`), and user lookup for contact matching.
 */
export function createLinearIntegration(opts: LinearIntegrationOptions): Integration {
  const clock = opts.clock ?? systemClock
  const logger = (opts.logger ?? silentLogger).child({ integration: 'linear' })
  const client = createLinearClient({
    apiKey: opts.secrets.apiKey,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    clock,
    logger,
    ...opts.retry,
  })
  const api = createLinearApi(client)
  const users = new Map<string, { id: string; name: string; email?: string | null } | null>()
  const lookupUser = async (id: string) => {
    if (!users.has(id)) {
      const u = await client.request('query User($id: String!) { user(id: $id) { id name email } }', { id }, { maxRetries: 0 })
      users.set(id, u.user ?? null)
      if (users.size > 1000) users.delete(users.keys().next().value!)
    }
    return users.get(id) ?? null
  }

  return {
    name: SYSTEM,

    createMcpServer: () => createLinearMcpServer(api, logger),

    async handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
      if (req.method.toUpperCase() !== 'POST') return json(405, { error: 'method not allowed' })
      const secret = opts.secrets.webhookSecret
      if (!secret) {
        logger.warn('linear webhook rejected: no webhook secret configured')
        return json(401, { error: 'webhook secret not configured' })
      }
      if (!verifySignature(req.body, req.headers['linear-signature'], secret)) {
        logger.warn('linear webhook rejected: bad signature', { delivery: req.headers['linear-delivery'] })
        return json(401, { error: 'invalid signature' })
      }
      let payload: LinearWebhookPayload
      try {
        payload = JSON.parse(req.body)
      } catch {
        return json(400, { error: 'invalid JSON' })
      }
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string')
        return json(400, { error: 'not a Linear webhook' })
      const ts = Number(payload.webhookTimestamp)
      if (!Number.isFinite(ts) || Math.abs(clock.now() - ts) > MAX_SKEW_MS) {
        logger.warn('linear webhook rejected: stale timestamp', { delivery: req.headers['linear-delivery'] })
        return json(401, { error: 'stale or missing webhookTimestamp' })
      }
      const delivery = req.headers['linear-delivery']?.trim() || `body:${bodyHash(req.body)}`
      try {
        const events = await mapWebhook(payload, delivery, {
          issue: (id) => api.identifierOf(id),
          user: lookupUser,
        })
        return { status: 200, body: 'ok', headers: { 'content-type': 'text/plain' }, events }
      } catch (e) {
        logger.error('linear webhook mapping failed', { error: errorMessage(e), type: payload.type })
        return json(500, { error: 'could not map the webhook' })
      }
    },

    async resolveUser(externalId: string): Promise<ExternalUser | null> {
      const u = await api.user(externalId)
      if (!u) return null
      return {
        handle: { system: SYSTEM, id: u.id },
        ...(u.email ? { email: u.email } : {}),
        ...(u.name || u.displayName ? { name: (u.name || u.displayName)! } : {}),
      }
    },
  }
}
