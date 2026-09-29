import type { LimitsOverview, PricingInfo } from '@mp/api'
import type { Message } from '@mp/chat'
import { reply } from '@mp/model'
import { afterEach, describe, expect, it } from 'vitest'
import { ALERTS_CHANNEL } from '../src/alerts.ts'
import { checkBudgetAlerts } from '../src/budget-alerts.ts'
import { loadConfig } from '../src/config.ts'
import { limitDefaults } from '../src/limits.ts'
import { testApp, until, type TestApp, type TestAppOptions } from './helpers.ts'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function make(opts: TestAppOptions = {}) {
  const t = await testApp({ workers: false, ...opts })
  apps.push(t)
  const s = t.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const person = async (name: string, handle: string, access?: 'viewer' | 'member' | 'admin') =>
    (
      await s.directory.contacts.create({
        name,
        kind: 'person',
        status: 'active',
        handles: [{ system: 'mp', id: handle }],
        ...(access ? { access } : {}),
      })
    ).id
  return { t, s, employee, person }
}

describe('defaults', () => {
  it('has runaway protection without any configuration', () => {
    const d = limitDefaults(loadConfig({}))
    expect(d).toEqual({
      maxDepth: 5,
      maxFanOut: 20,
      maxConcurrentSessions: 8,
      maxSteps: 60,
      maxWallMs: 30 * 60_000,
      maxAiStreak: 20,
      budgets: [{ target: 'employee', period: 'day', maxTokens: 5_000_000 }],
      warnAt: 0.8,
    })
  })

  it('reads every default from the environment; 0 turns a limit off', () => {
    const d = limitDefaults(
      loadConfig({
        LIMIT_MAX_DEPTH: '2',
        LIMIT_MAX_FAN_OUT: '3',
        LIMIT_MAX_CONCURRENT_RUNS: '4',
        MAX_STEPS: '10',
        LIMIT_RUN_WALL_MINUTES: '0',
        LIMIT_EMPLOYEE_DAILY_TOKENS: '0',
        LIMIT_EMPLOYEE_DAILY_COST_USD: '5',
        LIMIT_DEPLOYMENT_DAILY_TOKENS: '9000000',
        LIMIT_DEPLOYMENT_DAILY_COST_USD: '50',
        LIMIT_MAX_AI_STREAK: '6',
        BUDGET_WARN_PERCENT: '90',
      }),
    )
    expect(d).toEqual({
      maxDepth: 2,
      maxFanOut: 3,
      maxConcurrentSessions: 4,
      maxSteps: 10,
      maxAiStreak: 6,
      budgets: [
        { target: 'employee', period: 'day', maxCostUsd: 5 },
        { target: 'global', period: 'day', maxTokens: 9_000_000, maxCostUsd: 50 },
      ],
      warnAt: 0.9,
    })
    expect(() => loadConfig({ LIMIT_MAX_DEPTH: '-1' })).toThrow('LIMIT_MAX_DEPTH')
    expect(() => loadConfig({ BUDGET_WARN_PERCENT: '120' })).toThrow('BUDGET_WARN_PERCENT')
  })

  it('applies the defaults to runs and forks with no limit records', async () => {
    const { s, employee } = await make()
    expect(await s.usage.limits.list()).toEqual([])
    const eff = await s.usage.limits.effective({ employeeId: employee.id })
    expect(eff).toMatchObject({ maxDepth: 5, maxFanOut: 20, maxConcurrentSessions: 8, maxWallMs: 1_800_000, maxSteps: 60 })
    expect(eff.budgets).toEqual([
      { key: 'day:employee', period: 'day', scope: 'employee', maxTokens: 5_000_000, sources: { maxTokens: 'default' } },
    ])
  })

  it('a run pauses with a reason when the daily budget is used up, and an override lets new work through', async () => {
    const { s, employee } = await make({ env: { LIMIT_EMPLOYEE_DAILY_TOKENS: '1000' }, script: [reply('done')] })
    await s.usage.record({ employeeId: employee.id, model: 'm', promptTokens: 900, completionTokens: 200 })
    const session = await s.sessions.create({ employeeId: employee.id, title: 'Budget' })
    const run = await s.sessions.createRun({ sessionId: session.id, cause: { type: 'manual' } })
    expect(await s.runner.execute(run.id)).toMatchObject({ status: 'paused' })
    const paused = await s.sessions.requireRun(run.id)
    expect(paused.data.pauseReason).toBe(
      "the employee's daily token budget is used up: 1,100 of 1,000 tokens today (it resets at 00:00 UTC)",
    )
    await s.usage.limits.set({ target: { type: 'employee', id: employee.id }, maxTokens: 10_000, period: 'day' })
    await s.sessions.transition(run.id, 'paused', 'queued', { pauseReason: undefined } as never)
    expect(await s.runner.execute(run.id)).toMatchObject({ status: 'completed' })
  })
})

