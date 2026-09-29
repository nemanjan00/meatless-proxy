import { ManualClock, NotFoundError, ValidationError, createEventBus } from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  USAGE_RECORDED,
  checkForkLimits,
  createUsage,
  mergeLimits,
  startOfUtcDay,
  startOfUtcMonth,
  type UsageService,
} from '../src/index.ts'

let clock: ManualClock
let records: Records
let usage: UsageService

const pricing = {
  kimi: { inputPerM: 1, outputPerM: 4, cachedInputPerM: 0.25 },
  cheap: { inputPerM: 0.1, outputPerM: 0.2 },
}

beforeEach(() => {
  clock = new ManualClock(Date.UTC(2026, 8, 29, 12))
  records = createRecords({ store: memoryStore({ clock }) })
  usage = createUsage({ records, clock, pricing })
})

const call = (over: Record<string, unknown> = {}) =>
  usage.record({
    runId: 'run_1',
    sessionId: 'ses_1',
    rootSessionId: 'ses_root',
    employeeId: 'emp_a',
    requesterId: 'con_ana',
    model: 'kimi',
    promptTokens: 1000,
    completionTokens: 100,
    ...over,
  } as any)

describe('ledger', () => {
  it('records calls and computes cost from pricing', async () => {
    const r = await call({ cachedTokens: 400 })
    expect(r.id).toMatch(/^use_/)
    // 600 uncached * 1 + 400 cached * 0.25 + 100 out * 4 = 600 + 100 + 400 = 1100 micro-dollars
    expect(r.data).toMatchObject({ totalTokens: 1100, costUsd: 0.0011, at: '2026-09-29T12:00:00.000Z' })
    expect((await call({ model: 'unknown' })).data.costUsd).toBe(0)
    expect((await call({ costUsd: 5 })).data.costUsd).toBe(5)
    expect(usage.cost('cheap', { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 10 })).toBeCloseTo(0.3)
    await expect(call({ promptTokens: -1 })).rejects.toThrow(ValidationError)
    await expect(call({ model: undefined })).rejects.toThrow(ValidationError)
  })

  it('publishes on the bus', async () => {
    const bus = createEventBus()
    const seen: unknown[] = []
    bus.subscribe(USAGE_RECORDED, (m) => {
      seen.push(m.payload)
    })
    const u = createUsage({ records, clock, pricing, bus })
    await u.record({ model: 'kimi', promptTokens: 1, completionTokens: 1 })
    await bus.idle()
    expect(seen).toMatchObject([{ model: 'kimi', totalTokens: 2 }])
  })

  it('totals by filter', async () => {
    await call()
    await call({ runId: 'run_2', sessionId: 'ses_2', cachedTokens: 1000, reasoningTokens: 50 })
    await call({ employeeId: 'emp_b', rootSessionId: 'ses_other', sessionId: 'ses_3', runId: 'run_3', model: 'cheap' })
    const all = await usage.totals()
    expect(all).toMatchObject({
      calls: 3,
      promptTokens: 3000,
      completionTokens: 300,
      cachedTokens: 1000,
      reasoningTokens: 50,
      totalTokens: 3300,
    })
    expect(all.costUsd).toBeCloseTo(0.0014 + 0.00065 + 0.00012, 9)
    expect((await usage.totals({ runId: 'run_1' })).calls).toBe(1)
    expect((await usage.totals({ rootSessionId: 'ses_root' })).calls).toBe(2)
    expect((await usage.totals({ employeeId: 'emp_b' })).totalTokens).toBe(1100)
    expect((await usage.totals({ model: 'cheap', requesterId: 'con_ana' })).calls).toBe(1)
    expect(await usage.totals({ runId: 'nope' })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      calls: 0,
    })
    clock.advance(60_000)
    const since = clock.iso()
    await call()
    expect((await usage.totals({ since })).calls).toBe(1)
    expect((await usage.totals({ until: since })).calls).toBe(3)
  })

  it('breaks down by group and by day', async () => {
    await call({ employeeId: 'emp_a', promptTokens: 10, completionTokens: 0 })
    await call({ employeeId: 'emp_b', promptTokens: 500, completionTokens: 0 })
    await call({ employeeId: 'emp_b', promptTokens: 500, completionTokens: 0 })
    await call({ employeeId: undefined, promptTokens: 1, completionTokens: 0 })
    const byEmp = await usage.breakdown('employee')
    expect(byEmp.map((r) => [r.key, r.totalTokens, r.calls])).toEqual([
      ['emp_b', 1000, 2],
      ['emp_a', 10, 1],
      [null, 1, 1],
    ])
    clock.advance(24 * 3600_000)
    await call({ promptTokens: 7, completionTokens: 0 })
    const byDay = await usage.breakdown('day')
    expect(byDay.map((r) => [r.key, r.totalTokens])).toEqual([
      ['2026-09-29', 1011],
      ['2026-09-30', 7],
    ])
    expect((await usage.breakdown('model', { employeeId: 'emp_b' })).map((r) => r.key)).toEqual(['kimi'])
    expect((await usage.breakdown('requester')).map((r) => r.key)).toEqual(['con_ana'])
    expect((await usage.breakdown('session')).map((r) => r.key)).toEqual(['ses_1'])
  })
})

