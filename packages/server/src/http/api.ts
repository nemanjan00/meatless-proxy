import type * as Api from '@mp/api'
import type { Message as DomainMessage } from '@mp/chat'
import type { Checklist as DomainChecklist } from '@mp/checklists'
import { ConflictError, DeniedError, NotFoundError, isMpError, type Json } from '@mp/core'
import type { MpEvent } from '@mp/events'
import type { SecretScope as DomainScope } from '@mp/secrets'
import { TERMINAL_RUN_STATES, type RunState, type SessionStatus } from '@mp/sessions'
import { normalizeWhere, type Condition, type StoredRecord } from '@mp/store'
import type { UsageData } from '@mp/usage'
import { Hono, type Context } from 'hono'
import { AUTH_KINDS } from '../auth/access.ts'
import { principalOf } from '../auth/guard.ts'
import type { ChatVisibility } from '../auth/visibility.ts'
import type { Services } from '../services.ts'
import { rotateSshKey } from '../ssh.ts'
import { lineage } from './lineage.ts'
import { BadRequestError, boolParam, intParam, jsonBody, requireString } from './util.ts'
import {
  Views,
  actorOf,
  checklistCounts,
  emptyTotals,
  mapChecklist,
  mapEvent,
  mapSubscription,
  isUnmatched,
  toJson,
  usageFilter,
} from './views.ts'
import type { NowTracker } from '../live.ts'

/** Kinds the generic records API never exposes: secrets and credentials. */
const HIDDEN_KINDS = new Set<string>(['secret', ...AUTH_KINDS])
/** Kinds whose records can belong to a DM (and are then visible to its members only). */
const CHAT_KINDS = new Set(['channel', 'message', 'event'])

const LIVE_STATES: RunState[] = ['queued', 'running', 'suspended', 'paused']
const ALL_STATES: RunState[] = ['queued', 'running', 'suspended', 'paused', 'completed', 'failed', 'cancelled']

export interface ApiDeps {
  services: Services
  tracker: NowTracker
  version: string
  /** Whether migrations are applied (for /readyz). */
  migrationsReady: () => Promise<boolean>
  /** Who may see which chat (DMs: their members only). */
  visibility: ChatVisibility
}

/** The signed-in contact making the request (see src/auth: there is no other way to say who you are). */
export async function currentContact(_s: Services, c: Context): Promise<string> {
  return principalOf(c).contactId
}

/**
 * @deprecated There is no default web user any more: everyone signs in. Kept as a no-op
 * until bootstrap.ts stops calling it.
 */
export async function defaultWebContact(_s: Services): Promise<string> {
  return ''
}

const toApiScope = (s: DomainScope): Api.SecretScope =>
  s.type === 'global' ? { type: 'global' } : s.type === 'tool' ? { type: 'tool', id: s.name } : { type: s.type, id: s.id }

function toDomainScope(type: unknown, id: unknown): DomainScope {
  if (type === 'global' || type === undefined || type === '') return { type: 'global' }
  if (typeof id !== 'string' || !id) throw new BadRequestError('scope id is required for employee, project and tool scopes')
  if (type === 'employee' || type === 'project') return { type, id }
  if (type === 'tool') return { type: 'tool', name: id }
  throw new BadRequestError('scope type must be global, employee, project or tool')
}

function parseWhere(raw: string | undefined): Record<string, Json> | Condition[] | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object') return v
  } catch {}
  throw new BadRequestError('where must be URL-encoded JSON: an object or a list of { field, op, value }')
}

const isoHour = (at: string) => `${at.slice(0, 13)}:00:00.000Z`
const isoDay = (at: string) => `${at.slice(0, 10)}T00:00:00.000Z`

