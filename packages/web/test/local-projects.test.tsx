import type { Access } from '@mp/api'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { createMockDataLayer } from '../src/mock/index.ts'
import { mockLocalRepos, mockPushBranch } from '../src/mock/projects.ts'

function setup(access: Access = 'admin') {
  const data = createMockDataLayer({ now: Date.now() })
  data.api.me = async () => ({ contactId: 'con_01JB0000000000000000000001', name: 'Ana Novak', access, via: 'session' })
  return data
}

function renderAt(data: ReturnType<typeof setup>, path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
}

describe('local projects in the web UI', () => {
  it('admins create one from New project → Local repository', async () => {
    const user = userEvent.setup()
    const data = setup()
    renderAt(data, '/projects')
    await user.click(await screen.findByRole('button', { name: /New project/ }))
    const dialog = await screen.findByTestId('new-project-dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'Invoice parser')
    await user.click(within(dialog).getByRole('radio', { name: 'Local repository' }))
    expect(within(dialog).getByTestId('np-local-hint')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/^Repositories/)).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    const section = await screen.findByTestId('local-repository')
    expect(await within(section).findByText(/local:invoice-parser/)).toBeInTheDocument()
    expect(await within(section).findByText(/No branches yet/)).toBeInTheDocument()
  })

  it('members get no Local repository choice', async () => {
    const user = userEvent.setup()
    renderAt(setup('member'), '/projects')
    await user.click(await screen.findByRole('button', { name: /New project/ }))
    const dialog = await screen.findByTestId('new-project-dialog')
    expect(within(dialog).queryByRole('radio', { name: 'Local repository' })).toBeNull()
  })

  it('reviews a pushed branch with its diff, merges it, and shows the merged file', async () => {
    const user = userEvent.setup()
    const data = setup()
    const { project } = await data.api.createLocalProject({ name: 'Parser' })
    mockPushBranch(data.api.db, project.id, 'mp/billing-bot/parse', { 'parse.ts': 'export const parse = 1' }, 'Add the parser')
    renderAt(data, `/projects/${project.id}`)
    const section = await screen.findByTestId('local-repository')
    await user.click(await within(section).findByTestId('local-branch'))
    const review = await within(section).findByTestId('local-branch-review')
    expect(await within(review).findByTestId('local-diff')).toHaveTextContent('+export const parse = 1')
    expect(within(review).getByText('Add the parser')).toBeInTheDocument()
    await user.click(within(review).getByTestId('local-merge'))
    await waitFor(() => expect(within(section).getByText(/Nothing to review/)).toBeInTheDocument())
    expect(mockLocalRepos(data.api.db).get(project.id)!.main['parse.ts']).toBe('export const parse = 1')
    // Radix tabs switch on mouse down.
    fireEvent.mouseDown(within(section).getByRole('tab', { name: /Files/ }))
    await user.click(await within(section).findByRole('button', { name: /parse\.ts/ }))
    expect(await within(section).findByText('export const parse = 1')).toBeInTheDocument()
  })

  it('reports a conflict with its files and leaves the branch to review', async () => {
    const user = userEvent.setup()
    const data = setup()
    const { project } = await data.api.createLocalProject({ name: 'Clash' })
    mockPushBranch(data.api.db, project.id, 'mp/bot/one', { 'same.txt': 'one' })
    await data.api.mergeLocalBranch(project.id, 'mp/bot/one')
    mockPushBranch(data.api.db, project.id, 'mp/bot/two', { 'same.txt': 'two' })
    renderAt(data, `/projects/${project.id}`)
    const section = await screen.findByTestId('local-repository')
    const rows = await within(section).findAllByTestId('local-branch')
    await user.click(rows.find((r) => r.textContent?.includes('mp/bot/two'))!)
    const review = await within(section).findByTestId('local-branch-review')
    await within(review).findByTestId('local-diff')
    await user.click(within(review).getByTestId('local-merge'))
    const note = await within(review).findByTestId('local-conflict')
    expect(note).toHaveTextContent(/Nothing was changed/)
    expect(note).toHaveTextContent('same.txt')
    expect(mockLocalRepos(data.api.db).get(project.id)!.main['same.txt']).toBe('one')
  })

  it('deletes a branch after confirming', async () => {
    const user = userEvent.setup()
    const data = setup()
    const { project } = await data.api.createLocalProject({ name: 'Cleanup' })
    mockPushBranch(data.api.db, project.id, 'mp/bot/old', { 'x.txt': 'x' })
    renderAt(data, `/projects/${project.id}`)
    const section = await screen.findByTestId('local-repository')
    await user.click(await within(section).findByTestId('local-branch'))
    const review = await within(section).findByTestId('local-branch-review')
    await user.click(within(review).getByRole('button', { name: /Delete branch/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/1 commit that main doesn't/)
    await user.click(within(dialog).getByRole('button', { name: 'Delete branch' }))
    await waitFor(() => expect(mockLocalRepos(data.api.db).get(project.id)!.branches.size).toBe(0))
  })
})