describe('limits API', () => {
  it('is for admins only, reading included', async () => {
    const { t, person } = await make()
    const viewer = await person('Vera Example', 'vera', 'viewer')
    const member = await person('Mo Example', 'mo', 'member')
    for (const who of [viewer, member]) {
      const h = { 'x-mp-contact': who }
      expect((await t.req('GET', '/api/limits', undefined, h)).status).toBe(403)
      expect((await t.req('GET', '/api/pricing', undefined, h)).status).toBe(403)
      expect((await t.req('POST', '/api/limits', { target: { type: 'global' }, maxDepth: 1 }, h)).status).toBe(403)
      expect((await t.req('PUT', '/api/pricing', { pricing: {} }, h)).status).toBe(403)
    }
    expect((await t.req('GET', '/api/limits', undefined, { authorization: '' })).status).toBe(401)
    expect((await t.req('GET', '/api/limits')).status).toBe(200)
  })

  it('creates, edits and deletes overrides, with validation', async () => {
    const { t, s, employee } = await make()
    const created = await t.req('POST', '/api/limits', {
      target: { type: 'employee', id: employee.id },
      maxConcurrentSessions: 2,
    })
    expect(created.status).toBe(201)
    expect(created.body.data).toEqual({ target: { type: 'employee', id: employee.id }, maxConcurrentSessions: 2 })
    expect((await s.usage.limits.effective({ employeeId: employee.id })).maxConcurrentSessions).toBe(2)

    const edited = await t.req('PUT', `/api/limits/${created.body.id}`, {
      target: { type: 'employee', id: employee.id },
      maxConcurrentSessions: 3,
      maxWallMs: null,
    })
    expect(edited.status).toBe(200)
    const eff = await s.usage.limits.effective({ employeeId: employee.id })
    expect(eff.maxConcurrentSessions).toBe(3)
    expect(eff.maxWallMs).toBeUndefined()

    for (const bad of [
      {},
      { target: { type: 'planet' }, maxDepth: 1 },
      { target: { type: 'global' } },
      { target: { type: 'global' }, maxDepth: -1 },
      { target: { type: 'global' }, maxDepth: 'lots' },
      { target: { type: 'global' }, maxDepth: 1, period: 'day' },
      { target: { type: 'global' }, maxTokens: 1, period: 'week' },
      { target: { type: 'global' }, maxDepth: 1, colour: 'red' },
      { target: { type: 'global', id: 'x' }, maxDepth: 1 },
    ])
      expect((await t.req('POST', '/api/limits', bad)).status, JSON.stringify(bad)).toBe(422)
    expect((await t.req('PUT', '/api/limits/lim_missing', { target: { type: 'global' }, maxDepth: 1 })).status).toBe(404)
    expect((await t.req('DELETE', '/api/limits/lim_missing')).status).toBe(404)

    expect((await t.req('DELETE', `/api/limits/${created.body.id}`)).status).toBe(204)
    expect((await s.usage.limits.effective({ employeeId: employee.id })).maxConcurrentSessions).toBe(8)
  })

  it('shows the effective limits per scope with budget usage', async () => {
    const { t, s, employee, person } = await make({ env: { LIMIT_DEPLOYMENT_DAILY_TOKENS: '100000' } })
    const ana = await person('Ana Example', 'ana')
    await s.usage.record({
      employeeId: employee.id,
      requesterId: ana,
      model: 'kimi-k2.7-code',
      promptTokens: 1500,
      completionTokens: 500,
    })
    await s.usage.record({ employeeId: employee.id, model: 'mystery-model', promptTokens: 10, completionTokens: 10 })
    await s.usage.limits.set({ target: { type: 'contact', id: ana }, maxTokens: 4000 })
    await s.usage.limits.set({ target: { type: 'employee' }, maxFanOut: 30 })
    const r = await t.req<LimitsOverview>('GET', '/api/limits')
    expect(r.status).toBe(200)
    const o = r.body
    expect(o.defaults.maxDepth).toBe(5)
    expect(o.overrides).toHaveLength(2)
    const every = o.scopes[0]!
    expect(every).toMatchObject({ target: { type: 'global' }, name: 'Every employee', caps: { maxFanOut: 30, maxDepth: 5 } })
    expect(every.sources.maxDepth).toBe('default')
    expect(every.budgets.find((b) => b.key === 'day:global')).toMatchObject({ maxTokens: 100_000, used: { tokens: 2020 } })
    const emp = o.scopes.find((x) => x.target.id === employee.id)!
    expect(emp.budgets).toEqual([
      expect.objectContaining({ key: 'day:employee', maxTokens: 5_000_000, used: expect.objectContaining({ tokens: 2020 }) }),
    ])
    const req = o.scopes.find((x) => x.target.type === 'contact')!
    expect(req).toMatchObject({ name: 'Ana Example', target: { id: ana } })
    expect(req.budgets).toEqual([
      expect.objectContaining({ key: 'day:contact', maxTokens: 4000, used: expect.objectContaining({ tokens: 2000 }) }),
    ])
    expect(o.unpricedModels).toContain('mystery-model')
    expect(o.unpricedModels).not.toContain('kimi-k2.7-code')
  })
})

