import { ManualClock } from '@mp/core'
import { callTools, reply } from '@mp/model'
import { describe, expect, it } from 'vitest'
import type { RunLimits } from '../src/index.ts'
import { harness } from './harness.ts'

const MIN = 60_000

describe('wall clock', () => {
  it('pauses a run over its wall clock between steps, never in the middle of a tool call', async () => {
    const clock = new ManualClock()
    let toolDone = false
    const h = harness(() => callTools([{ name: 'slow' }]), { clock, maxWallMs: 30 * MIN })
    h.tool({ name: 'slow' }, async () => {
      clock.advance(20 * MIN) // a long tool call
      toolDone = true
      return { output: 'ok' }
    })
    const s = await h.session(['slow'])
    const run = await h.start(s.id)
    const out = await h.runner.execute(run.id)
    expect(out).toMatchObject({ status: 'paused', reason: 'wall clock' })
    expect(toolDone).toBe(true)
    // Two tool calls finished (40 minutes), then it paused before the third model call.
    expect(h.model.calls).toHaveLength(2)
    const r = await h.sessions.requireRun(run.id)
    expect(r.data.state).toBe('paused')
    expect(r.data.pauseReason).toBe(
      'worked for 40 minutes, over the limit of 30 minutes per run. Resuming gives it another 30 minutes.',
    )
    expect(r.data.limitPaused).toBe('wall')
    // Every tool call has its result: nothing was cut off.
    const hist = await h.sessions.runHistory(run.id)
    expect(hist.filter((e) => e.kind === 'tool_result')).toHaveLength(2)
  })

  it('resuming gives a fresh allowance, and time paused or waiting in the queue does not count', async () => {
    const clock = new ManualClock()
    let n = 0
    const h = harness(() => (++n >= 5 ? reply('done') : callTools([{ name: 'slow' }])), { clock, maxWallMs: 30 * MIN })
    h.tool({ name: 'slow' }, async () => {
      clock.advance(20 * MIN)
      return { output: 'ok' }
    })
    const s = await h.session(['slow'])
    const run = await h.start(s.id)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'paused', reason: 'wall clock' })
    clock.advance(24 * 60 * MIN) // a day paused
    await h.sessions.transition(run.id, 'paused', 'queued', { pauseReason: undefined } as never)
    const out = await h.runner.execute(run.id)
    expect(out).toMatchObject({ status: 'paused', reason: 'wall clock' })
    // The second allowance ran two more tool calls (40 minutes of work), not zero.
    expect(h.model.calls).toHaveLength(4)
  })

  it('takes the limit from limitsFor, and keeps time across a suspend', async () => {
    const clock = new ManualClock()
    const h = harness(() => callTools([{ name: 'tick' }]), {
      clock,
      limitsFor: async () => ({ maxWallMs: 10 * MIN }),
    })
    h.tool({ name: 'tick' }, async () => {
      clock.advance(4 * MIN)
      return { output: 'ok' }
    })
    const s = await h.session(['tick'])
    const run = await h.start(s.id)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'paused', reason: 'wall clock' })
    expect((await h.sessions.requireRun(run.id)).data.activeMs).toBe(12 * MIN)
  })

  it('without a limit, a long run is not paused', async () => {
    const clock = new ManualClock()
    let n = 0
    const h = harness(() => (++n > 3 ? reply('done') : callTools([{ name: 'slow' }])), { clock })
    h.tool({ name: 'slow' }, async () => {
      clock.advance(60 * MIN)
      return { output: 'ok' }
    })
    const s = await h.session(['slow'])
    const run = await h.start(s.id)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'completed' })
  })
})

describe('step limit', () => {
  it('takes the limit from limitsFor, and resuming gives another allowance', async () => {
    const h = harness(() => callTools([{ name: 'noop' }]), { maxSteps: 60, limitsFor: async () => ({ maxSteps: 2 }) })
    h.tool({ name: 'noop' }, async () => ({ output: 'ok' }))
    const s = await h.session(['noop'])
    const run = await h.start(s.id)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'paused', reason: 'max steps' })
    expect(h.model.calls).toHaveLength(2)
    const paused = await h.sessions.requireRun(run.id)
    expect(paused.data.pauseReason).toBe('reached 2 model calls in one run. Resuming gives it another 2.')
    await h.sessions.transition(run.id, 'paused', 'queued', { pauseReason: undefined } as never)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'paused', reason: 'max steps' })
    expect(h.model.calls).toHaveLength(4)
  })
})

describe('concurrency cap', () => {
  it('holds a run in the queue while its employee has as many runs working as allowed', async () => {
    const limits: RunLimits = { maxConcurrentRuns: 1 }
    const h = harness([reply('a'), reply('b')], { limitsFor: async () => limits, concurrencyRetryMs: 50 })
    const deferred: unknown[] = []
    h.bus.subscribe('run.deferred', (m) => void deferred.push(m.payload))
    const s1 = await h.session([], 'one')
    const s2 = await h.session([], 'two')
    const r1 = await h.start(s1.id)
    const r2 = await h.start(s2.id)
    await h.sessions.transition(r1.id, 'queued', 'running')
    const out = await h.runner.execute(r2.id)
    expect(out).toMatchObject({ status: 'skipped', reason: '1 runs of this employee are working (limit 1)' })
    expect((await h.sessions.requireRun(r2.id)).data.state).toBe('queued')
    expect(deferred).toEqual([{ runId: r2.id, employeeId: 'emp_test', working: 1, max: 1 }])
    expect((await h.queue.counts('runs')).delayed).toBe(1)
    // Once the first finishes, the second starts.
    expect(await h.runner.execute(r1.id)).toMatchObject({ status: 'completed' })
    expect(await h.runner.execute(r2.id)).toMatchObject({ status: 'completed' })
  })

  it('without a cap, runs start at once', async () => {
    const h = harness([reply('a')], { limitsFor: async () => ({}) })
    const s = await h.session()
    const other = await h.start((await h.session([], 'x')).id)
    await h.sessions.transition(other.id, 'queued', 'running')
    const run = await h.start(s.id)
    expect(await h.runner.execute(run.id)).toMatchObject({ status: 'completed' })
  })
})
