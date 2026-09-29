import type { Me } from '@mp/api'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { budgetLabel, buildLimit, capLabel, overrideSummary } from '../src/components/limits-settings.tsx'
import { buildPricing } from '../src/components/pricing-settings.tsx'
import { createMockDataLayer, EMP } from '../src/mock/index.ts'

type Layer = ReturnType<typeof createMockDataLayer>

async function renderAt(path: string, prepare?: (data: Layer) => void) {
  const data = createMockDataLayer({ now: Date.now() })
  prepare?.(data)
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return data
}

const as = (access: Me['access']) => (data: Layer) => {
  data.api.me = async () => ({ contactId: 'con_01JB0000000000000000000001', name: 'Ana Novak', access, via: 'session' })
}

describe('labels', () => {
  it('says each limit in plain language', () => {
    expect(capLabel('maxConcurrentSessions', 8)).toBe('Max 8 runs at once per employee (more wait in the queue)')
    expect(capLabel('maxWallMs', 30 * 60_000)).toBe('A run pauses after 30 minutes of work')
    expect(capLabel('maxDepth', undefined)).toBe('No limit on fork depth')
    expect(budgetLabel({ period: 'day', scope: 'employee' }, 'maxTokens', 5_000_000)).toBe('5M tokens per employee per day')
    expect(budgetLabel({ period: 'day', scope: 'global' }, 'maxCostUsd', 20)).toBe('$20.00 for the whole deployment per day')
    expect(budgetLabel({ period: 'run' }, 'maxTokens', 120_000)).toBe('120k tokens per run')
    expect(overrideSummary({ target: { type: 'contact', id: 'con_1' }, maxTokens: 1000, maxWallMs: null })).toEqual([
      'No limit on how long a run works',
      '1k tokens per requester per day',
    ])
  })

  it('validates an override before it is sent', () => {
    const empty = { text: '', none: false }
    const draft = (over: Record<string, { text: string; none: boolean }> = {}) =>
      ({
        maxConcurrentSessions: empty,
        maxDepth: empty,
        maxFanOut: empty,
        maxSteps: empty,
        maxWallMs: empty,
        maxAiStreak: empty,
        maxTokens: empty,
        maxCostUsd: empty,
        ...over,
      }) as Parameters<typeof buildLimit>[3]
    expect(buildLimit('employees', null, 'day', draft(), true)).toEqual({ error: 'Set at least one limit.' })
    expect(buildLimit('employee', null, 'day', draft({ maxDepth: { text: '2', none: false } }), true)).toEqual({
      error: 'Pick an employee.',
    })
    expect(buildLimit('global', null, 'day', draft({ maxDepth: { text: '-1', none: false } }), true)).toEqual({
      error: 'Fork depth: enter a number of 0 or more.',
    })
    expect(buildLimit('global', null, 'day', draft({ maxDepth: { text: '1.5', none: false } }), true)).toEqual({
      error: 'Fork depth: enter a whole number.',
    })
    expect(buildLimit('global', null, 'day', draft({ maxConcurrentSessions: { text: '0', none: false } }), true)).toEqual({
      error: 'Runs at once: at least 1.',
    })
    expect(
      buildLimit(
        'contact',
        'con_1',
        'month',
        draft({
          maxWallMs: { text: '45', none: false },
          maxTokens: { text: '2000', none: false },
          maxSteps: { text: '', none: true },
        }),
        true,
      ),
    ).toEqual({
      data: { target: { type: 'contact', id: 'con_1' }, maxSteps: null, maxWallMs: 2_700_000, maxTokens: 2000, period: 'month' },
    })
  })

  it('validates prices before they are sent', () => {
    const row = (model: string, input: string, output: string, cached = '') => ({ model, input, output, cached })
    expect(buildPricing([row('m', '1', '2', '0.5'), row('', '', '')])).toEqual({
      pricing: { m: { inputPerM: 1, outputPerM: 2, cachedInputPerM: 0.5 } },
    })
    expect(buildPricing([row('m', '1', '')])).toEqual({ error: 'm: enter the output price.' })
    expect(buildPricing([row('m', 'x', '1')])).toEqual({ error: 'm: the input price must be a number of 0 or more.' })
    expect(buildPricing([row('m', '1', '1'), row('m', '1', '1')])).toEqual({ error: 'm is listed twice.' })
    expect(buildPricing([row('', '1', '1')])).toEqual({ error: 'Every price needs a model name.' })
  })
})