describe('pricing', () => {
  it('prices models from the built-in table without configuration', async () => {
    const { s, employee } = await make()
    const u = await s.usage.record({
      employeeId: employee.id,
      model: 'kimi-k2.7-code',
      promptTokens: 1_000_000,
      completionTokens: 0,
    })
    expect(u.data.costUsd).toBeCloseTo(0.95)
  })

  it('PRICING overrides the built-in table, and the Settings editor overrides both', async () => {
    const { t, s, employee } = await make({
      env: {
        PRICING: JSON.stringify({
          'kimi-k2.7-code': { inputPerM: 2, outputPerM: 8 },
          'house-model': { inputPerM: 1, outputPerM: 1 },
        }),
      },
    })
    const cost = () => s.usage.cost('kimi-k2.7-code', { promptTokens: 1_000_000, completionTokens: 0 })
    expect(cost()).toBe(2)
    let info = (await t.req<PricingInfo>('GET', '/api/pricing')).body
    expect(info.env['house-model']).toEqual({ inputPerM: 1, outputPerM: 1 })
    expect(info.builtin['kimi-k2.7-code']).toBeDefined()
    expect(info.custom).toEqual({})

    const put = await t.req<PricingInfo>('PUT', '/api/pricing', {
      pricing: { 'kimi-k2.7-code': { inputPerM: 3, cachedInputPerM: 0.5, outputPerM: 9 } },
    })
    expect(put.status).toBe(200)
    expect(put.body.custom).toEqual({ 'kimi-k2.7-code': { inputPerM: 3, cachedInputPerM: 0.5, outputPerM: 9 } })
    expect(cost()).toBe(3)
    expect(await s.settings.get('pricing')).toEqual(put.body.custom)
    await s.usage.record({ employeeId: employee.id, model: 'kimi-k2.7-code', promptTokens: 1, completionTokens: 1 })
    info = (await t.req<PricingInfo>('GET', '/api/pricing')).body
    expect(info.models).toContainEqual({ model: 'kimi-k2.7-code', price: put.body.custom['kimi-k2.7-code'], source: 'custom' })

    for (const bad of [
      { pricing: { m: { inputPerM: 1 } } },
      { pricing: { m: { inputPerM: -1, outputPerM: 1 } } },
      { pricing: [] },
    ])
      expect((await t.req('PUT', '/api/pricing', bad)).status, JSON.stringify(bad)).toBe(422)
    // Clearing the editor falls back to PRICING.
    expect((await t.req('PUT', '/api/pricing', { pricing: {} })).status).toBe(200)
    expect(cost()).toBe(2)
  })
})

