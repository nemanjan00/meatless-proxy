import { randomUUID } from 'node:crypto'
import type { Clock, Logger } from '@mp/core'
import { createGitlabIntegration } from '@mp/integration-gitlab'
import { createLinearIntegration } from '@mp/integration-linear'
import { createSlackIntegration, type SlackInteractionStore } from '@mp/integration-slack'
import type { Integration } from '@mp/mcp'
import type { EffectClass } from '@mp/tools'
import { gitlabIdentity, type IdentityLookup, linearIdentity, slackIdentity } from './identity-lookups.ts'

/** What an integration factory gets besides its secrets. */
export interface IntegrationFactoryDeps {
  clock: Clock
  logger: Logger
  /** Replaces `fetch` for every API call (tests). */
  fetch?: typeof fetch
  /** API base URL override (tests, self-hosted instances). */
  baseUrl?: string
  /** The employee the instance is for; undefined for the deployment-wide one. */
  employeeId?: string
  /** Questions asked with Slack's `ask`, for the instance of an employee (or the deployment). */
  slackInteractions?: (employeeId: string | undefined) => SlackInteractionStore
}

/**
 * How the server builds one first-party integration from secrets. Everything
 * integration-specific in the server lives in these specs, so adding a fourth
 * integration is one more entry.
 */
export interface IntegrationSpec {
  /** `slack`, `linear`, `gitlab`: the MCP server name and the webhook path segment. */
  name: string
  /** For messages: `Slack`. */
  label: string
  /** The secret the tools need (the token). Without it the integration isn't set up for an employee. */
  tokenSecret: string
  /** The secret that authenticates webhooks. Without it webhooks to that URL are refused. */
  webhookSecret: string
  /** Optional secrets and config, e.g. `GITLAB_BASE_URL`. */
  optionalSecrets: string[]
  /** The optional secret (or config) holding the API base URL, e.g. `GITLAB_BASE_URL`. */
  baseUrlSecret?: string
  /** Effect class per tool; tools not in the table are `non_idempotent`. */
  effects: Record<string, EffectClass>
  /** Tools that answer in the system (used by the reply-goes-back-out policy). */
  answerTools?: string[]
  /** How the system's users are looked up and named, for linking them to contacts (./identity-lookups.ts). */
  identity?: IdentityLookup
  /** Builds an instance. Missing values are empty strings. */
  create(values: Record<string, string>, deps: IntegrationFactoryDeps): Integration
}

/** A placeholder for a value that isn't set: never matches a real signature or token. */
const UNSET = 'unset'

export const slackSpec: IntegrationSpec = {
  name: 'slack',
  label: 'Slack',
  tokenSecret: 'SLACK_BOT_TOKEN',
  webhookSecret: 'SLACK_SIGNING_SECRET',
  optionalSecrets: [],
  effects: {
    post_message: 'non_idempotent',
    reply: 'non_idempotent',
    read_channel: 'read',
    read_thread: 'read',
    react: 'idempotent',
    unreact: 'idempotent',
    lookup_user: 'read',
    open_dm: 'idempotent',
    list_channels: 'read',
    update_message: 'idempotent',
    ask: 'non_idempotent',
    get_file: 'idempotent',
    upload_file: 'non_idempotent',
    post_blocks: 'non_idempotent',
  },
  answerTools: ['post_message', 'reply', 'update_message', 'ask', 'post_blocks', 'upload_file'],
  identity: slackIdentity,
  create: (v, d) =>
    createSlackIntegration({
      secrets: { botToken: v.SLACK_BOT_TOKEN || UNSET, signingSecret: v.SLACK_SIGNING_SECRET ?? '' },
      clock: d.clock,
      logger: d.logger,
      ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
      ...(d.slackInteractions ? { interactions: d.slackInteractions(d.employeeId) } : {}),
    }),
}

export const linearSpec: IntegrationSpec = {
  name: 'linear',
  label: 'Linear',
  tokenSecret: 'LINEAR_API_KEY',
  webhookSecret: 'LINEAR_WEBHOOK_SECRET',
  optionalSecrets: [],
  effects: {
    search_issues: 'read',
    get_issue: 'read',
    create_issue: 'non_idempotent',
    update_issue: 'idempotent',
    create_sub_issue: 'non_idempotent',
    comment: 'non_idempotent',
    list_teams: 'read',
    list_workflow_states: 'read',
    list_users: 'read',
    list_projects: 'read',
    list_labels: 'read',
    list_cycles: 'read',
    viewer: 'read',
  },
  identity: linearIdentity,
  create: (v, d) =>
    createLinearIntegration({
      secrets: {
        apiKey: v.LINEAR_API_KEY || UNSET,
        ...(v.LINEAR_WEBHOOK_SECRET ? { webhookSecret: v.LINEAR_WEBHOOK_SECRET } : {}),
      },
      clock: d.clock,
      logger: d.logger,
      ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
    }),
}

export const gitlabSpec: IntegrationSpec = {
  name: 'gitlab',
  label: 'GitLab',
  tokenSecret: 'GITLAB_TOKEN',
  webhookSecret: 'GITLAB_WEBHOOK_SECRET',
  optionalSecrets: ['GITLAB_BASE_URL'],
  baseUrlSecret: 'GITLAB_BASE_URL',
  effects: {
    get_project: 'read',
    list_branches: 'read',
    get_file: 'read',
    list_tree: 'read',
    create_merge_request: 'non_idempotent',
    update_merge_request: 'idempotent',
    get_merge_request: 'read',
    list_merge_requests: 'read',
    merge_request_changes: 'read',
    comment_merge_request: 'non_idempotent',
    reply_discussion: 'non_idempotent',
    pipeline_status: 'read',
    job_log: 'read',
    get_issue: 'read',
    create_issue: 'non_idempotent',
    comment_issue: 'non_idempotent',
    current_user: 'read',
  },
  identity: gitlabIdentity,
  create: (v, d) => {
    const baseUrl = v.GITLAB_BASE_URL || d.baseUrl
    return createGitlabIntegration({
      // A random placeholder when the webhook secret is unset: no request can match it.
      secrets: { token: v.GITLAB_TOKEN || UNSET, webhookSecret: v.GITLAB_WEBHOOK_SECRET || `${UNSET}:${randomUUID()}` },
      clock: d.clock,
      logger: d.logger,
      ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    })
  },
}

/** The first-party integrations, by name. */
export const INTEGRATION_SPECS: Record<string, IntegrationSpec> = {
  slack: slackSpec,
  linear: linearSpec,
  gitlab: gitlabSpec,
}

/** Every secret name an integration reads. */
export const secretNamesOf = (spec: IntegrationSpec) => [spec.tokenSecret, spec.webhookSecret, ...spec.optionalSecrets]
