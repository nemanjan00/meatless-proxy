import { NotFoundError, ValidationError, type Json } from '@mp/core'
import type { Subject, Trigger, TriggerData, TriggerTarget } from '@mp/events'
import type { ToolContext } from '@mp/tools'
import { fail, ok, str, type Kit } from '../kit.ts'

const subjectProp = {
  type: 'object',
  description:
    'What to follow: {system, id}, e.g. {system:"linear", id:"PAY-123"}, {system:"github", id:"acme/billing#42"}, {system:"mp", id:"<thread or session id>"}.',
  properties: { system: { type: 'string' }, id: { type: 'string' } },
  required: ['system', 'id'],
}

const matchProp = {
  type: 'object',
  description:
    'Which events: {source?, type?, subject?: {system?, id?}} (globs, e.g. type "task.*"), where? (dot path -> value), filter? (MongoDB-style query over the event, e.g. {"payload.priority": {"$gte": 2}}).',
}

const targetProp = {
  type: 'object',
  description:
    'Where matching events go: {type:"session", sessionId} (default: this session), {type:"procedure", procedureId} or {type:"router"}.',
}

const subjectOf = (v: unknown): Subject => {
  const s = v as Subject
  if (!s || typeof s.system !== 'string' || typeof s.id !== 'string' || !s.system || !s.id)
    throw new ValidationError('subject must be {system, id}')
  return { system: s.system, id: s.id }
}

const triggerView = (t: Trigger): Json => ({
  id: t.id,
  name: t.data.name,
  enabled: t.data.enabled,
  priority: t.data.priority,
  match: t.data.match as Json,
  target: t.data.target as unknown as Json,
  fork: t.data.fork,
  mode: t.data.mode,
  fired: t.data.fired,
  ...(t.data.lastFiredAt ? { lastFiredAt: t.data.lastFiredAt } : {}),
})

