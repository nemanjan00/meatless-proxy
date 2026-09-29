import type { Me } from '@mp/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/app.tsx'
import { cronOf, formOfCron, untilPhrase } from '../src/lib/schedules.ts'
import { CON, SES, createMockDataLayer } from '../src/mock/index.ts'
import { mockDescribe, mockNext } from '../src/mock/schedules.ts'

type Layer = ReturnType<typeof createMockDataLayer>

function renderAt(path: string, tweak?: (data: Layer) => void) {
  const data = createMockDataLayer({ now: Date.now() })
  tweak?.(data)
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return { ...utils, data }
}

const as =
  (access: Me['access'], contactId: string = CON.ana) =>
  (data: Layer) => {
    data.api.me = async () => ({ contactId, name: 'Ana Novak', access, via: 'session' })
  }
const rows = () => screen.queryAllByTestId('schedule-row')
const rowOf = (text: string) => rows().find((r) => within(r).queryByText(text, { exact: false }))!

describe('schedule helpers', () => {
  it('builds cron from the form and reads it back', () => {
    const base = { time: '09:30', weekday: 5, monthDay: 1, cron: '' }
    expect(cronOf({ ...base, preset: 'weekday' })).toBe('30 9 * * 1-5')
    expect(cronOf({ ...base, preset: 'day' })).toBe('30 9 * * *')
    expect(cronOf({ ...base, preset: 'week' })).toBe('30 9 * * 5')
    expect(cronOf({ ...base, preset: 'month', monthDay: 15 })).toBe('30 9 15 * *')
    expect(cronOf({ ...base, preset: 'hour' })).toBe('0 * * * *')
    expect(cronOf({ ...base, preset: 'cron', cron: ' 0 12 * * 2 ' })).toBe('0 12 * * 2')
    expect(cronOf({ ...base, preset: 'day', time: '' })).toBeNull()
    expect(formOfCron('30 9 * * 1-5')).toMatchObject({ preset: 'weekday', time: '09:30' })
    expect(formOfCron('0 16 * * 5')).toMatchObject({ preset: 'week', weekday: 5, time: '16:00' })
    expect(formOfCron('0 8 1 * *')).toMatchObject({ preset: 'month', monthDay: 1 })
    expect(formOfCron('*/5 * * * *')).toMatchObject({ preset: 'cron', cron: '*/5 * * * *' })
    const now = Date.parse('2026-09-29T09:00:00Z')
    expect(untilPhrase('2026-09-29T09:20:00Z', now)).toBe('in 20m')
    expect(untilPhrase('2026-09-29T14:00:00Z', now)).toBe('in 5h')
    expect(untilPhrase('2026-10-03T09:00:00Z', now)).toBe('in 4d')
    expect(untilPhrase(null, now)).toBe('—')
  })

  it('the mock describes and previews like the server', () => {
    expect(mockDescribe({ type: 'cron', cron: '0 9 * * 1-5' }, 'UTC')).toBe('every weekday 09:00 UTC')
    expect(mockDescribe({ type: 'cron', cron: '0 16 * * 5' }, 'UTC')).toBe('every Friday 16:00 UTC')
    expect(mockNext({ type: 'cron', cron: '0 9 * * 1-5' }, Date.parse('2026-10-02T10:00:00Z'), 2)).toEqual([
      '2026-10-05T09:00:00.000Z',
      '2026-10-06T09:00:00.000Z',
    ])
  })
})

