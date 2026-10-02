import { openAiModel } from '@mp/model-openai'
import type { ToolResultContent } from '@mp/sessions'
import { afterEach, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

// Opt-in: real model calls (MP_LIVE_MODEL_TEST=1, with OPENAI_BASE_URL, OPENAI_API_KEY and MODEL set). A work
// session of the bootstrap employee, with its full toolset and the real employee prompt, gets a task that needs an
// on-demand tool (a reminder: schedule.create), and the first call's prompt size is compared with tools on demand off.
const live = process.env.MP_LIVE_MODEL_TEST === '1'

const realModel = () => {
  const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env
  if (!OPENAI_BASE_URL || !OPENAI_API_KEY || !MODEL) throw new Error('set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL')
  return openAiModel({ baseUrl: OPENAI_BASE_URL, apiKey: OPENAI_API_KEY, model: MODEL, maxRetries: 1, timeoutMs: 170_000 })
}

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

/** A work session of the bootstrap employee, as the router would start one, and a run with `text`. */
async function work(app: TestApp, text: string) {
  const s = app.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const contact = await s.directory.employees.contact(employee.id)
  const session = await s.sessions.create({
    employeeId: employee.id,
    title: 'Work',
    toolset: s.tools.allowed(await s.toolListsFor(employee.id)).map((d) => d.name),
    entries: [{ kind: 'system', content: { text: s.stdlib!.employeePrompt({ employee, contact, now: s.clock.iso() }) } }],
  })
  const run = await s.sessions.createRun({
    sessionId: session.id,
    cause: { type: 'manual' },
    input: [{ kind: 'user', content: { text } }],
  })
  const outcome = await s.runner.execute(run.id)
  return { session, run: await s.sessions.requireRun(run.id), outcome, employee }
}

describe.skipIf(!live)('tools on demand, live (MP_LIVE_MODEL_TEST=1)', () => {
  it('the first call is smaller with tools on demand', { timeout: 300_000 }, async () => {
    const sizes: Record<string, number> = {}
    for (const flag of ['false', 'true']) {
      t = await testApp({ workers: false, overrides: { model: realModel() }, env: { TOOLS_ON_DEMAND: flag } })
      const { run } = await work(t, 'Reply with just: ok')
      // The provider's prompt tokens of the call (the runner's estimate only when it reports none).
      sizes[flag] = run.data.context!.tokens
      await t.close()
      t = undefined
    }
    console.log(`first-call prompt tokens: every tool ${sizes.false}, on demand ${sizes.true}`)
    expect(sizes.true).toBeLessThan(sizes.false! * 0.75)
  })

  it('finds, loads and uses an on-demand tool to schedule a reminder', { timeout: 600_000 }, async () => {
    t = await testApp({ workers: false, overrides: { model: realModel() } })
    const s = t.a.services
    const { session, run, outcome, employee } = await work(
      t,
      'Ana here. Please remind me tomorrow at 09:00 to check the invoice export. Just set the reminder; your final message is my answer.',
    )
    const history = await s.sessions.history(session.id)
    const calls = history
      .filter((e) => e.kind === 'tool_result')
      .map((e) => e.content as unknown as ToolResultContent)
      .map((c) => `${c.name}${c.isError ? ' (error)' : ''}`)
    console.log('tool calls:', calls.join(', '))
    console.log('answer:', run.data.result?.output)
    expect(outcome.status, run.data.pauseReason ?? run.data.result?.error ?? '').toBe('completed')
    const tasks = await s.scheduledTasks.list({ employeeId: employee.id })
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(tasks[0]!.data).toLowerCase()).toContain('invoice')
    expect(((await s.sessions.require(session.id)).data.meta?.loadedTools as string[]) ?? []).toContain('schedule.create')
  })
})
