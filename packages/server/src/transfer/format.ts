import { stableStringify } from '@mp/core'
import { KIND_ORDER, type ApplyResult, type ImportPlan, type PlanCounts, type PlanIssue } from './types.ts'

const MAX_VALUE = 60

function short(v: unknown): string {
  const s = v === undefined ? '(none)' : typeof v === 'string' ? JSON.stringify(v.replace(/\s+/g, ' ')) : stableStringify(v)
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s
}

const counts = (c: PlanCounts) => `create ${c.create}, update ${c.update}, unchanged ${c.unchanged}`
const where = (i: PlanIssue) => `${i.source}${i.line !== undefined ? `:${i.line}` : ''}`

/**
 * A plan as text, for `--dry-run`: one line per created or updated record with
 * its changed fields, then counts per kind, warnings and errors. Unchanged
 * records are only counted, unless `verbose`.
 */
export function formatPlan(plan: ImportPlan, opts: { verbose?: boolean } = {}): string {
  const out: string[] = []
  for (const it of plan.items) {
    if (it.op === 'unchanged' && !opts.verbose) continue
    out.push(`${it.op.padEnd(9)} ${it.kind.padEnd(9)} ${it.label}  [${it.source}]`)
    for (const c of it.changes) {
      if (it.op === 'create') out.push(`    + ${c.field}: ${short(c.to)}`)
      else out.push(`    ~ ${c.field}: ${short(c.from)} -> ${short(c.to)}`)
    }
  }
  if (out.length) out.push('')
  out.push(`Plan: ${counts(plan.counts)}; ${plan.errors.length} error(s), ${plan.warnings.length} warning(s)`)
  for (const k of KIND_ORDER) {
    const c = plan.byKind[k]
    if (c) out.push(`  ${k.padEnd(9)} ${counts(c)}`)
  }
  if (plan.warnings.length) {
    out.push('', 'Warnings:')
    for (const w of plan.warnings) out.push(`  ${where(w)}: ${w.message}`)
  }
  if (plan.errors.length) {
    out.push('', 'Errors (skipped):')
    for (const e of plan.errors) out.push(`  ${where(e)}: ${e.message}`)
  }
  return `${out.join('\n')}\n`
}

/** The outcome of `applyImport` as text. */
export function formatApplyResult(r: ApplyResult): string {
  const out = [`Applied: ${counts(r.counts)}; ${r.errors.length} failure(s)`]
  for (const e of r.errors) out.push(`  ${where(e)}: ${e.message}`)
  return `${out.join('\n')}\n`
}
