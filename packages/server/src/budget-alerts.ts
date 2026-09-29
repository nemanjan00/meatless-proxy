import { errorMessage } from '@mp/core'
import type { ContactData } from '@mp/directory'
import { USAGE_RECORDED, type BudgetStatus, type UsageData } from '@mp/usage'
import { contactTag, type Alerts } from './alerts.ts'
import type { Services } from './services.ts'

/**
 * Budget alerts in #alerts (docs/spec.md#configurable-limits). After every model call, the
 * daily and monthly budgets of its employee, its requester and the whole deployment are
 * checked: at the warning share (`BUDGET_WARN_PERCENT`, 80 % by default) one warning is posted
 * per budget per period, and one more when the budget is used up (new work then pauses until
 * the period ends or an admin raises the limit). The alert key names the budget, the period's
 * start and the field, so there is one of each across restarts and instances.
 *
 * They tag the employee's owner (an `ownerId` contact on the employee, when set) or else the
 * admins; a requester's budget tags that person too.
 */

const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`
      : String(Math.round(n))
const fmtUsd = (n: number) => `$${n.toFixed(2)}`

/** Admins' tags (people with admin access who haven't left). */
async function adminTags(s: Services): Promise<string[]> {
  const admins = (
    await s.records.query<ContactData>('contact', { where: { access: 'admin', kind: 'person' }, limit: 50 })
  ).items.filter((c) => c.data.status !== 'left')
  const tags: string[] = []
  for (const a of admins) {
    const t = await contactTag(s, a.id)
    if (t && !tags.includes(t)) tags.push(t)
  }
  return tags
}

export interface BudgetAlertsOptions {
  /** Share of a budget (0–1) at which to warn; default: the usage defaults' `warnAt`, else 0.8. 0 turns warnings off. */
  warnAt?: number
}

/** Checks one call's budgets and posts what is due. Exported for tests; `wireBudgetAlerts` calls it on every call. */
export async function checkBudgetAlerts(
  s: Services,
  alerts: Pick<Alerts, 'post'>,
  call: Pick<UsageData, 'employeeId' | 'requesterId'>,
  opts: BudgetAlertsOptions = {},
): Promise<string[]> {
  const warnAt = opts.warnAt ?? (await s.usage.limits.defaults()).warnAt ?? 0.8
  const statuses = await s.usage.budgetStatus({
    ...(call.employeeId ? { employeeId: call.employeeId } : {}),
    ...(call.requesterId ? { requesterId: call.requesterId } : {}),
  })
  const posted: string[] = []
  for (const b of statuses) {
    if (b.period !== 'day' && b.period !== 'month') continue
    for (const field of ['maxTokens', 'maxCostUsd'] as const) {
      const max = b[field]
      if (max === undefined || max <= 0) continue
      const used = field === 'maxTokens' ? b.used.tokens : b.used.costUsd
      const share = used / max
      const reached = share >= 1
      if (!reached && (warnAt <= 0 || share < warnAt)) continue
      const condition = reached ? 'budget.reached' : 'budget.warning'
      const key = `${condition}:${b.key}:${b.scopeId ?? 'all'}:${(b.since ?? '').slice(0, 10)}:${field}`
      const text = await alertText(s, b, field, used, max, reached)
      const tags = await tagsFor(s, b)
      const id = await alerts.post(key, { condition, text, tags }, null)
      if (id) posted.push(key)
    }
  }
  return posted
}

async function whose(s: Services, b: BudgetStatus): Promise<{ subject: string; its: string }> {
  if (b.scope === 'employee' && b.scopeId) return { subject: `[[employee:${b.scopeId}]]`, its: 'its' }
  if (b.scope === 'contact' && b.scopeId) {
    const c = await s.directory.contacts.get(b.scopeId)
    return { subject: `Work requested by ${c?.data.name ?? b.scopeId}`, its: 'the requester’s' }
  }
  if (b.scope === 'global') return { subject: 'The whole deployment', its: 'its' }
  return { subject: `The ${b.scope} ${b.scopeId ?? ''}`.trim(), its: 'its' }
}

async function alertText(
  s: Services,
  b: BudgetStatus,
  field: 'maxTokens' | 'maxCostUsd',
  used: number,
  max: number,
  reached: boolean,
) {
  const { subject, its } = await whose(s, b)
  const every = b.period === 'day' ? 'daily' : 'monthly'
  const what = field === 'maxTokens' ? 'token' : 'cost'
  const amount = field === 'maxTokens' ? `${fmtTokens(used)} of ${fmtTokens(max)} tokens` : `${fmtUsd(used)} of ${fmtUsd(max)}`
  const when = b.period === 'day' ? 'today' : 'this month'
  const resets = b.period === 'day' ? 'at 00:00 UTC' : 'at the start of next month (UTC)'
  if (reached)
    return `${subject} used up ${its} ${every} ${what} budget: ${amount} ${when}. New work pauses until it resets ${resets}, or until an admin raises the limit in Settings → Limits.`
  const pct = Math.floor((used / max) * 100)
  return `${subject} has used ${pct}% of ${its} ${every} ${what} budget: ${amount} ${when}. At 100% new work pauses until it resets ${resets}. Settings → Limits can raise it.`
}

async function tagsFor(s: Services, b: BudgetStatus): Promise<string[]> {
  const tags: string[] = []
  if (b.scope === 'employee' && b.scopeId) {
    const e = await s.directory.employees.get(b.scopeId)
    const owner = typeof e?.data.ownerId === 'string' ? await contactTag(s, e.data.ownerId) : null
    if (owner) return [owner]
  }
  if (b.scope === 'contact' && b.scopeId) {
    const t = await contactTag(s, b.scopeId)
    if (t) tags.push(t)
  }
  for (const t of await adminTags(s)) if (!tags.includes(t)) tags.push(t)
  return tags
}

/**
 * Listens for recorded model calls and posts budget alerts. Checks run one at a time (a burst of
 * calls makes one check per employee and requester that is still pending), so a busy employee
 * doesn't cost a check per call.
 */
export function wireBudgetAlerts(s: Services, alerts: Pick<Alerts, 'post'>, opts: BudgetAlertsOptions = {}): () => void {
  const pending = new Map<string, Pick<UsageData, 'employeeId' | 'requesterId'>>()
  let running: Promise<void> | null = null
  const drain = async () => {
    while (pending.size) {
      const [key, call] = pending.entries().next().value as [string, Pick<UsageData, 'employeeId' | 'requesterId'>]
      pending.delete(key)
      try {
        await checkBudgetAlerts(s, alerts, call, opts)
      } catch (err) {
        s.logger.error('could not check budgets for alerts', { err: errorMessage(err) })
      }
    }
    running = null
  }
  return s.bus.subscribe<UsageData>(USAGE_RECORDED, (m) => {
    const call = { employeeId: m.payload.employeeId, requesterId: m.payload.requesterId }
    pending.set(`${call.employeeId ?? ''}:${call.requesterId ?? ''}`, call)
    running ??= drain()
    return running
  })
}
