import type { Access } from '@mp/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { createMockDataLayer, EMP } from '../src/mock/index.ts'

const layer = (access: Access = 'admin') => {
  const data = createMockDataLayer({ now: Date.now() })
  data.api.me = async () => ({ contactId: 'con_01JB0000000000000000000001', name: 'Ana Novak', access, via: 'session' })
  return data
}

function renderAt(path: string, access: Access = 'admin') {
  const data = layer(access)
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return data
}

const card = async (name: string) =>
  (await screen.findAllByTestId('integration-card')).find((c) => c.dataset.integration === name)!
const panelStep = (id: string) =>
  within(screen.getByTestId('setup-panel'))
    .getAllByTestId('setup-step')
    .find((s) => s.dataset.step === id)!

describe('employee page', () => {
  it('shows the profile, the SSH key and a card per integration with its state', async () => {
    renderAt(`/employees/${EMP.billing}`)
    expect(await screen.findByRole('heading', { level: 2, name: 'Billing Bot' })).toBeInTheDocument()
    const key = await screen.findByTestId('ssh-key')
    expect(within(key).getByText(/^ssh-ed25519 /)).toBeInTheDocument()
    expect(within(key).getByText(/^SHA256:/)).toBeInTheDocument()
    expect(within(key).getByRole('button', { name: 'Copy public key' })).toBeInTheDocument()
    expect((await card('slack')).querySelector('[data-state]')?.getAttribute('data-state')).toBe('connected')
    expect((await card('gitlab')).querySelector('[data-state]')?.getAttribute('data-state')).toBe('needs_attention')
    expect((await card('linear')).querySelector('[data-state]')?.getAttribute('data-state')).toBe('not_set_up')
    expect(screen.getByText('How integrations work')).toBeInTheDocument()
  })

  it('walks through GitLab: checked steps, the SSH key added for you', async () => {
    const user = userEvent.setup()
    renderAt(`/employees/${EMP.billing}`)
    await user.click(await card('gitlab'))
    const panel = await screen.findByTestId('setup-panel')
    expect(within(panel).getByText('GitLab for Billing Bot')).toBeInTheDocument()
    expect(panelStep('token').dataset.status).toBe('warning')
    expect(within(panelStep('token')).getByText(/expires in 12 days/)).toBeInTheDocument()
    expect(within(panelStep('projects')).getByText(/Developer is recommended/)).toBeInTheDocument()
    expect(panelStep('ssh-key').dataset.status).toBe('todo')
    await user.click(within(panelStep('ssh-key')).getByRole('button', { name: 'Add it for me' }))
    await waitFor(() => expect(panelStep('ssh-key').dataset.status).toBe('done'))
    expect(await screen.findByText(/Added the key to @billing-bot/)).toBeInTheDocument()
  })

  it('stores a token through the step form and shows why a bad one is refused', async () => {
    const user = userEvent.setup()
    renderAt(`/employees/${EMP.support}?setup=slack`)
    const panel = await screen.findByTestId('setup-panel')
    expect(within(panel).getByText('Slack for Support Bot')).toBeInTheDocument()
    const tokens = panelStep('tokens')
    const input = within(tokens).getByLabelText(/Bot User OAuth Token/)
    expect(input).toHaveAttribute('type', 'password')
    await user.type(input, 'xoxp-user')
    await user.click(within(tokens).getByRole('button', { name: 'Save and check' }))
    expect(await within(tokens).findByRole('alert')).toHaveTextContent('That isn’t a bot token')
    await user.clear(input)
    await user.type(input, 'xoxb-fine')
    await user.click(within(tokens).getByRole('button', { name: 'Save and check' }))
    await waitFor(() => expect(panelStep('tokens').dataset.status).toBe('done'))
    // Pasted values are never shown again.
    expect(within(panelStep('tokens')).queryByDisplayValue('xoxb-fine')).toBeNull()
    await user.click(within(panelStep('routing')).getByRole('button', { name: 'Add recommended trigger' }))
    await waitFor(() => expect(panelStep('routing').dataset.status).toBe('done'))
  })

  it('shows members the status read-only, with no forms or actions', async () => {
    const user = userEvent.setup()
    renderAt(`/employees/${EMP.billing}`, 'member')
    await screen.findByTestId('ssh-key')
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New employee' })).toBeNull()
    await user.click(await card('gitlab'))
    await screen.findByTestId('setup-panel')
    expect(screen.getByText(/Only admins can change it/)).toBeInTheDocument()
    expect(within(panelStep('ssh-key')).queryByRole('button', { name: 'Add it for me' })).toBeNull()
    expect(within(panelStep('token')).queryByRole('button', { name: 'Save and check' })).toBeNull()
  })

  it('rotates the SSH key after a confirmation that says what breaks', async () => {
    const user = userEvent.setup()
    renderAt(`/employees/${EMP.billing}`)
    const before = within(await screen.findByTestId('ssh-key')).getByText(/^ssh-ed25519 /).textContent
    await user.click(screen.getByRole('button', { name: 'Rotate' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/old key stops working/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Rotate key' }))
    await waitFor(() => expect(within(screen.getByTestId('ssh-key')).getByText(/^ssh-ed25519 /).textContent).not.toBe(before))
  })
})

describe('new employee dialog', () => {
  it('derives the handle, creates the employee and opens its page', async () => {
    const user = userEvent.setup()
    renderAt('/settings/employees')
    await user.click(await screen.findByRole('button', { name: 'New employee' }))
    const dialog = await screen.findByTestId('new-employee-dialog')
    await user.type(within(dialog).getByLabelText(/^Name/), 'Research Bot')
    expect(within(dialog).getByLabelText(/^Handle/)).toHaveValue('research-bot')
    await user.type(within(dialog).getByLabelText(/^Role/), 'Researcher')
    await user.click(within(dialog).getByRole('button', { name: 'Create employee' }))
    expect(await screen.findByText('Research Bot is ready.')).toBeInTheDocument()
    expect(await screen.findByTestId('integrations')).toBeInTheDocument()
    expect((await card('slack')).querySelector('[data-state]')?.getAttribute('data-state')).toBe('not_set_up')
  })

  it('refuses a taken handle and keeps the dialog open', async () => {
    const user = userEvent.setup()
    renderAt(`/employees/${EMP.billing}`)
    await user.click(await screen.findByRole('button', { name: 'New employee' }))
    const dialog = await screen.findByTestId('new-employee-dialog')
    await user.type(within(dialog).getByLabelText(/^Name/), 'Another')
    const handle = within(dialog).getByLabelText(/^Handle/)
    await user.clear(handle)
    await user.type(handle, 'billing-bot')
    await user.click(within(dialog).getByRole('button', { name: 'Create employee' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('@billing-bot is taken')
    expect(screen.getByTestId('new-employee-dialog')).toBeInTheDocument()
  })

  it('needs a name', async () => {
    const user = userEvent.setup()
    renderAt('/settings/employees')
    await user.click(await screen.findByRole('button', { name: 'New employee' }))
    const dialog = await screen.findByTestId('new-employee-dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create employee' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give it a name')
  })
})

describe('settings → integrations', () => {
  it('is an overview that links to each employee’s guided setup', async () => {
    renderAt('/settings/integrations')
    const rows = await screen.findAllByTestId('integrations-row')
    expect(rows.length).toBeGreaterThanOrEqual(3)
    const billing = rows.find((r) => within(r).queryByText('Billing Bot'))!
    const link = within(billing)
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.includes('setup=gitlab'))
    expect(link?.getAttribute('href')).toBe(`/employees/${EMP.billing}?setup=gitlab`)
  })
})
