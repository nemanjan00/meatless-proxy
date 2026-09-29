import { createHash } from 'node:crypto'
import { ConflictError, NotFoundError, ValidationError, isMpError, systemClock, type Clock, type KindSchema } from '@mp/core'
import type { Records } from '@mp/records'
import type { Actor, Link, Ref, StoredRecord } from '@mp/store'

export const MEMORY_KINDS = ['fact', 'preference', 'feedback', 'decision', 'other'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]
export type MemoryScopeType = 'company' | 'project' | 'contact'

/** Role of the default links from a memory to what it's about. */
export const ABOUT = 'about'

export const memorySchema: KindSchema = {
  kind: 'memory',
  prefix: 'mem',
  description: 'One thing the employee learned, was told or decided, recallable in later sessions.',
  titleField: 'summary',
  core: [
    { name: 'summary', type: 'string', required: true, description: "One line, used to decide whether it's relevant." },
    { name: 'kind', type: 'enum', values: [...MEMORY_KINDS], required: true },
    { name: 'content', type: 'text', description: 'Markdown. Link records with [[kind:id]].' },
    {
      name: 'scope',
      type: 'object',
      required: true,
      description: 'Who may recall it: the whole company, one project or one contact.',
      fields: [
        { name: 'type', type: 'enum', values: ['company', 'project', 'contact'], required: true },
        { name: 'id', type: 'ref', ref: ['project', 'contact'] },
      ],
    },
    {
      name: 'source',
      type: 'object',
      description: 'Where it came from and who said it.',
      fields: [
        { name: 'sessionId', type: 'ref', ref: 'session' },
        { name: 'contactId', type: 'ref', ref: 'contact' },
      ],
    },
    { name: 'verified', type: 'timestamp', description: 'When it was last confirmed to still be true.' },
    {
      name: 'employeeId',
      type: 'ref',
      ref: 'employee',
      description: 'The employee workspace it belongs to; unset means shared.',
    },
  ],
}

export interface MemoryScope {
  type: MemoryScopeType
  id?: string
}

export interface MemoryData extends Record<string, unknown> {
  summary: string
  kind: MemoryKind
  content?: string
  scope: MemoryScope
  source?: { sessionId?: string; contactId?: string }
  verified?: string
  employeeId?: string
}

export type Memory = StoredRecord<MemoryData>

export interface RememberInput {
  /** Update this memory instead of looking for one with the same summary. Created with this id if it doesn't exist. */
  id?: string
  summary: string
  /** Default `fact`. */
  kind?: MemoryKind
  content?: string
  /** Default: the whole company. */
  scope?: MemoryScope
  source?: MemoryData['source']
  employeeId?: string
  /** Records it's about (contacts, projects, sessions, memories), linked with role `about`. */
  about?: Ref[]
  actor?: Actor
}

/** What a session is allowed to see. */
export interface RecallContext {
  /** The recalling employee: sees shared memories and its own. Unset: only shared ones. */
  employeeId?: string
  /** Project-scoped memories are visible only for these projects. */
  projectIds?: string[]
  /** Contact-scoped memories are visible only for these contacts. */
  contactIds?: string[]
}

export interface RecallQuery {
  /** Keywords, matched against summary (weighted higher) and content. */
  text?: string
  /** Records the memories should be linked to (or scoped to). */
  refs?: Ref[]
  kinds?: MemoryKind[]
  /**
   * Visibility. Omitted means no filtering (admin tools, the web UI); any
   * session recall must pass one.
   */
  context?: RecallContext
  /** Default 10. */
  limit?: number
}

export interface Recalled {
  memory: Memory
  score: number
  /** The `refs` it's linked or scoped to. */
  matchedRefs: Ref[]
}

export interface MemoryService {
  /** Creates a memory, or updates the one with the same normalized summary in the same scope and workspace. */
  remember(input: RememberInput): Promise<{ memory: Memory; created: boolean }>
  get(id: string): Promise<Memory | null>
  require(id: string): Promise<Memory>
  update(id: string, patch: Partial<MemoryData>, opts?: { actor?: Actor; expectedVersion?: number }): Promise<Memory>
  recall(q: RecallQuery): Promise<Recalled[]>
  /** Whether a memory may be recalled in a context. */
  visible(memory: Memory, context: RecallContext): boolean
  link(memoryId: string, ref: Ref, role?: string, opts?: { actor?: Actor }): Promise<Link>
  unlink(memoryId: string, ref: Ref, role?: string, opts?: { actor?: Actor }): Promise<void>
  /** Records a memory is linked to (out) or linked from (in). */
  links(memoryId: string): Promise<Link[]>
  forget(id: string, opts?: { actor?: Actor }): Promise<void>
  /** Marks a memory as confirmed still true now. */
  verify(id: string, opts?: { actor?: Actor }): Promise<Memory>
}

