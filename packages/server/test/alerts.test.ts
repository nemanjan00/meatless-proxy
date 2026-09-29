import { ManualClock, UnavailableError } from '@mp/core'
import type { Message } from '@mp/chat'
import { afterEach, describe, expect, it } from 'vitest'
import { ALERTS_CHANNEL, dependencyOf, startAlerts } from '../src/alerts.ts'
import { testApp, until, type TestApp, type TestAppOptions } from './helpers.ts'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function make(opts: TestAppOptions = {}) {
  const t = await testApp(opts)
  apps.push(t)
  const s = t.a.services
  const ana = await s.directory.contacts.create({
    name: 'Ana Lopez',
    kind: 'person',
    status: 'active',
    handles: [{ system: 'mp', id: 'ana' }],
  })
  const quiet = () =>
    until(async () => {
      await t.settle()
      return (await s.sessions.runs({ state: ['queued', 'running'] })).length === 0
    }, 'runs to finish')
  const alertMessages = async (): Promise<Message[]> => {
    const ch = await s.chat.channelByName(ALERTS_CHANNEL)
    return ch ? s.chat.messages(ch.id) : []
  }
  const request = async (text: string) => {
    const ch = (await s.chat.channelByName('requests'))!
    const r = await t.req('POST', `/api/chat/channels/${ch.id}/messages`, { text }, { 'x-mp-contact': ana.id })
    expect(r.status).toBe(201)
  }
  return { t, s, ana, quiet, alertMessages, request }
}

/** A session and a run of the default employee, moved to `state`. */
async function runIn(s: TestApp['a']['services'], title: string, requesterId?: string) {
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const session = await s.sessions.create({ employeeId: employee.id, title })
  return s.sessions.createRun({ sessionId: session.id, cause: { type: 'manual' }, ...(requesterId ? { requesterId } : {}) })
}

