import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { ruleSummary } from '../src/components/webhooks.tsx'
import { createMockDataLayer, EMP } from '../src/mock/index.ts'

function renderAt(path: string) {
  const data = createMockDataLayer({ now: Date.now() })
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return data
}

describe('an employee’s webhooks', () => {
  it('adds one with a rule, shows its secret once, its URL and the rule in a line', async () => {
    const data = renderAt(`/employees/${EMP.billing}`)
    const section = await screen.findByTestId('webhooks')
    expect(within(section).getByText('No webhooks yet.')).toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: 'Add webhook' }))
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'stripe' } })
    fireEvent.change(screen.getByLabelText(/^Event type/), { target: { value: 'type' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rule' }))
    fireEvent.change(screen.getByLabelText('Rule 1 type'), { target: { value: 'invoice.paid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }))
    const status = await within(section).findByRole('status')
    expect(within(status).getByText(/won't be shown again/)).toBeInTheDocument()
    expect(within(status).getByText(/^[0-9a-f]{48}$/)).toBeInTheDocument()
    const row = await within(section).findByTestId('webhook-stripe')
    expect(within(row).getByText('type invoice.paid → ignore')).toBeInTheDocument()
    expect(within(row).getByText(/\/webhooks\/custom\/whk_/)).toBeInTheDocument()
    fireEvent.click(within(status).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(within(section).queryByRole('status')).toBeNull())
    expect((await data.api.webhooks({ employeeId: EMP.billing }))[0]).toMatchObject({ name: 'stripe', mapping: { type: 'type' } })
  })

  it('summarises rules', () => {
    expect(ruleSummary({ field: 'data.status', equals: 'failed', action: { type: 'session', sessionId: 'ses_1' } })).toBe(
      'data.status = failed → to session ses_1',
    )
    expect(ruleSummary({ action: { type: 'router' } })).toBe('anything → to the router')
  })
})
