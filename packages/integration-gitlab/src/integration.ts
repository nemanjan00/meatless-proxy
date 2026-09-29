import { type Clock, isMpError, type Logger, silentLogger, ValidationError } from '@mp/core'
import type { ExternalUser, Integration } from '@mp/mcp'
import { createGitlabClient, DEFAULT_BASE_URL, type GitlabClient } from './client.ts'
import { createGitlabMcpServer, SERVER_NAME } from './tools.ts'
import { handleGitlabWebhook, SYSTEM } from './webhook.ts'

export interface GitlabIntegrationOptions {
  /** Plain values, resolved by the server from its secrets. */
  secrets: {
    /** A bot user's personal access token or a project/group access token (scope `api`). */
    token: string
    /** The webhook's secret token, compared with `X-Gitlab-Token`. */
    webhookSecret: string
  }
  /** Default `https://gitlab.com`; self-hosted instances work the same (the API is at `<baseUrl>/api/v4`). */
  baseUrl?: string
  fetch?: typeof fetch
  clock?: Clock
  logger?: Logger
  /** Client tuning, mostly for tests. */
  retry?: { maxRetries?: number; retryBaseMs?: number; retryMaxMs?: number; timeoutMs?: number }
}

export interface GitlabIntegration extends Integration {
  /** The REST client the tools use (it refuses anything that merges). */
  readonly client: GitlabClient
}

/** The GitLab integration: MCP tools (never merging), webhooks in, and identity lookup. */
export function createGitlabIntegration(opts: GitlabIntegrationOptions): GitlabIntegration {
  if (!opts.secrets?.token) throw new ValidationError('the GitLab integration needs a token')
  if (!opts.secrets.webhookSecret) throw new ValidationError('the GitLab integration needs a webhook secret')
  const logger = (opts.logger ?? silentLogger).child({ integration: SERVER_NAME })
  const client = createGitlabClient({
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
    token: opts.secrets.token,
    logger,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...opts.retry,
  })
  const webhookSecret = opts.secrets.webhookSecret

  return {
    name: SERVER_NAME,
    client,
    createMcpServer: () => createGitlabMcpServer(client),
    async handleWebhook(req) {
      const result = handleGitlabWebhook(req, webhookSecret)
      if (result.status === 401) logger.warn('gitlab webhook rejected: bad token')
      else if (result.status >= 400) logger.warn('gitlab webhook rejected', { status: result.status })
      else logger.debug('gitlab webhook', { events: result.events.map((e) => e.type) })
      return result
    },
    async resolveUser(externalId: string): Promise<ExternalUser | null> {
      const username = externalId.trim().replace(/^@/, '')
      if (!username) return null
      const found = await client.get('/users', { username })
      const summary = Array.isArray(found)
        ? found.find((u: any) => String(u.username).toLowerCase() === username.toLowerCase())
        : undefined
      if (!summary) return null
      let full: any = summary
      try {
        full = await client.get(`/users/${summary.id}`)
      } catch (e) {
        if (!isMpError(e, 'integration_request')) throw e
      }
      return {
        handle: { system: SYSTEM, id: String(summary.username) },
        ...(full.public_email ? { email: String(full.public_email) } : {}),
        ...(full.name ? { name: String(full.name) } : {}),
      }
    },
  }
}