describe('Schedules page', () => {
  it('lists tasks and follow-ups by group, in words, with the last run linked to its session', async () => {
    renderAt('/schedules')
    await waitFor(() => expect(rows().length).toBe(6))
    const upcoming = screen.getByTestId('schedule-group-upcoming')
    expect(within(upcoming).getByText(/weekly invoice summary/)).toBeInTheDocument()
    expect(within(upcoming).getByText('every Friday 14:00 Europe/Belgrade')).toBeInTheDocument()
    expect(within(upcoming).getByText('every weekday 07:00 Europe/Belgrade')).toBeInTheDocument()
    expect(within(upcoming).getByText(/Check CI on !481/)).toBeInTheDocument()
    expect(within(screen.getByTestId('schedule-group-paused')).getByText(/CSV for finance/)).toBeInTheDocument()
    expect(within(screen.getByTestId('schedule-group-finished')).getByText(/vendor call/)).toBeInTheDocument()
    const weekly = rowOf('weekly invoice summary')
    expect(within(weekly).getByText('→ #billing')).toBeInTheDocument()
    expect(within(weekly).getByTestId('last-run').closest('a')).toHaveAttribute('href', `/sessions/${SES.billingIntake}`)
    expect(within(rowOf('Triage new PAY')).getByRole('img', { name: 'Failed' })).toBeInTheDocument()
    expect(within(rowOf('rotate the staging')).getByText(/next in 3h/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Follow-ups' }))
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('Check CI on !481')])
  })

  it('runs now, pauses and resumes, and deletes after asking', async () => {
    const { data } = renderAt('/schedules')
    await waitFor(() => expect(rows().length).toBe(6))
    const run = vi.spyOn(data.api, 'runSchedule')
    await userEvent.click(within(rowOf('weekly invoice summary')).getByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(rowOf('weekly invoice summary')).getByRole('img', { name: 'Queued' })).toBeInTheDocument())
    // A follow-up can't be run now.
    expect(within(rowOf('Check CI on !481')).queryByRole('button', { name: 'Run now' })).toBeNull()

    await userEvent.click(within(rowOf('weekly invoice summary')).getByRole('button', { name: 'Pause' }))
    await waitFor(() =>
      expect(within(screen.getByTestId('schedule-group-paused')).getByText(/weekly invoice summary/)).toBeInTheDocument(),
    )
    await userEvent.click(within(rowOf('weekly invoice summary')).getByRole('button', { name: 'Resume' }))
    await waitFor(() =>
      expect(within(screen.getByTestId('schedule-group-upcoming')).getByText(/weekly invoice summary/)).toBeInTheDocument(),
    )

    await userEvent.click(within(rowOf('rotate the staging')).getByRole('button', { name: 'Delete' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(rows().length).toBe(5))
    expect(screen.queryByText(/rotate the staging/)).toBeNull()
  })

  it('creates a recurring task with a preset, previewing when it runs', async () => {
    renderAt('/schedules')
    await waitFor(() => expect(rows().length).toBe(6))
    await userEvent.click(screen.getByRole('button', { name: /New scheduled task/ }))
    const dialog = await screen.findByTestId('schedule-dialog')
    await userEvent.type(within(dialog).getByLabelText(/Instruction/), 'Summarise yesterday’s refunds')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Recurring' }))
    await userEvent.selectOptions(within(dialog).getByLabelText('Repeat'), 'day')
    const time = within(dialog).getByLabelText('Time')
    await userEvent.clear(time)
    await userEvent.type(time, '08:15')
    const tz = within(dialog).getByLabelText(/Time zone/)
    await userEvent.clear(tz)
    await userEvent.type(tz, 'UTC')
    await waitFor(() => expect(within(dialog).getByTestId('schedule-preview')).toHaveTextContent('every day 08:15 UTC'))
    expect(within(dialog).getByTestId('schedule-preview')).toHaveTextContent('Next:')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))
    await waitFor(() => expect(rows().length).toBe(7))
    expect(within(rowOf('yesterday’s refunds')).getByTestId('schedule-when')).toHaveTextContent('every day 08:15 UTC')
  })

  it('creates a one-off, and shows why a bad cron is refused', async () => {
    renderAt('/schedules')
    await waitFor(() => expect(rows().length).toBe(6))
    await userEvent.click(screen.getByRole('button', { name: /New scheduled task/ }))
    const dialog = await screen.findByTestId('schedule-dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Recurring' }))
    await userEvent.selectOptions(within(dialog).getByLabelText('Repeat'), 'cron')
    await userEvent.type(within(dialog).getByLabelText(/Cron/), 'every tuesday')
    await waitFor(() => expect(within(dialog).getByTestId('schedule-preview')).toHaveTextContent(/can't read/))
    // Without an instruction it isn't sent.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Once' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Write what the employee should do.')
    await userEvent.type(within(dialog).getByLabelText(/Instruction/), 'Ping Bob about the offsite')
    await waitFor(() => expect(within(dialog).getByTestId('schedule-preview')).toHaveTextContent(/^once, /))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))
    await waitFor(() => expect(rows().length).toBe(7))
    const row = rowOf('Ping Bob about the offsite')
    expect(within(row).getByText(/next in/)).toBeInTheDocument()
  })

  it('members manage only what they asked for; viewers only look', async () => {
    renderAt('/schedules', as('member'))
    await waitFor(() => expect(rows().length).toBe(6))
    // Ana asked for the weekly summary and the CI follow-up, not Bob's triage.
    expect(within(rowOf('weekly invoice summary')).queryByTestId('schedule-actions')).not.toBeNull()
    expect(within(rowOf('Check CI on !481')).queryByTestId('schedule-actions')).not.toBeNull()
    expect(within(rowOf('Triage new PAY')).queryByTestId('schedule-actions')).toBeNull()
    expect(screen.getByRole('button', { name: /New scheduled task/ })).toBeInTheDocument()
  })

  it('viewers see the list without actions or a New button', async () => {
    renderAt('/schedules', as('viewer', CON.bob))
    await waitFor(() => expect(rows().length).toBe(6))
    expect(screen.queryAllByTestId('schedule-actions')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /New scheduled task/ })).toBeNull()
  })

  it('is in the sidebar next to Triggers', async () => {
    renderAt('/now')
    const link = await screen.findByRole('link', { name: 'Schedules' })
    expect(link).toHaveAttribute('href', '/schedules')
  })
})