describe('limits', () => {
  it('upserts by target and period, lists and removes', async () => {
    const a = await usage.limits.set({ target: { type: 'global' }, maxTokens: 1000, period: 'run' })
    const b = await usage.limits.set({ target: { type: 'global' }, maxTokens: 500, period: 'run' })
    expect(b.id).toBe(a.id)
    expect(b.data.maxTokens).toBe(500)
    await usage.limits.set({ target: { type: 'global' }, maxTokens: 9000, period: 'day' })
    await usage.limits.set({ target: { type: 'employee', id: 'emp_a' }, maxDepth: 2 })
    expect((await usage.limits.list()).length).toBe(3)
    expect((await usage.limits.list({ targetType: 'employee', targetId: 'emp_a' })).length).toBe(1)
    const edited = await usage.limits.set({ id: a.id, target: { type: 'global' }, maxCostUsd: 1, period: 'session' })
    expect(edited.data).toEqual({ target: { type: 'global' }, maxCostUsd: 1, period: 'session' })
    await usage.limits.remove(a.id)
    await expect(usage.limits.remove(a.id)).rejects.toThrow(NotFoundError)
    await expect(usage.limits.set({ target: { type: 'global' }, maxTokens: -1 })).rejects.toThrow(ValidationError)
    await expect(usage.limits.set({ target: { type: 'global', id: 'x' } })).rejects.toThrow(ValidationError)
    await expect(usage.limits.set({ target: { type: 'planet' as any } })).rejects.toThrow(ValidationError)
  })

  it('merges the tightest values across matching limits', async () => {
    await usage.limits.set({ target: { type: 'global' }, maxDepth: 5, maxFanOut: 10, maxTokens: 100_000, period: 'run' })
    await usage.limits.set({ target: { type: 'employee', id: 'emp_a' }, maxDepth: 3, maxTokens: 50_000, period: 'run' })
    await usage.limits.set({ target: { type: 'employee', id: 'emp_b' }, maxDepth: 1 })
    await usage.limits.set({ target: { type: 'template', id: 'tpl_x' }, maxFanOut: 4, maxWallMs: 60_000 })
    await usage.limits.set({ target: { type: 'procedure' }, maxAiStreak: 6 })
    await usage.limits.set({ target: { type: 'tree', id: 'ses_root' }, maxCostUsd: 2 })
    await usage.limits.set({ target: { type: 'session', id: 'ses_1' }, maxConcurrentSessions: 3, enabled: false })

    const eff = await usage.limits.effective({
      employeeId: 'emp_a',
      templateId: 'tpl_x',
      rootSessionId: 'ses_root',
      sessionId: 'ses_1',
    })
    expect(eff).toMatchObject({
      maxDepth: 3,
      maxFanOut: 4,
      maxWallMs: 60_000,
      budgets: { run: { maxTokens: 50_000 }, tree: { maxCostUsd: 2 } },
    })
    expect(eff.maxAiStreak).toBeUndefined()
    expect(eff.maxConcurrentSessions).toBeUndefined()
    expect(eff.limitIds.length).toBe(4)
    const withProc = await usage.limits.effective({ employeeId: 'emp_c', procedureId: 'prc_any' })
    expect(withProc).toMatchObject({ maxDepth: 5, maxFanOut: 10, maxAiStreak: 6 })
    expect(mergeLimits([])).toEqual({ budgets: {}, limitIds: [] })
  })
})

