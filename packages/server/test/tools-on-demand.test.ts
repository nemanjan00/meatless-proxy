import { reply } from '@mp/model'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { testApp, type TestApp } from './helpers.ts'

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

/** Runs one turn in a new work session of the bootstrap employee and returns the tool names the model was offered. */
async function offeredInWork(app: TestApp): Promise<{ offered: string[]; prompt: string }> {
  const s = app.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const toolset = s.tools.allowed(await s.toolListsFor(employee.id)).map((d) => d.name)
  // Stored without the on-demand list: the model is shown the current prompt, as the server configures it.
  const contact = await s.directory.employees.contact(employee.id)
  const prompt = s.stdlib!.employeePrompt({ employee, contact, now: s.clock.iso() })
  const session = await s.sessions.create({
    employeeId: employee.id,
    title: 'Work',
    toolset,
    entries: [{ kind: 'system', content: { text: prompt } }],
  })
  const run = await s.sessions.createRun({
    sessionId: session.id,
    cause: { type: 'manual' },
    input: [{ kind: 'user', content: { text: 'hi' } }],
  })
  await s.runner.execute(run.id)
  const call = app.model.calls.at(-1)!
  return {
    offered: (call.tools ?? []).map((x) => s.tools.resolveProviderName(x.function.name)!),
    prompt: String(call.messages[0]!.content),
  }
}

describe('TOOLS_ON_DEMAND', () => {
  it('is on by default', () => {
    expect(loadConfig({}).TOOLS_ON_DEMAND).toBe(true)
    expect(loadConfig({ TOOLS_ON_DEMAND: 'false' }).TOOLS_ON_DEMAND).toBe(false)
  })

  it('on: a work session is offered its core tools and the loaders, and the prompt lists the rest', async () => {
    t = await testApp({ script: [reply('ok')], workers: false })
    const { offered, prompt } = await offeredInWork(t)
    expect(offered).toContain('chat.reply')
    expect(offered).toContain('tools.find')
    expect(offered).toContain('tools.load')
    expect(offered).not.toContain('schedule.create')
    expect(offered).not.toContain('triggers.create')
    expect(prompt).toContain('## Tools on demand')
  })

  it('off: every tool is offered, with no loaders and no list', async () => {
    t = await testApp({ script: [reply('ok')], workers: false, env: { TOOLS_ON_DEMAND: 'false' } })
    const { offered, prompt } = await offeredInWork(t)
    expect(offered).toContain('schedule.create')
    expect(offered).toContain('triggers.create')
    expect(offered).not.toContain('tools.find')
    expect(prompt).not.toContain('## Tools on demand')
  })
})
