import { describe, expect, it } from 'vitest'
import {
  askText,
  currentProjects,
  lastProjectsText,
  MAX_LISTED_PROJECTS,
  NO_LEAD_TEXT,
  PROJECTS_ENTRY_META,
  PROJECTS_HEADER,
  projectsEntry,
  projectsText,
} from '../src/index.ts'
import { REPO, stack } from './helpers.ts'

describe('Your projects entry', () => {
  it('says there are none, and to ask an admin', async () => {
    const t = await stack()
    const lines = await currentProjects(t.directory, t.employee.id)
    expect(lines).toEqual([])
    const text = projectsText(lines)
    expect(text.startsWith(PROJECTS_HEADER)).toBe(true)
    expect(text).toMatch(/no project is assigned to you/)
    expect(text).toMatch(/ask an admin/)
  })

  it('lists name, role, owner, repos and a one-line description', async () => {
    const t = await stack()
    await t.directory.projects.update(t.project.id, {
      repositories: [{ url: 'git@github.com:acme/billing.git', httpUrl: REPO }],
      description: 'Invoices\n and   payments.',
    })
    await t.directory.projects.addMember(t.project.id, t.employee.data.contactId, 'member')
    const text = projectsText(await currentProjects(t.directory, t.employee.id))
    expect(text).toBe(
      `${PROJECTS_HEADER}\n- Billing (${t.project.id}); your role: member; owner: Ana Lima; ask: Ana Lima (owner, no lead set; mp:ana); repos: git@github.com:acme/billing.git, ${REPO}. Invoices and payments.`,
    )
  })

  it('says "you" for its own projects, owner role first, sorted by name', async () => {
    const t = await stack()
    const zed = await t.directory.projects.create({ name: 'Zed' })
    await t.directory.projects.addMember(zed.id, t.employee.data.contactId, 'reviewer')
    await t.directory.projects.addMember(zed.id, t.employee.data.contactId, 'member')
    await t.directory.projects.setOwner(t.project.id, t.employee.data.contactId)
    const lines = await currentProjects(t.directory, t.employee.id)
    expect(lines.map((l) => l.name)).toEqual(['Billing', 'Zed'])
    expect(lines[0]).toMatchObject({ roles: ['owner'], owner: 'you' })
    expect(lines[1]!.roles).toEqual(['member', 'reviewer'])
    expect(lines[1]!.owner).toBeUndefined()
  })

  it('names who to ask: the lead with handles, else a human owner, else human backups, else no lead', async () => {
    const t = await stack()
    await t.directory.projects.addMember(t.project.id, t.employee.data.contactId, 'member')
    const ask = async () => (await currentProjects(t.directory, t.employee.id))[0]!
    // A human owner stands in while no lead is set.
    expect((await ask()).ask).toEqual([{ name: 'Ana Lima', role: 'owner', handles: ['mp:ana'] }])

    // The AI employee owns it: no human owner, so a human backup, and never the AI itself.
    await t.directory.projects.setOwner(t.project.id, t.employee.data.contactId)
    expect(projectsText([await ask()])).toContain(`ask: ${NO_LEAD_TEXT}`)
    const bo = await t.directory.contacts.create({ name: 'Bo Berg', handles: [{ system: 'slack', id: 'U0TEST0002' }] })
    await t.directory.projects.addMember(t.project.id, bo.id, 'backup')
    expect(askText((await ask()).ask)).toBe('Bo Berg (backup, no lead set; slack:U0TEST0002)')

    // The lead wins over everyone.
    const cy = await t.directory.contacts.create({
      name: 'Cy Ode',
      handles: [
        { system: 'slack', id: 'U0TEST0003' },
        { system: 'mp', id: 'cy' },
      ],
    })
    await t.directory.projects.addMember(t.project.id, cy.id, 'lead')
    const text = projectsText([await ask()])
    expect(text).toContain('ask: Cy Ode (lead; slack:U0TEST0003, mp:cy)')
    expect(text).not.toContain('Bo Berg')
    await expect(t.directory.projects.addMember(t.project.id, t.employee.data.contactId, 'lead')).rejects.toThrow(
      /must be a person/,
    )
  })

  it('counts the projects beyond the limit', async () => {
    const t = await stack()
    for (let i = 0; i < MAX_LISTED_PROJECTS + 2; i++) {
      const p = await t.directory.projects.create({ name: `P${String(i).padStart(2, '0')}` })
      await t.directory.projects.addMember(p.id, t.employee.data.contactId)
    }
    const text = projectsText(await currentProjects(t.directory, t.employee.id))
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(MAX_LISTED_PROJECTS)
    expect(text).toContain('…and 2 more (directory.projects_of')
  })

  it('is skipped when the history already has the same list, and added again when it changed', async () => {
    const t = await stack()
    const first = await projectsEntry(t, t.employee.id, t.session.id)
    expect(first).not.toBeNull()
    expect(first!.meta[PROJECTS_ENTRY_META]).toEqual([])
    await t.sessions.append(t.run.id, first!)
    await t.sessions.commit(t.run.id)
    expect(lastProjectsText(await t.sessions.history(t.session.id))).toBe(first!.content.text)
    expect(await projectsEntry(t, t.employee.id, t.session.id)).toBeNull()
    await t.directory.projects.addMember(t.project.id, t.employee.data.contactId)
    const next = await projectsEntry(t, t.employee.id, t.session.id)
    expect(next!.content.text).toContain('Billing')
    expect(next!.meta[PROJECTS_ENTRY_META]).toEqual([t.project.id])
  })

  it('new sessions get the current list after the prompt, and the prompt stays byte-identical after an assignment', async () => {
    const t = await stack()
    const a = await t.out('sessions.create', { title: 'a', instruction: 'what do you work on?' })
    const promptA = (await t.sessions.history(a.sessionId))[0]!.content
    const runA = await t.sessions.runHistory(a.runId)
    expect(runA.map((e) => e.kind)).toEqual(['system', 'system', 'user'])
    expect((runA[1]!.content as { text: string }).text).toMatch(/no project is assigned/)

    // Assigned later: the next session knows, and its system prompt is the same bytes.
    await t.directory.projects.addMember(t.project.id, t.employee.data.contactId, 'member')
    const b = await t.out('sessions.create', { title: 'b', instruction: 'and now?' })
    const promptB = (await t.sessions.history(b.sessionId))[0]!.content
    expect(JSON.stringify(promptB)).toBe(JSON.stringify(promptA))
    const runB = await t.sessions.runHistory(b.runId)
    expect((runB[1]!.content as { text: string }).text).toContain(`Billing (${t.project.id}); your role: member`)

    // A fork of the first session gets the new list too, after the history it shares.
    const fork = await t.out('sessions.fork', { sessionId: a.sessionId, instruction: 'again' })
    const runF = await t.sessions.runHistory(fork.runId)
    expect((runF.at(-2)!.content as { text: string }).text).toContain('Billing')
  })
})

describe('directory.projects_of', () => {
  it('defaults to the calling employee', async () => {
    const t = await stack()
    const none = await t.out('directory.projects_of', {})
    expect(none).toMatchObject({ contactId: t.employee.data.contactId, projects: [] })
    expect(none.note).toMatch(/Ask an admin/)
    await t.directory.projects.addMember(t.project.id, t.employee.data.contactId, 'member')
    const mine = await t.out('directory.projects_of', {})
    expect(mine.projects).toEqual([expect.objectContaining({ id: t.project.id, roles: ['member'] })])
    expect(mine.note).toBeUndefined()
    expect(t.tools.get('directory.projects_of')!.def.description).toMatch(/^Which projects you work on/)
  })

  it('still answers for a given contact', async () => {
    const t = await stack()
    const o = await t.out('directory.projects_of', { contactId: t.ana.id, role: 'owner' })
    expect(o.projects.map((p: { id: string }) => p.id)).toEqual([t.project.id])
    expect(o.note).toBeUndefined()
  })
})