describe('Settings → Limits', () => {
  it('shows the effective limits per scope, with usage against budgets and the unpriced models', async () => {
    await renderAt('/settings/limits')
    const every = await screen.findByTestId('limits-scope-all')
    expect(within(every).getByText('Max 8 runs at once per employee (more wait in the queue)')).toBeInTheDocument()
    expect(within(every).getByText('A run pauses after 30 minutes of work')).toBeInTheDocument()
    expect(within(every).getByText('5M tokens per employee per day')).toBeInTheDocument()
    expect(within(every).getByText('30M tokens for the whole deployment per day')).toBeInTheDocument()
    expect(within(every).getAllByTestId('budget-bar').length).toBe(1)
    const billing = screen.getByTestId(`limits-scope-${EMP.billing}`)
    expect(within(billing).getByText('Max 12 runs at once per employee (more wait in the queue)')).toBeInTheDocument()
    expect(within(billing).getByText('8M tokens per employee per day')).toBeInTheDocument()
    expect(within(billing).getByTestId('budget-bar')).toBeInTheDocument()
    expect(within(screen.getByTestId('unpriced-note')).getByRole('link', { name: 'Set prices' })).toHaveAttribute(
      'href',
      '/settings/pricing',
    )
  })

  it('creates, edits and deletes an override, and refuses bad values', async () => {
    const data = await renderAt('/settings/limits')
    await screen.findByTestId('limits-scope-all')
    await userEvent.click(screen.getByRole('button', { name: 'Add override' }))
    const dialog = await screen.findByTestId('limit-editor')
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Applies to' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Every employee' }))
    fireEvent.change(within(dialog).getByLabelText('Children per loop'), { target: { value: '-3' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add override' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Children per loop: enter a number of 0 or more.')
    fireEvent.change(within(dialog).getByLabelText('Children per loop'), { target: { value: '' } })
    fireEvent.change(within(dialog).getByLabelText('Runs at once'), { target: { value: '3' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add override' }))
    await waitFor(() => expect(screen.queryByTestId('limit-editor')).not.toBeInTheDocument())
    const created = [...data.api.db.records.get('limit')!.values()].find(
      (l) => (l.data as { target: { type: string; id?: string } }).target.type === 'employee' && !(l.data as any).target.id,
    )
    expect(created?.data).toEqual({ target: { type: 'employee' }, maxConcurrentSessions: 3 })
    const overrides = await screen.findByTestId('limit-overrides')
    await waitFor(() =>
      expect(within(overrides).getByText('Max 3 runs at once per employee (more wait in the queue)')).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(
        within(screen.getByTestId('limits-scope-all')).getByText('Max 3 runs at once per employee (more wait in the queue)'),
      ).toBeInTheDocument(),
    )

    // Edit: no limit on runs at once.
    await userEvent.click(within(overrides).getAllByRole('button', { name: 'Edit Every employee' })[0]!)
    const edit = await screen.findByTestId('limit-editor')
    expect(within(edit).getByLabelText('Runs at once')).toHaveValue('3')
    await userEvent.click(within(edit).getByRole('checkbox', { name: 'No limit: Runs at once' }))
    await userEvent.click(within(edit).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(data.api.db.records.get('limit')!.get(created!.id)!.data).toEqual({
        target: { type: 'employee' },
        maxConcurrentSessions: null,
      }),
    )

    // Delete: the default applies again.
    await userEvent.click(
      within(await screen.findByTestId('limit-overrides')).getAllByRole('button', { name: 'Delete Every employee' })[0]!,
    )
    await waitFor(() => expect(data.api.db.records.get('limit')!.has(created!.id)).toBe(false))
    await waitFor(() =>
      expect(
        within(screen.getByTestId('limits-scope-all')).getByText('Max 8 runs at once per employee (more wait in the queue)'),
      ).toBeInTheDocument(),
    )
  })

  it('is for admins only', async () => {
    await renderAt('/settings/limits', as('member'))
    expect(await screen.findByText('Only admins can see this.')).toBeInTheDocument()
    expect(screen.queryByTestId('limits-settings')).not.toBeInTheDocument()
  })
})

describe('Settings → Pricing', () => {
  it('lists the models in use, and a price set here applies', async () => {
    const data = await renderAt('/settings/pricing')
    const models = await screen.findByTestId('pricing-models')
    const k3 = within(models).getByText('k3').parentElement!
    expect(within(k3).getByText('no pricing configured')).toBeInTheDocument()
    expect(within(within(models).getByText('kimi-k2-7-code').parentElement!).getByText('built-in')).toBeInTheDocument()
    await userEvent.click(within(k3).getByRole('button', { name: 'Set a price' }))
    const editor = screen.getByTestId('pricing-editor')
    expect(within(editor).getByLabelText('Model 1')).toHaveValue('k3')
    fireEvent.change(within(editor).getByLabelText('Input price of k3'), { target: { value: '2' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save prices' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('k3: enter the output price.')
    fireEvent.change(within(editor).getByLabelText('Output price of k3'), { target: { value: '8' } })
    fireEvent.change(within(editor).getByLabelText('Cached input price of k3'), { target: { value: '0.2' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save prices' }))
    await waitFor(async () =>
      expect((await data.api.pricing()).custom).toEqual({ k3: { inputPerM: 2, outputPerM: 8, cachedInputPerM: 0.2 } }),
    )
    await waitFor(() =>
      expect(
        within(within(screen.getByTestId('pricing-models')).getByText('k3').parentElement!).getByText('set here'),
      ).toBeInTheDocument(),
    )
  })

  it('the usage page links a missing price to the editor', async () => {
    await renderAt('/usage', (d) => {
      d.api.db.usage = d.api.db.usage.map((u) => ({ ...u, cost: 0 }))
    })
    // The usage page renders charts first; slow CI machines need more than the default second.
    const link = await screen.findByRole('link', { name: 'set prices' }, { timeout: 5000 })
    expect(link).toHaveAttribute('href', '/settings/pricing')
  })
})
