import { randomBytes } from 'node:crypto'
import type { SetupStep } from '@mp/api'
import { DeniedError, errorMessage, UnavailableError, ValidationError } from '@mp/core'
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

export const LINEAR_API_URL = 'https://api.linear.app/graphql'
/** Resource types the Linear webhook sends (packages/integration-linear/README.md). */
export const LINEAR_RESOURCE_TYPES = ['Issue', 'Comment', 'IssueLabel', 'Reaction']

interface Viewer {
  id: string
  name?: string
  displayName?: string
  email?: string
  admin?: boolean
}

/** One GraphQL call. Returns `data`, or throws: `ValidationError` for a rejected key, `DeniedError` for a forbidden call. */
async function gql<T>(ctx: SetupContext, key: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const r = await http(ctx.deps, ctx.deps.baseUrls.linear ?? LINEAR_API_URL, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  })
  const errors = (r.json?.errors ?? []) as { message?: string; extensions?: { type?: string; code?: string } }[]
  const text = errors.map((e) => e.message ?? '').join('; ')
  const kind = errors.map((e) => `${e.extensions?.type ?? ''} ${e.extensions?.code ?? ''}`).join(' ')
  if (r.status === 401 || /authenticat/i.test(`${kind} ${text}`)) throw new ValidationError('Linear rejected the API key.')
  if (/forbidden|permission|admin/i.test(`${kind} ${text}`))
    throw new DeniedError(redact(ctx, text || 'Linear refused the call.'))
  if (r.status === 429 || /ratelimit/i.test(kind))
    throw new UnavailableError('Linear is rate limiting the harness; try again in a minute')
  if (!r.ok || errors.length || !r.json?.data)
    throw new UnavailableError(redact(ctx, `Linear answered HTTP ${r.status}${text ? `: ${text}` : ''}`))
  return r.json.data as T
}

const viewerOf = async (ctx: SetupContext, key: string) =>
  (await gql<{ viewer: Viewer; organization?: { name?: string; urlKey?: string } }>(
    ctx,
    key,
    'query { viewer { id name displayName email admin } organization { name urlKey } }',
  )) as { viewer: Viewer; organization?: { name?: string; urlKey?: string } }

