import type * as Api from '@mp/api'
import { describeStart } from '@mp/api'
import {
  ConflictError,
  DeniedError,
  NotFoundError,
  UnavailableError,
  ValidationError,
  isMpError,
  sleep,
  type Json,
  type KindSchema,
} from '@mp/core'
import type { Procedure, ProcedureData } from '@mp/directory'
import type { Trigger } from '@mp/events'
import type { Actor } from '@mp/store'
import { type Context, Hono } from 'hono'
import { principalOf, viewerOf } from '../auth/guard.ts'
import { ChatVisibility, PRIVATE_TITLE } from '../auth/visibility.ts'
import { BadRequestError, jsonBody, requireString } from '../http/util.ts'
import { actorOf } from '../http/views.ts'
import type { Services } from '../services.ts'
import { DEFAULT_SETTINGS, SettingNames } from '../settings.ts'
import { matchFor, nameFor, parseStart, triggerInputFor } from './starts.ts'
import { ProcedureViews } from './views.ts'

export { CATCH_ALL_START, matchFor, parseStart, startOf, triggerInputFor } from './starts.ts'
export { ProcedureViews } from './views.ts'

/**
 * The procedures API (docs/spec.md#procedures, `@mp/api` procedures.ts): procedures with how they
 * start, their runs and their context, created with their triggers and context in one call, run
 * now, and rebuilt. Reads are for everyone signed in; writes for members; triggers for admins
 * (as in the records API, where triggers are admin-only).
 */

/** Remembers the result of a create or run by its idempotency key, so a double submit returns the first. */
const REQUEST_KIND = 'procedure_request'
const requestSchema: KindSchema = {
  kind: REQUEST_KIND,
  prefix: 'prq',
  description: 'The result of a procedure create or run, by idempotency key: a repeated request returns it.',
  core: [
    { name: 'op', type: 'string', required: true },
    { name: 'state', type: 'enum', values: ['pending', 'done'], required: true },
    { name: 'result', type: 'json' },
  ],
}
/** How long a repeated request waits for the first one to finish. */
const WAIT_MS = 10_000
const MAX_KEY = 200

const TRIGGERS_ADMIN = 'only admins decide when a procedure runs: its triggers route company events'

const isAdmin = (c: Context) => principalOf(c).access === 'admin'
const requireAdmin = (c: Context) => {
  if (!isAdmin(c)) throw new DeniedError(TRIGGERS_ADMIN)
}

function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new BadRequestError(`${name} must be a string`)
  return v.trim() || undefined
}

