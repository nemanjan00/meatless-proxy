import type * as Api from '@mp/api'
import { MEMORY_KINDS } from '@mp/api'
import { ConflictError, DeniedError, NotFoundError, isMpError } from '@mp/core'
import type { MpEvent } from '@mp/events'
import { type Memory, type MemoryData, type MemoryKind, memoryKey } from '@mp/memory'
import type { Link, Ref } from '@mp/store'
import { type Context, Hono } from 'hono'
import { principalOf } from '../auth/guard.ts'
import type { ChatVisibility } from '../auth/visibility.ts'
import { BadRequestError, intParam, jsonBody, requireString } from '../http/util.ts'
import { actorOf } from '../http/views.ts'
import type { Services } from '../services.ts'
import { type MemoryViewer, canChangeMemory, canSeeMemory, contactsAbout, peopleAmong } from './memory-access.ts'
import { DirectorySnapshot, changedFields, readAll } from './names.ts'
import { type KnowledgeUse, byTarget, usesOf } from './use.ts'

/**
 * The memory API (docs/spec.md "Memory" and "Web UI › Memory", `@mp/api` knowledge.ts): what the
 * employees remember, filtered by employee, kind, subject, source and text, under the privacy
 * rule of memory-access.ts. People teach employees facts here, correct them (with a note that
 * shows in the history) and have them forgotten.
 */

const ABOUT = 'about'
const MAX_NOTE = 2000

/** The server's addition to the memory kind: the last correction and its note. */
export const correctionField = {
  name: 'correction',
  type: 'object' as const,
  description: 'The last correction a person made, and why.',
  fields: [
    { name: 'note', type: 'string' as const, required: true },
    { name: 'contactId', type: 'ref' as const, ref: 'contact' },
    { name: 'at', type: 'timestamp' as const, required: true },
  ],
}

export function defineCorrectionField(records: Services['records']) {
  if (!(records.kinds.get('memory').extensions ?? []).some((f) => f.name === 'correction'))
    records.kinds.extend('memory', [correctionField])
}

const optText = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new BadRequestError(`${name} must be a string`)
  return v
}

function parseKind(v: unknown): MemoryKind | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(v))
    throw new BadRequestError(`kind must be one of ${MEMORY_KINDS.join(', ')}`)
  return v as MemoryKind
}

/** One memory with everything a view needs, computed once per request. */
interface Row {
  memory: Memory
  links: Link[]
  about: Api.KnowledgeRef[]
  people: string[]
}

export class MemoryViews {
  private constructor(
    private readonly s: Services,
    private readonly vis: ChatVisibility,
    readonly viewer: MemoryViewer,
    readonly names: DirectorySnapshot,
    private readonly uses: Map<string, KnowledgeUse[]>,
  ) {}

  static async load(s: Services, vis: ChatVisibility, viewer: MemoryViewer): Promise<MemoryViews> {
    const [names, uses] = await Promise.all([DirectorySnapshot.load(s), usesOf(s, 'memory')])
    return new MemoryViews(s, vis, viewer, names, byTarget(uses))
  }

  /** A memory's row, from its links. */
  row(memory: Memory, links: Link[]): Row {
    const about = new Map<string, Api.KnowledgeRef>()
    const add = (kind: string, id: string) => {
      const r = this.names.ref(kind, id)
      if (r) about.set(id, r)
    }
    if (memory.data.scope?.type !== 'company' && memory.data.scope?.id) add(memory.data.scope.type, memory.data.scope.id)
    for (const l of links) {
      if (l.role !== ABOUT) continue
      const other = l.from.id === memory.id ? l.to : l.from
      add(other.kind, other.id)
    }
    const people = peopleAmong(contactsAbout(memory, links), this.names.contacts)
    return { memory, links, about: [...about.values()], people }
  }

  /** Every memory the viewer may see. */
  async visibleRows(): Promise<Row[]> {
    const [memories, out, inc] = await Promise.all([
      readAll<MemoryData>(this.s, 'memory'),
      this.s.records.links({ from: { kind: 'memory' } }),
      this.s.records.links({ to: { kind: 'memory' } }),
    ])
    const byMemory = new Map<string, Link[]>()
    for (const l of [...out, ...inc])
      for (const end of [l.from, l.to]) if (end.kind === 'memory') byMemory.set(end.id, [...(byMemory.get(end.id) ?? []), l])
    return memories.map((m) => this.row(m as Memory, byMemory.get(m.id) ?? [])).filter((r) => canSeeMemory(this.viewer, r.people))
  }

  /** One memory's row, or a 404 when it's missing or the viewer may not see it. */
  async visibleRow(id: string): Promise<Row> {
    const m = await this.s.memory.get(id)
    if (!m) throw new NotFoundError('memory', id)
    const r = this.row(m, await this.s.records.links({ touching: { kind: 'memory', id } }))
    if (!canSeeMemory(this.viewer, r.people)) throw new NotFoundError('memory', id)
    return r
  }

