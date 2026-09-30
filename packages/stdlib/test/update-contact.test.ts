import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSET, ROUTER_EXCLUDED_TOOLS, employeePrompt } from '../src/index.ts'
import { stack } from './helpers.ts'

const SOURCE = 'thread in #billing, 2026-09-29'

describe('directory.update_contact', () => {
  it('fills empty fields with where they came from, and suggests changes to set ones', async () => {
    const t = await stack()
    const bo = await t.directory.contacts.create({ name: 'Bo Example', email: 'bo@example.com' })
    const r = await t.out('directory.update_contact', {
      contactId: t.ana.id,
      role: 'Staff engineer',
      team: 'Payments',
      manager: bo.id,
      source: SOURCE,
    })
    expect(r.filled).toEqual([
      { field: 'team', value: 'Payments' },
      { field: 'manager', value: bo.id },
    ])
    expect(r.suggested).toEqual([
      expect.objectContaining({ field: 'role', current: 'Backend engineer', proposed: 'Staff engineer', repeated: false }),
    ])
    expect(r.note).toMatch(/Suggested, not changed/)

    const ana = await t.directory.contacts.require(t.ana.id)
    // A set field is never overwritten.
    expect(ana.data).toMatchObject({ role: 'Backend engineer', team: 'Payments', manager: bo.id })
    expect(ana.data.learned).toEqual([
      { field: 'team', value: 'Payments', employeeId: t.employee.id, source: SOURCE, at: t.clock.iso() },
      { field: 'manager', value: bo.id, employeeId: t.employee.id, source: SOURCE, at: t.clock.iso() },
    ])
    const [s] = await t.directory.learning.suggestions(t.ana.id)
    expect(s!.data).toMatchObject({
      field: 'role',
      current: 'Backend engineer',
      proposed: 'Staff engineer',
      employeeId: t.employee.id,
      source: SOURCE,
      status: 'pending',
      times: 1,
    })

    // get_contact shows who learned what, and the pending suggestion, so the employee doesn't suggest it again.
    const c = await t.out('directory.get_contact', { id: t.ana.id })
    expect(c.learned).toEqual([
      { field: 'team', employeeId: t.employee.id, at: t.clock.iso() },
      { field: 'manager', employeeId: t.employee.id, at: t.clock.iso() },
    ])
    expect(c.pendingSuggestions).toEqual([{ field: 'role', proposed: 'Staff engineer', employeeId: t.employee.id }])
    expect(c.extra).toBeUndefined()
  })

  it('updates the same suggestion when the same employee says it again, and adds another employee’s', async () => {
    const t = await stack()
    await t.out('directory.update_contact', { contactId: t.ana.id, role: 'Staff engineer', source: SOURCE })
    t.clock.advance(60_000)
    const again = await t.out('directory.update_contact', {
      contactId: t.ana.id,
      role: '  staff   Engineer ',
      source: 'standup notes',
    })
    expect(again.suggested[0]).toMatchObject({ repeated: true })
    let list = await t.directory.learning.suggestions(t.ana.id)
    expect(list).toHaveLength(1)
    expect(list[0]!.data).toMatchObject({ times: 2, source: 'standup notes', suggestedAt: t.clock.iso() })

    // The same value as now is no change at all.
    const same = await t.out('directory.update_contact', { contactId: t.ana.id, role: 'backend engineer', source: SOURCE })
    expect(same).toMatchObject({ filled: [], suggested: [], unchanged: [{ field: 'role', reason: 'already set to that' }] })

    // Another employee's suggestion is its own.
    const other = await t.directory.employees.create({ name: 'Docs Bot' })
    const s2 = await t.newSession('Other', other.id)
    const run2 = await t.startRun(s2.id)
    await t.out(
      'directory.update_contact',
      { contactId: t.ana.id, role: 'Staff engineer', source: SOURCE },
      t.ctxFor(s2.id, run2.id, { employeeId: other.id }),
    )
    list = await t.directory.learning.suggestions(t.ana.id)
    expect(list.map((x) => x.data.employeeId).sort()).toEqual([t.employee.id, other.id].sort())

    // Rejected stays rejected: saying it again doesn't reopen it.
    const mine = list.find((x) => x.data.employeeId === t.employee.id)!
    await t.directory.learning.reject(mine.id, t.ana.id)
    const after = await t.out('directory.update_contact', { contactId: t.ana.id, role: 'Staff engineer', source: SOURCE })
    expect(after).toMatchObject({ suggested: [], unchanged: [{ field: 'role', reason: 'suggested before and rejected' }] })
    expect((await t.directory.learning.suggestions(t.ana.id)).map((x) => x.data.employeeId)).toEqual([other.id])

    // Accepting one settles the other employees' suggestions of the same value.
    await t.directory.learning.accept(list.find((x) => x.data.employeeId === other.id)!.id, t.ana.id)
    expect((await t.directory.contacts.require(t.ana.id)).data.role).toBe('Staff engineer')
    expect(await t.directory.learning.suggestions(t.ana.id)).toEqual([])
  })

  it('appends bio notes as dated lines with their source, once, within a cap', async () => {
    const t = await stack()
    const note = 'Leads the invoice export rewrite.'
    const r = await t.out('directory.update_contact', { contactId: t.ana.id, bio_note: note, source: SOURCE })
    expect(r.bio).toBe('added')
    const line = `- 2026-09-29: ${note} [source: ${SOURCE}]`
    let ana = await t.directory.contacts.require(t.ana.id)
    expect(ana.data.bio).toBe(line)
    expect(t.directory.learning.facts(ana)).toEqual([
      { field: 'bio', value: note, employeeId: t.employee.id, source: SOURCE, at: t.clock.iso(), line },
    ])

    // Saying the same thing again (other case, punctuation, or a part of it) adds nothing.
    for (const same of ['leads the invoice export rewrite', 'Leads the invoice export rewrite!!'])
      expect((await t.out('directory.update_contact', { contactId: t.ana.id, bio_note: same, source: 'x' })).bio).toBe(
        'duplicate',
      )
    await t.out('directory.update_contact', { contactId: t.ana.id, bio_note: 'Reviews database migrations.', source: 'MR !12' })
    ana = await t.directory.contacts.require(t.ana.id)
    expect(ana.data.bio!.split('\n')).toHaveLength(2)

    // One short line only, and the bio doesn't grow forever.
    expect(
      (await t.call('directory.update_contact', { contactId: t.ana.id, bio_note: 'x'.repeat(281), source: 'x' })).isError,
    ).toBe(true)
    await t.directory.contacts.update(t.ana.id, { bio: 'y'.repeat(3950) })
    const full = await t.call('directory.update_contact', {
      contactId: t.ana.id,
      bio_note: 'Speaks at the tech talks.',
      source: 'x',
    })
    expect(full.isError).toBe(true)
    expect((full.output as { error: string }).error).toMatch(/bio is full.*memory\.remember/)
  })

  it('refuses other fields, AI contacts, a bad manager and a missing source', async () => {
    const t = await stack()
    const err = async (args: Record<string, unknown>) => {
      const r = await t.call('directory.update_contact', args)
      expect(r.isError).toBe(true)
      return (r.output as { error: string }).error
    }
    for (const field of ['permissions', 'email', 'handles', 'status', 'kind', 'name'])
      expect(await err({ contactId: t.ana.id, source: SOURCE, [field]: 'x' })).toMatch(
        new RegExp(`only role, team, manager and bio notes, not ${field}.*ask an admin`),
      )
    const before = await t.directory.contacts.require(t.ana.id)

    expect(await err({ contactId: before.id, role: 'x' })).toMatch(/source is required/)
    expect(await err({ contactId: before.id, role: 'x', source: '   ' })).toMatch(/source is required/)
    expect(await err({ contactId: before.id, source: SOURCE })).toMatch(/give role, team, manager or bio_note/)
    expect(await err({ contactId: before.id, manager: 'con_missing', source: SOURCE })).toMatch(/not a contact/)
    expect(await err({ contactId: before.id, manager: before.id, source: SOURCE })).toMatch(/own manager/)
    const bot = await t.directory.employees.contact(t.employee.id)
    expect(await err({ contactId: before.id, manager: bot.id, source: SOURCE })).toMatch(/not a person/)
    expect(await err({ contactId: bot.id, team: 'Bots', source: SOURCE })).toMatch(/AI employee or agent/)
    expect(await err({ contactId: 'con_missing', team: 'x', source: SOURCE })).toMatch(/not found/)
    expect(await err({ contactId: before.id, team: 'x'.repeat(121), source: SOURCE })).toMatch(/at most 120/)

    // Nothing was written.
    const after = await t.directory.contacts.require(t.ana.id)
    expect(after.version).toBe(before.version)
    expect(await t.directory.learning.suggestions(t.ana.id, { status: 'all' })).toEqual([])
  })

  it('is idempotent: a retried call returns the first result and writes once', async () => {
    const t = await stack()
    const ctx = t.ctx()
    const args = { contactId: t.ana.id, team: 'Payments', role: 'Staff engineer', bio_note: 'Owns invoicing.', source: SOURCE }
    const first = await t.out('directory.update_contact', args, ctx)
    const version = (await t.directory.contacts.require(t.ana.id)).version
    const retry = await t.out('directory.update_contact', args, ctx)
    expect(retry).toEqual(first)
    expect((await t.directory.contacts.require(t.ana.id)).version).toBe(version)
    const [s] = await t.directory.learning.suggestions(t.ana.id)
    expect(s!.data.times).toBe(1)
  })

  it('keeps concurrent fills consistent', async () => {
    const t = await stack()
    const bo = await t.directory.contacts.create({ name: 'Bo Example' })
    await Promise.all([
      t.out('directory.update_contact', { contactId: bo.id, team: 'Payments', source: SOURCE }),
      t.out('directory.update_contact', { contactId: bo.id, role: 'Analyst', source: SOURCE }),
      t.out('directory.update_contact', { contactId: bo.id, bio_note: 'Runs the monthly close.', source: SOURCE }),
    ])
    const c = await t.directory.contacts.require(bo.id)
    expect(c.data).toMatchObject({ team: 'Payments', role: 'Analyst' })
    expect(c.data.bio).toContain('Runs the monthly close.')
    expect(
      t.directory.learning
        .facts(c)
        .map((f) => f.field)
        .sort(),
    ).toEqual(['bio', 'role', 'team'])
  })

  it('stale provenance is dropped when a person edits the field', async () => {
    const t = await stack()
    await t.out('directory.update_contact', { contactId: t.ana.id, team: 'Payments', source: SOURCE })
    await t.directory.contacts.update(t.ana.id, { team: 'Platform' })
    expect(t.directory.learning.facts(await t.directory.contacts.require(t.ana.id))).toEqual([])
  })

  it('is in the default toolset, not in router contexts, and the prompt says when to use it', async () => {
    const t = await stack()
    expect(DEFAULT_TOOLSET).toContain('directory.update_contact')
    expect(ROUTER_EXCLUDED_TOOLS).toContain('directory.update_contact')
    expect(t.tools.get('directory.update_contact')?.def.effect).toBe('idempotent')
    const prompt = employeePrompt({
      employee: t.employee,
      contact: await t.directory.employees.contact(t.employee.id),
      now: t.clock.iso(),
    })
    expect(prompt).toMatch(/directory\.update_contact/)
    expect(prompt).toMatch(/never a guess; never personal or sensitive details/)
  })
})
