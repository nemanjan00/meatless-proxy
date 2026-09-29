import { SUBSCRIPTION_PRESETS, subscriptionScope } from '../subscription-presets.ts'
import { NotFoundError, ValidationError, type Json } from '@mp/core'
import type { Subject, Trigger, TriggerPatch, TriggerTarget } from '@mp/events'
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

const scheduleProp = {
  type: 'object',
  description:
    'Fire on a schedule instead of on events: {cron, timezone?, graceSeconds?}, e.g. {cron:"0 9 * * 1-5", timezone:"Europe/Berlin"} for weekdays at 9:00. timezone is an IANA name (default UTC); graceSeconds is how late a missed firing may still fire (default 300). A schedule trigger has no match.',
  properties: {
    cron: { type: 'string' },
    timezone: { type: 'string' },
    graceSeconds: { type: 'number' },
  },
  required: ['cron'],
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
  ...(t.data.schedule ? { schedule: t.data.schedule as unknown as Json } : {}),
  ...(t.data.lastScheduledAt ? { lastScheduledAt: t.data.lastScheduledAt } : {}),
})

export function registerEventTools(kit: Kit): void {
  const { deps } = kit
  const { events } = deps

  kit.tool(
    {
      name: 'subscriptions.subscribe',
      description:
        'Have events about a thing (a ticket, a PR, a thread, a running environment, another session) delivered straight to this session, without routing. primary: true means you are the one expected to act on untagged events. By default you get the events that matter for that kind of thing (e.g. replies, comments, pipeline results), not everything: narrow further with types, a preset or a filter (MongoDB-style query), or pass all: true for every event.',
      effect: 'idempotent',
      params: {
        properties: {
          subject: subjectProp,
          types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Event type globs, e.g. ["comment.*"]. Default: the usual ones for this kind of subject.',
          },
          preset: {
            type: 'string',
            enum: Object.keys(SUBSCRIPTION_PRESETS),
            description: Object.entries(SUBSCRIPTION_PRESETS)
              .map(([k, v]) => `${k}: ${v.description}`)
              .join(' '),
          },
          filter: { type: 'object', description: 'e.g. {"payload.author.kind": "contact"}' },
          all: { type: 'boolean', description: 'Every event about the subject. Rarely what you want.' },
          primary: { type: 'boolean' },
        },
        required: ['subject'],
      },
    },
    async (a, ctx) => {
      const subject = subjectOf(a.subject)
      let scope: ReturnType<typeof subscriptionScope>
      try {
        scope = subscriptionScope(subject.system, {
          ...(a.types ? { types: a.types } : {}),
          ...(a.filter !== undefined ? { filter: a.filter } : {}),
          ...(a.preset ? { preset: String(a.preset) } : {}),
          ...(a.all ? { all: true } : {}),
        })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
      const sub = await events.subscriptions.subscribe(ctx.sessionId, subject, {
        ...(a.primary !== undefined ? { primary: !!a.primary } : {}),
        ...scope,
        actor: kit.actor(ctx),
      })
      return ok({
        subscriptionId: sub.id,
        subject: sub.data.subject as unknown as Json,
        primary: sub.data.primary,
        types: (sub.data.types ?? 'all') as Json,
        ...(sub.data.filter !== undefined ? { filter: sub.data.filter } : {}),
      })
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
        'Create a trigger for yourself: new events that match go to a context (default: this session) as runs, optionally each in a fresh fork. With a schedule instead of a match, it fires on that schedule (a schedule.fired event). Use subscriptions for things you already work on; triggers are for new work.',
      effect: 'non_idempotent',
      params: {
        properties: {
          name: { type: 'string' },
          match: matchProp,
          schedule: scheduleProp,
          target: targetProp,
          fork: { type: 'boolean', description: 'Handle each event in a fork of the target. Default false.' },
          mode: { type: 'string', enum: ['continuing', 'ephemeral'], description: 'Default ephemeral.' },
          priority: { type: 'number', description: 'Higher matches first. Default 0.' },
          enabled: { type: 'boolean' },
        },
        required: ['name'],
      },
    },
    async (a, ctx) => {
      if (!str(a.name)) return fail('name is required')
      if (a.match === undefined && a.schedule === undefined) return fail('give a match (which events) or a schedule')
      const t = await events.triggers.create(
        {
          name: a.name,
          employeeId: ctx.employeeId,
          ...(a.match !== undefined ? { match: a.match } : {}),
          ...(a.schedule !== undefined ? { schedule: a.schedule } : {}),
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
      description:
        'Change one of your triggers (name, match, schedule, target, fork, mode, priority, enabled). schedule: null turns a schedule trigger back into an event trigger.',
      effect: 'idempotent',
      params: {
        properties: {
          triggerId: { type: 'string' },
          name: { type: 'string' },
          match: matchProp,
          schedule: { ...scheduleProp, type: ['object', 'null'] },
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
      const patch: TriggerPatch = {}
      for (const k of ['name', 'match', 'schedule', 'fork', 'mode', 'priority', 'enabled'] as const)
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