  usage(id: string): { lastUsedAt: string | null; uses: number } {
    const list = this.uses.get(id) ?? []
    const last = list.reduce<string | null>((a, u) => (!a || u.data.lastAt > a ? u.data.lastAt : a), null)
    return { lastUsedAt: last, uses: list.reduce((n, u) => n + u.data.count, 0) }
  }

  private async source(m: Memory, withMessage: boolean): Promise<Api.MemorySource> {
    const person = this.names.person(m.data.source?.contactId)
    const sid = m.data.source?.sessionId
    if (!sid) return { session: null, person }
    const session = await this.s.sessions.get(sid)
    if (!session) return { session: null, person }
    if (!(await this.vis.canReadSession({ contactId: this.viewer.contactId, admin: this.viewer.access === 'admin' }, session)))
      return { session: null, private: true, person }
    const out: Api.MemorySource = {
      session: { id: session.id, title: session.data.title, slug: session.data.slug, status: session.data.status },
      person,
    }
    if (withMessage) {
      const message = await this.firstMessage(session.id)
      if (message) out.message = message
    }
    return out
  }

  /** The chat message that started a session (its first run's event), when the viewer may see its channel. */
  private async firstMessage(sessionId: string): Promise<Api.MemorySource['message'] | undefined> {
    const runs = await this.s.sessions.runs({ sessionId })
    const eventId = runs[0]?.data.cause?.eventId
    if (!eventId) return undefined
    const e = (await this.s.rawEvents.get(eventId)) as MpEvent | null
    const p = e?.data.payload as { messageId?: unknown } | undefined
    if (e?.data.source !== 'chat' || typeof p?.messageId !== 'string') return undefined
    const msg = await this.s.chat.getMessage(p.messageId)
    if (!msg || !(await this.vis.canSeeChannel(this.viewer.contactId, msg.data.channelId))) return undefined
    const channel = await this.s.chat.getChannel(msg.data.channelId)
    return {
      channelId: msg.data.channelId,
      threadId: msg.data.threadId ?? msg.id,
      text: msg.data.text.replace(/\s+/g, ' ').slice(0, 160),
      ...(channel && !channel.data.dm ? { channelName: channel.data.name } : {}),
    }
  }

  async item(r: Row, opts: { message?: boolean } = {}): Promise<Api.MemoryItem> {
    const m = r.memory
    return {
      memory: m as unknown as Api.ApiRecord<Api.MemoryRecordData>,
      employee: this.names.employee(m.data.employeeId),
      about: r.about,
      personal: r.people.length > 0,
      source: await this.source(m, !!opts.message),
      ...this.usage(m.id),
      canEdit: canChangeMemory(this.viewer, r.people),
    }
  }

  async detail(r: Row): Promise<Api.MemoryDetail> {
    const revs = await this.s.records.revisions<MemoryData>('memory', r.memory.id)
    const history: Api.MemoryRevision[] = revs.map((rev, i) => {
      const prev = i > 0 ? (revs[i - 1]!.data as Record<string, unknown> | null) : null
      const data = rev.data
      const changed = i === 0 ? [] : changedFields(prev, data as Record<string, unknown> | null)
      const note = data?.correction && changed.includes('correction') ? (data.correction as { note?: string }).note : undefined
      return {
        version: rev.version,
        op: rev.op,
        at: rev.at,
        actor: { type: rev.actor.type, id: rev.actor.id, name: this.names.actorName(rev.actor) },
        changed,
        summary: data?.summary ?? '',
        ...(data?.content ? { content: data.content } : {}),
        ...(note ? { note } : {}),
      }
    })
    return { ...(await this.item(r, { message: true })), history: history.reverse() }
  }
}

