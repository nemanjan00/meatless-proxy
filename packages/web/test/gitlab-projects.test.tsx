import { ApiRequestError } from '@mp/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/app.tsx'
import { createMockDataLayer, EMP } from '../src/mock/index.ts'

/** The GitLab setup's projects step as an admin, with the mock account's 153 projects; spies on the listing. */
function renderSetup() {
  const data = createMockDataLayer({ now: Date.now() })
  data.api.me = async () => ({ contactId: 'con_01JB0000000000000000000001', name: 'Ana Novak', access: 'admin', via: 'session' })
  const list = vi.fn(data.api.gitlabProjects.bind(data.api))
  data.api.gitlabProjects = list
  const act = vi.fn(data.api.integrationAction.bind(data.api))
  data.api.integrationAction = act
  render(
    <MemoryRouter initialEntries={[`/employees/${EMP.billing}?setup=gitlab`]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return { data, list, act }
}

const panel = () => screen.findByTestId('setup-panel')
const rows = () => within(screen.getByTestId('gitlab-projects')).getAllByTestId('gitlab-project')
const row = (path: string) => rows().find((r) => r.textContent?.includes(path))!
const count = () => screen.getByTestId('gitlab-projects-count').textContent

describe('GitLab setup: the projects list', () => {
  it('shows the first page with a total, and Load more appends the next', async () => {
    const user = userEvent.setup()
    renderSetup()
    await within(await panel()).findByTestId('gitlab-projects')
    await waitFor(() => expect(count()).toBe('50 of 153 projects'))
    expect(rows()).toHaveLength(50)
    const first = rows()[0]!.textContent
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rows()).toHaveLength(100))
    expect(rows()[0]!.textContent).toBe(first)
    expect(count()).toBe('100 of 153 projects')
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rows()).toHaveLength(153))
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('searches on the server once typing pauses', async () => {
    const user = userEvent.setup()
    const { list } = renderSetup()
    await within(await panel()).findByTestId('gitlab-projects')
    await user.type(screen.getByRole('searchbox', { name: 'Search GitLab projects' }), 'ledger')
    await waitFor(() => expect(count()).toMatch(/^\d+ of \d+ projects? matching “ledger”$/))
    expect(rows().every((r) => r.textContent?.includes('ledger'))).toBe(true)
    // Debounced: no request for "l", "le", … only for the whole word.
    expect(list.mock.calls.map((c) => c[1]?.search ?? '')).toEqual(['', 'ledger'])
    await user.clear(screen.getByRole('searchbox'))
    await user.type(screen.getByRole('searchbox'), 'zzz-nothing')
    expect(await screen.findByTestId('gitlab-projects-empty')).toHaveTextContent('No project matches “zzz-nothing”.')
  })

  it('keeps the selection across pages and searches, and adds it all at once', async () => {
    const user = userEvent.setup()
    const { act } = renderSetup()
    await within(await panel()).findByTestId('gitlab-projects')
    await user.click(within(row('acme/invoices')).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(rows()).toHaveLength(100))
    const late = rows()[80]!
    const latePath = late.querySelector('a')!.textContent!
    await user.click(within(late).getByRole('checkbox'))
    await user.type(screen.getByRole('searchbox'), 'ledger')
    await waitFor(() => expect(count()).toMatch(/matching “ledger”/))
    const ledger = rows().find((r) => !r.textContent?.includes(latePath))!
    await user.click(within(ledger).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Add selected (3)' }))
    await waitFor(() => expect(act).toHaveBeenCalled())
    const ids = (act.mock.calls[0]![3] as { projects: number[] }).projects
    expect(ids).toHaveLength(3)
    expect(ids).toContain(2)
    expect(await screen.findByText(/Added 3 projects/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add selected' })).toBeDisabled())
    await user.clear(screen.getByRole('searchbox'))
    await waitFor(() => expect(row('acme/invoices').dataset.added).toBe('true'))
  })

  it('filters to the projects already added, or the rest', async () => {
    const user = userEvent.setup()
    renderSetup()
    await within(await panel()).findByTestId('gitlab-projects')
    await user.click(screen.getByRole('button', { name: 'Added' }))
    expect(rows().map((r) => r.querySelector('a')!.textContent)).toEqual(['acme/payments-api'])
    await user.click(screen.getByRole('button', { name: 'Not added' }))
    expect(rows().some((r) => r.textContent?.includes('acme/payments-api'))).toBe(false)
    expect(rows()).toHaveLength(49)
  })

  it('checks default branches per row and keeps the Maintainer warning', async () => {
    renderSetup()
    await within(await panel()).findByTestId('gitlab-projects')
    // tools/auth (id 9) is left unprotected in the mock; acme/infra is Maintainer on this employee.
    await waitFor(() => expect(row('tools/auth')).toHaveTextContent('main isn’t protected'), { timeout: 3000 })
    expect(row('tools/auth')).toHaveTextContent('main · unprotected')
    expect(row('acme/invoices')).toHaveTextContent('main · protected')
    expect(row('acme/infra')).toHaveTextContent(/Maintainer: it could merge/)
  })

  it('says why the list failed, and retries', async () => {
    const user = userEvent.setup()
    const { list, data } = renderSetup()
    const real = list.getMockImplementation()!
    list.mockImplementation(() =>
      Promise.reject(new ApiRequestError(503, 'unavailable', 'GitLab answered GET /projects with HTTP 500')),
    )
    await panel()
    expect(await screen.findByTestId('gitlab-projects-error')).toHaveTextContent(/HTTP 500/)
    list.mockImplementation(real)
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(count()).toBe('50 of 153 projects'))
    expect(data).toBeTruthy()
  })
})
