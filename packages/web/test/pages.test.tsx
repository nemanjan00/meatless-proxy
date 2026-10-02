import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { CHN, CON, createMockDataLayer, SES } from '../src/mock/index.ts'
import { applyNowEvent } from '../src/pages/now.tsx'

function renderAt(path: string) {
  const data = createMockDataLayer({ now: Date.now() })
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return { ...utils, data }
}

describe('pages against the mock API', () => {
  it('Now shows running cards, waiting rows and streams deltas', async () => {
    const { data } = renderAt('/now')
    const cards = await screen.findAllByTestId('now-card')
    expect(cards).toHaveLength(3)
    expect(screen.getAllByTestId('now-row').length).toBeGreaterThanOrEqual(5)
    const card = cards.find((c) => within(c).queryByText('PAY-123: refund a double charge'))!
    act(() => {
      data.live.emit('step.started', { runId: 'run_01JB0000000000000000000004', sessionId: SES.pay123, step: 9, kind: 'model' })
      data.live.emit('model.delta', {
        runId: 'run_01JB0000000000000000000004',
        sessionId: SES.pay123,
        content: 'Streaming hello',
      })
    })
    expect(within(card).getByText('Streaming hello')).toBeInTheDocument()
  })

  it('Sessions groups rows by status and filters', async () => {
    renderAt('/sessions')
    const rows = await screen.findAllByTestId('session-row')
    expect(rows.length).toBeGreaterThan(15)
    expect(screen.getByRole('heading', { name: /Running/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Contexts' }))
    await waitFor(() => expect(screen.getAllByTestId('session-row').length).toBeLessThan(rows.length))
  })

  it('Session detail shows the document, history, properties and the tree', async () => {
    renderAt(`/sessions/${SES.pay123}`)
    expect(await screen.findByRole('heading', { level: 2, name: 'PAY-123: refund a double charge' })).toBeInTheDocument()
    await screen.findByTestId('timeline')
    expect(screen.getAllByTestId('tool-call').length).toBeGreaterThan(2)
    expect(screen.getByTestId('pointer-entry')).toBeInTheDocument()
    expect(within(screen.getByTestId('properties')).getByText('Billing Bot')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'tree' }))
    fireEvent.click(screen.getByRole('tab', { name: 'tree' }))
    const tree = await screen.findByTestId('session-tree')
    expect(within(tree).getAllByTestId('tree-node').length).toBe(9)
  })

  it('Session detail and the list say what a session waits for, not just its status', async () => {
    renderAt(`/sessions/${SES.deploy214}`)
    const outcome = await screen.findByTestId('session-outcome')
    expect(within(outcome).getByTestId('waiting-for')).toHaveTextContent(
      'Waiting for review of mp/fix-login in local project portal',
    )
  })

  it('Session rows show an outcome line', async () => {
    renderAt('/sessions')
    await screen.findAllByTestId('session-row')
    const lines = screen.getAllByTestId('session-outcome').map((x) => x.textContent)
    expect(lines).toContain('waiting for review of mp/fix-login in local project portal')
  })

  it('Session tree collapses a subtree', async () => {
    renderAt(`/sessions/${SES.pay123}?tab=tree`)
    const tree = await screen.findByTestId('session-tree')
    await waitFor(() => expect(within(tree).getAllByTestId('tree-node')).toHaveLength(9))
    fireEvent.click(within(tree).getByRole('button', { name: 'Collapse PAY-123: refund a double charge' }))
    expect(within(tree).getAllByTestId('tree-node')).toHaveLength(5)
    expect(within(tree).getByRole('button', { name: 'Expand PAY-123: refund a double charge' })).toHaveTextContent('+4')
  })

  it('Branches tab draws the entry tree', async () => {
    renderAt(`/sessions/${SES.pay123}?tab=branches`)
    const t = await screen.findByTestId('entry-tree')
    expect(within(t).getByText(/rewound/)).toBeInTheDocument()
    expect(within(t).getByText(/offloaded/)).toBeInTheDocument()
  })

  it('Lineage shows the origin chain', async () => {
    renderAt(`/lineage/${SES.pay123}`)
    const chain = await screen.findByTestId('origin-chain')
    expect(within(chain).getByText(/Event: Customer charged twice/)).toBeInTheDocument()
    expect(within(chain).getByText(/Session: PAY-123/)).toBeInTheDocument()
  })

  it('Triggers shows the map and unmatched events', async () => {
    renderAt('/triggers')
    const map = await screen.findByTestId('trigger-map')
    expect(within(map).getByText('New PAY task')).toBeInTheDocument()
    expect(within(screen.getByTestId('unmatched')).getAllByRole('link').length).toBeGreaterThanOrEqual(2)
  })

  it('Chat shows a thread with tags and posts a reply', async () => {
    const { data } = renderAt(`/chat/${CHN.billing}/msg_01JB0000000000000000000001`)
    const thread = await screen.findByTestId('thread')
    await within(thread).findByText(/Found it/)
    const box = within(thread).getByLabelText('Message')
    fireEvent.change(box, { target: { value: 'Approved, go ahead' } })
    fireEvent.click(within(thread).getByRole('button', { name: /Send/ }))
    await within(thread).findByText('Approved, go ahead')
    const t = await data.api.thread('msg_01JB0000000000000000000001')
    expect(t.replies.at(-1)!.data.text).toBe('Approved, go ahead')
  })

  it('Usage shows totals and the breakdown table', async () => {
    renderAt('/usage')
    const totals = await screen.findByTestId('usage-totals')
    expect(within(totals).getByText('Tokens')).toBeInTheDocument()
    expect(await screen.findByRole('columnheader', { name: /Total/ })).toBeInTheDocument()
  })

  it('Project detail renders the generated properties form with extension fields', async () => {
    renderAt('/projects/pro_01JB0000000000000000000001')
    const form = await screen.findByTestId('record-form')
    expect(within(form).getByText('Extension fields')).toBeInTheDocument()
    expect(within(form).getByLabelText(/Oncall rotation/)).toHaveValue('payments-primary')
    expect(screen.getByTestId('links-graph')).toBeInTheDocument()
  })

  it('References are picked by name with a typeahead, not typed as ids', async () => {
    const { data } = renderAt(`/records/contact/${CON.ana}`)
    const form = await screen.findByTestId('record-form')
    // Manager shows the name; change it by typing a name.
    expect(await within(form).findByText('Dana Park')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Change Manager' }))
    const box = await within(form).findByLabelText(/Manager/, { selector: 'input' })
    fireEvent.change(box, { target: { value: 'chen' } })
    const option = await within(form).findByRole('option', { name: /Chen Li/ })
    fireEvent.click(option)
    expect(await within(form).findByText('Chen Li')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect((await data.api.getRecord('contact', CON.ana)).data.manager).toBe(CON.chen))
  })

  it('Settings writes secrets without reading them back', async () => {
    const { data } = renderAt('/settings/secrets')
    await screen.findByTestId('secrets')
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'new_token' } })
    fireEvent.change(screen.getByLabelText('Secret value'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }))
    await waitFor(async () => expect((await data.api.secrets()).some((s) => s.name === 'NEW_TOKEN')).toBe(true))
    expect(JSON.stringify(await data.api.secrets())).not.toContain('sk-test')
  })

  it('Inbox lists items', async () => {
    renderAt('/inbox')
    expect((await screen.findAllByTestId('inbox-item')).length).toBe(6)
  })

  it('Inbox marks everything read, and clears', async () => {
    const { data } = renderAt('/inbox')
    await screen.findAllByTestId('inbox-item')
    fireEvent.click(screen.getByRole('button', { name: /Mark all read/ }))
    await waitFor(async () => expect((await data.api.inbox()).every((i) => i.read)).toBe(true))
    expect(screen.getByRole('button', { name: /Mark all read/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument()
    expect(await data.api.inbox()).toEqual([])
  })
})

describe('applyNowEvent', () => {
  it('ignores events for unknown runs', async () => {
    const { api } = createMockDataLayer({ now: Date.now() })
    const snap = await api.now()
    const e = {
      type: 'event',
      channel: 'now',
      topic: 'model.delta',
      payload: { runId: 'run_x', sessionId: 's', content: 'x' },
      at: '',
    } as const
    expect(applyNowEvent(snap, e)).toBe(snap)
  })
  it('adds usage to the run totals', async () => {
    const { api } = createMockDataLayer({ now: Date.now() })
    const snap = await api.now()
    const item = snap.items.find((i) => i.run.data.state === 'running')!
    const next = applyNowEvent(snap, {
      type: 'event',
      channel: 'now',
      topic: 'usage.recorded',
      payload: {
        runId: item.run.id,
        sessionId: item.session.id,
        employeeId: item.employee.id,
        model: 'm',
        usage: { input: 100, output: 10, cached: 50 },
        cost: 0.01,
      },
      at: '',
    })
    const after = next.items.find((i) => i.run.id === item.run.id)!
    expect(after.tokens.total).toBe(item.tokens.total + 110)
    expect(after.tokens.calls).toBe(item.tokens.calls + 1)
  })
})
