import type { SessionListItem } from '@mp/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { compareSessions, groupSessions } from '../src/lib/session-list.ts'
import { CON, createMockDataLayer, EMP, mockId, PRO } from '../src/mock/index.ts'

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0)

function Probe() {
  const l = useLocation()
  return <div data-testid="location">{l.search}</div>
}

function renderAt(path: string) {
  const data = createMockDataLayer({ now: NOW })
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
      <Probe />
    </MemoryRouter>,
  )
  return { ...utils, data }
}

const search = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '')
const titles = () => screen.queryAllByTestId('session-row').map((r) => r.querySelector('span.truncate')?.textContent ?? '')
const pick = async (combobox: string, option: string | RegExp) => {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }))
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

describe('Sessions list: sort', () => {
  it('sorts rows inside every group, and keeps the sort in the URL', async () => {
    renderAt('/sessions?group=employee')
    await screen.findAllByTestId('session-row')
    const byActivity = titles()
    await pick('Sort', 'Title A–Z')
    await waitFor(() => expect(search().get('sort')).toBe('title'))
    await waitFor(() => expect(titles()).not.toEqual(byActivity))
    // Groups stay in employee-name order; rows inside each follow the title.
    const sections = [...new Set(screen.getAllByTestId('session-row').map((r) => r.closest('section')!))]
    expect(sections.map((s) => within(s).getByRole('heading').textContent)).toEqual([
      expect.stringContaining('Billing Bot'),
      expect.stringContaining('Infra Bot'),
      expect.stringContaining('Support Bot'),
    ])
    for (const s of sections) {
      const t = within(s)
        .getAllByTestId('session-row')
        .map((r) => r.querySelector('span.truncate')!.textContent!)
      expect(t).toEqual([...t].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })))
    }
    await pick('Sort', 'Recent activity')
    await waitFor(() => expect(search().has('sort')).toBe(false))
    await waitFor(() => expect(titles()).toEqual(byActivity))
  })

  it('reads the sort from the URL: oldest first', async () => {
    renderAt('/sessions?group=employee&employee=' + EMP.infra + '&sort=oldest')
    await screen.findAllByTestId('session-row')
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Oldest')
    const newestLast = titles()
    expect(newestLast.at(-1)).not.toBe(newestLast[0])
  })

  it('orders trees by latest activity and rows in a tree by depth', () => {
    const row = (id: string, rootId: string, depth: number, activity: string, title = id): SessionListItem =>
      ({
        session: { id, createdAt: activity, updatedAt: activity, data: { title, rootId, depth, status: 'active' } },
        employee: { id: 'emp_1', name: 'E' },
        runState: null,
        tokens: {},
        children: 0,
        lastActivityAt: activity,
        startedFrom: 'manual',
      }) as unknown as SessionListItem
    const rows = [
      row('a', 'a', 0, '2026-09-01T00:00:00.000Z', 'Old tree'),
      row('b', 'b', 0, '2026-09-02T00:00:00.000Z', 'New tree'),
      row('b2', 'b', 1, '2026-09-03T00:00:00.000Z', 'zeta'),
      row('b3', 'b', 1, '2026-09-02T12:00:00.000Z', 'alpha'),
    ]
    const trees = groupSessions(rows, 'tree', 'title')
    expect(trees.map((g) => g.label)).toEqual(['New tree', 'Old tree'])
    expect(trees[0]!.rows.map((r) => r.session.id)).toEqual(['b', 'b3', 'b2'])
    expect(groupSessions(rows, 'tree', 'activity')[0]!.rows.map((r) => r.session.id)).toEqual(['b', 'b2', 'b3'])
    expect([...rows].sort(compareSessions('oldest')).map((r) => r.session.id)).toEqual(['a', 'b', 'b3', 'b2'])
  })
})

