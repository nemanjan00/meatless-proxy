import type { Access } from '@mp/api'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { CON, createMockDataLayer, PRC } from '../src/mock/index.ts'

function renderAt(path: string, access: Access = 'admin', prepare?: (data: ReturnType<typeof createMockDataLayer>) => void) {
  const data = createMockDataLayer({ now: Date.now() })
  data.api.me = async () => ({ contactId: CON.ana, name: 'Ana Novak', access, via: 'session' })
  prepare?.(data)
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return data
}

const row = async (name: string) => (await screen.findAllByTestId('procedure-row')).find((r) => within(r).queryByText(name))!

describe('procedures list', () => {
  it('explains procedures and shows how each starts, its owner, approvals, runs and context', async () => {
    renderAt('/procedures')
    expect(await screen.findByTestId('procedures-explainer')).toHaveTextContent(/each run starts with the procedure already read/)
    const rows = await screen.findAllByTestId('procedure-row')
    expect(rows).toHaveLength(6)
    const deploy = await row('Production deploy')
    expect(within(deploy).getAllByText('Someone posts in #deploys').length).toBeGreaterThan(0)
    expect(within(deploy).getAllByText('Bob Smith').length).toBeGreaterThan(0)
    expect(deploy.querySelector('[data-context=stale]')).not.toBeNull()
    expect(within(deploy).getAllByText('Yes, 2').length).toBeGreaterThan(0)
    const review = await row('Weekly access review')
    expect(within(review).getAllByText('Every Monday at 09:00 (Europe/Belgrade)').length).toBeGreaterThan(0)
    expect(review.querySelector('[data-context=missing]')).not.toBeNull()
    expect(within(review).getAllByText('Never run').length).toBeGreaterThan(0)
    expect(within(await row('Incident postmortem')).getAllByText('Manual only').length).toBeGreaterThan(0)
  })

  it('searches and filters by owner', async () => {
    const user = userEvent.setup()
    renderAt('/procedures')
    await screen.findAllByTestId('procedure-row')
    await user.type(screen.getByLabelText('Search procedures'), 'refund')
    await waitFor(() => expect(screen.getAllByTestId('procedure-row')).toHaveLength(1))
    await user.clear(screen.getByLabelText('Search procedures'))
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: CON.bob } })
    await waitFor(() => expect(screen.getAllByTestId('procedure-row')).toHaveLength(2))
    await user.type(screen.getByLabelText('Search procedures'), 'nothing like this')
    expect(await screen.findByText(/No procedure matches/)).toBeInTheDocument()
  })

  it('has an empty state with New procedure', async () => {
    renderAt('/procedures', 'admin', (d) => d.api.db.records.get('procedure')?.clear())
    expect(await screen.findByText(/No procedures yet/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New procedure' }).length).toBe(2)
  })
})

describe('procedure page', () => {
  it('shows when it runs in plain words, its approvals, runs and an out-of-date context, and rebuilds it', async () => {
    const user = userEvent.setup()
    renderAt(`/procedures/${PRC.deploy}`)
    expect(await screen.findByRole('heading', { level: 2, name: 'Production deploy' })).toBeInTheDocument()
    const when = screen.getByTestId('when-it-runs')
    expect(within(when).getByText('Whenever someone starts it')).toBeInTheDocument()
    expect(within(when).getByText('When someone posts in #deploys')).toBeInTheDocument()
    expect(within(when).getByText('When someone writes @deploy in chat')).toBeInTheDocument()
    const approvals = screen.getByTestId('approvals-panel')
    expect(within(approvals).getByText('Approves before the deploy starts')).toBeInTheDocument()
    expect(within(approvals).getByText('Dana Park')).toBeInTheDocument()
    const runs = screen.getAllByTestId('procedure-run')
    expect(runs.length).toBeGreaterThanOrEqual(5)
    expect(within(screen.getByTestId('runs')).getAllByText('Someone posts in #deploys').length).toBeGreaterThan(0)
    const ctx = screen.getByTestId('context-panel')
    expect(within(ctx).getByText('Out of date')).toBeInTheDocument()
    await user.click(within(ctx).getByRole('button', { name: /Rebuild context/ }))
    await waitFor(() => expect(within(screen.getByTestId('context-panel')).getByText('Ready')).toBeInTheDocument())
  })

  it('runs now with what to do, and links to the run', async () => {
    const user = userEvent.setup()
    renderAt(`/procedures/${PRC.access}`)
    await screen.findByRole('heading', { level: 2, name: 'Access request' })
    const before = screen.getAllByTestId('procedure-run').length
    await user.click(screen.getByRole('button', { name: 'Run now' }))
    const dialog = await screen.findByTestId('run-now-dialog')
    await user.type(within(dialog).getByLabelText(/What to do/), 'Grant Eli read access to Grafana.')
    await user.click(within(dialog).getByRole('button', { name: /Run now/ }))
    const link = await within(await screen.findByTestId('run-started')).findByRole('link', { name: 'Open the run' })
    expect(link.getAttribute('href')).toMatch(/^\/sessions\/ses_/)
    await waitFor(() => expect(screen.getAllByTestId('procedure-run').length).toBe(before + 1))
    expect(screen.getByText('Access request: Grant Eli read access to Grafana.')).toBeInTheDocument()
  })

  it('adds a trigger from a form, and refuses a catch-all with a friendly message', async () => {
    const user = userEvent.setup()
    renderAt(`/procedures/${PRC.refund}`)
    await screen.findByRole('heading', { level: 2, name: 'Refund approval' })
    await user.click(screen.getByRole('button', { name: /Add a trigger/ }))
    let editor = await screen.findByTestId('trigger-editor')
    await user.click(within(editor).getByRole('button', { name: /A schedule/ }))
    fireEvent.change(within(editor).getByLabelText('When'), { target: { value: '0 16 * * 5' } })
    expect(within(editor).getByTestId('start-summary')).toHaveTextContent('Every Friday at 16:00')
    await user.click(within(editor).getByRole('button', { name: 'Add trigger' }))
    expect(await within(screen.getByTestId('when-it-runs')).findByText('Every Friday at 16:00')).toBeInTheDocument()
    // Another source with nothing to match is a catch-all.
    await user.click(screen.getByRole('button', { name: /Add a trigger/ }))
    editor = await screen.findByTestId('trigger-editor')
    await user.click(within(editor).getByRole('button', { name: /An integration event/ }))
    fireEvent.change(within(editor).getByLabelText('From'), { target: { value: 'custom' } })
    await user.click(within(editor).getByRole('button', { name: 'Add trigger' }))
    expect(await within(editor).findByRole('alert')).toHaveTextContent(/would start the procedure for every event/)
  })

  it('edits the steps with a live preview, saving a new version that puts the context out of date', async () => {
    const user = userEvent.setup()
    renderAt(`/procedures/${PRC.access}`)
    await screen.findByRole('heading', { level: 2, name: 'Access request' })
    expect(within(screen.getByTestId('context-panel')).getByText('Ready')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Edit steps/ }))
    const editor = screen.getByLabelText('Steps (markdown)')
    await user.clear(editor)
    fireEvent.change(editor, { target: { value: '## Steps\n\n1. Ask Dana first.' } })
    expect(within(screen.getByTestId('steps-preview')).getByText('Ask Dana first.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save steps' }))
    await waitFor(() => expect(within(screen.getByTestId('context-panel')).getByText('Out of date')).toBeInTheDocument())
    expect(within(screen.getByTestId('steps')).getByText('Ask Dana first.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /History/ }))
    expect(await screen.findByTestId('steps-history')).toHaveTextContent(/v2 · Changed body/)
  })

  it('archives: its triggers go off and Run now goes away', async () => {
    const user = userEvent.setup()
    renderAt(`/procedures/${PRC.access}`)
    await screen.findByRole('heading', { level: 2, name: 'Access request' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Archive/ }))
    await user.click(await screen.findByRole('button', { name: 'Archive' }))
    expect(await screen.findByText(/Archived: it doesn't run/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull()
    for (const s of within(screen.getByTestId('when-it-runs')).getAllByRole('switch'))
      expect(s).toHaveAttribute('aria-checked', 'false')
  })

  it('is read-only for viewers, and members cannot change triggers', async () => {
    renderAt(`/procedures/${PRC.deploy}`, 'viewer')
    await screen.findByRole('heading', { level: 2, name: 'Production deploy' })
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Edit steps/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add a trigger/ })).toBeNull()
    expect(screen.getByText('Only admins change when a procedure runs by itself.')).toBeInTheDocument()
  })
})

