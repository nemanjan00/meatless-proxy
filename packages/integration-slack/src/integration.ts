import { type Clock, errorMessage, type Logger, silentLogger, systemClock } from '@mp/core'
import type { ExternalUser, Integration, IntegrationEvent, WebhookRequest, WebhookResult } from '@mp/mcp'
import { createSlackClient, DEFAULT_BASE_URL, type RetryOptions, slackErrorCode } from './client.ts'
import {
  type DownloadOptions,
  downloadSlackFile,
  type SlackDownload,
  type SlackUploadInput,
  type SlackUploadResult,
  uploadSlackFile,
} from './files.ts'
import { mapSlackEvent, type SelfIdentity, type SlackEnvelope, SLACK_SYSTEM } from './events.ts'
import { type BlockActionsPayload, handleBlockActions, type SlackInteractionStore } from './interactions.ts'
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
  /**
   * The questions the harness asked with `ask`, so answers from Slack's interactivity can be
   * matched to them. Without it, interactive requests are acknowledged and ignored.
   */
  interactions?: SlackInteractionStore
}

/** Most channel names cached at once. */
const CHANNEL_CACHE_MAX = 1000
/** How long a failed channel lookup is remembered, so a broken lookup doesn't slow every event. */
const CHANNEL_MISS_TTL_MS = 60_000
/** Most permalinks cached at once. */
const PERMALINK_CACHE_MAX = 5000

const json = (status: number, body: unknown, events: IntegrationEvent[] = []): WebhookResult => ({
  status,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  events,
})

/** Whether a request is an interactivity payload (form-encoded `payload=`) rather than an Events API envelope. */
const isInteractive = (req: WebhookRequest) =>
  (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded') || req.body.startsWith('payload=')

/** The Slack integration, with what the harness does beside the MCP tools. */
export interface SlackIntegration extends Integration {
  /**
   * Downloads a file shared in Slack (files.info, then its private URL with the bot token), for
   * the harness to save into the employee's files: the bytes never go through the model.
   */
  downloadFile(fileId: string, opts?: DownloadOptions): Promise<SlackDownload>
  /**
   * Shares a file in a channel or thread (Slack's external upload flow, scope `files:write`),
   * with bytes the harness read from the employee's files: they never go through the model.
   */
  uploadFile(input: SlackUploadInput, opts?: { maxBytes?: number; signal?: AbortSignal }): Promise<SlackUploadResult>
  /**
   * A message's permalink (`chat.getPermalink`), for links in the UI. Cached for the instance's
   * life: permalinks don't change. Throws when Slack can't give one (unknown channel, no access).
   */
  permalink(channel: string, ts: string): Promise<string>
  /** A channel's name without the `#` (`conversations.info`, cached), or undefined for DMs and failures. */
  channelName(channelId: string): Promise<string | undefined>
}

/**
 * The Slack integration: tools over the Web API as the app's bot, Events API
 * webhooks turned into events, and user lookup for contact matching.
 */
export function createSlackIntegration(opts: SlackIntegrationOptions): SlackIntegration {
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
    // Interactivity (buttons, inputs) comes form-encoded as `payload=<json>`, signed the same way:
    // https://docs.slack.dev/interactivity/handling-user-interaction/
    if (isInteractive(req)) return interactive(req.body)
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

  /** Slack wants a 200 within 3 s, empty: the answer is handled after (`after`). */
  const interactive = (body: string): WebhookResult => {
    let payload: { type?: unknown }
    try {
      payload = JSON.parse(new URLSearchParams(body).get('payload') ?? '') as { type?: unknown }
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') throw new Error('no payload type')
    } catch {
      return json(400, { error: 'invalid_payload' })
    }
    logger.debug('slack interactive request', { type: payload.type })
    const store = opts.interactions
    if (payload.type !== 'block_actions' || !store) return { status: 200, body: '', events: [] }
    return {
      status: 200,
      body: '',
      events: [],
      after: () =>
        handleBlockActions(payload as BlockActionsPayload, {
          store,
          client,
          channelName,
          logger,
          now: () => new Date(clock.now()).toISOString(),
        }),
    }
  }

  const resolveUser = async (externalId: string): Promise<ExternalUser | null> => {
    try {
      const r = await client.call('users.info', { user: externalId }, {})
      const u = (r.user ?? {}) as {
        id?: string
        name?: string
        real_name?: string
        is_bot?: boolean
        profile?: { email?: string; real_name?: string; display_name?: string }
      }
      const id = u.id ?? externalId
      const name = u.real_name || u.profile?.real_name
      const display = u.profile?.display_name || undefined
      const email = u.profile?.email
      // Slackbot isn't flagged `is_bot`, but it's no person either.
      const bot = u.is_bot === true || id === 'USLACKBOT'
      return {
        handle: { system: SLACK_SYSTEM, id },
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
        ...(display && display !== name ? { displayName: display } : {}),
        ...(bot ? { bot: true } : {}),
      }
    } catch (err) {
      if (slackErrorCode(err) === 'user_not_found') return null
      throw err
    }
  }

  // A Web API base other than Slack's (tests, a proxy) serves files too.
  const apiHost = opts.baseUrl && opts.baseUrl !== DEFAULT_BASE_URL ? new URL(opts.baseUrl).host : undefined
  const fileDeps = {
    client,
    token: opts.secrets.botToken,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(apiHost ? { allowHost: (host: string) => host === apiHost } : {}),
  }
  // Permalinks never change: cached until the instance is replaced (or the cache is full), failures not at all.
  const permalinks = new Map<string, Promise<string>>()
  const permalink: SlackIntegration['permalink'] = (channel, ts) => {
    const key = `${channel}/${ts}`
    const hit = permalinks.get(key)
    if (hit) return hit
    const p = quick.call('chat.getPermalink', { channel, message_ts: ts }, {}).then((r) => {
      if (typeof r.permalink !== 'string' || !/^https:\/\//.test(r.permalink))
        throw new Error(`slack chat.getPermalink: no permalink for ${key}`)
      return r.permalink
    })
    permalinks.set(key, p)
    if (permalinks.size > PERMALINK_CACHE_MAX) permalinks.delete(permalinks.keys().next().value as string)
    p.catch(() => permalinks.delete(key))
    return p
  }

  const downloadFile: SlackIntegration['downloadFile'] = (fileId, o) => downloadSlackFile(fileDeps, fileId, o)
  const uploadFile: SlackIntegration['uploadFile'] = (input, o) => uploadSlackFile(fileDeps, input, o)

  return {
    name: 'slack',
    createMcpServer: () => createSlackMcpServer(client, logger),
    handleWebhook,
    resolveUser,
    downloadFile,
    uploadFile,
    permalink,
    channelName,
  }
}