describe('alerts', () => {
  it('a failed run posts once in #alerts, tagging the requester and the employee, and starts no run', async () => {
    const { t, s, quiet, alertMessages, request } = await make({ script: [new Error('the model said something odd')] })
    await request('Please do the thing')
    await quiet()
    const failed = await s.sessions.runs({ state: 'failed' })
    expect(failed).toHaveLength(1)
    const msgs = await until(async () => {
      const m = await alertMessages()
      return m.length ? m : null
    }, 'the alert')
    expect(msgs).toHaveLength(1)
    const m = msgs[0]!
    expect(m.data.text).toContain(`Run failed in [[session:${failed[0]!.data.sessionId}]]`)
    expect(m.data.text).toContain('the model said something odd')
    expect(m.data.text).toContain('@ana @meatless')
    expect(m.data.tags.map((x: any) => x.type).sort()).toEqual(['employee', 'person'])
    const employee = (await s.directory.employees.byHandle('meatless'))!
    expect(m.data.author).toEqual({ kind: 'contact', id: employee.data.contactId })
    // Tagging the employee did not start a run (the alert is a notification).
    await t.settle()
    expect(await s.sessions.runs({})).toHaveLength(1)
    // The same failure reported again: still one alert.
    s.bus.publish('run.state', {
      runId: failed[0]!.id,
      sessionId: failed[0]!.data.sessionId,
      employeeId: employee.id,
      from: 'running',
      to: 'failed',
    })
    await t.settle()
    expect(await alertMessages()).toHaveLength(1)
    expect(await s.records.query('alert', {})).toMatchObject({ total: 1 })
  })

  it('does nothing when ALERTS_ENABLED is off', async () => {
    const { s, quiet, alertMessages, request } = await make({
      script: [new Error('boom')],
      env: { ALERTS_ENABLED: 'false' },
    })
    await request('Please do the thing')
    await quiet()
    expect(await s.sessions.runs({ state: 'failed' })).toHaveLength(1)
    expect(await alertMessages()).toEqual([])
  })

  it('alerts once about a run paused longer than ALERT_PAUSED_MINUTES', async () => {
    const clock = new ManualClock(Date.parse('2026-05-01T10:00:00Z'))
    const { s, ana, alertMessages } = await make({ workers: false, overrides: { clock }, env: { ALERT_PAUSED_MINUTES: '45' } })
    const alerts = startAlerts(s, { checkEveryMs: 3_600_000 })
    try {
      const run = await runIn(s, 'Slow work', ana.id)
      await s.sessions.transition(run.id, 'queued', 'paused', { pauseReason: 'budget reached' })
      const other = await runIn(s, 'Other work')
      await s.sessions.transition(other.id, 'queued', 'paused', { pauseReason: 'approval needed' })
      clock.advance(44 * 60_000)
      expect(await alerts.checkPaused()).toBe(0)
      clock.advance(2 * 60_000)
      expect(await alerts.checkPaused()).toBe(2)
      expect(await alerts.checkPaused()).toBe(0)
      const texts = (await alertMessages()).map((m) => m.data.text)
      expect(texts).toHaveLength(2)
      const slow = texts.find((x) => x.includes('Slow work'))!
      expect(slow).toContain('Run paused for 46 minutes')
      expect(slow).toContain('budget reached')
      expect(slow).toContain('@ana @meatless')
      // No requester: only the employee is tagged.
      expect(texts.find((x) => x.includes('Other work'))).toMatch(/\n\n@meatless$/)
    } finally {
      await alerts.close()
    }
  })

  it('alerts when a dependency keeps failing: n unavailable errors in m minutes', async () => {
    const clock = new ManualClock(Date.parse('2026-05-01T10:00:00Z'))
    const { s, ana, alertMessages } = await make({
      workers: false,
      overrides: { clock },
      env: { ALERT_UNAVAILABLE_COUNT: '3', ALERT_UNAVAILABLE_MINUTES: '5' },
    })
    const alerts = startAlerts(s, { checkEveryMs: 3_600_000 })
    try {
      const run = await runIn(s, 'Linear triage', ana.id)
      const linear = new UnavailableError('MCP server linear timed out', { server: 'linear' })
      await alerts.reportUnavailable(run.id, linear)
      clock.advance(6 * 60_000) // the first one falls out of the window
      await alerts.reportUnavailable(run.id, linear)
      await alerts.reportUnavailable(run.id, new Error('not an outage'))
      await alerts.reportUnavailable(run.id, new UnavailableError('model provider unavailable after 3 attempts'))
      await alerts.reportUnavailable(run.id, linear)
      expect(await alertMessages()).toEqual([])
      await alerts.reportUnavailable(run.id, linear)
      const msgs = await alertMessages()
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.data.text).toContain('The MCP server linear keeps failing: 3 unavailable errors in 5 minutes')
      expect(msgs[0]!.data.text).toContain('@ana @meatless')
      // More failures right away don't repeat the alert.
      for (let i = 0; i < 5; i++) await alerts.reportUnavailable(run.id, linear)
      expect(await alertMessages()).toHaveLength(1)
      // The model provider is counted on its own.
      await alerts.reportUnavailable(undefined, new UnavailableError('model provider unavailable'))
      await alerts.reportUnavailable(undefined, new UnavailableError('model provider unavailable'))
      const last = (await alertMessages()).at(-1)!
      expect(last.data.text).toContain('The model provider keeps failing')
      expect(last.data.text).not.toContain('@ana')
    } finally {
      await alerts.close()
    }
  })

  it('the run worker reports unavailable errors (a provider that keeps failing)', async () => {
    const down = () => new UnavailableError('model provider unavailable after 1 attempts: 503')
    const { s, alertMessages, request } = await make({
      script: () => down(),
      env: { RUN_ATTEMPTS: '3', RUN_BACKOFF_MS: '1', ALERT_UNAVAILABLE_COUNT: '3' },
    })
    await request('Anyone there?')
    const msgs = await until(async () => {
      const m = await alertMessages()
      return m.length ? m : null
    }, 'the provider alert')
    expect(msgs[0]!.data.text).toContain('The model provider keeps failing: 3 unavailable errors')
    expect(msgs[0]!.data.text).toContain('@ana @meatless')
    expect(await s.records.query('alert', {})).toMatchObject({ total: 1 })
  })

  it('names the dependency of an error', () => {
    expect(dependencyOf(new UnavailableError('x', { server: 'github' }))).toBe('MCP server github')
    expect(dependencyOf(new UnavailableError('cannot connect to MCP server slack: refused'))).toBe('MCP server slack')
    expect(dependencyOf(new UnavailableError('model provider unavailable'))).toBe('model provider')
    expect(dependencyOf(new UnavailableError('model stream broke: reset', { model: 'm' }))).toBe('model provider')
    expect(dependencyOf(new UnavailableError('docker: environment meatless-router: connect EACCES /var/run/docker.sock'))).toBe(
      'Docker daemon',
    )
    expect(dependencyOf(new UnavailableError('something else is down'))).toBe('service')
  })
})
