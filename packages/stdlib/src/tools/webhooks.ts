import type { Json } from '@mp/core'
import type { ToolContext } from '@mp/tools'
import { fail, ok, str, type Kit } from '../kit.ts'

const SETUP_NOTE =
  'Nobody has its secret yet, you included: an admin gets one on your employee page (Webhooks › New secret) and sets it, with the URL, on the system that sends. Until then deliveries are refused. Tell the person who asked.'

const mappingProp = {
  type: 'object',
  description:
    'Paths into the JSON body (like action or data.issue.id): type (event type), subject (what it is about), text (a template with {path} placeholders).',
  properties: { type: { type: 'string' }, subject: { type: 'string' }, text: { type: 'string' } },
}
const rulesProp = {
  type: 'array',
  description:
    'The first rule that matches decides; none: your router. Each: { type?: glob on the event type, field?: body path, equals? | contains?: text, action: { type: "ignore" | "router" | "session", sessionId? (default: this session) } }.',
  items: { type: 'object' },
}

/**
 * webhooks.list, webhooks.create and webhooks.update: an employee sets up its own incoming webhooks.
 * Their secrets never reach the model: a new one has a secret nobody knows until an admin makes one.
 */
export function registerWebhookTools(kit: Kit): void {
  const hooks = kit.deps.webhooks
  if (!hooks) return

  /** A session action without an id is this session. */
  const withSessions = (rules: unknown, ctx: ToolContext) =>
    Array.isArray(rules)
      ? rules.map((r) => {
          const x = (r ?? {}) as Record<string, unknown>
          const a = (x.action ?? {}) as Record<string, unknown>
          return a.type === 'session' && !a.sessionId ? { ...x, action: { type: 'session', sessionId: ctx.sessionId } } : x
        })
      : rules

  kit.tool(
    {
      name: 'webhooks.list',
      description:
        'Your incoming webhooks: their URLs, how the body maps to events, their rules, and how many deliveries came in.',
      effect: 'read',
      params: { properties: {} },
    },
    async (_a, ctx) => ok({ webhooks: (await hooks.list(ctx.employeeId)) as Json }),
  )

  kit.tool(
    {
      name: 'webhooks.create',
      description:
        'Create an incoming webhook for yourself: a URL another system (Sentry, Stripe, CI…) posts JSON to. Its events come to you as untrusted input, from source webhook:<name>, sent where the first matching rule says (ignore, your router, or a session). Map a subject so follow-ups about the same thing reach the same session.',
      effect: 'non_idempotent',
      params: {
        properties: {
          name: { type: 'string', description: 'A slug, e.g. sentry.' },
          about: { type: 'string', description: 'What it is for, in a line.' },
          auth: {
            type: 'object',
            description:
              'How deliveries prove they are real: { type: "token" | "hmac", header? }. Default a token in X-Webhook-Token.',
          },
          mapping: mappingProp,
          rules: rulesProp,
        },
        required: ['name'],
      },
    },
    async (a, ctx) => {
      if (!str(a.name)) return fail('name is required')
      const { webhook } = await hooks.create(
        {
          employeeId: ctx.employeeId,
          name: a.name,
          ...(a.about !== undefined ? { about: a.about } : {}),
          ...(a.auth !== undefined ? { auth: a.auth } : {}),
          ...(a.mapping !== undefined ? { mapping: a.mapping } : {}),
          rules: withSessions(a.rules, ctx),
        },
        kit.actor(ctx),
      )
      return ok({ webhook: webhook as Json, next: SETUP_NOTE })
    },
  )

  kit.tool(
    {
      name: 'webhooks.update',
      description: 'Change one of your webhooks: about, auth, mapping, rules (replaced as a whole), or enabled.',
      effect: 'idempotent',
      params: {
        properties: {
          id: { type: 'string', description: 'The webhook id (whk_…), from webhooks.list.' },
          about: { type: 'string' },
          auth: { type: 'object' },
          mapping: mappingProp,
          rules: rulesProp,
          enabled: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
    async (a, ctx) => {
      const id = str(a.id)
      const mine = (await hooks.list(ctx.employeeId)).some((w) => w.id === id)
      if (!id || !mine) return fail(`no webhook ${a.id} of yours: see webhooks.list`)
      const patch: Record<string, unknown> = {}
      for (const k of ['about', 'auth', 'mapping', 'enabled'] as const) if (a[k] !== undefined) patch[k] = a[k]
      if (a.rules !== undefined) patch.rules = withSessions(a.rules, ctx)
      return ok({ webhook: (await hooks.update(id, patch, kit.actor(ctx))) as Json })
    },
  )
}