export interface MemoryDeps {
  records: Records
  clock?: Clock
}

/** `"The Deploy  window is Friday."` -> `the deploy window is friday`. Memories with the same normalized summary are the same fact. */
export function normalizeSummary(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?;:,]+$/g, '')
    .trim()
}

const STOP = new Set(
  'a an and are as at be by can do does for from has have how i in is it its me my of on or our should so that the this to we what when where which who why will with you your'.split(
    ' ',
  ),
)

export function memoryKeywords(text: string): string[] {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
  return [...new Set(words)]
}

const MAX_WORDS = 8
const SCOPE_KIND: Record<MemoryScopeType, string | null> = { company: null, project: 'project', contact: 'contact' }

/** The record key that makes one fact one memory: the same normalized summary, scope and workspace. */
export function memoryKey(d: Pick<MemoryData, 'summary' | 'scope' | 'employeeId'>): string {
  const h = createHash('sha256').update(normalizeSummary(d.summary)).digest('hex').slice(0, 32)
  return `${d.employeeId ?? '*'}|${d.scope.type}|${d.scope.id ?? ''}|${h}`
}

function checkScope(scope: MemoryScope) {
  if (scope.type !== 'company' && !scope.id) throw new ValidationError(`a ${scope.type} memory needs scope.id`)
  if (scope.type === 'company' && scope.id) throw new ValidationError('a company memory has no scope.id')
}