describe('budget alerts', () => {
  const alertsIn = async (s: TestApp['a']['services']): Promise<Message[]> => {
    const ch = await s.chat.channelByName(ALERTS_CHANNEL)
    return ch ? s.chat.messages(ch.id) : []
  }

  it('warns once per period at 80%, tagging the admins, and once more at 100%', async () => {
    const { t, s, employee } = await make({ workers: true, env: { LIMIT_EMPLOYEE_DAILY_TOKENS: '1000' } })
    const admin = await t.admin()
    const adminContact = await s.directory.contacts.require(admin.contactId)
    const rec = (tokens: number) =>
      s.usage.record({ employeeId: employee.id, model: 'm', promptTokens: tokens, completionTokens: 0 })
    await rec(500)
    await t.settle()
    expect(await alertsIn(s)).toHaveLength(0)
    await rec(320) // 82%
    const [warning] = await until(async () => {
      const m = await alertsIn(s)
      return m.length ? m : null
    }, 'the warning')
    expect(warning!.data.text).toContain(
      `[[employee:${employee.id}]] has used 82% of its daily token budget: 820 of 1k tokens today`,
    )
    const adminTag = adminContact.data.handles?.find((h) => h.system === 'mp')?.id
    expect(warning!.data.text).toContain(adminTag ? `@${adminTag}` : adminContact.data.name)
    await rec(50)
    await t.settle()
    expect(await alertsIn(s)).toHaveLength(1)
    await rec(200) // 107%
    const all = await until(async () => {
      const m = await alertsIn(s)
      return m.length === 2 ? m : null
    }, 'the used-up alert')
    expect(all[1]!.data.text).toContain('used up its daily token budget: 1.1k of 1k tokens today. New work pauses')
    await rec(10)
    await t.settle()
    expect(await alertsIn(s)).toHaveLength(2)
    expect((await s.records.query('alert', { where: { condition: 'budget.warning' } })).total).toBe(1)
    // Alerts don't start runs.
    expect(await s.sessions.runs({})).toHaveLength(0)
  })

  it("warns about a requester's and the deployment's budgets too, and not below the threshold", async () => {
    const { s, employee, person } = await make({
      env: { LIMIT_EMPLOYEE_DAILY_TOKENS: '0', LIMIT_DEPLOYMENT_DAILY_TOKENS: '10000' },
    })
    const ana = await person('Ana Example', 'ana')
    await s.usage.limits.set({ target: { type: 'contact', id: ana }, maxTokens: 1000 })
    const posted: { key: string; text: string; tags?: string[] }[] = []
    const alerts = {
      post: async (key: string, data: { text: string; tags?: string[] }) => {
        if (posted.some((p) => p.key === key)) return null
        posted.push({ key, ...data })
        return 'msg'
      },
    }
    await s.usage.record({ employeeId: employee.id, requesterId: ana, model: 'm', promptTokens: 700, completionTokens: 0 })
    expect(await checkBudgetAlerts(s, alerts, { employeeId: employee.id, requesterId: ana })).toEqual([])
    await s.usage.record({ employeeId: employee.id, requesterId: ana, model: 'm', promptTokens: 150, completionTokens: 0 })
    const keys = await checkBudgetAlerts(s, alerts, { employeeId: employee.id, requesterId: ana })
    expect(keys).toEqual([expect.stringMatching(/^budget\.warning:day:contact:con_\w+:\d{4}-\d{2}-\d{2}:maxTokens$/)])
    expect(posted[0]!.text).toContain('Work requested by Ana Example has used 85% of the requester’s daily token budget')
    expect(posted[0]!.tags).toContain('@ana')
    await s.usage.record({ employeeId: employee.id, model: 'm', promptTokens: 7200, completionTokens: 0 })
    const more = await checkBudgetAlerts(s, alerts, { employeeId: employee.id })
    expect(more).toEqual([expect.stringMatching(/^budget\.warning:day:global:all:/)])
    expect(posted[1]!.text).toContain('The whole deployment has used 80% of its daily token budget')
    // Warnings off.
    expect(await checkBudgetAlerts(s, { post: async () => 'x' }, { employeeId: employee.id }, { warnAt: 0 })).toEqual([])
  })
})
