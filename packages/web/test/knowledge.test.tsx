import { type Access, parseSkillMarkdown, skillMarkdown } from '@mp/api'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { CON, createMockApi, createMockDb, createMockLive, EMP, mockId, PRO } from '../src/mock/index.ts'

const PEOPLE = { ana: CON.ana, bob: CON.bob, eli: CON.eli, farah: mockId('con', 6), gus: mockId('con', 7) }

/** The app on the mock, signed in as someone with some access (the mock enforces the same rules as the server). */
function renderAt(
  path: string,
  who: { id: string; name: string; access: Access } = { id: CON.ana, name: 'Ana Novak', access: 'admin' },
) {
  const db = createMockDb({ now: Date.now() })
  const api = createMockApi(db, { me: who })
  const data = { api, live: createMockLive(db.now), mock: true }
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return data
}

const rowWith = async (testId: string, text: string | RegExp) =>
  (await screen.findAllByTestId(testId)).find((r) => within(r).queryAllByText(text).length > 0)!

// ─── Memory ─────────────────────────────────────────────────────────────────

describe('memory page', () => {
  it('explains memory and lists what the employees remember, with kind, subjects, employee and use', async () => {
    renderAt('/memory')
    expect(await screen.findByTestId('memory-explainer')).toHaveTextContent(/shown only to that person and to admins/)
    const rows = await screen.findAllByTestId('memory-row')
    expect(rows.length).toBe(13)
    const ana = await rowWith('memory-row', /Ana approves refunds above \$250/)
    expect(within(ana).getAllByText('Ana Novak').length).toBeGreaterThan(0)
    expect(within(ana).getAllByText('Payments API').length).toBeGreaterThan(0)
    expect(within(ana).getByLabelText('Personal')).toBeInTheDocument()
    expect(within(ana).getAllByText(/used 45m/).length).toBeGreaterThan(0)
    expect(screen.getByTestId('memory-count')).toHaveTextContent('13 memories')
  })

  it('filters by employee, kind, subject and text, and clears them', async () => {
    const user = userEvent.setup()
    renderAt(`/memory?employee=${EMP.support}&kind=fact`)
    await waitFor(() => expect(screen.getAllByTestId('memory-row').length).toBeLessThan(13))
    for (const r of screen.getAllByTestId('memory-row')) expect(r.querySelector('[aria-label=Fact]')).not.toBeNull()
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!)
    await user.type(screen.getAllByLabelText('Search memories')[0]!, 'helm')
    await waitFor(() => expect(screen.getAllByTestId('memory-row').length).toBeGreaterThanOrEqual(1))
  })

  it('filters by what a memory is about, from the URL', async () => {
    renderAt(`/memory?about=${PRO.platform}`)
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(3))
  })

  it('hides memories about other people from members, and shows the ones about themselves', async () => {
    renderAt('/memory', { id: CON.bob, name: 'Bob Smith', access: 'member' })
    const rows = await screen.findAllByTestId('memory-row')
    const text = rows.map((r) => r.textContent).join('\n')
    expect(text).toContain('Bob prefers incident updates')
    expect(text).not.toContain('Ana approves refunds')
    expect(text).toContain('Deploys to production happen on weekdays')
  })

  it('opens a memory in a drawer with its source and history, and corrects it with a note', async () => {
    const user = userEvent.setup()
    const data = renderAt(`/memory/${mockId('mem', 13)}`)
    const drawer = await screen.findByTestId('memory-drawer')
    expect(
      (await within(drawer).findAllByText('The monthly billing run starts on the 1st at 04:00 UTC.')).length,
    ).toBeGreaterThan(0)
    const history = within(drawer).getByTestId('memory-history')
    expect(within(history).getByText(/Corrected/)).toBeInTheDocument()
    expect(within(history).getByText(/after the FX rate job/)).toBeInTheDocument()
    expect(within(drawer).getByText('Billing intake')).toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: 'Correct it' }))
    // The note is required.
    await user.clear(within(drawer).getByLabelText(/Summary/))
    await user.type(within(drawer).getByLabelText(/Summary/), 'The monthly billing run starts on the 2nd at 04:00 UTC.')
    await user.click(within(drawer).getByRole('button', { name: 'Save correction' }))
    expect(await within(drawer).findByText(/Say what was wrong/)).toBeInTheDocument()
    await user.type(within(drawer).getByLabelText(/What was wrong/), 'It moved to the 2nd.')
    await user.click(within(drawer).getByRole('button', { name: 'Save correction' }))
    await waitFor(async () => {
      const m = await data.api.memory(mockId('mem', 13))
      expect(m.memory.data.correction?.note).toBe('It moved to the 2nd.')
      expect(m.memory.data.summary).toContain('the 2nd')
    })
  })

  it('forgets a memory only after confirming', async () => {
    const user = userEvent.setup()
    const data = renderAt(`/memory/${mockId('mem', 2)}`)
    const drawer = await screen.findByTestId('memory-drawer')
    await within(drawer).findByText(/Bob prefers incident updates/)
    await user.click(within(drawer).getByRole('button', { name: 'Forget' }))
    const dialog = await screen.findByRole('dialog', { name: 'Forget this memory?' })
    await user.click(within(dialog).getByRole('button', { name: 'Forget it' }))
    await waitFor(async () => expect((await data.api.memories()).items.map((i) => i.memory.id)).not.toContain(mockId('mem', 2)))
  })

  it('lets a person add a memory, saying who can see it when it is about someone', async () => {
    const user = userEvent.setup()
    const data = renderAt('/memory')
    await screen.findAllByTestId('memory-row')
    await user.click(screen.getAllByRole('button', { name: 'Add memory' })[0]!)
    const dialog = await screen.findByTestId('new-memory-dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Remember this' }))
    expect(await within(dialog).findByText(/Write what to remember/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/Summary/), 'Eli wants invoices checked before the 25th.')
    await user.click(within(dialog).getByRole('radio', { name: /Preference/ }))
    fireEvent.change(within(dialog).getByLabelText('Who remembers it'), { target: { value: EMP.billing } })
    const about = within(dialog).getByLabelText(/About/, { selector: 'input' })
    await user.type(about, 'eli')
    await user.click(await within(dialog).findByRole('option', { name: /Eli Brown/ }))
    expect(within(dialog).getByTestId('privacy-note')).toHaveTextContent(/only Eli and admins/)
    await user.click(within(dialog).getByRole('button', { name: 'Remember this' }))
    await waitFor(async () => {
      const found = (await data.api.memories({ text: 'invoices checked before' })).items[0]
      expect(found?.memory.data).toMatchObject({ kind: 'preference', employeeId: EMP.billing, source: { contactId: CON.ana } })
      expect(found?.about.map((a) => a.id)).toEqual([CON.eli])
    })
    // The new memory opens in the drawer.
    expect(await screen.findByTestId('memory-drawer')).toBeInTheDocument()
  })

  it('shows viewers no Add memory button', async () => {
    renderAt('/memory', { id: CON.eli, name: 'Eli Brown', access: 'viewer' })
    await screen.findAllByTestId('memory-row')
    expect(screen.queryByRole('button', { name: 'Add memory' })).toBeNull()
  })
})