/** Filters, sorts and pages rows for `GET /api/memories`. */
export function filterRows(rows: Row[], q: Record<string, string | undefined>, viewer: MemoryViewer): Row[] {
  const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const mine = q.mine === 'true' || q.mine === '1'
  return rows.filter((r) => {
    const d = r.memory.data
    if (q.employeeId === 'shared' ? !!d.employeeId : q.employeeId && d.employeeId !== q.employeeId) return false
    if (q.kind && d.kind !== q.kind) return false
    if (q.about && !r.about.some((a) => a.id === q.about) && d.scope?.id !== q.about) return false
    if (q.taughtBy && d.source?.contactId !== q.taughtBy) return false
    if (q.sessionId && d.source?.sessionId !== q.sessionId) return false
    if (mine && !r.people.includes(viewer.contactId)) return false
    if (words.length) {
      const hay = `${d.summary} ${d.content ?? ''} ${r.about.map((a) => a.name).join(' ')}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) return false
    }
    return true
  })
}

function facets(rows: Row[], views: MemoryViews): Api.MemoryFacets {
  const employees = new Map<string, number>()
  const kinds = new Map<MemoryKind, number>()
  const subjects = new Map<string, { ref: Api.KnowledgeRef; count: number }>()
  const teachers = new Map<string, number>()
  let shared = 0
  for (const r of rows) {
    const d = r.memory.data
    if (d.employeeId) employees.set(d.employeeId, (employees.get(d.employeeId) ?? 0) + 1)
    else shared++
    kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1)
    for (const a of r.about) subjects.set(a.id, { ref: a, count: (subjects.get(a.id)?.count ?? 0) + 1 })
    const t = d.source?.contactId
    if (t) teachers.set(t, (teachers.get(t) ?? 0) + 1)
  }
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)
  return {
    employees: [...employees].map(([id, count]) => ({ ...views.names.employee(id)!, count })).sort(byName),
    shared,
    kinds: MEMORY_KINDS.filter((k) => kinds.has(k)).map((kind) => ({ kind, count: kinds.get(kind)! })),
    subjects: [...subjects.values()].map((x) => ({ ...x.ref, count: x.count })).sort(byName),
    teachers: [...teachers]
      .map(([id, count]) => ({ ...views.names.person(id)!, count }))
      .filter((t) => t.kind === 'person')
      .sort(byName),
  }
}

export function memoryRoutes(s: Services, vis: ChatVisibility): Hono {
  const app = new Hono()
  defineCorrectionField(s.records)
  const viewer = (c: Context): MemoryViewer => {
    const p = principalOf(c)
    return { contactId: p.contactId, access: p.access }
  }
  const load = (c: Context) => MemoryViews.load(s, vis, viewer(c))

  /** `about` refs from a body: contacts and projects that exist. */
  const parseAbout = async (raw: unknown): Promise<Ref[] | undefined> => {
    if (raw === undefined || raw === null) return undefined
    if (!Array.isArray(raw)) throw new BadRequestError('about must be a list of { kind, id }')
    const out: Ref[] = []
    for (const a of raw) {
      const kind = a?.kind
      const id = a?.id
      if ((kind !== 'contact' && kind !== 'project') || typeof id !== 'string' || !id)
        throw new BadRequestError('each about is { kind: contact | project, id }')
      await s.records.require(kind, id)
      if (!out.some((x) => x.id === id)) out.push({ kind, id })
    }
    return out
  }

  const parseScope = async (raw: unknown): Promise<MemoryData['scope'] | undefined> => {
    if (raw === undefined || raw === null) return undefined
    const type = (raw as { type?: unknown }).type
    const id = (raw as { id?: unknown }).id
    if (type === 'company') return { type: 'company' }
    if ((type === 'project' || type === 'contact') && typeof id === 'string' && id) {
      await s.records.require(type, id)
      return { type, id }
    }
    throw new BadRequestError('scope is { type: company } or { type: project | contact, id }')
  }

  const parseEmployee = async (raw: unknown): Promise<string | null | undefined> => {
    if (raw === undefined) return undefined
    if (raw === null || raw === '') return null
    if (typeof raw !== 'string') throw new BadRequestError('employeeId must be a string or null')
    return (await s.directory.employees.require(raw)).id
  }

  /** Makes the memory's `about` links (to contacts and projects) exactly these. */
  const setAbout = async (m: Memory, want: Ref[], actor: ReturnType<typeof actorOf>) => {
    const links = await s.records.links({ from: { kind: 'memory', id: m.id }, role: ABOUT })
    const scopeId = m.data.scope?.type !== 'company' ? m.data.scope?.id : undefined
    for (const l of links)
      if ((l.to.kind === 'contact' || l.to.kind === 'project') && l.to.id !== scopeId && !want.some((w) => w.id === l.to.id))
        await s.memory.unlink(m.id, l.to, ABOUT, { actor })
    for (const w of want) await s.memory.link(m.id, w, ABOUT, { actor })
  }

  app.get('/api/memories', async (c) => {
    const q = c.req.query()
    const v = await load(c)
    const rows = await v.visibleRows()
    const shown = filterRows(rows, q, v.viewer)
    const sort = q.sort ?? 'learned'
    const key = (r: Row) =>
      sort === 'used' ? (v.usage(r.memory.id).lastUsedAt ?? '') : sort === 'updated' ? r.memory.updatedAt : r.memory.createdAt
    shown.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : a.memory.id < b.memory.id ? 1 : -1))
    const limit = intParam(q.limit, 'limit', 100, 500, 1)
    const offset = intParam(q.offset, 'offset', 0)
    const items: Api.MemoryItem[] = []
    for (const r of shown.slice(offset, offset + limit)) items.push(await v.item(r))
    return c.json({ items, total: shown.length, facets: facets(rows, v) } satisfies Api.MemoryPage)
  })

  app.get('/api/memories/:id', async (c) => {
    const v = await load(c)
    return c.json(await v.detail(await v.visibleRow(c.req.param('id'))))
  })

  app.post('/api/memories', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    const summary = requireString(body.summary, 'summary').trim()
    const kind = parseKind(body.kind) ?? 'fact'
    const content = optText(body.content, 'content')?.trim()
    const employeeId = await parseEmployee(body.employeeId)
    const about = (await parseAbout(body.about)) ?? []
    const scope = (await parseScope(body.scope)) ?? { type: 'company' as const }
    const me = viewer(c)
    // One fact is one memory: the same summary updates the existing one, if the caller may change it.
    const existing = await s.records.getByKey<MemoryData>(
      'memory',
      memoryKey({ summary, scope, ...(employeeId ? { employeeId } : {}) }),
    )
    if (existing) {
      const v = await load(c)
      const r = v.row(existing as Memory, await s.records.links({ touching: { kind: 'memory', id: existing.id } }))
      if (!canChangeMemory(me, r.people))
        throw new ConflictError('a memory with this summary already exists: word it differently, or ask an admin')
    }
    const { memory, created } = await s.memory.remember({
      summary,
      kind,
      ...(content ? { content } : {}),
      scope,
      source: { contactId: me.contactId },
      ...(employeeId ? { employeeId } : {}),
      about,
      actor: actorOf(me.contactId),
    })
    const v = await load(c)
    const r = v.row(memory, await s.records.links({ touching: { kind: 'memory', id: memory.id } }))
    return c.json({ created, memory: await v.detail(r) } satisfies Api.CreatedMemory, created ? 201 : 200)
  })

  /** The row, when the caller may change it: 404 when they may not see it, 403 when they may only read it. */
  const changeable = async (c: Context) => {
    const v = await load(c)
    const r = await v.visibleRow(c.req.param('id') ?? '')
    if (!canChangeMemory(v.viewer, r.people))
      throw new DeniedError('members change memories; anyone may correct or forget a memory about themselves')
    return { v, r }
  }

  app.patch('/api/memories/:id', async (c) => {
    const { r } = await changeable(c)
    const body = await jsonBody<Record<string, unknown>>(c)
    if (body.version !== undefined && typeof body.version !== 'number') throw new BadRequestError('version must be a number')
    const me = viewer(c)
    const actor = actorOf(me.contactId)
    const patch: Partial<MemoryData> = {}
    if (body.summary !== undefined) patch.summary = requireString(body.summary, 'summary').trim()
    const kind = parseKind(body.kind)
    if (kind) patch.kind = kind
    if (body.content !== undefined) patch.content = optText(body.content, 'content')?.trim() || undefined
    const employeeId = await parseEmployee(body.employeeId)
    if (employeeId !== undefined) patch.employeeId = employeeId ?? undefined
    const scope = await parseScope(body.scope)
    if (scope) patch.scope = scope
    const about = await parseAbout(body.about)
    const note = optText(body.note, 'note')?.trim()
    if (note !== undefined && !note) throw new BadRequestError('a correction needs a note: say what was wrong')
    if (note) {
      if (note.length > MAX_NOTE) throw new BadRequestError(`the note must be at most ${MAX_NOTE} characters`)
      const at = s.clock.iso()
      Object.assign(patch, { correction: { note, contactId: me.contactId, at }, verified: at })
    }
    if (!Object.keys(patch).length && !about) throw new BadRequestError('nothing to change')
    let m = r.memory
    if (Object.keys(patch).length)
      try {
        m = await s.memory.update(m.id, patch, {
          actor,
          ...(typeof body.version === 'number' ? { expectedVersion: body.version } : {}),
        })
      } catch (e) {
        if (isMpError(e, 'conflict'))
          throw new ConflictError(
            typeof body.version === 'number'
              ? 'someone changed this memory meanwhile: reload it and try again'
              : 'another memory already says this: edit that one instead',
          )
        throw e
      }
    if (about) await setAbout(m, about, actor)
    const v = await load(c)
    const next = v.row(m, await s.records.links({ touching: { kind: 'memory', id: m.id } }))
    return c.json(await v.detail(next))
  })

  app.post('/api/memories/:id/verify', async (c) => {
    const { r } = await changeable(c)
    const m = await s.memory.verify(r.memory.id, { actor: actorOf(viewer(c).contactId) })
    const v = await load(c)
    return c.json(await v.detail(v.row(m, r.links)))
  })

  app.delete('/api/memories/:id', async (c) => {
    const { r } = await changeable(c)
    await s.memory.forget(r.memory.id, { actor: actorOf(viewer(c).contactId) })
    s.logger.info('memory forgotten from the web UI', { memoryId: r.memory.id, by: viewer(c).contactId })
    return c.body(null, 204)
  })

  return app
}
