import type { Access } from '@mp/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { createMockDataLayer, EMP, PRO } from '../src/mock/index.ts'

function renderAt(path: string, access: Access = 'admin') {
  const data = createMockDataLayer({ now: Date.now() })
  data.api.me = async () => ({ contactId: 'con_01JB0000000000000000000001', name: 'Ana Novak', access, via: 'session' })
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return data
}

const rows = async () =>
  (await screen.findAllByTestId('employee-project')).map((r) => within(r).getAllByRole('link')[0]!.textContent)

/** Focuses a record picker's input and types (focused directly: in jsdom, a click on the project page lands on the split view's resize handle). */
async function typeInto(user: ReturnType<typeof userEvent.setup>, box: HTMLElement, text: string) {
  const input = box.querySelector<HTMLInputElement>('input[role=combobox]')!
  input.blur()
  input.focus()
  await user.keyboard(text)
}

/** Types into a record picker and picks the option with this label. */
async function pick(user: ReturnType<typeof userEvent.setup>, box: HTMLElement, text: string, option: string | RegExp) {
  await typeInto(user, box, text)
  await user.click(await within(box).findByRole('option', { name: option }))
}

describe('employee page: Projects', () => {
  it('lists its projects with roles, removes one and adds one with a role', async () => {
    const user = userEvent.setup()
    const data = renderAt(`/employees/${EMP.billing}`)
    const section = await screen.findByTestId('employee-projects')
    expect(within(section).getByText('Projects')).toBeInTheDocument()
    expect(await rows()).toEqual(['Invoicing', 'Payments API'])
    const payments = (await screen.findAllByTestId('employee-project')).find((r) => r.textContent?.includes('Payments API'))!
    expect(within(payments).getByText('member')).toBeInTheDocument()
    expect(within(payments).getByText('owner Ana Novak')).toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: 'Remove from Invoicing' }))
    await waitFor(async () => expect(await rows()).toEqual(['Payments API']))

    const add = screen.getByTestId('employee-projects-add')
    await pick(user, add, 'Platform', /Infra Platform/)
    await waitFor(async () => expect(await rows()).toEqual(['Infra Platform', 'Payments API']))
    const people = await data.api.projectPeople(PRO.platform)
    expect(people.people.find((p) => p.employeeId === EMP.billing)?.roles).toEqual(['member'])
  })

  it('says so when it has no projects', async () => {
    renderAt(`/employees/${EMP.support}`)
    expect(await screen.findByTestId('employee-projects-empty')).toHaveTextContent(/No projects yet/)
  })

  it('is read-only for viewers', async () => {
    renderAt(`/employees/${EMP.billing}`, 'viewer')
    await screen.findAllByTestId('employee-project')
    expect(screen.queryByTestId('employee-projects-add')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Remove from/ })).toBeNull()
  })
})

