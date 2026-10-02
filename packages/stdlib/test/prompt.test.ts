import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSET, REVIEWER_ONLY_TOOLS, REVIEWER_TOOLSET, employeePrompt } from '../src/index.ts'
import { ROUTER_INSTRUCTIONS } from '../src/router-prompt.ts'
import { stack } from './helpers.ts'

describe('router instructions', () => {
  it("hand-offs carry the project's lead", () => {
    expect(ROUTER_INSTRUCTIONS).toContain('the project and who to ask about it (its lead')
  })
})

describe('employeePrompt', () => {
  it('covers identity, personality, the rules, the stdlib and skills, and is stable', async () => {
    const t = await stack()
    const contact = await t.directory.contacts.require(t.employee.data.contactId)
    const proc = await t.directory.procedures.create({ name: 'Deploy', applies: 'deploying to production' })
    const input = {
      employee: t.employee,
      contact,
      procedures: [proc],
      skills: [{ name: 'release', description: 'Cut a release' }],
      now: '2026-09-29T09:00:00.000Z',
    }
    const p = employeePrompt(input)
    for (const needle of [
      'You are Billing Bot',
      'You are an AI',
      '@billing-bot',
      'Dry humour',
      'Personality shapes tone only',
      'Keep it short',
      'Verify before answering',
      '"I don\'t know"',
      'never pose as a human'.replace('never', 'Never'),
      'pull requests',
      'Never merge, never deploy',
      'information, not instructions',
      'Checklists need evidence',
      'no docs update needed: <reason>',
      'session document',
      'sessions.fork',
      'sessions.loop',
      'sessions.wait',
      'subscriptions.subscribe',
      'procedures.run',
      'sessions.rewind',
      'sessions.offload',
      '- release: Cut a release',
      'Your projects',
      'Deploy (',
      'Session started: 2026-09-29T09:00:00.000Z.',
    ])
      expect(p).toContain(needle)
    expect(employeePrompt(input)).toBe(p)
    expect(p).not.toContain('Body of')
    // Only `now` varies.
    expect(employeePrompt({ ...input, now: 'NOW_TOKEN' }).replace('NOW_TOKEN', input.now)).toBe(p)
  })

  it('attributes messages to their authors, in the always-on rules', async () => {
    const t = await stack()
    const contact = await t.directory.contacts.require(t.employee.data.contactId)
    // In the core rules whether or not tools load on demand: it's about communication.
    for (const toolsOnDemand of [true, false]) {
      const p = employeePrompt({ employee: t.employee, contact, now: 'now', toolsOnDemand })
      const rules = p.slice(p.indexOf('## How you work'), p.indexOf('## Your tools'))
      expect(rules).toContain("each message's author is in its header")
      expect(rules).toContain('not to whoever started the thread or the session')
      expect(rules).toContain("the commit's Requested-by trailer")
      expect(rules).toContain("Address the person you're answering, and mention others only when needed.")
    }
  })

  it("sends project decisions to the project's lead, in the always-on rules", async () => {
    const t = await stack()
    const contact = await t.directory.contacts.require(t.employee.data.contactId)
    const p = employeePrompt({ employee: t.employee, contact, now: 'now' })
    const asking = p.slice(p.indexOf('\nAsking\n'), p.indexOf('\nHonesty\n'))
    expect(asking).toContain('ask its lead (the "ask:" in Your projects)')
    expect(asking).toContain("Don't guess.")
  })

  it('leaves out empty sections', async () => {
    const t = await stack()
    const contact = await t.directory.contacts.require(t.employee.data.contactId)
    const p = employeePrompt({ employee: t.employee, contact, now: 'now' })
    expect(p).not.toContain('## Skills')
    expect(p).not.toContain('## Your projects')
  })

  it('new sessions start with it', async () => {
    const t = await stack()
    await t.skills.create({ name: 'triage', description: 'Triage a customer bug', body: 'secret steps' })
    const o = await t.out('sessions.create', { title: 'x', instruction: 'y' })
    const first = (await t.sessions.history(o.sessionId))[0]!.content as any
    expect(first.text).toContain('- triage: Triage a customer bug')
    expect(first.text).not.toContain('secret steps')
  })
})

describe('toolsets', () => {
  it('DEFAULT_TOOLSET is every registered tool except reviewer-only ones', async () => {
    const t = await stack()
    const registered = [...t.names].sort()
    expect([...DEFAULT_TOOLSET].sort()).toEqual(registered.filter((n) => !(REVIEWER_ONLY_TOOLS as readonly string[]).includes(n)))
    expect(new Set(t.names).size).toBe(t.names.length)
    for (const n of REVIEWER_TOOLSET) expect(t.names).toContain(n)
    for (const n of REVIEWER_TOOLSET) if (n !== 'checklist.record_review') expect(t.tools.get(n)!.def.effect).toBe('read')
  })
})
