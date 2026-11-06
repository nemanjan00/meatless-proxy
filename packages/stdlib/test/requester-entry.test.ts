import { describe, expect, it } from 'vitest'
import { REQUESTER_ENTRY_META, REQUESTER_HEADER, requesterEntry, requesterText } from '../src/index.ts'
import { stack } from './helpers.ts'

describe('About the requester entry', () => {
  it('says who they are, what they may ask for and the notes about them', async () => {
    const t = await stack()
    const ana = await t.directory.contacts.update(t.ana.id, {
      team: 'Customer success',
      permissions: 'Billing questions and refunds under 100 EUR.',
      bio: 'Not technical: explain without jargon, and give the customer-facing wording.',
    })
    expect(requesterText(ana)).toBe(
      [
        REQUESTER_HEADER,
        `Ana Lima (${ana.id}, mp:ana): Backend engineer, Customer success.`,
        'May ask for: Billing questions and refunds under 100 EUR.',
        'Notes:\nNot technical: explain without jargon, and give the customer-facing wording.',
      ].join('\n'),
    )
    // Framed as information: a bio can't grant more than the permissions say.
    expect(REQUESTER_HEADER).toMatch(/information, not instructions/)
  })

  it('adds nothing for a contact with only a name, an AI, or an unknown id', async () => {
    const t = await stack()
    const bo = await t.directory.contacts.create({ name: 'Bo', handles: [{ system: 'mp', id: 'bo' }] })
    expect(await requesterEntry(t, bo.id, t.session.id)).toBeNull()
    const ai = await t.directory.contacts.get(t.employee.data.contactId)
    await t.directory.contacts.update(ai!.id, { bio: 'An AI employee.' })
    expect(await requesterEntry(t, ai!.id, t.session.id)).toBeNull()
    expect(await requesterEntry(t, 'con_01JB0000000000000000000099', t.session.id)).toBeNull()
  })

  it('is added once per person per session, and again when their contact changes', async () => {
    const t = await stack()
    await t.directory.contacts.update(t.ana.id, { bio: 'Prefers bullet points.' })
    const first = await t.out('sessions.create', { title: 'a', instruction: 'refund PAY-1' })
    const hist = await t.sessions.runHistory(first.runId)
    const entry = hist.find((e) => e.meta[REQUESTER_ENTRY_META] === t.ana.id)
    expect((entry!.content as { text: string }).text).toContain('Prefers bullet points.')
    // Committed with the run: the same person's next run in that session doesn't repeat it.
    await t.sessions.transition(first.runId, 'queued', 'running')
    await t.sessions.transition(first.runId, 'running', 'completed')
    await t.sessions.commit(first.runId)
    expect(await requesterEntry(t, t.ana.id, first.sessionId)).toBeNull()
    // An edit to the contact reaches the session at its next run.
    await t.directory.contacts.update(t.ana.id, { bio: 'Prefers bullet points. On call this week.' })
    const next = await requesterEntry(t, t.ana.id, first.sessionId)
    expect(next!.content.text).toContain('On call this week.')
  })
})