describe('Sessions list: filters', () => {
  it('filters by project and origin through the URL, then clears them', async () => {
    renderAt('/sessions')
    const all = (await screen.findAllByTestId('session-row')).length
    await pick('Project', 'Support Portal')
    await waitFor(() => expect(search().get('project')).toBe(PRO.portal))
    await waitFor(() => expect(screen.getAllByTestId('session-row').length).toBeLessThan(all))
    for (const tag of screen.getAllByTestId('session-project')) expect(tag).toHaveTextContent('Support Portal')
    await pick('Started from', 'Router hand-off')
    await waitFor(() => expect(search().get('origin')).toBe('handoff'))
    await waitFor(() => expect(titles()).toEqual(['Customer asks for a data export']))
    expect(screen.getByTestId('session-count')).toHaveTextContent('1 session')
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(screen.getAllByTestId('session-row')).toHaveLength(all))
    expect(search().has('project')).toBe(false)
    expect(search().has('origin')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('filters by requester and employee from the URL', async () => {
    renderAt(`/sessions?requester=${CON.ana}&employee=${EMP.billing}`)
    await screen.findAllByTestId('session-row')
    expect(await screen.findByRole('button', { name: 'Clear requested by' })).toBeInTheDocument()
    expect(screen.getByTestId('session-filters')).toHaveTextContent('Ana Novak')
    expect(screen.getByRole('combobox', { name: 'Employee' })).toHaveTextContent('Billing Bot')
    expect(titles()).toEqual(expect.arrayContaining(['PAY-123: refund a double charge', 'Refund policy for annual plans']))
    expect(titles()).not.toContain('Customer asks for a data export')
    expect(screen.getAllByTestId('session-requester').length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: 'Clear requested by' }))
    await waitFor(() => expect(search().has('requester')).toBe(false))
    await pick('Employee', 'All employees')
    await waitFor(() => expect(search().get('employee')).toBe('all'))
    await waitFor(() => expect(titles()).toContain('Customer asks for a data export'))
  })

  it('hides finished router contexts unless asked', async () => {
    renderAt('/sessions?origin=router')
    await screen.findAllByTestId('session-row')
    expect(titles()).not.toContain('Router (before instructions v2)')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Hide finished router contexts' }))
    await waitFor(() => expect(search().get('retired')).toBe('1'))
    await waitFor(() => expect(titles()).toContain('Router (before instructions v2)'))
  })

  it('shows an empty state with Clear filters when nothing matches', async () => {
    renderAt(`/sessions?origin=router&project=${PRO.portal}`)
    expect(await screen.findByText('No sessions match these filters.')).toBeInTheDocument()
    const clear = screen.getAllByRole('button', { name: 'Clear filters' })
    await userEvent.click(clear.at(-1)!)
    expect((await screen.findAllByTestId('session-row')).length).toBeGreaterThan(20)
  })

  it('shows last activity with the exact time, and keeps rows 36 px', async () => {
    renderAt('/sessions')
    const row = (await screen.findAllByTestId('session-row'))[0]!
    expect(row.className).toContain('h-9')
    expect(row.querySelector('time')?.getAttribute('dateTime')).toMatch(/^\d{4}-/)
  })
})

describe('Sessions list: mock API', () => {
  it('filters, sorts and derives where sessions came from', async () => {
    const { api } = createMockDataLayer({ now: NOW })
    const def = await api.listSessions({ limit: 500 })
    expect(def.items.some((i) => i.session.id === mockId('ses', 80))).toBe(false)
    expect((await api.listSessions({ excludeRoles: 'none', limit: 500 })).total).toBe(def.total + 1)
    const from = new Set(def.items.map((i) => i.startedFrom))
    expect([...from].sort()).toEqual(['chat', 'handoff', 'manual', 'procedure', 'router', 'session', 'trigger'])
    const chat = await api.listSessions({ origin: 'chat', requesterId: CON.dana })
    expect(chat.items.map((i) => i.session.data.title).sort()).toEqual([
      'How do refunds show up on the portal?',
      'Why did the March invoice double?',
    ])
    const titled = (await api.listSessions({ sort: 'title', employeeId: EMP.support })).items.map((i) => i.session.data.title)
    expect(titled).toEqual([...titled].sort())
    await expect(api.listSessions({ sort: 'nope' as never })).rejects.toThrow(/sort/)
  })
})