// ─── Skills ─────────────────────────────────────────────────────────────────

describe('skills page', () => {
  it('explains skills and groups them by scope, with when to use and who used them', async () => {
    renderAt('/skills')
    expect(await screen.findByTestId('skills-explainer')).toHaveTextContent(
      /load the full instructions when a task calls for them/,
    )
    const groups = await screen.findAllByTestId('skill-group')
    expect(groups.map((g) => g.querySelector('h2')?.textContent)).toEqual(['Company-wide4', 'Infra Platform1', 'Payments API2'])
    const triage = await rowWith('skill-row', 'triage-customer-bug')
    expect(within(triage).getAllByText(/A support ticket or chat message/).length).toBeGreaterThan(0)
    expect(within(triage).getAllByTestId('skill-used-by').length).toBeGreaterThan(0)
    const off = await rowWith('skill-row', 'answer-access-request')
    expect(within(off).getByText('off')).toBeInTheDocument()
    expect(
      within(await rowWith('skill-row', 'Platform releases: images first, then the chart bump.')).getByText('replaces company'),
    ).toBeInTheDocument()
  })

  it('creates a skill from the template, and refuses a taken name', async () => {
    const user = userEvent.setup()
    renderAt('/skills')
    await screen.findAllByTestId('skill-row')
    await user.click(screen.getAllByRole('button', { name: 'New skill' })[0]!)
    const dialog = await screen.findByTestId('new-skill-dialog')
    expect((within(dialog).getAllByLabelText('Instructions (markdown)')[0] as HTMLTextAreaElement).value).toContain(
      '## How to do it',
    )
    await user.type(within(dialog).getByLabelText('Name'), 'cut-release')
    await user.type(within(dialog).getByLabelText(/What it helps with/), 'Another release skill.')
    await user.click(within(dialog).getByRole('button', { name: 'Create skill' }))
    expect(await within(dialog).findByText(/already a skill called cut-release/)).toBeInTheDocument()
    await user.clear(within(dialog).getByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), 'rotate-secrets')
    await user.click(within(dialog).getByRole('radio', { name: 'One project' }))
    await user.click(within(dialog).getByRole('button', { name: 'Create skill' }))
    expect(await screen.findByTestId('skill-instructions')).toBeInTheDocument()
    expect(await screen.findByText(/^Project skill of /)).toBeInTheDocument()
  })

  it('imports a pasted SKILL.md into the form', async () => {
    const user = userEvent.setup()
    renderAt('/skills')
    await screen.findAllByTestId('skill-row')
    await user.click(screen.getByRole('button', { name: 'Import' }))
    const dialog = await screen.findByTestId('new-skill-dialog')
    fireEvent.change(within(dialog).getByLabelText(/SKILL.md/, { selector: 'textarea' }), {
      target: {
        value:
          '---\nname: review-terraform\ndescription: Review a Terraform plan before it is applied.\nwhen_to_use: A merge request changes infrastructure.\n---\n\n## Steps\n\n1. Read the plan.\n',
      },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Read it' }))
    expect(within(dialog).getByLabelText('Name')).toHaveValue('review-terraform')
    expect(within(dialog).getByLabelText(/When to use it/)).toHaveValue('A merge request changes infrastructure.')
  })

  it('edits the instructions with a preview, reads versions, restores one, and switches the skill off', async () => {
    const user = userEvent.setup()
    const data = renderAt(`/skills/${mockId('skl', 3)}`)
    const section = await screen.findByTestId('skill-instructions')
    await user.click(within(section).getByRole('button', { name: /Edit/ }))
    const box = within(section).getAllByLabelText('Instructions (markdown)')[0]!
    fireEvent.change(box, { target: { value: '## How to do it\n\n1. Just ship it.' } })
    expect(within(section).getAllByTestId('steps-preview')[0]).toHaveTextContent('Just ship it.')
    await user.click(within(section).getByRole('button', { name: 'Save instructions' }))
    await waitFor(async () => expect((await data.api.skill(mockId('skl', 3))).skill.version).toBe(4))
    await user.click(within(section).getByRole('button', { name: /Versions/ }))
    const versions = await screen.findByTestId('skill-versions')
    expect(within(versions).getByText(/v2 · Changed what it helps with, when to use it/)).toBeInTheDocument()
    await user.click(within(versions).getByText(/v1 · Created/))
    await user.click(within(versions).getByRole('button', { name: 'Restore this version' }))
    await waitFor(async () => {
      const k = await data.api.skill(mockId('skl', 3))
      expect(k.skill.version).toBe(5)
      expect(k.skill.data.whenToUse).toBeUndefined()
    })
    await user.click(screen.getByRole('switch'))
    await waitFor(async () => expect((await data.api.skill(mockId('skl', 3))).skill.data.enabled).toBe(false))
  })
})

describe('SKILL.md', () => {
  it('parses front matter, falls back to the heading, and round-trips', () => {
    expect(parseSkillMarkdown('---\nname: "a: b"\ndescription: >\n  folded\n  text\n---\nBody')).toEqual({
      name: 'a: b',
      description: 'folded text',
      whenToUse: '',
      body: 'Body',
    })
    expect(parseSkillMarkdown('# Cut a release\n\nTag it and write the notes.\n\n## Steps')).toMatchObject({
      name: 'Cut a release',
      description: 'Tag it and write the notes.',
    })
    const md = skillMarkdown({ name: 'x', description: 'Does: things', whenToUse: 'Always', body: '## Steps' })
    expect(parseSkillMarkdown(md)).toEqual({ name: 'x', description: 'Does: things', whenToUse: 'Always', body: '## Steps' })
  })
})

// ─── People ─────────────────────────────────────────────────────────────────

describe('people page', () => {
  it('is called People and lists people, employees and agents with access, email, handles and projects', async () => {
    renderAt('/contacts')
    expect(await screen.findByTestId('people-explainer')).toHaveTextContent(/one-time link/)
    expect(screen.getAllByText('People').length).toBeGreaterThan(0)
    const ana = await rowWith('person-row', 'Ana Novak')
    expect(within(ana).getByText('admin')).toBeInTheDocument()
    expect(within(ana).getAllByText(/ana@example.com/).length).toBeGreaterThan(0)
    expect(within(ana).getAllByText(/Slack U0ANA/).length).toBeGreaterThan(0)
    expect(within(ana).getAllByText('Payments API').length).toBeGreaterThan(0)
    const bot = await rowWith('person-row', 'Billing Bot')
    expect(bot.getAttribute('href')).toBe(`/employees/${EMP.billing}`)
    // The deactivated person is hidden until asked for.
    expect(screen.queryAllByTestId('person-row').some((r) => r.textContent?.includes('Farah Haddad'))).toBe(false)
  })

  it('filters by kind, access, team and text', async () => {
    const user = userEvent.setup()
    renderAt('/contacts')
    await screen.findAllByTestId('person-row')
    await user.click(screen.getByRole('tab', { name: /AI employees/ }))
    await waitFor(() => expect(screen.getAllByTestId('person-row')).toHaveLength(3))
    await user.click(screen.getByRole('tab', { name: /Everyone/ }))
    await user.click(screen.getByLabelText(/Deactivated/))
    expect(await rowWith('person-row', 'Farah Haddad')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Search people'), 'gitlab gus')
    await waitFor(() => expect(screen.queryAllByTestId('person-row')).toHaveLength(0))
    await user.clear(screen.getByLabelText('Search people'))
    await user.type(screen.getByLabelText('Search people'), 'gus.lee')
    await waitFor(() => expect(screen.getAllByTestId('person-row')).toHaveLength(1))
  })

  it('adds a person (admins) and shows the sign-in link, sent on Slack when they have a handle', async () => {
    const user = userEvent.setup()
    const data = renderAt('/contacts')
    await screen.findAllByTestId('person-row')
    await user.click(screen.getAllByRole('button', { name: 'Add person' })[0]!)
    const dialog = await screen.findByTestId('new-person-dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Add person' }))
    expect(await within(dialog).findByText(/as colleagues know it/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Name'), 'Ivo Petrov')
    await user.type(within(dialog).getByLabelText(/Email/), 'ivo@example.com')
    await user.click(within(dialog).getByRole('radio', { name: 'Viewer' }))
    await user.type(within(dialog).getByLabelText(/Team/), 'Support')
    await user.click(within(dialog).getByRole('button', { name: 'Add a handle' }))
    await user.type(within(dialog).getByLabelText('Slack id'), 'U0IVO')
    expect(within(dialog).getByRole('checkbox', { name: /Send a sign-in link/ })).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: 'Add person' }))
    const link = await within(dialog).findByTestId('sign-in-link')
    expect(link).toHaveTextContent(/Sent to Ivo Petrov as a Slack DM/)
    expect(link).toHaveTextContent(/works once/)
    const people = await data.api.people({ text: 'ivo' })
    expect(people[0]).toMatchObject({
      access: 'viewer',
      contact: { data: { team: 'Support', handles: [{ system: 'slack', id: 'U0IVO' }] } },
    })
  })

  it("doesn't offer Add person to members", async () => {
    renderAt('/contacts', { id: CON.bob, name: 'Bob Smith', access: 'member' })
    await screen.findAllByTestId('person-row')
    expect(screen.queryByRole('button', { name: 'Add person' })).toBeNull()
  })
})