describe('New project dialog', () => {
  it('creates a project owned by the employee, with repositories and docs, in one step', async () => {
    const user = userEvent.setup()
    const data = renderAt(`/employees/${EMP.billing}`)
    const section = await screen.findByTestId('employee-projects')
    await user.click(within(section).getByRole('button', { name: 'New project' }))
    const dialog = await screen.findByTestId('new-project-dialog')
    // The employee whose page it is owns it unless changed.
    expect(within(dialog).getByTestId('np-owner')).toHaveTextContent('Billing Bot')
    await user.type(within(dialog).getByLabelText('Name'), 'Refunds')
    await user.type(within(dialog).getByLabelText(/^Description/), 'Refund tooling.')
    await user.type(
      within(dialog).getByLabelText(/^Repositories/),
      'git@git.example.com:acme/refunds.git{enter}https://git.example.com/acme/refunds-ui',
    )
    await user.type(within(dialog).getByLabelText(/^Docs links/), 'https://docs.example.com/refunds')
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(screen.queryByTestId('new-project-dialog')).toBeNull())
    await waitFor(async () => expect(await rows()).toContain('Refunds'))
    const refunds = (await screen.findAllByTestId('employee-project')).find((r) => r.textContent?.includes('Refunds'))!
    expect(within(refunds).getByText('owner')).toBeInTheDocument()
    const p = (await data.api.employeeProjects(EMP.billing)).projects.find((x) => x.project.data.name === 'Refunds')!
    expect(p.project.data.repositories).toEqual([
      { url: 'git@git.example.com:acme/refunds.git' },
      { url: 'https://git.example.com/acme/refunds-ui' },
    ])
    expect(p.project.data.links).toEqual([{ system: 'docs', ref: 'https://docs.example.com/refunds' }])
  })

  it('shows why a project was refused, and needs a name', async () => {
    const user = userEvent.setup()
    renderAt(`/employees/${EMP.billing}`)
    const section = await screen.findByTestId('employee-projects')
    await user.click(within(section).getByRole('button', { name: 'New project' }))
    const dialog = await screen.findByTestId('new-project-dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give it a name.')
    await user.type(within(dialog).getByLabelText('Name'), 'Invoicing')
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already exists/)
  })

  it('replaces the generic form on the Projects list, and picks an owner there', async () => {
    const user = userEvent.setup()
    const data = renderAt('/projects')
    await user.click(await screen.findByRole('button', { name: /New project/ }))
    const dialog = await screen.findByTestId('new-project-dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'Status page')
    await pick(user, dialog, 'Infra', /Infra Bot/)
    expect(within(dialog).getByTestId('np-owner')).toHaveTextContent('Infra Bot')
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(await screen.findByTestId('project-people')).toBeInTheDocument()
    const mine = await data.api.employeeProjects(EMP.infra)
    expect(mine.projects.find((x) => x.project.data.name === 'Status page')?.roles).toEqual(['owner'])
  })
})

describe('project page: people', () => {
  it('shows the employees and people on it, owners first, and adds an employee', async () => {
    const user = userEvent.setup()
    renderAt(`/projects/${PRO.payments}`)
    const section = await screen.findByTestId('project-people')
    await waitFor(() => expect(within(section).getAllByTestId('project-person').length).toBeGreaterThan(1))
    const people = within(section).getAllByTestId('project-person')
    expect(people[0]).toHaveTextContent(/Ana Novak.*owner/)
    const bot = people.find((p) => p.textContent?.includes('Billing Bot'))!
    expect(bot).toHaveTextContent('@billing-bot')
    expect(within(bot).getByText('AI')).toBeInTheDocument()
    await pick(user, within(section).getByTestId('project-people-add'), 'Infra', /Infra Bot/)
    await waitFor(() => expect(within(section).getByText('Infra Bot')).toBeInTheDocument())
    // AI contacts aren't offered twice (as a contact and as an employee).
    await typeInto(user, section, 'Support')
    await waitFor(() =>
      expect(
        within(section)
          .getAllByRole('option')
          .filter((o) => o.textContent?.includes('Support Bot')),
      ).toHaveLength(1),
    )
    expect(within(section).getByRole('option', { name: /Support Bot/ })).toHaveTextContent('employee')
  })
})

describe('GitLab setup: Add as project', () => {
  it('shows which GitLab projects are added, and adds one', async () => {
    const user = userEvent.setup()
    const data = renderAt(`/employees/${EMP.billing}?setup=gitlab`)
    const panel = await screen.findByTestId('setup-panel')
    const list = await within(panel).findByTestId('gitlab-projects')
    const row = (path: string) =>
      within(list)
        .getAllByTestId('gitlab-project')
        .find((r) => r.textContent?.includes(path))!
    // payments-api is the Payments project's repository, and Billing Bot is on it.
    expect(row('acme/payments-api').dataset.added).toBe('true')
    expect(within(row('acme/payments-api')).getByText('Added')).toBeInTheDocument()
    await user.click(within(row('acme/invoices')).getByRole('button', { name: 'Add as project' }))
    await waitFor(() => expect(row('acme/invoices').dataset.added).toBe('true'))
    expect(await screen.findByText(/Added 1 project: acme\/invoices/)).toBeInTheDocument()
    const mine = await data.api.employeeProjects(EMP.billing)
    const added = mine.projects.find((p) => p.project.data.name === 'Invoices service')!
    expect(added.roles).toEqual(['member'])
    expect(added.project.data.repositories?.[0]).toMatchObject({
      url: 'git@git.example.com:acme/invoices.git',
      httpUrl: 'https://git.example.com/acme/invoices.git',
    })
  })
})