export function procedureRoutes(s: Services): Hono {
  const app = new Hono()
  if (!s.records.kinds.has(REQUEST_KIND)) s.records.kinds.define(requestSchema)
  const views = () => new ProcedureViews(s)
  const actor = (c: Context): Actor => actorOf(principalOf(c).contactId)
  const locks = new Map<string, Promise<unknown>>()

  /**
   * Runs `fn` once per idempotency key: a repeat (concurrent or later, in any process) gets the
   * first result. Without a key it just runs. A failed first attempt frees the key.
   */
  const once = async <T extends Json>(
    key: string | undefined,
    op: string,
    fn: () => Promise<T>,
  ): Promise<{ result: T; first: boolean }> => {
    if (!key) return { result: await fn(), first: true }
    if (key.length > MAX_KEY) throw new BadRequestError(`idempotencyKey must be at most ${MAX_KEY} characters`)
    const k = `${op}:${key}`
    const prev = locks.get(k) ?? Promise.resolve()
    const attempt = async (): Promise<{ result: T; first: boolean }> => {
      for (;;) {
        let reserved: { id: string } | null = null
        try {
          reserved = await s.records.create(REQUEST_KIND, { op, state: 'pending' }, { key: k })
        } catch (e) {
          if (!isMpError(e, 'conflict')) throw e
        }
        if (reserved) {
          try {
            const result = await fn()
            await s.records.update(REQUEST_KIND, reserved.id, { state: 'done', result })
            return { result, first: true }
          } catch (e) {
            await s.records.delete(REQUEST_KIND, reserved.id).catch(() => {})
            throw e
          }
        }
        // Another process has it: wait for its result (or for it to fail and free the key).
        for (let waited = 0; ; waited += 100) {
          const existing = await s.records.getByKey<{ state: string; result?: T }>(REQUEST_KIND, k)
          if (!existing) break
          if (existing.data.state === 'done') return { result: existing.data.result as T, first: false }
          if (waited >= WAIT_MS) throw new ConflictError('the same request is still being handled: try again in a moment')
          await sleep(100)
        }
      }
    }
    const run = prev.then(attempt)
    const tail = run.catch(() => {})
    locks.set(k, tail)
    void tail.then(() => {
      if (locks.get(k) === tail) locks.delete(k)
    })
    return run
  }

  const requireProcedure = async (id: string): Promise<Procedure> => s.directory.procedures.require(id)
  const contexts = () => {
    if (!s.procedureContexts) throw new UnavailableError('procedure contexts need the standard library, which is turned off')
    return s.procedureContexts
  }

  const parseApprovals = async (raw: unknown): Promise<ProcedureData['approvals']> => {
    if (raw === undefined || raw === null) return undefined
    if (!Array.isArray(raw)) throw new BadRequestError('approvals must be a list of { contactId | role, step? }')
    const out: NonNullable<ProcedureData['approvals']> = []
    for (const a of raw) {
      const contactId = optString(a?.contactId, 'approvals[].contactId')
      const role = optString(a?.role, 'approvals[].role')
      const step = optString(a?.step, 'approvals[].step')
      if (!contactId && !role) throw new BadRequestError('each approval needs a contact or a role')
      if (contactId) await s.directory.contacts.require(contactId)
      out.push({ ...(contactId ? { contactId } : {}), ...(role ? { role } : {}), ...(step ? { step } : {}) })
    }
    return out
  }

  /** The procedure's triggers, or a 404 for one that isn't. */
  const ownTrigger = async (p: Procedure, triggerId: string): Promise<Trigger> => {
    const v = views()
    const ctx = (await v.contexts(p)).map((x) => x.id)
    const t = (await v.triggers(p, ctx)).find((x) => x.id === triggerId)
    if (!t) throw new NotFoundError('trigger of this procedure', triggerId)
    return t
  }

  /** Creates a trigger for a start and remembers the start on it. */
  const addTrigger = async (
    p: Procedure,
    start: Api.ProcedureStart,
    o: { employeeId: string; name?: string; enabled?: boolean },
    a: Actor,
  ) => {
    const name = o.name ?? (await defaultName(start))
    const input = triggerInputFor(start, {
      procedureId: p.id,
      employeeId: o.employeeId,
      name: name || p.data.name,
      ...(o.enabled !== undefined ? { enabled: o.enabled } : {}),
    })
    const t = await s.events.triggers.create(input, a)
    await s.records.update('trigger', t.id, { start: start as unknown as Json }, { actor: a })
    return t
  }

  /** A schedule without a time zone runs in the company's (the `timezone` setting). */
  const withTimezone = async (start: Api.ProcedureStart): Promise<Api.ProcedureStart> =>
    start.kind === 'schedule' && !start.timezone
      ? { ...start, timezone: (await s.settings.get<string>(SettingNames.timezone)) || DEFAULT_SETTINGS.timezone }
      : start

  /** A trigger's default name: its start in words, e.g. "Someone posts in #access-requests". */
  const defaultName = async (start: Api.ProcedureStart) => {
    const channel = start.kind === 'channel' ? await views().channelName(start.channelId) : undefined
    const words = describeStart(start, () => channel).replace(/^When /, '')
    return nameFor(words.charAt(0).toUpperCase() + words.slice(1))
  }

  /** The employee a new trigger belongs to: the one given, else the context's, else another trigger's. */
  const employeeFor = async (p: Procedure, given: string | undefined): Promise<string> => {
    if (given) return (await s.directory.employees.require(given)).id
    const ctx = p.data.contextSessionId ? await s.sessions.get(p.data.contextSessionId) : null
    if (ctx) return ctx.data.employeeId
    const v = views()
    const t = (await v.triggers(p, [])).at(0)
    if (t) return t.data.employeeId
    throw new ValidationError('say which employee runs this procedure (employeeId)')
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  app.get('/api/procedures', async (c) => {
    const q = c.req.query()
    const all: Procedure[] = []
    for (let offset = 0; ; offset += 200) {
      const page = await s.directory.procedures.list({
        ...(q.text ? { text: q.text } : {}),
        orderBy: { field: 'name', dir: 'asc' },
        limit: 200,
        offset,
      })
      all.push(...page.items)
      if (page.items.length < 200) break
    }
    const archived = q.archived === 'true' || q.archived === '1'
    const shown = all.filter((p) => (archived || p.data.archived !== true) && (!q.ownerId || p.data.ownerId === q.ownerId))
    const v = views()
    const items: Api.ProcedureListItem[] = []
    for (const p of shown) items.push(await v.listItem(p))
    return c.json(items)
  })

  app.get('/api/procedures/:id', async (c) => {
    const detail = await views().detail(await requireProcedure(c.req.param('id')))
    // Instances that came from a DM: their members only; admins see that they exist (src/auth/visibility.ts).
    const vis = new ChatVisibility(s)
    const viewer = viewerOf(principalOf(c))
    const runs: Api.ProcedureRun[] = []
    for (const r of detail.runs) {
      const access = await vis.sessionAccess(viewer, await s.sessions.get(r.sessionId))
      if (access === 'full') runs.push(r)
      else if (access === 'redacted') {
        const { outcome: _, ...rest } = r
        runs.push({ ...rest, title: PRIVATE_TITLE, startedBy: { type: 'system', label: '' } })
      }
    }
    return c.json({ ...detail, runs })
  })

  // ── Creating ─────────────────────────────────────────────────────────────

  app.post('/api/procedures', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    const name = requireString(body.name, 'name').trim()
    const applies = requireString(body.applies, 'applies').trim()
    const employeeId = (await s.directory.employees.require(requireString(body.employeeId, 'employeeId'))).id
    const ownerId = optString(body.ownerId, 'ownerId')
    if (ownerId) await s.directory.contacts.require(ownerId)
    const text = optString(body.body, 'body')
    const approvals = await parseApprovals(body.approvals)
    if (body.projectIds !== undefined && (!Array.isArray(body.projectIds) || body.projectIds.some((x) => typeof x !== 'string')))
      throw new BadRequestError('projectIds must be a list of project ids')
    if (body.starts !== undefined && !Array.isArray(body.starts)) throw new BadRequestError('starts must be a list')
    const starts: Api.ProcedureStart[] = []
    for (const raw of (body.starts as unknown[] | undefined) ?? []) starts.push(await withTimezone(parseStart(raw)))
    if (starts.length) requireAdmin(c)
    // Every start is checked before anything is written: a catch-all refuses the whole create.
    for (const st of starts) matchFor(st)
    const key = optString(body.idempotencyKey, 'idempotencyKey')
    const a = actor(c)
    const { result, first } = await once(key, 'create', async () => {
      const p = await s.directory.procedures.create(
        {
          name,
          applies,
          ...(text ? { body: text } : {}),
          ...(ownerId ? { ownerId } : {}),
          ...(approvals?.length ? { approvals } : {}),
          ...(body.projectIds ? { projectIds: body.projectIds as string[] } : {}),
        },
        { actor: a },
      )
      const made: Trigger[] = []
      try {
        if (s.procedureContexts) await s.procedureContexts.ensure(p.id, employeeId, { actor: a })
        for (const st of starts) made.push(await addTrigger(p, st, { employeeId }, a))
      } catch (e) {
        // Nothing half-made: the procedure goes, with its triggers and context.
        for (const t of made) await s.events.triggers.remove(t.id).catch(() => {})
        const ctx = (await s.directory.procedures.get(p.id))?.data.contextSessionId
        if (ctx) await s.sessions.update(ctx, { status: 'abandoned' }).catch(() => {})
        await s.records.delete('procedure', p.id, { cascade: true }).catch(() => {})
        throw e
      }
      return p.id
    })
    const detail = await views().detail(await requireProcedure(result))
    return c.json({ created: first, procedure: detail } satisfies Api.CreatedProcedure, first ? 201 : 200)
  })

  // ── Running ──────────────────────────────────────────────────────────────

  app.post('/api/procedures/:id/run', async (c) => {
    const p = await requireProcedure(c.req.param('id'))
    const body = await jsonBody<Record<string, unknown>>(c)
    const work = optString(body.work, 'work')
    const employeeId = optString(body.employeeId, 'employeeId')
    if (employeeId) await s.directory.employees.require(employeeId)
    const pc = contexts()
    const me = principalOf(c)
    const { result } = await once(optString(body.idempotencyKey, 'idempotencyKey'), `run:${p.id}`, async () => {
      const started = await pc.start(p.id, {
        ...(employeeId ? { employeeId } : {}),
        ...(work ? { work } : {}),
        requesterId: me.contactId,
        actor: actorOf(me.contactId),
        note: `run now by ${me.name}`,
      })
      return started as unknown as Json
    })
    return c.json(result as unknown as Api.ProcedureRunStarted, 201)
  })

  app.post('/api/procedures/:id/context/rebuild', async (c) => {
    const p = await requireProcedure(c.req.param('id'))
    const body = await jsonBody<Record<string, unknown>>(c)
    const employeeId = optString(body.employeeId, 'employeeId')
    if (employeeId) await s.directory.employees.require(employeeId)
    await contexts().rebuild(p.id, { ...(employeeId ? { employeeId } : {}), actor: actor(c) })
    return c.json(await views().detail(await requireProcedure(p.id)))
  })

  app.post('/api/procedures/:id/archive', async (c) => {
    const p = await requireProcedure(c.req.param('id'))
    const body = await jsonBody<Record<string, unknown>>(c)
    if (typeof body.archived !== 'boolean') throw new BadRequestError('archived must be true or false')
    const a = actor(c)
    await s.directory.procedures.update(p.id, { archived: body.archived }, { actor: a })
    // An archived procedure doesn't run: its triggers go off (turning them back on is an admin's call).
    if (body.archived) {
      const v = views()
      for (const t of await v.triggers(
        p,
        (await v.contexts(p)).map((x) => x.id),
      ))
        if (t.data.enabled) await s.events.triggers.update(t.id, { enabled: false }, a)
    }
    return c.json(await views().detail(await requireProcedure(p.id)))
  })

  // ── Triggers (admins) ────────────────────────────────────────────────────

  app.post('/api/procedures/:id/triggers', async (c) => {
    requireAdmin(c)
    const p = await requireProcedure(c.req.param('id'))
    const body = await jsonBody<Record<string, unknown>>(c)
    const start = await withTimezone(parseStart(body.start))
    matchFor(start)
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean')
    const employeeId = await employeeFor(p, optString(body.employeeId, 'employeeId'))
    const name = optString(body.name, 'name')
    await addTrigger(
      p,
      start,
      { employeeId, ...(name ? { name } : {}), ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}) },
      actor(c),
    )
    return c.json(await views().detail(await requireProcedure(p.id)), 201)
  })

  app.patch('/api/procedures/:id/triggers/:triggerId', async (c) => {
    requireAdmin(c)
    const p = await requireProcedure(c.req.param('id'))
    const t = await ownTrigger(p, c.req.param('triggerId'))
    const body = await jsonBody<Record<string, unknown>>(c)
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean')
    const name = optString(body.name, 'name')
    const employeeId = optString(body.employeeId, 'employeeId')
    if (employeeId) await s.directory.employees.require(employeeId)
    const patch: Record<string, unknown> = {
      ...(name ? { name } : {}),
      ...(employeeId ? { employeeId } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    }
    if (body.start !== undefined) {
      const start = await withTimezone(parseStart(body.start))
      const { match, schedule } = matchFor(start)
      Object.assign(patch, { match, schedule: schedule ?? null, start })
      // A trigger this API named after its start is renamed with it.
      if (!name && (t.data as { start?: unknown }).start) patch.name = await defaultName(start)
    }
    await s.events.triggers.update(t.id, patch as never, actor(c))
    return c.json(await views().detail(await requireProcedure(p.id)))
  })

  app.delete('/api/procedures/:id/triggers/:triggerId', async (c) => {
    requireAdmin(c)
    const p = await requireProcedure(c.req.param('id'))
    const t = await ownTrigger(p, c.req.param('triggerId'))
    await s.events.triggers.remove(t.id, actor(c))
    return c.json(await views().detail(await requireProcedure(p.id)))
  })

  return app
}
