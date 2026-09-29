import { ValidationError, errorMessage } from '@mp/core'
import { APPLIES_TO, IDENTITY, ProjectRoles } from '@mp/directory'
import type { MemoryData } from '@mp/memory'
import { MENTIONS, parseDocLinks } from '@mp/records'
import type { Actor } from '@mp/store'
import { textFields } from './common.ts'
import type { ApplyResult, ImportPlan, PlanItem, PlanIssue, TransferServices } from './types.ts'

export interface ApplyOptions {
  /** Refuse to apply a plan with errors, and stop at the first failure. */
  strict?: boolean
  /** Who the changes are attributed to (default: system `import`). */
  actor?: Actor
}

/**
 * Applies a plan from `planImport`: creates and updates records in dependency
 * order (contacts, employees, projects, procedures, skills, docs, memories,
 * then links). Created records keep the planned ids, so `[[kind:id]]` links in
 * the imported text resolve. An item that fails is reported and the rest go on,
 * unless `strict`.
 */
export async function applyImport(s: TransferServices, plan: ImportPlan, opts: ApplyOptions = {}): Promise<ApplyResult> {
  if (opts.strict && plan.errors.length)
    throw new ValidationError(
      'the import plan has errors',
      plan.errors.map((e) => `${e.source}${e.line !== undefined ? `:${e.line}` : ''}: ${e.message}`),
    )
  const actor: Actor = opts.actor ?? { type: 'system', id: 'import' }
  const o = { actor }
  const { records, directory } = s
  const counts = { create: 0, update: 0, unchanged: 0 }
  const errors: PlanIssue[] = []
  const touched: PlanItem[] = []

  const apply = async (it: PlanItem) => {
    const d = it.data as any
    if (it.kind === 'link') {
      const l = it.link!
      if (l.role === ProjectRoles.owner && l.to.kind === 'project') await directory.projects.setOwner(l.to.id, l.from.id, o)
      else await records.link(l.from, l.to, l.role, l.data ?? {}, o)
      return
    }
    if (it.op === 'create') {
      switch (it.kind) {
        case 'employee': {
          await records.create(it.kind, d, { ...o, id: it.id, ...(it.key ? { key: it.key } : {}) })
          await records.link({ kind: 'employee', id: it.id }, { kind: 'contact', id: d.contactId }, IDENTITY, {}, o)
          return
        }
        case 'procedure': {
          await records.create(it.kind, d, { ...o, id: it.id })
          for (const p of d.projectIds ?? [])
            await records.link({ kind: 'procedure', id: it.id }, { kind: 'project', id: p }, APPLIES_TO, {}, o)
          return
        }
        case 'memory': {
          const { verified, ...rest } = d as MemoryData
          await s.memory.remember({ ...rest, id: it.id, actor })
          if (verified) await s.memory.update(it.id, { verified }, o)
          return
        }
        default:
          await records.create(it.kind, d, { ...o, id: it.id, ...(it.key ? { key: it.key } : {}) })
          return
      }
    }
    switch (it.kind) {
      case 'contact':
        await directory.contacts.update(it.id, d, o)
        return
      case 'employee':
        await directory.employees.update(it.id, d, o)
        return
      case 'project':
        await directory.projects.update(it.id, d, o)
        return
      case 'procedure':
        await directory.procedures.update(it.id, d, o)
        return
      case 'skill':
        await s.skills.update(it.id, d, o)
        return
      case 'doc':
        await s.docs.update(it.id, d, o)
        return
      case 'memory':
        await s.memory.update(it.id, d, o)
        return
    }
  }

  for (const it of plan.items) {
    if (it.op === 'unchanged') {
      counts.unchanged++
      continue
    }
    try {
      await apply(it)
      counts[it.op]++
      if (it.kind !== 'link') touched.push(it)
    } catch (e) {
      if (opts.strict) throw e
      errors.push({ source: it.source, message: `${it.kind} ${it.label}: ${errorMessage(e)}` })
    }
  }

  // `[[kind:id]]` mentions are linked when a record is written, but only to records that already exist:
  // write again the records whose text mentions something created after them.
  for (const it of touched) {
    try {
      const r = await records.get(it.kind, it.id)
      if (!r) continue
      const wanted = new Set<string>()
      for (const f of textFields(records, it.kind)) {
        const v = r.data[f]
        if (typeof v === 'string')
          for (const l of parseDocLinks(v)) if (l.id !== it.id && (await records.get(l.kind, l.id))) wanted.add(l.id)
      }
      if (!wanted.size) continue
      const have = new Set((await records.links({ from: { kind: it.kind, id: it.id }, role: MENTIONS })).map((l) => l.to.id))
      if ([...wanted].some((id) => !have.has(id))) await records.update(it.kind, it.id, {}, o)
    } catch (e) {
      errors.push({ source: it.source, message: `${it.kind} ${it.label}: could not link mentions: ${errorMessage(e)}` })
    }
  }
  return { counts, errors }
}