/** The HTTP API of `@mp/api`, as a hono app mounted at the root. */
export function apiRoutes(deps: ApiDeps): Hono {
  const s = deps.services
  const app = new Hono()
  const views = () => new Views(s)
  const actor = async (c: Context) => actorOf(await currentContact(s, c))
  const vis = deps.visibility
  const me_ = (c: Context) => principalOf(c).contactId

  /** Extra conditions hiding DM channels (and their messages and chat events) from people who aren't members. */
  const dmFilter = async (c: Context, kind: string): Promise<Condition[]> => {
    if (!CHAT_KINDS.has(kind)) return []
    const hidden = [...(await vis.hiddenChannels(me_(c)))]
    if (!hidden.length) return []
    const field = kind === 'channel' ? 'id' : kind === 'message' ? 'channelId' : 'payload.channelId'
    return [{ field, op: 'nin', value: hidden }]
  }
  /** 404 for a record in a DM the caller isn't in. */
  const requireVisible = async <R extends StoredRecord | null>(c: Context, r: R): Promise<R> => {
    if (r && CHAT_KINDS.has(r.kind) && !(await vis.canSeeRecord(me_(c), r))) throw new NotFoundError(r.kind, r.id)
    return r
  }
  /** Only admins change who may do what, or anything of a session but its document and title. */
  const guardAccessField = (c: Context, kind: string, data: Record<string, unknown>) => {
    if (principalOf(c).access === 'admin') return
    if (kind === 'contact' && 'access' in data) throw new DeniedError("only admins can change someone's access")
    if (kind === 'session' && Object.keys(data).some((k) => k !== 'document' && k !== 'title'))
      throw new DeniedError("members can edit a session's document and title only")
  }

  const visibleKind = (kind: string) => {
    if (HIDDEN_KINDS.has(kind) || !s.records.kinds.has(kind)) throw new NotFoundError('record kind', kind)
    return kind
  }

  // ── Records ──────────────────────────────────────────────────────────────

  app.get('/api/kinds', (c) => c.json(s.records.kinds.list().filter((k) => !HIDDEN_KINDS.has(k.kind)) as Api.ApiKindSchema[]))

  app.get('/api/records/:kind', async (c) => {
    const kind = visibleKind(c.req.param('kind'))
    const q = c.req.query()
    const parsed = parseWhere(q.where)
    const hide = await dmFilter(c, kind)
    const where = hide.length ? [...normalizeWhere(parsed), ...hide] : parsed
    const page = await s.records.query(kind, {
      ...(where ? { where } : {}),
      ...(q.text ? { text: q.text } : {}),
      orderBy: { field: q.orderBy || 'updatedAt', dir: q.dir === 'asc' ? 'asc' : 'desc' },
      limit: intParam(q.limit, 'limit', 50, 500, 1),
      offset: intParam(q.offset, 'offset', 0),
    })
    return c.json(page satisfies Api.Page<Api.ApiRecord>)
  })

  app.get('/api/records/:kind/:id', async (c) =>
    c.json(await requireVisible(c, await s.records.require(visibleKind(c.req.param('kind')), c.req.param('id')))),
  )

  app.post('/api/records/:kind', async (c) => {
    const kind = visibleKind(c.req.param('kind'))
    const body = await jsonBody<{ data?: unknown; key?: unknown }>(c)
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data))
      throw new BadRequestError('data must be an object')
    if (body.key !== undefined && typeof body.key !== 'string') throw new BadRequestError('key must be a string')
    guardAccessField(c, kind, body.data as Record<string, unknown>)
    const r = await s.records.create(kind, body.data as Record<string, unknown>, {
      actor: await actor(c),
      ...(typeof body.key === 'string' ? { key: body.key } : {}),
    })
    return c.json(r, 201)
  })

  app.patch('/api/records/:kind/:id', async (c) => {
    const kind = visibleKind(c.req.param('kind'))
    const id = c.req.param('id')
    const body = await jsonBody<{ data?: unknown; version?: unknown }>(c)
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data))
      throw new BadRequestError('data must be an object')
    if (body.version !== undefined && typeof body.version !== 'number') throw new BadRequestError('version must be a number')
    guardAccessField(c, kind, body.data as Record<string, unknown>)
    await requireVisible(c, await s.records.get(kind, id))
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body.data as Record<string, unknown>)) patch[k] = v === null ? undefined : v
    try {
      const r = await s.records.update(kind, id, patch, {
        actor: await actor(c),
        ...(typeof body.version === 'number' ? { expectedVersion: body.version } : {}),
      })
      return c.json(r)
    } catch (e) {
      if (isMpError(e, 'conflict')) {
        const current = await s.records.get(kind, id)
        throw new ConflictError(e.message, { current })
      }
      throw e
    }
  })

  app.delete('/api/records/:kind/:id', async (c) => {
    const kind = visibleKind(c.req.param('kind'))
    const id = c.req.param('id')
    const current = await requireVisible(c, await s.records.require(kind, id))
    const version = c.req.query('version')
    if (version !== undefined && version !== '' && Number(version) !== current.version)
      throw new ConflictError(`${kind} ${id} is at version ${current.version}`, { current })
    await s.records.delete(kind, id, { actor: await actor(c), cascade: boolParam(c.req.query('cascade')) })
    return c.body(null, 204)
  })

  app.get('/api/records/:kind/:id/links', async (c) => {
    const kind = visibleKind(c.req.param('kind'))
    const id = c.req.param('id')
    await requireVisible(c, await s.records.require(kind, id))
    const dir = c.req.query('direction')
    if (dir && !['out', 'in', 'both'].includes(dir)) throw new BadRequestError('direction must be out, in or both')
    const role = c.req.query('role')
    const linked = await s.records.linked(
      { kind, id },
      { direction: (dir as 'out' | 'in' | 'both') || 'both', ...(role ? { role } : {}) },
    )
    const shown = []
    for (const l of linked)
      if (!HIDDEN_KINDS.has(l.record.kind) && (await vis.canSeeRecord(me_(c), l.record as StoredRecord))) shown.push(l)
    return c.json(shown satisfies Api.ApiLinkedRecord[])
  })

  app.post('/api/records/:kind/:id/links', async (c) => {
    const kind = visibleKind(c.req.param('kind'))
    const id = c.req.param('id')
    const body = await jsonBody<{ to?: { kind?: unknown; id?: unknown }; role?: unknown; data?: unknown }>(c)
    const toKind = requireString(body.to?.kind, 'to.kind')
    const toId = requireString(body.to?.id, 'to.id')
    const role = requireString(body.role, 'role')
    visibleKind(toKind)
    const link = await s.records.link(
      { kind, id },
      { kind: toKind, id: toId },
      role,
      body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {},
      { actor: await actor(c) },
    )
    return c.json(link satisfies Api.ApiLink, 201)
  })

  app.delete('/api/links/:id', async (c) => {
    const link = await s.store.links.get(c.req.param('id'))
    if (!link) throw new NotFoundError('link', c.req.param('id'))
    await s.store.links.unlink(link.id, { actor: await actor(c) })
    return c.body(null, 204)
  })

  app.get('/api/records/:kind/:id/revisions', async (c) => {
    const kind = visibleKind(c.req.param('kind'))
    await requireVisible(c, await s.records.get(kind, c.req.param('id')))
    const revs = await s.records.revisions(kind, c.req.param('id'))
    if (!revs.length) throw new NotFoundError(kind, c.req.param('id'))
    return c.json(revs satisfies Api.ApiRevision[])
  })

  app.get('/api/records/:kind/:id/backlinks', async (c) => {
    const kind = visibleKind(c.req.param('kind'))
    const id = c.req.param('id')
    await requireVisible(c, await s.records.require(kind, id))
    return c.json((await s.records.backlinks({ kind, id })).filter((r) => !HIDDEN_KINDS.has(r.kind)) satisfies Api.ApiRecord[])
  })

  // ── Sessions and runs ────────────────────────────────────────────────────

  app.get('/api/sessions', async (c) => {
    const q = c.req.query()
    const status = q.status
      ? (q.status
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean) as SessionStatus[])
      : undefined
    const page = await s.sessions.query({
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(status?.length ? { status } : {}),
      ...(q.rootId ? { rootId: q.rootId } : {}),
      ...(q.text ? { text: q.text } : {}),
      limit: intParam(q.limit, 'limit', 50, 500, 1),
      offset: intParam(q.offset, 'offset', 0),
    })
    const v = views()
    const items = await Promise.all(page.items.map((x) => v.sessionListItem(x)))
    return c.json({ items, total: page.total } satisfies Api.Page<Api.SessionListItem>)
  })

  app.get('/api/sessions/:id', async (c) => {
    const session = await s.sessions.require(c.req.param('id'))
    const v = views()
    const [employee, checklist, runs, links, tokens, subs] = await Promise.all([
      v.employeeSummary(session.data.employeeId),
      s.records.getByKey<DomainChecklist['data']>('checklist', session.id),
      v.runsOf(session.id),
      s.records.linked({ kind: 'session', id: session.id }),
      v.tokens({ sessionId: session.id }),
      s.events.subscriptions.forSession(session.id),
    ])
    const live = runs.filter((r) => !TERMINAL_RUN_STATES.includes(r.data.state))
    const activeRun = live.find((r) => r.data.mode === 'continuing') ?? live.at(-1) ?? null
    const threads: Api.SessionDetail['threads'] = []
    for (const sub of subs) {
      if (sub.data.subject.system !== 'mp' || !sub.data.subject.id.startsWith('msg_')) continue
      const msg = await s.chat.getMessage(sub.data.subject.id)
      if (!msg) continue
      threads.push({ channelId: msg.data.channelId, threadId: msg.id, title: msg.data.text.slice(0, 80) })
    }
    // Threads the session posted in without subscribing (e.g. a router's ephemeral runs replying).
    const posted = await s.records.query<DomainMessage['data']>('message', {
      where: { 'author.kind': 'session', 'author.id': session.id },
      orderBy: { field: 'createdAt', dir: 'desc' },
      limit: 50,
    })
    for (const m of posted.items) {
      const rootId = m.data.threadId ?? m.id
      if (threads.some((t) => t.threadId === rootId)) continue
      const root = rootId === m.id ? m : await s.chat.getMessage(rootId)
      if (root) threads.push({ channelId: root.data.channelId, threadId: root.id, title: root.data.text.slice(0, 80) })
    }
    const hidden = await vis.hiddenChannels(me_(c))
    return c.json({
      session: session as Api.Session,
      employee,
      checklist: checklist ? mapChecklist(checklist as DomainChecklist) : null,
      activeRun: activeRun as Api.Run | null,
      links: links.filter((l) => !HIDDEN_KINDS.has(l.record.kind) && !(l.record.kind === 'channel' && hidden.has(l.record.id))),
      tokens,
      threads: threads.filter((t) => !hidden.has(t.channelId)),
    } satisfies Api.SessionDetail)
  })

  app.get('/api/sessions/:id/history', async (c) => c.json((await s.sessions.history(c.req.param('id'))) as Api.ApiEntry[]))

  app.get('/api/sessions/:id/tree', async (c) => {
    const tree = await s.sessions.tree(c.req.param('id'))
    const v = views()
    const build = async (n: typeof tree, siblings: (typeof tree)[] = []): Promise<Api.SessionTreeNode> => {
      const d = n.session.data
      const loopMeta = d.meta?.loop as { index?: number; of?: number } | undefined
      const loop = loopMeta
        ? {
            ...loopMeta,
            of:
              loopMeta.of ??
              siblings.filter((x) => x.session.data.meta?.loop && x.session.data.parent?.entryId === d.parent?.entryId).length,
          }
        : undefined
      const [employee, runState, tokens, children] = await Promise.all([
        v.employeeSummary(d.employeeId),
        v.latestRunState(n.session.id),
        v.tokens({ sessionId: n.session.id }),
        Promise.all(n.children.map((ch) => build(ch, n.children))),
      ])
      return {
        id: n.session.id,
        title: d.title,
        slug: d.slug,
        status: d.status,
        employee,
        origin: !d.parent ? 'root' : loop ? 'loop' : 'fork',
        ...(loop && typeof loop.index === 'number' && typeof loop.of === 'number'
          ? { loop: { index: loop.index, of: loop.of } }
          : {}),
        runState,
        tokens: tokens.total,
        createdAt: n.session.createdAt,
        children,
      }
    }
    return c.json(await build(tree))
  })

  app.get('/api/sessions/:id/entry-tree', async (c) => {
    const session = await s.sessions.require(c.req.param('id'))
    const runs = await s.sessions.runs({ sessionId: session.id })
    const byId = new Map<string, Api.ApiEntry>()
    const add = (es: Api.ApiEntry[]) => {
      for (const e of es) byId.set(e.id, e)
    }
    add((await s.sessions.history(session.id)) as Api.ApiEntry[])
    for (const r of runs) add((await s.sessions.runHistory(r.id)) as Api.ApiEntry[])
    // Rewound branches and offloaded entries hang off summaries and pointers.
    for (const e of [...byId.values()]) {
      const content = e.content as Record<string, unknown> | null
      if (e.kind === 'summary' && typeof content?.replacesTip === 'string')
        add((await s.store.entries.path(content.replacesTip)) as Api.ApiEntry[])
      if (e.kind === 'pointer' && typeof content?.original === 'string') {
        const orig = await s.store.entries.get(content.original)
        if (orig) add([orig as Api.ApiEntry])
      }
    }
    const entries = [...byId.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
    )
    return c.json({
      sessionId: session.id,
      head: session.data.head,
      entries,
      runs: runs.map((r) => ({ id: r.id, mode: r.data.mode, state: r.data.state, base: r.data.base, tip: r.data.tip })),
    } satisfies Api.EntryTree)
  })

  app.get('/api/sessions/:id/runs', async (c) => {
    const session = await s.sessions.require(c.req.param('id'))
    return c.json((await s.sessions.runs({ sessionId: session.id })).reverse() as Api.Run[])
  })

  app.get('/api/subscriptions', async (c) => {
    const sessionId = c.req.query('sessionId')
    const subs = sessionId
      ? await s.events.subscriptions.forSession(sessionId)
      : (await s.records.query<any>('subscription', { orderBy: { field: 'createdAt', dir: 'desc' }, limit: 500 })).items
    const out = subs.map(mapSubscription)
    // Chat threads have no title of their own: use the start of the thread's first message.
    const titles = new Map<string, string>()
    for (const sub of out) {
      const ref = sub.data.subject.ref
      if (sub.data.subject.system !== 'mp' || !ref.startsWith('msg_') || sub.data.subject.title || titles.has(ref)) continue
      const msg = await s.chat.getMessage(ref)
      if (msg && (await vis.canSeeChannel(me_(c), msg.data.channelId)))
        titles.set(ref, msg.data.text.replace(/\s+/g, ' ').slice(0, 80))
    }
    for (const sub of out) {
      const title = titles.get(sub.data.subject.ref)
      if (title && !sub.data.subject.title) sub.data.subject = { ...sub.data.subject, title }
    }
    return c.json(out satisfies Api.Subscription[])
  })

  app.post('/api/sessions/:id/fork', async (c) => {
    const body = await jsonBody<{ atEntry?: unknown; title?: unknown }>(c)
    if (body.atEntry !== undefined && body.atEntry !== null && typeof body.atEntry !== 'string')
      throw new BadRequestError('atEntry must be an entry id')
    if (body.title !== undefined && typeof body.title !== 'string') throw new BadRequestError('title must be a string')
    const fork = await s.sessions.fork(c.req.param('id'), {
      ...(body.atEntry !== undefined ? { atEntry: body.atEntry as string | null } : {}),
      ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title } : {}),
      actor: await actor(c),
    })
    return c.json(fork as Api.Session, 201)
  })

  app.post('/api/sessions/:id/message', async (c) => {
    const session = await s.sessions.require(c.req.param('id'))
    const body = await jsonBody<{ text?: unknown }>(c)
    const text = requireString(body.text, 'text')
    const contactId = await currentContact(s, c)
    const { event } = await s.rawEvents.ingest({
      source: 'ui',
      type: 'message.posted',
      subject: { system: 'mp', id: session.id },
      actorContactId: contactId,
      payload: { text, sessionId: session.id },
      text,
      dedupeKey: `ui:${session.id}:${s.clock.now()}:${Math.random().toString(36).slice(2)}`,
    })
    const outcome = await s.router.deliver(event, {
      sessionId: session.id,
      reason: 'session_tag',
      expectedToAct: true,
      trusted: true,
      fork: false,
      priority: 10,
    })
    await s.rawEvents.markRouted(event.id)
    const routed = await s.records.update('event', event.id, {
      routing: toJson({
        at: s.clock.iso(),
        deliveries: [
          {
            sessionId: session.id,
            reason: 'session_tag',
            expectedToAct: true,
            trusted: true,
            fork: false,
            outcome: { ...outcome },
          },
        ],
        triggerIds: [],
        subscriptionIds: [],
      }),
    })
    if (outcome.type === 'skipped') throw new ConflictError(`not delivered: ${outcome.reason}`)
    return c.json({
      event: mapEvent(routed as unknown as MpEvent),
      runId: outcome.runId,
      inbox: outcome.type === 'inbox' || outcome.type === 'woke',
    })
  })

  app.get('/api/entries/:id/children', async (c) => {
    const id = c.req.param('id')
    if (!(await s.store.entries.get(id))) throw new NotFoundError('entry', id)
    return c.json((await s.store.entries.children(id)) as Api.ApiEntry[])
  })

  app.get('/api/runs/:id', async (c) => c.json((await s.sessions.requireRun(c.req.param('id'))) as Api.Run))
  app.get('/api/runs/:id/history', async (c) => c.json((await s.sessions.runHistory(c.req.param('id'))) as Api.ApiEntry[]))

  app.post('/api/runs/:id/pause', async (c) => {
    const body = await jsonBody<{ reason?: unknown }>(c)
    const run = await s.sessions.requireRun(c.req.param('id'))
    const contactId = await currentContact(s, c)
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason : `paused by ${contactId}`
    if (run.data.state === 'paused') return c.json(run as Api.Run)
    const r = await s.sessions.transition(run.id, ['queued', 'running', 'suspended'], 'paused', { pauseReason: reason })
    return c.json(r as Api.Run)
  })

  app.post('/api/runs/:id/resume', async (c) => {
    const run = await s.sessions.requireRun(c.req.param('id'))
    if (run.data.state === 'queued') return c.json(run as Api.Run)
    const r = await s.sessions.transition(run.id, 'paused', 'queued', { pauseReason: undefined } as never)
    await s.runner.enqueue(r.id, { priority: r.data.priority })
    return c.json(r as Api.Run)
  })

  app.post('/api/runs/:id/cancel', async (c) => {
    const run = await s.sessions.requireRun(c.req.param('id'))
    if (TERMINAL_RUN_STATES.includes(run.data.state)) {
      if (run.data.state === 'cancelled') return c.json(run as Api.Run)
      throw new ConflictError(`run ${run.id} already ${run.data.state}`)
    }
    const r = await s.sessions.transition(run.id, ['queued', 'running', 'suspended', 'paused'], 'cancelled', {
      result: { status: 'cancelled' },
      endedAt: s.clock.iso(),
    })
    for (const w of await s.sessions.waitersOf(run.id)) await s.runner.wake(w.id)
    return c.json(r as Api.Run)
  })

  app.get('/api/lineage/:id', async (c) => c.json(await lineage(s, c.req.param('id'))))

  // ── Activity ─────────────────────────────────────────────────────────────

  app.get('/api/now', async (c) => {
    const v = views()
    const runs = (await s.sessions.runs({ state: LIVE_STATES })).reverse()
    const items: Api.NowItem[] = []
    for (const run of runs.slice(0, 200)) {
      const session = await v.session(run.data.sessionId)
      if (!session) continue
      const [employee, tokens, checklist] = await Promise.all([
        v.employeeSummary(run.data.employeeId),
        v.tokens({ runId: run.id }),
        s.records.getByKey<DomainChecklist['data']>('checklist', session.id),
      ])
      const activity = deps.tracker.activity(run.id)
      const since = run.updatedAt
      const step: Api.NowItem['step'] =
        run.data.state === 'running'
          ? (activity?.step ?? { kind: 'model', label: 'thinking', since })
          : run.data.state === 'queued'
            ? { kind: 'queued', label: 'queued', since }
            : run.data.state === 'paused'
              ? { kind: 'paused', label: run.data.pauseReason ?? 'paused', since }
              : { kind: 'waiting', label: 'waiting', since }
      const counts = checklistCounts(checklist as DomainChecklist | null)
      const wait = run.data.wait
      const waitingOn: Api.NowItem['waitingOn'] | undefined =
        run.data.state !== 'suspended' || !wait
          ? undefined
          : wait.type === 'runs'
            ? {
                type: 'children',
                label: `${wait.mode} of ${wait.runIds.length} runs`,
                refs: wait.runIds.map((id) => ({ kind: 'run', id })),
              }
            : wait.type === 'timer'
              ? { type: 'timer', label: `until ${wait.until}` }
              : { type: 'delivery', label: 'a reply or event' }
      items.push({
        run: run as Api.Run,
        session: session as Api.Session,
        employee,
        step,
        ...(waitingOn ? { waitingOn } : {}),
        tokens,
        ...(counts ? { checklist: counts } : {}),
        recentTools: activity?.recentTools ?? [],
        ...(activity && run.data.state === 'running' ? { streaming: activity.streaming } : {}),
      })
    }
    const counts = {} as Record<RunState, number>
    for (const st of ALL_STATES) counts[st] = await s.store.records.count('run', { state: st })
    return c.json({ items, paused: (await s.control.state()).paused, counts } satisfies Api.NowSnapshot)
  })

  app.get('/api/inbox', async (c) => {
    const v = views()
    const items: Api.InboxItem[] = []
    for (const run of (await s.sessions.runs({ state: 'paused' })).reverse().slice(0, 100)) {
      const session = await v.session(run.data.sessionId)
      const reason = run.data.pauseReason ?? 'paused'
      items.push({
        id: `paused:${run.id}`,
        type: /budget|limit|token|cost/i.test(reason) ? 'limit' : 'paused_run',
        title: `Paused: ${session?.data.title ?? run.data.sessionId}`,
        detail: reason,
        at: run.updatedAt,
        read: false,
        sessionId: run.data.sessionId,
        runId: run.id,
        employee: await v.employeeSummary(run.data.employeeId),
      })
    }
    const mentions = await s.records.query<DomainMessage['data']>('message', {
      where: [{ field: 'tags', op: 'contains', value: { type: 'person' } }, ...(await dmFilter(c, 'message'))],
      orderBy: { field: 'createdAt', dir: 'desc' },
      limit: 50,
    })
    for (const m of mentions.items) {
      const author = await v.author(m.data.author)
      const people = m.data.tags.filter((t) => t.type === 'person').map((t) => t.raw)
      items.push({
        id: `mention:${m.id}`,
        type: 'mention',
        title: `${author.name} mentioned ${people.join(', ')}`,
        detail: m.data.text.slice(0, 200),
        at: m.data.createdAt,
        read: false,
        channelId: m.data.channelId,
        threadId: m.data.threadId ?? m.id,
        ...(author.type === 'employee' ? { employee: { id: author.id, name: author.name } } : {}),
      })
    }
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    return c.json(items)
  })

  // ── Events and triggers ──────────────────────────────────────────────────

  app.get('/api/events', async (c) => {
    const q = c.req.query()
    const where: Condition[] = [...(await dmFilter(c, 'event'))]
    if (q.source) where.push({ field: 'source', op: 'eq', value: q.source })
    if (q.type) where.push({ field: 'type', op: 'eq', value: q.type })
    if (q.subject) where.push({ field: q.subject.includes(':') ? 'subjectKey' : 'subject.id', op: 'eq', value: q.subject })
    if (q.routed === 'true' || q.routed === 'unmatched') where.push({ field: 'routed', op: 'eq', value: true })
    else if (q.routed === 'false') where.push({ field: 'routed', op: 'eq', value: false })
    else if (q.routed) throw new BadRequestError('routed must be true, false or unmatched')
    const limit = intParam(q.limit, 'limit', 50, 500, 1)
    const offset = intParam(q.offset, 'offset', 0)
    if (q.routed === 'unmatched') {
      const all = await s.records.query<MpEvent['data']>('event', { where, orderBy: { field: 'receivedAt', dir: 'desc' } })
      const unmatched = (all.items as MpEvent[]).filter(isUnmatched)
      return c.json({ items: unmatched.slice(offset, offset + limit).map(mapEvent), total: unmatched.length })
    }
    const page = await s.records.query<MpEvent['data']>('event', {
      where,
      orderBy: { field: 'receivedAt', dir: 'desc' },
      limit,
      offset,
    })
    return c.json({ items: (page.items as MpEvent[]).map(mapEvent), total: page.total } satisfies Api.Page<Api.ApiEvent>)
  })

  app.get('/api/events/:id', async (c) => {
    const e = await s.rawEvents.require(c.req.param('id'))
    await requireVisible(c, e as unknown as StoredRecord)
    const runs = await s.records.query('run', { where: { 'cause.eventId': e.id }, orderBy: { field: 'createdAt' } })
    const extra = new Set(
      views()
        .deliveries(e)
        .flatMap((d) => (d.data.runId ? [d.data.runId] : [])),
    )
    const all = new Map(runs.items.map((r) => [r.id, r]))
    for (const id of extra) {
      if (!all.has(id)) {
        const r = await s.sessions.getRun(id)
        if (r) all.set(id, r)
      }
    }
    return c.json({
      event: mapEvent(e),
      deliveries: views().deliveries(e),
      runs: [...all.values()] as Api.Run[],
    } satisfies Api.EventDetail)
  })

  app.post('/api/events', async (c) => {
    const body = await jsonBody<Partial<Api.IngestEventBody>>(c)
    const source = requireString(body.source, 'source')
    const type = requireString(body.type, 'type')
    if (!('payload' in body)) throw new BadRequestError('payload is required')
    if (body.dedupeKey !== undefined && typeof body.dedupeKey !== 'string')
      throw new BadRequestError('dedupeKey must be a string')
    let subject: { system: string; id: string } | undefined
    if (body.subject !== undefined) {
      const sub = body.subject as { system?: unknown; ref?: unknown; id?: unknown }
      subject = { system: requireString(sub.system, 'subject.system'), id: requireString(sub.ref ?? sub.id, 'subject.ref') }
    }
    const { event, created } = await s.events.ingest({
      source,
      type,
      ...(body.dedupeKey ? { dedupeKey: body.dedupeKey } : {}),
      ...(subject ? { subject } : {}),
      payload: (body.payload ?? null) as Json,
    })
    return c.json({ event: mapEvent(event), created }, created ? 201 : 200)
  })

  app.get('/api/triggers', async (c) => {
    const v = views()
    const out: Api.TriggerStats[] = []
    for (const t of await s.events.triggers.list()) {
      const trigger = await v.trigger(t)
      const ctx = trigger.data.contextId ? await v.session(trigger.data.contextId) : null
      const recent = await s.records.query<MpEvent['data']>('event', {
        where: [{ field: 'routing.triggerIds', op: 'contains', value: t.id }],
        orderBy: { field: 'receivedAt', dir: 'desc' },
        limit: 10,
      })
      out.push({
        trigger,
        context: ctx ? { id: ctx.id, title: ctx.data.title, slug: ctx.data.slug } : null,
        employee: await v.employeeSummary(t.data.employeeId),
        fires: t.data.fired ?? 0,
        lastFiredAt: t.data.lastFiredAt ?? null,
        recentEvents: (recent.items as MpEvent[]).map((e) => ({
          id: e.id,
          type: e.data.type,
          ...(e.data.subject ? { subject: { system: e.data.subject.system, ref: e.data.subject.id } } : {}),
          ...(typeof e.data.text === 'string' && e.data.text ? { text: e.data.text.slice(0, 200) } : {}),
          receivedAt: e.data.receivedAt,
        })),
      })
    }
    return c.json(out)
  })

  // ── Chat ─────────────────────────────────────────────────────────────────

  app.get('/api/chat/channels', async (c) => {
    const v = views()
    const out: Api.ChannelSummary[] = []
    const hidden = await vis.hiddenChannels(me_(c))
    for (const ch of await s.chat.listChannels()) {
      if (hidden.has(ch.id)) continue
      const last = await s.records.query<DomainMessage['data']>('message', {
        where: { channelId: ch.id },
        orderBy: { field: 'createdAt', dir: 'desc' },
        limit: 1,
      })
      out.push({ channel: await v.channel(ch), lastMessageAt: last.items[0]?.data.createdAt ?? null, messages: last.total })
    }
    return c.json(out)
  })

  const memberRef = (m: { type?: unknown; id?: unknown }) => {
    const id = requireString(m.id, 'member id')
    if (m.type === 'employee') return { kind: 'employee', id }
    if (m.type === 'session') return { kind: 'session', id }
    if (m.type === 'person') return { kind: 'contact', id }
    throw new BadRequestError('member type must be employee, session or person')
  }

  /**
   * A DM with an employee is a request to it: new top-level messages go to its router,
   * like #requests. Adds that trigger once per employee member (idempotent).
   */
  const routeDmToEmployees = async <C extends { id: string }>(ch: C, by: Awaited<ReturnType<typeof actor>>): Promise<C> => {
    let out = ch
    const members = await s.chat.members(ch.id)
    for (const m of members.filter((x) => x.kind === 'employee' || x.kind === 'contact')) {
      const e = m.kind === 'employee' ? await s.directory.employees.get(m.id) : await s.directory.employees.byContact(m.id)
      if (!e) continue
      const existing = (await s.events.triggers.list({ employeeId: e.id })).find(
        (t) => t.data.match.where?.['payload.channelId'] === ch.id,
      )
      if (existing) continue
      await s.events.triggers.create(
        {
          name: `DM: ${e.data.name}`,
          employeeId: e.id,
          match: { source: 'chat', type: 'message.posted', where: { 'payload.channelId': ch.id } },
          target: { type: 'router' },
        },
        by,
      )
      const routerId = await s.routerSessionFor(e.id)
      if (routerId) out = (await s.chat.updateChannel(ch.id, { contextSessionId: routerId }, by)) as unknown as C
    }
    return out
  }

  app.post('/api/chat/channels', async (c) => {
    const body = await jsonBody<{ name?: unknown; topic?: unknown; members?: unknown; dm?: unknown }>(c)
    const name = requireString(body.name, 'name')
    if (body.members !== undefined && !Array.isArray(body.members)) throw new BadRequestError('members must be a list')
    const contactId = await currentContact(s, c)
    const members = ((body.members as { type?: unknown; id?: unknown }[] | undefined) ?? []).map(memberRef)
    // A DM also has the person who opened it as a member.
    if (body.dm === true && !members.some((m) => m.kind === 'contact' && m.id === contactId))
      members.push({ kind: 'contact', id: contactId })
    let ch = await s.chat.createChannel({
      name,
      ...(typeof body.topic === 'string' ? { topic: body.topic } : {}),
      createdBy: { kind: 'contact', id: contactId },
      members,
    })
    if (body.dm === true) {
      ch = (await s.records.update('channel', ch.id, { dm: true })) as typeof ch
      ch = await routeDmToEmployees(ch, await actor(c))
    }
    return c.json(await views().channel(ch), 201)
  })

  app.get('/api/chat/channels/:id/messages', async (c) => {
    const ch = await s.chat.getChannel(c.req.param('id'))
    if (!ch) throw new NotFoundError('channel', c.req.param('id'))
    await vis.requireChannel(me_(c), ch.id)
    const before = c.req.query('before')
    const msgs = await s.chat.messages(ch.id, {
      limit: intParam(c.req.query('limit'), 'limit', 50, 500, 1),
      ...(before ? { before } : {}),
    })
    const v = views()
    return c.json(await Promise.all(msgs.map((m) => v.message(m))))
  })

  app.get('/api/chat/threads/:id', async (c) => {
    await vis.requireMessage(me_(c), c.req.param('id'))
    const msgs = await s.chat.thread(c.req.param('id'))
    const v = views()
    const [root, ...replies] = await Promise.all(msgs.map((m) => v.message(m)))
    const subs = await s.events.subscriptions.forSubject({ system: 'mp', id: msgs[0]!.id })
    const sessions: Api.ChatThread['sessions'] = []
    // Subscribed sessions first, then sessions that posted in the thread.
    const ids = [
      ...new Set([
        ...subs.map((sub) => sub.data.sessionId),
        ...msgs.flatMap((m) => (m.data.author.kind === 'session' ? [m.data.author.id] : [])),
      ]),
    ]
    for (const id of ids) {
      const x = await v.session(id)
      if (x)
        sessions.push({ id: x.id, slug: x.data.slug, title: x.data.title, employee: await v.employeeSummary(x.data.employeeId) })
    }
    return c.json({ root: root!, replies, sessions } satisfies Api.ChatThread)
  })

  app.post('/api/chat/channels/:id/messages', async (c) => {
    const body = await jsonBody<{ text?: unknown; threadId?: unknown }>(c)
    const text = requireString(body.text, 'text')
    if (body.threadId !== undefined && body.threadId !== null && typeof body.threadId !== 'string')
      throw new BadRequestError('threadId must be a string')
    const contactId = await currentContact(s, c)
    await vis.requireChannel(contactId, c.req.param('id'))
    const msg = await s.chat.post({
      channelId: c.req.param('id'),
      ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
      author: { kind: 'contact', id: contactId },
      text,
    })
    return c.json(await views().message(msg), 201)
  })

  const messageOr404 = async (id: string, c: Context) => {
    const m = await s.chat.getMessage(id)
    if (!m || !(await vis.canSeeChannel(me_(c), m.data.channelId))) throw new NotFoundError('message', id)
    return m
  }
  const me = async (c: Context) => ({ kind: 'contact', id: await currentContact(s, c) })

  app.patch('/api/chat/messages/:id', async (c) => {
    const body = await jsonBody<{ text?: unknown }>(c)
    const text = requireString(body.text, 'text')
    await messageOr404(c.req.param('id'), c)
    return c.json(await views().message(await s.chat.edit(c.req.param('id'), text, await me(c))))
  })

  app.delete('/api/chat/messages/:id', async (c) => {
    await messageOr404(c.req.param('id'), c)
    return c.json(await views().message(await s.chat.delete(c.req.param('id'), await me(c))))
  })

  const emojiOf = (v: unknown) => {
    const emoji = requireString(v, 'emoji').trim()
    if (!emoji || emoji.length > 32) throw new BadRequestError('emoji must be 1 to 32 characters')
    return emoji
  }

  app.post('/api/chat/messages/:id/reactions', async (c) => {
    const body = await jsonBody<{ emoji?: unknown }>(c)
    await messageOr404(c.req.param('id'), c)
    return c.json(await views().message(await s.chat.react(c.req.param('id'), emojiOf(body.emoji), await me(c))))
  })

  app.delete('/api/chat/messages/:id/reactions', async (c) => {
    let emoji: unknown = c.req.query('emoji')
    if (emoji === undefined && c.req.header('content-type')?.includes('json'))
      emoji = (await jsonBody<{ emoji?: unknown }>(c)).emoji
    await messageOr404(c.req.param('id'), c)
    return c.json(await views().message(await s.chat.unreact(c.req.param('id'), emojiOf(emoji), await me(c))))
  })

  app.post('/api/chat/read', async (c) => {
    const body = await jsonBody<{ scope?: unknown; messageId?: unknown }>(c)
    const scope = requireString(body.scope, 'scope')
    if (body.messageId !== undefined && typeof body.messageId !== 'string')
      throw new BadRequestError('messageId must be a string')
    await s.chat.markRead(await me(c), scope, typeof body.messageId === 'string' ? { messageId: body.messageId } : {})
    return c.body(null, 204)
  })

  app.get('/api/chat/unread', async (c) => {
    const reader = await me(c)
    const hidden = await vis.hiddenChannels(reader.id)
    const unread = (await s.chat.unread(reader, { taggedIds: [reader.id] })).filter((u) => !hidden.has(u.channelId))
    return c.json(unread satisfies Api.ChannelUnread[])
  })

  app.post('/api/chat/dms', async (c) => {
    const body = await jsonBody<{ members?: unknown }>(c)
    if (!Array.isArray(body.members) || !body.members.length) throw new BadRequestError('members must be a non-empty list')
    const refs = (body.members as { kind?: unknown; type?: unknown; id?: unknown }[]).map((m) => {
      const kind = m.kind ?? m.type
      return memberRef({ type: kind === 'contact' ? 'person' : kind, id: m.id })
    })
    const self = await me(c)
    const before = await s.store.records.count('channel')
    let ch = await s.chat.openDm([self, ...refs], self)
    ch = await routeDmToEmployees(ch, await actor(c))
    const created = (await s.store.records.count('channel')) > before
    return c.json(await views().channel(ch), created ? 201 : 200)
  })

  app.get('/api/chat/search', async (c) => {
    const q = c.req.query()
    let author: { kind: string; id: string } | undefined
    if (q.author) {
      const [kind, id] = q.author.includes(':')
        ? q.author.split(':', 2)
        : [q.author.startsWith('ses_') ? 'session' : 'contact', q.author]
      author = { kind: kind!, id: id! }
    }
    if (q.channelId) await vis.requireChannel(me_(c), q.channelId)
    const hidden = await vis.hiddenChannels(me_(c))
    const found = (
      await s.chat.search(q.text ?? '', {
        ...(q.channelId ? { channelId: q.channelId } : {}),
        ...(author ? { author } : {}),
        ...(q.tagged ? { tagged: q.tagged } : {}),
        ...(q.threadId ? { threadId: q.threadId } : {}),
        limit: intParam(q.limit, 'limit', 50, 200, 1),
      })
    ).filter((m) => !hidden.has(m.data.channelId))
    const v = views()
    const channels = new Map<string, { id: string; name: string; dm: boolean }>()
    const out: Api.ChatSearchResult[] = []
    for (const m of found) {
      let ch = channels.get(m.data.channelId)
      if (!ch) {
        const rec = await s.chat.getChannel(m.data.channelId)
        ch = { id: m.data.channelId, name: rec?.data.name ?? m.data.channelId, dm: rec?.data.dm === true }
        channels.set(ch.id, ch)
      }
      out.push({ message: await v.message(m, { summary: false }), channel: ch, threadId: m.data.threadId ?? m.id })
    }
    return c.json(out)
  })

  app.post('/api/chat/channels/:id/members', async (c) => {
    const body = await jsonBody<{ type?: unknown; id?: unknown }>(c)
    const ref = memberRef(body)
    await vis.requireChannel(me_(c), c.req.param('id'))
    await s.chat.addMember(c.req.param('id'), ref, await actor(c))
    const ch = await s.chat.getChannel(c.req.param('id'))
    return c.json(await views().channel(ch!))
  })

  // ── Usage ────────────────────────────────────────────────────────────────

  const usageRecords = async (q: Record<string, string | undefined>) => {
    const f = usageFilter(q)
    const where: Condition[] = []
    for (const [k, val] of Object.entries(f)) {
      if (k === 'since') where.push({ field: 'at', op: 'gte', value: val })
      else if (k === 'until') where.push({ field: 'at', op: 'lt', value: val })
      else where.push({ field: k, op: 'eq', value: val })
    }
    return (await s.records.query<UsageData>('usage', { where, orderBy: { field: 'at' } })).items
  }

  const groupKey = (u: StoredRecord<UsageData>, by: Api.UsageGroupBy): string => {
    const d = u.data
    switch (by) {
      case 'employee':
        return d.employeeId ?? ''
      case 'model':
        return d.model
      case 'session':
        return d.sessionId ?? ''
      case 'tree':
        return d.rootSessionId ?? ''
      case 'project':
        return d.projectId ?? ''
      case 'contact':
        return d.requesterId ?? ''
      case 'template':
        return d.templateId ?? ''
      case 'tool':
        return (d as { tool?: string }).tool ?? ''
      case 'day':
        return isoDay(d.at)
      case 'hour':
        return isoHour(d.at)
    }
  }

  const labelOf = async (v: Views, by: Api.UsageGroupBy, key: string): Promise<string> => {
    if (!key) return '(none)'
    if (by === 'employee') return (await v.employee(key))?.data.name ?? key
    if (by === 'session' || by === 'tree') return (await v.session(key))?.data.title ?? key
    if (by === 'contact') return (await v.contact(key))?.data.name ?? key
    if (by === 'project') return (await s.directory.projects.get(key))?.data.name ?? key
    if (by === 'template') return (await s.sessions.getTemplate(key))?.data.name ?? key
    return key
  }

  const GROUPS: Api.UsageGroupBy[] = [
    'employee',
    'model',
    'session',
    'tree',
    'project',
    'contact',
    'template',
    'tool',
    'day',
    'hour',
  ]

  app.get('/api/usage/totals', async (c) => c.json(await views().tokens(usageFilter(c.req.query()))))

  app.get('/api/usage/breakdown', async (c) => {
    const q = c.req.query()
    const groupBy = (q.groupBy ?? 'employee') as Api.UsageGroupBy
    if (!GROUPS.includes(groupBy)) throw new BadRequestError(`groupBy must be one of ${GROUPS.join(', ')}`)
    const rows = new Map<string, Api.UsageRow>()
    for (const u of await usageRecords(q)) {
      const key = groupKey(u as StoredRecord<UsageData>, groupBy)
      const row = rows.get(key) ?? { key, label: key, ...emptyTotals() }
      row.input += u.data.promptTokens
      row.output += u.data.completionTokens
      row.cached += u.data.cachedTokens ?? 0
      row.reasoning += u.data.reasoningTokens ?? 0
      row.total += u.data.promptTokens + u.data.completionTokens
      row.cost += u.data.costUsd
      row.calls++
      rows.set(key, row)
    }
    const v = views()
    for (const r of rows.values()) r.label = await labelOf(v, groupBy, r.key)
    const list = [...rows.values()]
    if (groupBy === 'day' || groupBy === 'hour') list.sort((a, b) => (a.key < b.key ? -1 : 1))
    else list.sort((a, b) => b.total - a.total)
    return c.json({ groupBy, rows: list } satisfies Api.UsageBreakdown)
  })

  app.get('/api/usage/series', async (c) => {
    const q = c.req.query()
    const interval = q.interval === 'hour' ? 'hour' : q.interval === 'day' || !q.interval ? 'day' : null
    if (!interval) throw new BadRequestError('interval must be hour or day')
    const splitBy = q.splitBy as Api.UsageGroupBy | undefined
    if (splitBy && !GROUPS.includes(splitBy)) throw new BadRequestError(`splitBy must be one of ${GROUPS.join(', ')}`)
    const buckets = new Map<string, Record<string, number>>()
    const keys = new Map<string, number>()
    for (const u of await usageRecords(q)) {
      const t = interval === 'hour' ? isoHour(u.data.at) : isoDay(u.data.at)
      const key = splitBy ? groupKey(u as StoredRecord<UsageData>, splitBy) || '(none)' : 'total'
      const tokens = u.data.promptTokens + u.data.completionTokens
      const b = buckets.get(t) ?? {}
      b[key] = (b[key] ?? 0) + tokens
      buckets.set(t, b)
      keys.set(key, (keys.get(key) ?? 0) + tokens)
    }
    const v = views()
    const keyList = [...keys.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const labelled = await Promise.all(
      keyList.map(async (key) => ({ key, label: splitBy && key !== '(none)' ? await labelOf(v, splitBy, key) : key })),
    )
    const points = [...buckets.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([t, b]) => {
        const p: { t: string } & Record<string, number | string> = { t }
        for (const k of keyList) p[k] = b[k] ?? 0
        return p
      })
    return c.json({ interval, ...(splitBy ? { splitBy } : {}), keys: labelled, points } satisfies Api.UsageSeries)
  })

  // ── Files ────────────────────────────────────────────────────────────────

  app.get('/api/files/:employeeId', async (c) => {
    const employeeId = c.req.param('employeeId')
    await s.directory.employees.require(employeeId)
    const list = await s.files.list(employeeId, c.req.query('dir') || '/')
    return c.json(
      list.map((e) => {
        const m = /^\/shared\/([^/]+)\/.+/.exec(e.path)
        return {
          path: e.path,
          name: e.name,
          type: e.type,
          size: e.size ?? 0,
          updatedAt: e.updatedAt ?? '',
          ...(m ? { shared: { ownerEmployeeId: m[1]!, permission: 'read' as const } } : {}),
        }
      }) satisfies Api.FileEntry[],
    )
  })

  app.get('/api/files/:employeeId/content', async (c) => {
    const path = requireString(c.req.query('path'), 'path')
    const f = await s.files.read(c.req.param('employeeId'), path)
    return c.json({ path: f.path, content: f.content, version: f.version, updatedAt: f.updatedAt } satisfies Api.FileContent)
  })

  app.put('/api/files/:employeeId/content', async (c) => {
    const path = requireString(c.req.query('path'), 'path')
    const body = await jsonBody<{ content?: unknown; version?: unknown }>(c)
    if (typeof body.content !== 'string') throw new BadRequestError('content must be a string')
    if (body.version !== undefined && typeof body.version !== 'number') throw new BadRequestError('version must be a number')
    const employeeId = c.req.param('employeeId')
    await s.directory.employees.require(employeeId)
    const f = await s.files.write(employeeId, path, body.content, {
      ...(typeof body.version === 'number' ? { expectedVersion: body.version } : {}),
      actor: await actor(c),
    })
    return c.json({ path: f.path, content: f.content, version: f.version, updatedAt: f.updatedAt } satisfies Api.FileContent)
  })

  // ── Secrets (names only; values are write-only) ──────────────────────────

  app.get('/api/secrets', async (c) => {
    const list = await s.secrets.list()
    return c.json(
      list.map((m) => ({
        name: m.name,
        scope: toApiScope(m.scope),
        createdAt: m.updatedAt,
        updatedAt: m.updatedAt,
      })) satisfies Api.SecretInfo[],
    )
  })

  app.put('/api/secrets', async (c) => {
    const body = await jsonBody<{ name?: unknown; value?: unknown; scope?: { type?: unknown; id?: unknown } }>(c)
    const name = requireString(body.name, 'name')
    if (typeof body.value !== 'string' || !body.value) throw new BadRequestError('value is required')
    const scope = toDomainScope(body.scope?.type, body.scope?.id)
    await s.secrets.set(name, body.value, scope, await currentContact(s, c))
    const meta = (await s.secrets.list()).find(
      (m) => m.name === name && JSON.stringify(toApiScope(m.scope)) === JSON.stringify(toApiScope(scope)),
    )
    const at = meta?.updatedAt ?? s.clock.iso()
    return c.json({ name, scope: toApiScope(scope), createdAt: at, updatedAt: at } satisfies Api.SecretInfo)
  })

  app.delete('/api/secrets', async (c) => {
    const name = requireString(c.req.query('name'), 'name')
    await s.secrets.delete(name, toDomainScope(c.req.query('scopeType'), c.req.query('scopeId')))
    return c.body(null, 204)
  })

  // ── Employees' SSH keys ─────────────────────────────────────────────────

  app.post('/api/employees/:id/ssh-key', async (c) => {
    const id = c.req.param('id')
    await s.directory.employees.require(id)
    const publicKey = await rotateSshKey(s, id)
    return c.json({ employeeId: id, publicKey })
  })

  // ── Control and health ───────────────────────────────────────────────────

  app.get('/api/control', async (c) => c.json(await s.control.state()))
  app.post('/api/control/pause-all', async (c) => c.json(await s.control.pauseAll(await actor(c))))
  app.post('/api/control/resume-all', async (c) => c.json(await s.control.resumeAll(await actor(c))))

  app.get('/healthz', (c) => c.json({ ok: true, version: deps.version } satisfies Api.Health))

  app.get('/readyz', async (c) => {
    const checks: Record<string, boolean> = {}
    checks.database = await s.store.records
      .count('setting')
      .then(() => true)
      .catch(() => false)
    checks.queue = await s.queue
      .counts('runs')
      .then(() => true)
      .catch(() => false)
    checks.migrations = await deps.migrationsReady().catch(() => false)
    const ok = Object.values(checks).every(Boolean)
    return c.json({ ok, checks, version: deps.version } satisfies Api.Health, ok ? 200 : 503)
  })

  app.all('/api/*', () => {
    throw new NotFoundError('route')
  })

  return app
}