export function registerEventTools(kit: Kit): void {
  const { deps } = kit
  const { events } = deps

  kit.tool(
    {
      name: 'subscriptions.subscribe',
      description:
        'Have events about a thing (a ticket, a PR, a thread, a running environment, another session) delivered straight to this session, without routing. primary: true means you are the one expected to act on untagged events. Optionally only some event types, or a filter (MongoDB-style query over the event).',
      effect: 'idempotent',
      params: {
        properties: {
          subject: subjectProp,
          types: { type: 'array', items: { type: 'string' }, description: 'Event type globs, e.g. ["comment.*"]. Default: all.' },
          filter: { type: 'object', description: 'e.g. {"payload.author.kind": "contact"}' },
          primary: { type: 'boolean' },
        },
        required: ['subject'],
      },
    },
    async (a, ctx) => {
      const sub = await events.subscriptions.subscribe(ctx.sessionId, subjectOf(a.subject), {
        ...(a.primary !== undefined ? { primary: !!a.primary } : {}),
        ...(a.types ? { types: a.types } : {}),
        ...(a.filter !== undefined ? { filter: a.filter } : {}),
        actor: kit.actor(ctx),
      })
      return ok({ subscriptionId: sub.id, subject: sub.data.subject as unknown as Json, primary: sub.data.primary })
    },
  )

  kit.tool(
    {
      name: 'subscriptions.unsubscribe',
      description: 'Stop receiving events about a thing.',
      effect: 'idempotent',
      params: { properties: { subject: subjectProp }, required: ['subject'] },
    },
    async (a, ctx) => {
      const subject = subjectOf(a.subject)
      await events.subscriptions.unsubscribe(ctx.sessionId, subject)
      return ok({ unsubscribed: subject as unknown as Json })
    },
  )

  kit.tool(
    {
      name: 'subscriptions.list',
      description: 'What this session is subscribed to.',
      effect: 'read',
    },
    async (_a, ctx) => {
      const subs = await events.subscriptions.forSession(ctx.sessionId)
      return ok({
        subscriptions: subs.map((s) => ({
          id: s.id,
          subject: s.data.subject as unknown as Json,
          primary: s.data.primary,
          ...(s.data.types ? { types: s.data.types } : {}),
          ...(s.data.filter !== undefined ? { filter: s.data.filter } : {}),
        })),
      })
    },
  )

  const ownTrigger = async (id: string, ctx: ToolContext): Promise<Trigger> => {
    const t = await events.triggers.get(id)
    if (!t || t.data.employeeId !== ctx.employeeId) throw new NotFoundError('trigger', id)
    return t
  }

  const checkTarget = async (target: unknown, ctx: ToolContext): Promise<TriggerTarget> => {
    if (target === undefined) return { type: 'session', sessionId: ctx.sessionId }
    const t = target as TriggerTarget
    if (t?.type === 'session') await kit.ownSession(t.sessionId, ctx)
    return t
  }

  kit.tool(
    {
      name: 'triggers.list',
      description: 'Your triggers: which new events are routed to which of your contexts.',
      effect: 'read',
      params: { properties: { enabled: { type: 'boolean' } } },
    },
    async (a, ctx) => {
      const list = await events.triggers.list({
        employeeId: ctx.employeeId,
        ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
      })
      return ok({ triggers: list.map(triggerView) })
    },
  )

  kit.tool(
    {
      name: 'triggers.create',
      description:
        'Create a trigger for yourself: new events that match go to a context (default: this session) as runs, optionally each in a fresh fork. Use subscriptions for things you already work on; triggers are for new work.',
      effect: 'non_idempotent',
      params: {
        properties: {
          name: { type: 'string' },
          match: matchProp,
          target: targetProp,
          fork: { type: 'boolean', description: 'Handle each event in a fork of the target. Default false.' },
          mode: { type: 'string', enum: ['continuing', 'ephemeral'], description: 'Default ephemeral.' },
          priority: { type: 'number', description: 'Higher matches first. Default 0.' },
          enabled: { type: 'boolean' },
        },
        required: ['name', 'match'],
      },
    },
    async (a, ctx) => {
      if (!str(a.name)) return fail('name is required')
      const t = await events.triggers.create(
        {
          name: a.name,
          employeeId: ctx.employeeId,
          match: a.match,
          target: await checkTarget(a.target, ctx),
          ...(a.fork !== undefined ? { fork: !!a.fork } : {}),
          ...(a.mode ? { mode: a.mode } : {}),
          ...(a.priority !== undefined ? { priority: a.priority } : {}),
          ...(a.enabled !== undefined ? { enabled: !!a.enabled } : {}),
        },
        kit.actor(ctx),
      )
      return ok(triggerView(t))
    },
  )

  kit.tool(
    {
      name: 'triggers.update',
      description: 'Change one of your triggers (name, match, target, fork, mode, priority, enabled).',
      effect: 'idempotent',
      params: {
        properties: {
          triggerId: { type: 'string' },
          name: { type: 'string' },
          match: matchProp,
          target: targetProp,
          fork: { type: 'boolean' },
          mode: { type: 'string', enum: ['continuing', 'ephemeral'] },
          priority: { type: 'number' },
          enabled: { type: 'boolean' },
        },
        required: ['triggerId'],
      },
    },
    async (a, ctx) => {
      await ownTrigger(a.triggerId, ctx)
      const patch: Partial<TriggerData> = {}
      for (const k of ['name', 'match', 'fork', 'mode', 'priority', 'enabled'] as const)
        if (a[k] !== undefined) (patch as any)[k] = a[k]
      if (a.target !== undefined) patch.target = await checkTarget(a.target, ctx)
      if (!Object.keys(patch).length) return fail('nothing to update')
      return ok(triggerView(await events.triggers.update(a.triggerId, patch, kit.actor(ctx))))
    },
  )

  kit.tool(
    {
      name: 'triggers.disable',
      description: 'Disable one of your triggers (it stays, and can be enabled again with triggers.update).',
      effect: 'idempotent',
      params: { properties: { triggerId: { type: 'string' } }, required: ['triggerId'] },
    },
    async (a, ctx) => {
      await ownTrigger(a.triggerId, ctx)
      return ok(triggerView(await events.triggers.update(a.triggerId, { enabled: false }, kit.actor(ctx))))
    },
  )
}