describe('person page', () => {
  it('shows the profile, projects, memories, recent requests, and where to make a token', async () => {
    renderAt(`/contacts/${CON.ana}`)
    const profile = await screen.findByTestId('person-profile')
    expect(within(profile).getByText('Dana Park')).toBeInTheDocument()
    expect(within(await screen.findByTestId('person-projects')).getByText('Payments API')).toBeInTheDocument()
    const memories = screen.getByTestId('person-memories')
    expect(within(memories).getByRole('link', { name: 'See them' })).toHaveAttribute('href', `/memory?about=${CON.ana}`)
    expect((await screen.findAllByTestId('person-request')).length).toBeGreaterThan(0)
    // Ana has no tokens: she can make one in Settings.
    expect(within(screen.getByTestId('person-tokens')).getByRole('link', { name: /New token/ })).toHaveAttribute(
      'href',
      '/settings/tokens',
    )
  })

  it("lists someone's API tokens for admins, and revokes one", async () => {
    const user = userEvent.setup()
    const data = renderAt(`/contacts/${CON.dana}`)
    const tokens = await screen.findAllByTestId('person-token')
    expect(tokens).toHaveLength(2)
    expect(within(tokens[1]!).getByText('revoked')).toBeInTheDocument()
    await user.click(within(tokens[0]!).getByRole('button', { name: 'Revoke' }))
    await waitFor(async () => expect((await data.api.person(CON.dana)).tokens?.every((t) => t.revoked)).toBe(true))
  })

  it('changes access, sends a sign-in link, and deactivates after confirming', async () => {
    const user = userEvent.setup()
    const data = renderAt(`/contacts/${PEOPLE.gus}`)
    const access = await screen.findByTestId('person-access')
    fireEvent.change(within(access).getByLabelText('Access'), { target: { value: 'admin' } })
    await waitFor(async () => expect((await data.api.person(PEOPLE.gus)).access).toBe('admin'))
    const signIn = screen.getByTestId('person-sign-in')
    await user.click(within(signIn).getByRole('button', { name: /Sign-in link/ }))
    expect(await within(signIn).findByTestId('sign-in-link')).toHaveTextContent(/Slack DM/)
    await user.click(within(signIn).getByRole('button', { name: /Deactivate/ }))
    const dialog = await screen.findByRole('dialog', { name: /Deactivate Gus Lee/ })
    expect(dialog).toHaveTextContent(/signed out everywhere/)
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }))
    await waitFor(async () => expect((await data.api.person(PEOPLE.gus)).deactivated).toBe(true))
    expect(await screen.findByRole('button', { name: /Reactivate/ })).toBeInTheDocument()
  })

  it('edits the profile and handles', async () => {
    const user = userEvent.setup()
    const data = renderAt(`/contacts/${CON.bob}`)
    await screen.findByTestId('person-profile')
    await user.click(screen.getByRole('button', { name: /Edit/ }))
    const dialog = await screen.findByTestId('edit-person-dialog')
    await user.clear(within(dialog).getByLabelText('Team'))
    await user.type(within(dialog).getByLabelText('Team'), 'Infrastructure')
    await user.click(within(dialog).getAllByRole('button', { name: 'Remove handle' })[1]!)
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(async () => {
      const p = await data.api.person(CON.bob)
      expect(p.contact.data.team).toBe('Infrastructure')
      expect(p.contact.data.handles).toEqual([{ system: 'slack', id: 'U0BOB' }])
    })
  })

  it("hides someone else's memories, sign-ins and tokens from members", async () => {
    renderAt(`/contacts/${CON.ana}`, { id: CON.bob, name: 'Bob Smith', access: 'member' })
    const memories = await screen.findByTestId('person-memories')
    expect(memories).toHaveTextContent(/Only Ana and admins see/)
    expect(screen.queryByTestId('person-tokens')).toBeNull()
    expect(within(screen.getByTestId('person-access')).queryByLabelText('Access')).toBeNull()
  })
})
