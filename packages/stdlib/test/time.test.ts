import { createHooks } from '@mp/core'
import { memoryQueue } from '@mp/queue'
import { createRouter } from '@mp/router'
import { describe, expect, it } from 'vitest'
import { employeePrompt } from '../src/index.ts'
import { checkTimezone, timeIn } from '../src/tools/time.ts'
import { stack } from './helpers.ts'

describe('time.now', () => {
  it('reads the injected clock, in UTC by default', async () => {
    const t = await stack()
    const now = await t.out('time.now')
    expect(now).toEqual({
      iso: '2026-09-29T09:00:00.000Z',
      local: '2026-09-29T09:00:00+00:00',
      timezone: 'UTC',
      weekday: 'Tuesday',
      unix: Date.UTC(2026, 8, 29, 9) / 1000,
    })
    t.clock.advance(90 * 60_000 + 15_000)
    expect((await t.out('time.now')).iso).toBe('2026-09-29T10:30:15.000Z')
    expect(t.tools.get('time.now')!.def.effect).toBe('read')
  })

  it('uses the company timezone, and an explicit one over it', async () => {
    const t = await stack()
    t.deps.defaultTimezone = async () => 'Europe/Belgrade'
    expect(await t.out('time.now')).toMatchObject({
      timezone: 'Europe/Belgrade',
      local: '2026-09-29T11:00:00+02:00',
      weekday: 'Tuesday',
    })
    expect(await t.out('time.now', { timezone: 'America/New_York' })).toMatchObject({
      timezone: 'America/New_York',
      local: '2026-09-29T05:00:00-04:00',
      iso: '2026-09-29T09:00:00.000Z',
    })
    // Late evening in UTC is already the next day further east.
    t.clock.set(Date.UTC(2026, 8, 29, 23, 30))
    expect(await t.out('time.now', { timezone: 'Asia/Kolkata' })).toMatchObject({
      local: '2026-09-30T05:00:00+05:30',
      weekday: 'Wednesday',
    })
    t.deps.defaultTimezone = async () => undefined
    expect((await t.out('time.now')).timezone).toBe('UTC')
  })

  it('rejects an unknown timezone, naming an example', async () => {
    const t = await stack()
    const r = await t.call('time.now', { timezone: 'Mars/Olympus' })
    expect(r.isError).toBe(true)
    expect((r.output as { error: string }).error).toMatch(/unknown timezone "Mars\/Olympus".*Europe\/Belgrade/)
    expect(() => checkTimezone('Nope/Nowhere')).toThrow(/IANA/)
    expect(checkTimezone('utc')).toBe('UTC')
  })

  it('handles daylight saving and midnight', () => {
    // Belgrade leaves summer time on 2026-10-25.
    expect(timeIn(Date.UTC(2026, 9, 24, 22), 'Europe/Belgrade').local).toBe('2026-10-25T00:00:00+02:00')
    expect(timeIn(Date.UTC(2026, 9, 26, 12), 'Europe/Belgrade').local).toBe('2026-10-26T13:00:00+01:00')
    expect(timeIn(Date.UTC(2026, 8, 29, 0, 0, 0), 'UTC').local).toBe('2026-09-29T00:00:00+00:00')
  })

  it('is offered to router contexts', async () => {
    const { ROUTER_EXCLUDED_TOOLS } = await import('../src/index.ts')
    const { globMatch } = await import('@mp/core')
    expect(ROUTER_EXCLUDED_TOOLS.some((p) => globMatch(p, 'time.now'))).toBe(false)
  })
})

describe('time and prompt caching', () => {
  it('the prompt says where the time comes from and holds no clock time of its own', async () => {
    const t = await stack()
    const contact = await t.directory.contacts.require(t.employee.data.contactId)
    const p = employeePrompt({ employee: t.employee, contact, now: '2026-09-29T09:00:00.000Z' })
    expect(p).toContain('time.now')
    expect(p).toContain('stamped with when it arrived')
  })

  it('keeps the system prompt byte-identical while events at different times arrive', async () => {
    const t = await stack()
    const created = await t.out('sessions.create', { title: 'Payouts', instruction: 'watch the payouts thread' })
    const system = async () => (await t.sessions.history(created.sessionId))[0]!.content as { text: string }
    const before = (await system()).text
    const finish = async (runId: string) => {
      await t.sessions.transition(runId, 'queued', 'running')
      await t.sessions.transition(runId, 'running', 'completed', { result: { status: 'completed', output: 'ok' } })
    }
    await finish(created.runId)

    const router = createRouter({
      events: t.events,
      sessions: t.sessions,
      queue: memoryQueue(),
      hooks: createHooks(),
      routerSessionFor: async () => null,
      procedureContext: async () => null,
    })
    const deliver = async (text: string) => {
      const { event } = await t.events.ingest({ source: 'chat', type: 'message.posted', text })
      const out = await router.deliver(event, {
        sessionId: created.sessionId,
        reason: 'subscription',
        expectedToAct: true,
        trusted: true,
        fork: false,
        priority: 0,
      })
      expect(out.type).toBe('run')
      const runId = (out as { runId: string }).runId
      const history = await t.sessions.runHistory(runId)
      await finish(runId)
      return (history.find((e) => e.kind === 'event')!.content as { text: string }).text
    }

    const first = await deliver('what time is it?')
    t.clock.advance(3 * 3600_000 + 7 * 60_000)
    await t.out('time.now')
    const second = await deliver('and now?')

    expect(first.split('\n')[0]).toContain('Tue 2026-09-29 09:00 UTC')
    expect(second.split('\n')[0]).toContain('Tue 2026-09-29 12:07 UTC')
    expect((await system()).text).toBe(before)
  })
})
