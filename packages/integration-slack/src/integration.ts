import { type Clock, errorMessage, type Logger, silentLogger, systemClock } from '@mp/core'
import type { ExternalUser, Integration, IntegrationEvent, WebhookRequest, WebhookResult } from '@mp/mcp'
import { createSlackClient, type RetryOptions, slackErrorCode } from './client.ts'
import { mapSlackEvent, type SelfIdentity, type SlackEnvelope, SLACK_SYSTEM } from './events.ts'
import { verifySlackSignature } from './signature.ts'
import { createSlackMcpServer } from './tools.ts'

export interface SlackSecrets {
  /** Bot User OAuth Token (`xoxb-…`). */
  botToken: string
  /** The app's Signing Secret, for verifying Events API requests. */
  signingSecret: string
}

export interface SlackIntegrationOptions {
  secrets: SlackSecrets
  fetch?: typeof fetch
  /** Web API base. Default `https://slack.com/api`. */
  baseUrl?: string
  clock?: Clock
  logger?: Logger
  retry?: RetryOptions
  /** Waits between retries (tests). */
  sleep?: (ms: number) => Promise<void>
  /** How long a channel name stays cached. Default 1 hour. */
  channelNameTtlMs?: number
}

/** Most channel names cached at once. */
const CHANNEL_CACHE_MAX = 1000
/** How long a failed channel lookup is remembered, so a broken lookup doesn't slow every event. */
const CHANNEL_MISS_TTL_MS = 60_000

const json = (status: number, body: unknown, events: IntegrationEvent[] = []): WebhookResult => ({
  status,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  events,
})

/**
 * The Slack integration: tools over the Web API as the app's bot, Events API
 * webhooks turned into events, and user lookup for contact matching.
 */
export function createSlackIntegration(opts: SlackIntegrationOptions): Integration {
  const clock = opts.clock ?? systemClock
  const logger = (opts.logger ?? silentLogger).child({ integration: 'slack' })
  const client = createSlackClient({
    token: opts.secrets.botToken,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    clock,
    logger,
  })
  // Lookups on the webhook path don't wait out rate limits: Slack wants an answer within 3 seconds.
  const quick = createSlackClient({
    token: opts.secrets.botToken,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    retry: { attempts: 1 },
    clock,
    logger,
  })
  const ttl = opts.channelNameTtlMs ?? 60 * 60 * 1000

  const names = new Map<string, { name: string | undefined; until: number }>()
  const pending = new Map<string, Promise<string | undefined>>()
  const channelName = (id: string): Promise<string | undefined> => {
    const hit = names.get(id)
    if (hit && hit.until > clock.now()) return Promise.resolve(hit.name)
    const inflight = pending.get(id)
    if (inflight) return inflight
    const p = (async () => {
      try {
        const r = await quick.call('conversations.info', { channel: id }, {})
        const ch = (r.channel ?? {}) as { name?: string }
        const name = typeof ch.name === 'string' && ch.name ? ch.name : undefined
        names.set(id, { name, until: clock.now() + ttl })
        return name
      } catch (err) {
        logger.debug('slack channel name lookup failed', { channel: id, err: errorMessage(err) })
        names.set(id, { name: undefined, until: clock.now() + CHANNEL_MISS_TTL_MS })
        return undefined
      } finally {
        pending.delete(id)
        if (names.size > CHANNEL_CACHE_MAX) names.delete(names.keys().next().value as string)
      }
    })()
    pending.set(id, p)
    return p
  }

  // The app's own bot identity (auth.test), for ignoring its own messages. Looked up once, lazily.
  let authTest: Promise<{ userId?: string; botId?: string }> | undefined
  const ownIdentity = () => {
    authTest ??= quick
      .call('auth.test', {}, {})
      .then((r) => ({
        ...(typeof r.user_id === 'string' ? { userId: r.user_id } : {}),
        ...(typeof r.bot_id === 'string' ? { botId: r.bot_id } : {}),
      }))
      .catch((err) => {
        logger.warn('slack auth.test failed', { err: errorMessage(err) })
        authTest = undefined
        return {}
      })
    return authTest
  }

  const selfFor = async (env: SlackEnvelope): Promise<SelfIdentity> => {
    const userIds = new Set<string>()
    const botIds = new Set<string>()
    for (const a of env.authorizations ?? []) if (a.is_bot && a.user_id) userIds.add(a.user_id)
    // Without an app id to compare, a bot message can only be recognised as ours by the bot id.
    const ev = env.event
    const m = ev?.subtype === 'message_changed' ? ev.message : ev?.subtype === 'message_deleted' ? ev.previous_message : ev
    const needsAuth = userIds.size === 0 || (!!m?.bot_id && !m.app_id && !m.bot_profile?.app_id)
    if (needsAuth) {
      const me = await ownIdentity()
      if (me.userId) userIds.add(me.userId)
      if (me.botId) botIds.add(me.botId)
    }
    return { userIds, botIds, ...(env.api_app_id ? { appId: env.api_app_id } : {}) }
  }

  const handleWebhook = async (req: WebhookRequest): Promise<WebhookResult> => {
    if (req.method.toUpperCase() !== 'POST') return { ...json(405, { error: 'method_not_allowed' }), headers: { allow: 'POST' } }
    const check = verifySlackSignature({
      signingSecret: opts.secrets.signingSecret,
      signature: req.headers['x-slack-signature'],
      timestamp: req.headers['x-slack-request-timestamp'],
      body: req.body,
      nowMs: clock.now(),
    })
    if (!check.ok) {
      logger.warn('slack webhook rejected', { reason: check.reason })
      return json(401, { error: `invalid_signature: ${check.reason}` })
    }
    let env: SlackEnvelope
    try {
      env = JSON.parse(req.body) as SlackEnvelope
      if (!env || typeof env !== 'object' || typeof env.type !== 'string') throw new Error('not an envelope')
    } catch {
      return json(400, { error: 'invalid_body' })
    }
    if (env.type === 'url_verification') {
      const challenge = (env as { challenge?: unknown }).challenge
      return {
        status: 200,
        body: typeof challenge === 'string' ? challenge : '',
        headers: { 'content-type': 'text/plain' },
        events: [],
      }
    }
    if (env.type === 'app_rate_limited') {
      logger.warn('slack is rate limiting event deliveries to this app', {
        minute: (env as { minute_rate_limited?: unknown }).minute_rate_limited,
      })
      return { status: 200, events: [] }
    }
    if (env.type !== 'event_callback') return { status: 200, events: [] }
    const event = await mapSlackEvent(env, { self: await selfFor(env), channelName })
    logger.debug('slack event', {
      eventId: env.event_id,
      type: env.event?.type,
      subtype: env.event?.subtype,
      mapped: event?.type ?? null,
      retry: req.headers['x-slack-retry-num'],
    })
    return { status: 200, events: event ? [event] : [] }
  }

  const resolveUser = async (externalId: string): Promise<ExternalUser | null> => {
    try {
      const r = await client.call('users.info', { user: externalId }, {})
      const u = (r.user ?? {}) as { id?: string; real_name?: string; profile?: { email?: string; real_name?: string } }
      const name = u.real_name || u.profile?.real_name
      const email = u.profile?.email
      return { handle: { system: SLACK_SYSTEM, id: u.id ?? externalId }, ...(email ? { email } : {}), ...(name ? { name } : {}) }
    } catch (err) {
      if (slackErrorCode(err) === 'user_not_found') return null
      throw err
    }
  }

  return {
    name: 'slack',
    createMcpServer: () => createSlackMcpServer(client, logger),
    handleWebhook,
    resolveUser,
  }
}
