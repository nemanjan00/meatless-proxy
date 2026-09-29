import { errorMessage, isMpError, type KindSchema } from '@mp/core'
import { afterToolCall } from '@mp/runner'
import type { Ref, StoredRecord } from '@mp/store'
import type { Services } from '../services.ts'

/**
 * When employees use knowledge: a memory recalled (by `memory.recall`, or loaded at the start of
 * work) or a skill loaded (`skills.load`). One small record per thing and employee, keyed
 * `<kind>:<id>:<employeeId>`, with the last time and a count. It's kept apart from the memory
 * and skill records so using them doesn't make new versions (or conflicts with someone editing).
 */
export const USE_KIND = 'knowledge_use'

export const knowledgeUseSchema: KindSchema = {
  kind: USE_KIND,
  prefix: 'kus',
  description: 'When an employee last used a memory or a skill, and how often.',
  core: [
    {
      name: 'target',
      type: 'object',
      required: true,
      fields: [
        { name: 'kind', type: 'string', required: true },
        { name: 'id', type: 'string', required: true },
      ],
    },
    { name: 'employeeId', type: 'string' },
    { name: 'lastAt', type: 'timestamp', required: true },
    { name: 'count', type: 'number', required: true },
    { name: 'lastSessionId', type: 'string' },
  ],
}

export interface KnowledgeUseData extends Record<string, unknown> {
  target: Ref
  employeeId?: string
  lastAt: string
  count: number
  lastSessionId?: string
}

export type KnowledgeUse = StoredRecord<KnowledgeUseData>

type Deps = Pick<Services, 'records' | 'clock'>

export function defineUseKind(records: Services['records']) {
  if (!records.kinds.has(USE_KIND)) records.kinds.define(knowledgeUseSchema)
}

/** Records one use. Safe under races (compare-and-swap, retried). */
export async function recordUse(s: Deps, target: Ref, employeeId: string | undefined, sessionId?: string): Promise<void> {
  defineUseKind(s.records)
  const key = `${target.kind}:${target.id}:${employeeId ?? '*'}`
  const at = s.clock.iso()
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await s.records.getByKey<KnowledgeUseData>(USE_KIND, key)
    try {
      if (cur) {
        await s.records.update<KnowledgeUseData>(
          USE_KIND,
          cur.id,
          { lastAt: at, count: cur.data.count + 1, ...(sessionId ? { lastSessionId: sessionId } : {}) },
          { expectedVersion: cur.version },
        )
      } else {
        await s.records.create<KnowledgeUseData>(
          USE_KIND,
          {
            target: { kind: target.kind, id: target.id },
            ...(employeeId ? { employeeId } : {}),
            lastAt: at,
            count: 1,
            ...(sessionId ? { lastSessionId: sessionId } : {}),
          },
          { key },
        )
      }
      return
    } catch (e) {
      if (!isMpError(e, 'conflict')) throw e
    }
  }
}

/** Every use of records of a kind, optionally only since a time. */
export async function usesOf(s: Pick<Services, 'records'>, kind: string, since?: string): Promise<KnowledgeUse[]> {
  defineUseKind(s.records)
  const out: KnowledgeUse[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await s.records.query<KnowledgeUseData>(USE_KIND, {
      where: [
        { field: 'target.kind', op: 'eq', value: kind },
        ...(since ? [{ field: 'lastAt', op: 'gte' as const, value: since }] : []),
      ],
      orderBy: { field: 'createdAt', dir: 'asc' },
      limit: 1000,
      offset,
    })
    out.push(...(page.items as KnowledgeUse[]))
    if (page.items.length < 1000) break
  }
  return out
}

/** Uses grouped by the record they're about. */
export function byTarget(uses: KnowledgeUse[]): Map<string, KnowledgeUse[]> {
  const m = new Map<string, KnowledgeUse[]>()
  for (const u of uses) m.set(u.data.target.id, [...(m.get(u.data.target.id) ?? []), u])
  return m
}

/** Records memory recalls and skill loads as they happen. Returns a function that stops it. */
export function registerKnowledgeUse(s: Services): () => void {
  defineUseKind(s.records)
  const log = s.logger.child({ component: 'knowledge-use' })
  const track = (fn: () => Promise<void>) => {
    void fn().catch((err) => log.warn('could not record a knowledge use', { err: errorMessage(err) }))
  }
  return s.hooks.onTransform(afterToolCall, async (p) => {
    if (p.result.isError) return p
    const name = p.tool.name
    if (name !== 'memory.recall' && name !== 'skills.load') return p
    const out = p.result.output as Record<string, unknown> | null
    const employeeId = p.run.data.employeeId
    const sessionId = p.session.id
    if (name === 'memory.recall') {
      const ids = ((out?.memories as { id?: unknown }[] | undefined) ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string')
      track(async () => {
        for (const id of ids) await recordUse(s, { kind: 'memory', id }, employeeId, sessionId)
      })
    } else {
      const skillName = typeof out?.name === 'string' ? out.name : null
      const version = typeof out?.version === 'number' ? out.version : null
      if (skillName)
        track(async () => {
          const same = (await s.skills.list()).filter((k) => k.data.name.trim().toLowerCase() === skillName.trim().toLowerCase())
          const hit = same.find((k) => k.version === version) ?? same[0]
          if (hit) await recordUse(s, { kind: 'skill', id: hit.id }, employeeId, sessionId)
        })
    }
    return p
  })
}
