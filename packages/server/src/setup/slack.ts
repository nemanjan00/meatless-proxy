import type { Json, SetupStep } from '@mp/api'
import { errorMessage, UnavailableError, ValidationError } from '@mp/core'
import {
  addHandle,
  addTrigger,
  ago,
  http,
  type IntegrationSetupModule,
  redact,
  routingStep,
  type SetupContext,
  secretState,
  step,
  webhookUrl,
} from './common.ts'
import { interactiveActivity } from './activity.ts'

export const SLACK_API_URL = 'https://slack.com/api'
/** Bot scopes the Slack tools and events need (packages/integration-slack/README.md). */
export const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:write',
  'mpim:history',
  'mpim:write',
  'reactions:read',
  'reactions:write',
  'users:read',
  'users:read.email',
]
/** Events API subscriptions the integration maps. */
export const SLACK_BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'reaction_added',
]
/** Errors from `auth.test` that mean the token itself is bad. */
const BAD_TOKEN = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'no_permission'])

/**
 * The Slack app manifest for one employee: its name, bot user, scopes, events, and the request URLs
 * of the Events API and of interactivity (buttons and inputs of `mcp.slack.ask`). Manifest fields:
 * https://docs.slack.dev/reference/app-manifest/
 */
export function slackManifest(
  name: string,
  handle: string,
  requestUrl: string,
  interactivityUrl = `${requestUrl}/interactive`,
): Record<string, Json> {
  return {
    display_information: {
      name: name.slice(0, 35),
      description: `${name}, an AI employee (meatless-proxy)`.slice(0, 139),
      background_color: '#1f2937',
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: {
        display_name: handle
          .toLowerCase()
          .replace(/[^a-z0-9._-]/g, '-')
          .slice(0, 80),
        always_online: true,
      },
    },
    oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
    settings: {
      event_subscriptions: { request_url: requestUrl, bot_events: SLACK_BOT_EVENTS },
      interactivity: { is_enabled: true, request_url: interactivityUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}

/** Slack's "create an app from this manifest" link. */
export const slackCreateUrl = (manifest: Json) =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`

export function manifestFor(ctx: SetupContext) {
  const requestUrl = webhookUrl(ctx, 'slack')
  const interactivityUrl = `${requestUrl}/interactive`
  const manifest = slackManifest(ctx.employee.data.name, ctx.handle, requestUrl, interactivityUrl)
  return { manifest, createUrl: slackCreateUrl(manifest), requestUrl, interactivityUrl }
}

interface AuthTest {
  ok: boolean
  error?: string
  url?: string
  team?: string
  team_id?: string
  user?: string
  user_id?: string
  bot_id?: string
  scopes: string[] | null
}

async function slackCall(ctx: SetupContext, token: string, method: string, params: Record<string, string> = {}) {
  const base = (ctx.deps.baseUrls.slack ?? SLACK_API_URL).replace(/\/+$/, '')
  const r = await http(ctx.deps, `${base}/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  if (r.status === 429) throw new UnavailableError('Slack is rate limiting the harness; try again in a minute')
  if (!r.json || typeof r.json !== 'object') throw new UnavailableError(`Slack answered ${method} with HTTP ${r.status}`)
  return r
}

async function authTest(ctx: SetupContext, token: string): Promise<AuthTest> {
  const r = await slackCall(ctx, token, 'auth.test')
  const scopes = r.headers.get('x-oauth-scopes')
  return {
    ...(r.json as Omit<AuthTest, 'scopes'>),
    scopes: scopes
      ? scopes
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : null,
  }
}

/** Slack's guided setup: the app from a manifest, its tokens, events, channels and routing. */
export const slackSetup: IntegrationSetupModule = {
  name: 'slack',
  label: 'Slack',
  tokenSecret: 'SLACK_BOT_TOKEN',
  secrets: [
    { name: 'SLACK_BOT_TOKEN', label: 'Bot User OAuth Token', placeholder: 'xoxb-…' },
    { name: 'SLACK_SIGNING_SECRET', label: 'Signing Secret', placeholder: '32 hex characters' },
  ],

  async check(ctx) {
    const id = ctx.employee.id
    const token = ctx.values.SLACK_BOT_TOKEN
    const tokenState = secretState(ctx.metas, 'SLACK_BOT_TOKEN', id)
    const signing = secretState(ctx.metas, 'SLACK_SIGNING_SECRET', id)
    const { requestUrl, createUrl, interactivityUrl } = manifestFor(ctx)
    const activity = await ctx.deps.activity.get(id, 'slack')
    const interactive = await ctx.deps.activity.get(id, interactiveActivity('slack'))
    const steps: SetupStep[] = []

    // (a) The app, from the generated manifest.
    const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(ctx.publicUrl)
    if (tokenState.own || activity)
      steps.push(
        step('app', 'Create the Slack app', 'done', `The app is created; Slack sends its events to ${requestUrl}.`, {
          requestUrl,
          createUrl,
        }),
      )
    else
      steps.push(
        step(
          'app',
          'Create the Slack app',
          !ctx.publicUrlConfigured && local ? 'warning' : 'todo',
          !ctx.publicUrlConfigured
            ? `PUBLIC_URL isn't set, so the request URL uses ${ctx.publicUrl}. Slack must be able to reach it: set PUBLIC_URL to the harness's public address first.`
            : 'Create the app from the manifest, then install it to the workspace.',
          { requestUrl, createUrl },
        ),
      )

    // (b) The bot token and signing secret, checked with auth.test.
    let auth: AuthTest | null = null
    if (!token) {
      steps.push(step('tokens', 'Install it and paste the tokens', 'todo', 'Paste the bot token and the signing secret.'))
    } else {
      const note = tokenState.own
        ? ''
        : ' It uses the deployment-wide bot token: paste this employee’s own to give it its own bot.'
      try {
        auth = await authTest(ctx, token)
        if (!auth.ok) {
          steps.push(
            step(
              'tokens',
              'Install it and paste the tokens',
              BAD_TOKEN.has(auth.error ?? '') ? 'error' : 'warning',
              `Slack rejected the bot token (${auth.error ?? 'unknown error'}). Paste a current Bot User OAuth Token.`,
            ),
          )
          auth = null
        } else {
          const missing = auth.scopes ? SLACK_BOT_SCOPES.filter((sc) => !auth!.scopes!.includes(sc)) : []
          const problems = [
            ...(missing.length ? [`The app lacks the scopes ${missing.join(', ')}: add them and reinstall it.`] : []),
            ...(signing.own || signing.global ? [] : ['The signing secret isn’t set, so webhooks are refused.']),
          ]
          steps.push(
            step(
              'tokens',
              'Install it and paste the tokens',
              problems.length || !tokenState.own ? 'warning' : 'done',
              `Signed in as @${auth.user} in ${auth.team}.${problems.length ? ` ${problems.join(' ')}` : ''}${note}`,
              {
                botUser: auth.user ?? null,
                botUserId: auth.user_id ?? null,
                team: auth.team ?? null,
                teamUrl: auth.url ?? null,
                missingScopes: missing,
                signingSecret: signing.own || signing.global,
              },
            ),
          )
        }
      } catch (err) {
        steps.push(
          step(
            'tokens',
            'Install it and paste the tokens',
            'warning',
            redact(ctx, `Couldn't check the token: ${errorMessage(err)}`),
          ),
        )
      }
    }

    // (c) A signed request has reached this employee's webhook.
    if (activity)
      steps.push(
        step(
          'events',
          'Events reach the harness',
          'done',
          `The last signed request from Slack arrived ${ago(activity.lastAt, ctx.s.clock.now())}.`,
          {
            lastAt: activity.lastAt,
            requestUrl,
          },
        ),
      )
    else
      steps.push(
        step(
          'events',
          'Events reach the harness',
          'todo',
          signing.own || signing.global
            ? 'No signed request from Slack yet. Under Event Subscriptions, retry the request URL.'
            : 'Paste the signing secret first: Slack verifies the request URL with it.',
          { requestUrl },
        ),
      )

    // (c2) Interactivity: answers to questions asked with mcp.slack.ask. Optional: the rest works without it.
    if (interactive)
      steps.push(
        step(
          'interactivity',
          'Buttons and forms reach the harness',
          'done',
          `The last signed interactive request from Slack arrived ${ago(interactive.lastAt, ctx.s.clock.now())}.`,
          { lastAt: interactive.lastAt, interactivityUrl, optional: true },
        ),
      )
    else
      steps.push(
        step(
          'interactivity',
          'Buttons and forms reach the harness',
          'todo',
          `Optional: needed for questions with inputs and buttons (mcp.slack.ask). Apps created from this manifest have it; for an existing app, turn on Interactivity & Shortcuts and set the Request URL to ${interactivityUrl}. This shows as done after the first answer.`,
          { interactivityUrl, optional: true },
        ),
      )

    // (d) Channels the bot is in.
    const botName = auth?.user ?? ctx.handle
    if (!auth || !token) {
      steps.push(
        step('channels', 'Invite it to channels', 'todo', 'Needs a working bot token.', { invite: `/invite @${botName}` }),
      )
    } else {
      try {
        const r = await slackCall(ctx, token, 'users.conversations', {
          types: 'public_channel,private_channel',
          exclude_archived: 'true',
          limit: '200',
        })
        if (!r.json.ok) throw new Error(r.json.error ?? 'unknown error')
        const channels = ((r.json.channels ?? []) as { id: string; name?: string; is_private?: boolean }[]).map((c) => ({
          id: c.id,
          name: c.name ?? c.id,
          private: !!c.is_private,
        }))
        steps.push(
          step(
            'channels',
            'Invite it to channels',
            channels.length ? 'done' : 'todo',
            channels.length
              ? `In ${channels.length} channel${channels.length === 1 ? '' : 's'}. DMs to the app work without an invite.`
              : `It isn’t in any channel yet. Run /invite @${botName} in each channel it should read or post in.`,
            { channels, invite: `/invite @${botName}` },
          ),
        )
      } catch (err) {
        steps.push(
          step('channels', 'Invite it to channels', 'warning', redact(ctx, `Couldn't list its channels: ${errorMessage(err)}`), {
            invite: `/invite @${botName}`,
          }),
        )
      }
    }

    // (e) A trigger takes its mentions and DMs.
    steps.push(await routingStep(ctx, 'slack', 'Slack', 'The recommended trigger sends mentions and DMs to the router context.'))
    return steps
  },

  async validate(ctx, given) {
    const token = given.SLACK_BOT_TOKEN
    if (given.SLACK_SIGNING_SECRET !== undefined && !/^[A-Za-z0-9]{16,128}$/.test(given.SLACK_SIGNING_SECRET.trim()))
      throw new ValidationError('That doesn’t look like a signing secret: copy it from Basic Information → App Credentials.')
    if (token === undefined) return { message: 'Signing secret saved.' }
    if (!token.startsWith('xoxb-'))
      throw new ValidationError(
        'That isn’t a bot token: use the Bot User OAuth Token (xoxb-…) from OAuth & Permissions, never a user token.',
      )
    let auth: AuthTest
    try {
      auth = await authTest(ctx, token)
    } catch (err) {
      return { message: redact(ctx, `Saved, but Slack couldn't be reached to check it: ${errorMessage(err)}`) }
    }
    if (!auth.ok) {
      if (BAD_TOKEN.has(auth.error ?? ''))
        throw new ValidationError(`Slack rejected the bot token (${auth.error}). It was not saved.`)
      return { message: `Saved, but auth.test answered ${auth.error}.` }
    }
    return {
      message: `Connected as @${auth.user} in ${auth.team}.`,
      after: async () => (auth.user_id ? addHandle(ctx, 'slack', auth.user_id) : undefined),
    }
  },

  actions: {
    'add-trigger': (ctx) =>
      addTrigger(ctx, 'slack', {
        name: 'Slack: mentions and DMs',
        match: { source: 'integration:slack', filter: { type: { $in: ['message.mentioned', 'message.direct'] } } },
        target: { type: 'router' },
        fork: false,
        mode: 'ephemeral',
      }),
  },

  available(steps) {
    return steps.find((s) => s.id === 'routing')?.status === 'done' ? [] : ['add-trigger']
  },
}