describe('checkBudget', () => {
  const ctx = { runId: 'run_1', sessionId: 'ses_1', rootSessionId: 'ses_root', employeeId: 'emp_a' }

  it('checks run, session and tree budgets', async () => {
    await usage.limits.set({ target: { type: 'global' }, maxTokens: 2500, period: 'run' })
    expect(await usage.checkBudget(ctx)).toEqual({ ok: true })
    await call()
    await call()
    expect((await usage.checkBudget(ctx)).ok).toBe(true)
    await call()
    const res = await usage.checkBudget(ctx)
    expect(res).toMatchObject({ ok: false, field: 'maxTokens', period: 'run', used: { tokens: 3300 } })
    // A new run of the same session starts fresh...
    expect((await usage.checkBudget({ ...ctx, runId: 'run_2' })).ok).toBe(true)
    // ...unless the session has its own budget.
    await usage.limits.set({ target: { type: 'session' }, maxTokens: 3000 })
    expect(await usage.checkBudget({ ...ctx, runId: 'run_2' })).toMatchObject({ ok: false, period: 'session' })
    // Tree cost.
    await usage.limits.set({ target: { type: 'tree', id: 'ses_root' }, maxCostUsd: 0.004 })
    expect(await usage.checkBudget({ ...ctx, runId: 'run_9', sessionId: 'ses_9' })).toMatchObject({
      ok: false,
      field: 'maxCostUsd',
      period: 'tree',
    })
    expect(
      (await usage.checkBudget({ runId: 'run_9', sessionId: 'ses_9', rootSessionId: 'ses_x', employeeId: 'emp_a' })).ok,
    ).toBe(true)
  })

  it('checks day and month budgets over the employee', async () => {
    await usage.limits.set({ target: { type: 'employee', id: 'emp_a' }, maxTokens: 2000, period: 'day' })
    await usage.limits.set({ target: { type: 'employee', id: 'emp_a' }, maxTokens: 3000, period: 'month' })
    await call({ runId: 'r1' })
    await call({ runId: 'r2', employeeId: 'emp_b' })
    expect((await usage.checkBudget(ctx)).ok).toBe(true)
    await call({ runId: 'r3' })
    expect(await usage.checkBudget(ctx)).toMatchObject({ ok: false, period: 'day', used: { tokens: 2200 } })
    expect((await usage.checkBudget({ ...ctx, employeeId: 'emp_b' })).ok).toBe(true)
    // Next UTC day: the day budget resets, the month budget still counts.
    clock.set(Date.UTC(2026, 8, 30, 0, 0, 1))
    expect((await usage.checkBudget(ctx)).ok).toBe(true)
    await call({ runId: 'r4' })
    expect(await usage.checkBudget(ctx)).toMatchObject({ ok: false, period: 'month', used: { tokens: 3300 } })
    clock.set(Date.UTC(2026, 9, 1, 0, 0, 0))
    expect((await usage.checkBudget(ctx)).ok).toBe(true)
  })

  it('ignores disabled limits and limits for other targets', async () => {
    await usage.limits.set({ target: { type: 'global' }, maxTokens: 1, enabled: false })
    await usage.limits.set({ target: { type: 'employee', id: 'emp_z' }, maxTokens: 1 })
    await usage.limits.set({ target: { type: 'template', id: 'tpl_1' }, maxTokens: 1 })
    await call()
    expect((await usage.checkBudget(ctx)).ok).toBe(true)
    expect((await usage.checkBudget({ ...ctx, templateId: 'tpl_1' })).ok).toBe(false)
  })

  it('computes period starts in UTC', () => {
    expect(startOfUtcDay(Date.UTC(2026, 1, 3, 23, 59))).toBe('2026-02-03T00:00:00.000Z')
    expect(startOfUtcMonth(Date.UTC(2026, 1, 3, 23, 59))).toBe('2026-02-01T00:00:00.000Z')
  })
})

describe('checkForkLimits', () => {
  it('allows up to the limit and refuses beyond it', () => {
    const limits = { maxDepth: 2, maxFanOut: 3, maxConcurrentSessions: 5, budgets: {}, limitIds: [] }
    expect(checkForkLimits({ depth: 2, fanOut: 3, runningSessions: 5, limits })).toEqual({ ok: true })
    expect(checkForkLimits({ depth: 3, fanOut: 1, runningSessions: 1, limits })).toMatchObject({
      ok: false,
      field: 'maxDepth',
      max: 2,
    })
    expect(checkForkLimits({ depth: 1, fanOut: 4, runningSessions: 1, limits })).toMatchObject({ ok: false, field: 'maxFanOut' })
    expect(checkForkLimits({ depth: 1, fanOut: 1, runningSessions: 6, limits })).toMatchObject({
      ok: false,
      field: 'maxConcurrentSessions',
    })
    expect(checkForkLimits({ depth: 99, fanOut: 99, runningSessions: 99, limits: { budgets: {}, limitIds: [] } })).toEqual({
      ok: true,
    })
  })
})