/** Linear's guided setup: the employee's API key, the webhook, routing. */
export const linearSetup: IntegrationSetupModule = {
  name: 'linear',
  label: 'Linear',
  tokenSecret: 'LINEAR_API_KEY',
  secrets: [
    { name: 'LINEAR_API_KEY', label: 'Personal API key', placeholder: 'lin_api_…' },
    { name: 'LINEAR_WEBHOOK_SECRET', label: 'Webhook signing secret', placeholder: 'lin_wh_…' },
  ],

  async check(ctx) {
    const id = ctx.employee.id
    const key = ctx.values.LINEAR_API_KEY
    const keyState = secretState(ctx.metas, 'LINEAR_API_KEY', id)
    const secret = secretState(ctx.metas, 'LINEAR_WEBHOOK_SECRET', id)
    const steps: SetupStep[] = []
    let viewer: Viewer | null = null

    if (!key) steps.push(step('api-key', 'Paste its API key', 'todo', 'A personal API key of the employee’s own Linear member.'))
    else {
      try {
        const v = await viewerOf(ctx, key)
        viewer = v.viewer
        steps.push(
          step(
            'api-key',
            'Paste its API key',
            keyState.own ? 'done' : 'warning',
            `Signed in as ${viewer.displayName ?? viewer.name ?? viewer.id}${v.organization?.name ? ` in ${v.organization.name}` : ''}.${keyState.own ? '' : ' It uses the deployment-wide key: paste this employee’s own.'}`,
            {
              viewerId: viewer.id,
              name: viewer.name ?? null,
              email: viewer.email ?? null,
              organization: v.organization?.name ?? null,
            },
          ),
        )
      } catch (err) {
        steps.push(
          step(
            'api-key',
            'Paste its API key',
            err instanceof ValidationError ? 'error' : 'warning',
            redact(ctx, errorMessage(err)),
          ),
        )
      }
    }

    const url = webhookUrl(ctx, 'linear')
    const activity = await ctx.deps.activity.get(id, 'linear')
    if (activity)
      steps.push(
        step('webhook', 'Webhook', 'done', `The last signed event arrived ${ago(activity.lastAt, ctx.s.clock.now())}.`, { url }),
      )
    else
      steps.push(
        step(
          'webhook',
          'Webhook',
          'todo',
          secret.own
            ? 'The signing secret is set; no event has arrived yet.'
            : 'Create the webhook here (Linear admins), or by hand with the URL below, then paste its signing secret.',
          { url, secretSet: secret.own, resourceTypes: LINEAR_RESOURCE_TYPES },
        ),
      )

    steps.push(
      await routingStep(ctx, 'linear', 'Linear', 'The recommended trigger sends issues assigned to it to the router context.'),
    )
    return steps
  },

  async validate(ctx, given) {
    if (given.LINEAR_API_KEY === undefined) return { message: 'Signing secret saved.' }
    let v: Awaited<ReturnType<typeof viewerOf>>
    try {
      v = await viewerOf(ctx, given.LINEAR_API_KEY)
    } catch (err) {
      if (err instanceof ValidationError) throw new ValidationError('Linear rejected the API key. It was not saved.')
      return { message: redact(ctx, `Saved, but Linear couldn't be reached to check it: ${errorMessage(err)}`) }
    }
    return {
      message: `Connected as ${v.viewer.displayName ?? v.viewer.name ?? v.viewer.id}.`,
      after: () => addHandle(ctx, 'linear', v.viewer.id),
    }
  },

  actions: {
    /** Creates (or repairs) the employee's webhook with a fresh signing secret. Needs a Linear admin's key. */
    async 'create-webhook'(ctx) {
      const key = ctx.values.LINEAR_API_KEY
      if (!key) throw new ValidationError('Paste the API key first.')
      const url = webhookUrl(ctx, 'linear')
      const secret = `lin_wh_${randomBytes(24).toString('hex')}`
      const existing = await gql<{ webhooks: { nodes: { id: string; url: string }[] } }>(
        ctx,
        key,
        'query { webhooks(first: 100) { nodes { id url } } }',
      )
      const mine = existing.webhooks.nodes.find((w) => w.url === url)
      const own = secretState(ctx.metas, 'LINEAR_WEBHOOK_SECRET', ctx.employee.id).own
      if (mine && own) return 'The webhook is already registered.'
      if (mine) {
        const r = await gql<{ webhookUpdate: { success: boolean } }>(
          ctx,
          key,
          'mutation($id: String!, $input: WebhookUpdateInput!) { webhookUpdate(id: $id, input: $input) { success } }',
          { id: mine.id, input: { secret, resourceTypes: LINEAR_RESOURCE_TYPES } },
        )
        if (!r.webhookUpdate.success) throw new UnavailableError('Linear didn’t update the webhook.')
      } else {
        const r = await gql<{ webhookCreate: { success: boolean } }>(
          ctx,
          key,
          'mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success } }',
          {
            input: {
              url,
              secret,
              label: `meatless-proxy ${ctx.handle}`.slice(0, 50),
              resourceTypes: LINEAR_RESOURCE_TYPES,
              allPublicTeams: true,
            },
          },
        )
        if (!r.webhookCreate.success) throw new UnavailableError('Linear didn’t create the webhook.')
      }
      await ctx.s.secrets.set('LINEAR_WEBHOOK_SECRET', secret, { type: 'employee', id: ctx.employee.id }, ctx.actor.id)
      return mine ? 'Updated the webhook with a new signing secret.' : 'Registered the webhook; its signing secret is saved.'
    },

    async 'add-trigger'(ctx) {
      const key = ctx.values.LINEAR_API_KEY
      if (!key) throw new ValidationError('Paste the API key first: the trigger matches issues assigned to its Linear user.')
      const { viewer } = await viewerOf(ctx, key)
      return addTrigger(ctx, 'linear', {
        name: `Linear: issues assigned to ${viewer.displayName ?? viewer.name ?? ctx.employee.data.name}`,
        match: { source: 'integration:linear', type: 'issue.assigned', where: { 'payload.assignee.id': viewer.id } },
        target: { type: 'router' },
        fork: false,
        mode: 'ephemeral',
      })
    },
  },

  available(steps, ctx) {
    const out: string[] = []
    const status = (id: string) => steps.find((s) => s.id === id)?.status
    const keyOk = status('api-key') === 'done' || status('api-key') === 'warning'
    if (keyOk && status('webhook') !== 'done') out.push('create-webhook')
    if (keyOk && status('routing') !== 'done' && ctx.values.LINEAR_API_KEY) out.push('add-trigger')
    return out
  },
}
