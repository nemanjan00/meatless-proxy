import { describe, expect, it } from 'vitest'
import { createMockDataLayer, EMP, RUN, SES } from '../src/mock/index.ts'
import { startSimulation } from '../src/mock/live.ts'

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0)

describe('mock API', () => {
  it('implements the session views over the fake data', async () => {
    const { api } = createMockDataLayer({ now: NOW })
    const list = await api.listSessions({ employeeId: EMP.billing })
    expect(list.total).toBeGreaterThan(5)
    expect(list.items.every((i) => i.employee.name === 'Billing Bot')).toBe(true)
    const d = await api.getSession(SES.pay123)
    expect(d.activeRun?.id).toBe(RUN.r2)
    expect(d.checklist?.data.items.length).toBe(6)
    const tree = await api.sessionTree(SES.inv1002)
    expect(tree.id).toBe(SES.billingIntake)
    const pay = tree.children.find((c) => c.id === SES.pay123)!
    expect(pay.children.filter((c) => c.origin === 'loop')).toHaveLength(3)
    const et = await api.sessionEntryTree(SES.pay123)
    expect(et.entries.some((e) => e.kind === 'summary')).toBe(true)
    expect(et.entries.some((e) => e.kind === 'pointer')).toBe(true)
    // loop children's own entries belong to them, not to the parent
    const child = await api.sessionEntryTree(SES.inv1001)
    const own = child.entries.filter((e) => !et.entries.some((x) => x.id === e.id))
    expect(own.length).toBeGreaterThan(0)
  })

  it('has runs in every state', async () => {
    const { api } = createMockDataLayer({ now: NOW })
    const now = await api.now()
    for (const s of ['queued', 'running', 'suspended', 'paused', 'completed', 'failed', 'cancelled'] as const)
      expect(now.counts[s]).toBeGreaterThan(0)
    expect(now.items.every((i) => ['queued', 'running', 'suspended', 'paused'].includes(i.run.data.state))).toBe(true)
  })

  it('builds lineage from event to forks', async () => {
    const { api } = createMockDataLayer({ now: NOW })
    const g = await api.lineage(SES.pay123)
    const types = new Set(g.nodes.map((n) => n.type))
    expect([...types].sort()).toEqual(['delivery', 'event', 'run', 'session', 'trigger'])
    expect(g.edges.some((e) => e.type === 'looped')).toBe(true)
    await expect(api.lineage('nope')).rejects.toMatchObject({ status: 404 })
  })

  it('counts trigger fires and finds unmatched events', async () => {
    const { api } = createMockDataLayer({ now: NOW })
    const t = await api.triggers()
    expect(t.find((x) => x.trigger.data.name === 'New PAY task')!.fires).toBe(3)
    const unmatched = await api.listEvents({ routed: 'unmatched' })
    expect(unmatched.total).toBeGreaterThanOrEqual(2)
  })

  it('writes with compare-and-swap and emits live events', async () => {
    const { api, live } = createMockDataLayer({ now: NOW })
    const topics: string[] = []
    live.subscribe(['records:contact', 'now', `chat:${'chn_01JB0000000000000000000001'}`], (e) => topics.push(e.topic))
    const c = (await api.listRecords('contact', { where: { name: 'Ana Novak' } })).items[0]!
    const next = await api.updateRecord('contact', c.id, { role: 'Head of Payments' }, c.version)
    expect(next.version).toBe(c.version + 1)
    await expect(api.updateRecord('contact', c.id, { role: 'x' }, c.version)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    })
    await api.pauseRun(RUN.r2)
    await api.postMessage('chn_01JB0000000000000000000001', { text: '@billing-bot#pay-123-refund ship it' })
    expect(topics).toEqual(['record.changed', 'run.state', 'chat.message'])
    const revs = await api.recordRevisions('contact', c.id)
    expect(revs.at(-1)!.op).toBe('update')
  })

  it('groups usage', async () => {
    const { api } = createMockDataLayer({ now: NOW })
    const b = await api.usageBreakdown('employee')
    expect(b.rows.map((r) => r.label)).toContain('Billing Bot')
    const series = await api.usageSeries('day', { splitBy: 'model' })
    expect(series.keys.length).toBeGreaterThan(1)
    const total = await api.usageTotals()
    expect(total.total).toBe(b.rows.reduce((n, r) => n + r.total, 0))
  })

  it('simulates a running session: deltas, entries, usage', async () => {
    const { api, live } = createMockDataLayer({ now: NOW })
    const topics = new Set<string>()
    live.subscribe([`session:${SES.pay123}`], (e) => topics.add(e.topic))
    const stop = startSimulation(api.db, live, { tickMs: 1, chunk: 50, backgroundEvery: 1_000_000 })
    await new Promise((r) => setTimeout(r, 120))
    stop()
    expect(topics.has('model.delta')).toBe(true)
    expect(topics.has('entry.appended')).toBe(true)
    expect(topics.has('usage.recorded')).toBe(true)
  })
})