/** Registers the `memory` kind and returns the memory service. */
export function createMemory({ records, clock = systemClock }: MemoryDeps): MemoryService {
  records.kinds.define(memorySchema)

  const tryLink = async (from: Ref, to: Ref, role: string, actor?: Actor) => {
    try {
      await records.link(from, to, role, {}, actor ? { actor } : {})
    } catch (e) {
      // Linking to something that doesn't exist (e.g. a scope id from another system) is not fatal.
      if (!isMpError(e, 'not_found')) throw e
    }
  }

  const linkAbout = async (m: Memory, about: Ref[] | undefined, actor?: Actor) => {
    const from = { kind: 'memory', id: m.id }
    const kind = SCOPE_KIND[m.data.scope.type]
    if (kind && m.data.scope.id) await tryLink(from, { kind, id: m.data.scope.id }, ABOUT, actor)
    for (const r of about ?? []) if (r.id !== m.id) await records.link(from, r, ABOUT, {}, actor ? { actor } : {})
  }

  const visible = (m: Memory, ctx: RecallContext): boolean => {
    if (m.data.employeeId && m.data.employeeId !== ctx.employeeId) return false
    const s = m.data.scope
    if (s.type === 'project') return !!s.id && (ctx.projectIds ?? []).includes(s.id)
    if (s.type === 'contact') return !!s.id && (ctx.contactIds ?? []).includes(s.id)
    return true
  }

  const service: MemoryService = {
    async remember(input) {
      const { id, about, actor, ...rest } = input
      const data: MemoryData = {
        ...rest,
        summary: input.summary?.trim(),
        kind: input.kind ?? 'fact',
        scope: input.scope ?? { type: 'company' },
      }
      for (const [k, v] of Object.entries(data)) if (v === undefined) delete (data as any)[k]
      if (!data.summary) throw new ValidationError('summary is required')
      checkScope(data.scope)
      const key = memoryKey(data)
      const o = actor ? { actor } : {}

      const updateExisting = async (existing: Memory) => {
        const m = await records.update<MemoryData>('memory', existing.id, data, { ...o, key })
        await linkAbout(m, about, actor)
        return { memory: m, created: false }
      }

      if (id) {
        const existing = await records.get<MemoryData>('memory', id)
        if (existing) return updateExisting(existing)
        const m = await records.create<MemoryData>('memory', data, { ...o, key, id })
        await linkAbout(m, about, actor)
        return { memory: m, created: true }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await records.getByKey<MemoryData>('memory', key)
        if (existing) return updateExisting(existing)
        try {
          const m = await records.create<MemoryData>('memory', data, { ...o, key })
          await linkAbout(m, about, actor)
          return { memory: m, created: true }
        } catch (e) {
          // Someone else remembered the same fact at the same time: update theirs.
          if (!(e instanceof ConflictError)) throw e
        }
      }
      throw new ConflictError('could not remember: the memory keeps changing')
    },

    get: (id) => records.get<MemoryData>('memory', id),
    require: (id) => records.require<MemoryData>('memory', id),

    async update(id, patch, opts = {}) {
      const current = await service.require(id)
      const next = { ...current.data, ...patch } as MemoryData
      if (patch.scope) checkScope(patch.scope)
      const key = memoryKey(next)
      const m = await records.update<MemoryData>('memory', id, patch, {
        ...(opts.actor ? { actor: opts.actor } : {}),
        ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        ...(key !== current.key ? { key } : {}),
      })
      if (patch.scope) await linkAbout(m, [], opts.actor)
      return m
    },

    visible,

    async recall(q) {
      const words = memoryKeywords(q.text ?? '').slice(0, MAX_WORDS)
      const refs = q.refs ?? []
      const limit = q.limit ?? 10
      // `kind` can't be a query condition: the store reads it as the record kind, so filter here.
      const kindOk = (m: Memory) => !q.kinds?.length || q.kinds.includes(m.data.kind)
      const candidates = new Map<string, Memory>()
      const refHits = new Map<string, Ref[]>()
      const addRefHit = (memId: string, ref: Ref) => {
        const list = refHits.get(memId) ?? []
        if (!list.some((r) => r.id === ref.id)) list.push(ref)
        refHits.set(memId, list)
      }

      for (const w of words)
        for (const m of (await records.query<MemoryData>('memory', { text: w })).items) candidates.set(m.id, m)
      for (const ref of refs) {
        for (const l of await records.links({ touching: ref })) {
          const other = l.from.id === ref.id ? l.to : l.from
          if (other.kind !== 'memory') continue
          const m = await records.get<MemoryData>('memory', other.id)
          if (m) {
            candidates.set(m.id, m)
            addRefHit(m.id, ref)
          }
        }
        for (const m of (await records.query<MemoryData>('memory', { where: { 'scope.id': ref.id } })).items) {
          candidates.set(m.id, m)
          addRefHit(m.id, ref)
        }
      }
      if (!words.length && !refs.length) {
        const recent = await records.query<MemoryData>('memory', {
          orderBy: { field: 'updatedAt', dir: 'desc' },
          ...(q.context || q.kinds?.length ? {} : { limit }),
        })
        for (const m of recent.items) candidates.set(m.id, m)
      }

      const out: Recalled[] = []
      for (const m of candidates.values()) {
        if (!kindOk(m) || (q.context && !visible(m, q.context))) continue
        const summary = m.data.summary.toLowerCase()
        const content = (m.data.content ?? '').toLowerCase()
        let score = 0
        for (const w of words) {
          if (summary.includes(w)) score += 3
          if (content.includes(w)) score += 1
        }
        const matchedRefs = refHits.get(m.id) ?? []
        score += matchedRefs.length * 5
        if (words.length || refs.length) {
          if (score === 0) continue
        }
        out.push({ memory: m, score, matchedRefs })
      }
      out.sort(
        (a, b) =>
          b.score - a.score ||
          (a.memory.updatedAt < b.memory.updatedAt
            ? 1
            : a.memory.updatedAt > b.memory.updatedAt
              ? -1
              : a.memory.id < b.memory.id
                ? 1
                : -1),
      )
      return out.slice(0, limit)
    },

    async link(memoryId, ref, role = ABOUT, opts = {}) {
      await service.require(memoryId)
      if (ref.id === memoryId) throw new ValidationError('a memory cannot link to itself')
      return records.link({ kind: 'memory', id: memoryId }, ref, role, {}, opts)
    },

    unlink: (memoryId, ref, role = ABOUT, opts = {}) => records.unlink({ kind: 'memory', id: memoryId }, ref, role, opts),

    links: (memoryId) => records.links({ touching: { kind: 'memory', id: memoryId } }),

    async forget(id, opts = {}) {
      if (!(await service.get(id))) throw new NotFoundError('memory', id)
      await records.delete('memory', id, { cascade: true, ...opts })
    },

    verify: (id, opts = {}) => records.update<MemoryData>('memory', id, { verified: clock.iso() }, opts),
  }
  return service
}