describe('new procedure', () => {
  it('creates the procedure, its trigger and its context in one go, once, and opens it', async () => {
    const user = userEvent.setup()
    const data = renderAt('/procedures')
    await screen.findAllByTestId('procedure-row')
    await user.click(screen.getAllByRole('button', { name: 'New procedure' })[0]!)
    const dialog = await screen.findByTestId('new-procedure-dialog')
    // The steps start from the template's four sections.
    expect((within(dialog).getByLabelText('Steps (markdown)') as HTMLTextAreaElement).value).toMatch(
      /## When to use[\s\S]*## Escalate if/,
    )
    await user.type(within(dialog).getByLabelText('Name'), 'Vendor invoice dispute')
    await user.type(within(dialog).getByLabelText(/When it applies/), 'A vendor disputes one of our invoices.')
    await user.click(within(dialog).getByRole('button', { name: /An @tag/ }))
    expect(within(dialog).getByTestId('start-summary')).toHaveTextContent('When someone writes @vendor-invoice-dispute in chat')
    await user.click(within(dialog).getByRole('button', { name: /Add a role/ }))
    await user.type(within(dialog).getByLabelText('Approver role'), 'finance lead')
    await user.type(within(dialog).getByLabelText('At which step'), 'before any credit note')
    const create = within(dialog).getByRole('button', { name: 'Create procedure' })
    fireEvent.click(create)
    fireEvent.click(create)
    expect(await screen.findByRole('heading', { level: 2, name: 'Vendor invoice dispute' })).toBeInTheDocument()
    expect(
      within(screen.getByTestId('when-it-runs')).getByText('When someone writes @vendor-invoice-dispute in chat'),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('approvals-panel')).getByText('Someone with the role finance lead')).toBeInTheDocument()
    expect(within(screen.getByTestId('context-panel')).getByText('Ready')).toBeInTheDocument()
    const made = [...(data.api.db.records.get('procedure')?.values() ?? [])].filter(
      (p) => p.data.name === 'Vendor invoice dispute',
    )
    expect(made).toHaveLength(1)
  })

  it('asks for a name and a purpose, and tells members that only admins make it start by itself', async () => {
    const user = userEvent.setup()
    renderAt('/procedures', 'member')
    await screen.findAllByTestId('procedure-row')
    await user.click(screen.getAllByRole('button', { name: 'New procedure' })[0]!)
    const dialog = await screen.findByTestId('new-procedure-dialog')
    expect(within(dialog).getByText(/Only admins make procedures start by themselves/)).toBeInTheDocument()
    expect(within(dialog).queryByTestId('start-form')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Create procedure' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give it a name.')
    await user.type(within(dialog).getByLabelText('Name'), 'Laptop request')
    await user.click(within(dialog).getByRole('button', { name: 'Create procedure' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Say in one line when it applies.')
  })
})
