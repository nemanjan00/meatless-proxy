import type { ApiEntry, ApiEvent, ApiRecord, Channel, ContactData, EmployeeData, Message, Run, UsageSeries } from '@mp/api'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { summarizeRun, uncommittedRuns } from '../src/components/recent-runs.tsx'
import {
  applySuggestion,
  channelLabel,
  groupByChannel,
  matchSuggestions,
  mentionAt,
  reactionChips,
  tagCandidates,
  tagExamples,
  upsertMessage,
} from '../src/lib/chat.ts'
import { linkRole, plainDoc } from '../src/lib/doclinks.ts'
import { formatCostOf, unpriced } from '../src/lib/format.ts'
import { routingOutcome } from '../src/lib/routing.ts'
import { labelFor } from '../src/lib/schema-form.ts'
import { bucketLabel, bucketTime, fillRows, fillSeries, intervalFor } from '../src/lib/usage-series.ts'
import { CHN, createMockDataLayer } from '../src/mock/index.ts'

const HOUR = 3_600_000

describe('usage series', () => {
  it('parses server and mock bucket keys', () => {
    expect(bucketTime('2026-09-29T00:00:00.000Z')).toBe(Date.parse('2026-09-29T00:00:00Z'))
    expect(bucketTime('2026-09-29')).toBe(Date.parse('2026-09-29T00:00:00Z'))
    expect(bucketTime('2026-09-29T14:00')).toBe(Date.parse('2026-09-29T14:00:00Z'))
    expect(Number.isNaN(bucketTime('nope'))).toBe(true)
  })

  it('labels days as dates, never raw ISO', () => {
    expect(bucketLabel('2026-09-29T00:00:00.000Z', 'day')).toBe('Sep 29')
    expect(bucketLabel('2026-09-29T14:00:00.000Z', 'hour')).toMatch(/^\d{2}:00$/)
  })

  it('fills every bucket of the range with 0s and keeps the values', () => {
    const series: UsageSeries = {
      interval: 'day',
      keys: [{ key: 'a', label: 'A' }],
      points: [{ t: '2026-09-29T00:00:00.000Z', a: 42 }],
    }
    const until = Date.parse('2026-09-29T12:00:00Z')
    const filled = fillSeries(series, until - 7 * 24 * HOUR, until)
    expect(filled.points).toHaveLength(8)
    expect(filled.points.at(-1)).toEqual({ t: '2026-09-29T00:00:00.000Z', a: 42 })
    expect(filled.points.slice(0, -1).every((p) => p.a === 0)).toBe(true)
    const hours = fillRows([{ key: '2026-09-29T10:00:00.000Z', total: 5 }], 'hour', until - 24 * HOUR, until)
    expect(hours).toHaveLength(25)
    expect(hours.find((r) => r.total === 5)?.key).toBe('2026-09-29T10:00:00.000Z')
  })

  it('picks hours for a day and days for a week', () => {
    expect(intervalFor(24)).toBe('hour')
    expect(intervalFor(24 * 7)).toBe('day')
  })

  it('says when calls were not priced', () => {
    expect(unpriced({ cost: 0, calls: 3 })).toBe(true)
    expect(unpriced({ cost: 0, calls: 0 })).toBe(false)
    expect(formatCostOf({ cost: 0, calls: 3 })).toBe('—')
    expect(formatCostOf({ cost: 1.5, calls: 3 })).toBe('$1.50')
  })
})

const ev = (data: Partial<ApiEvent['data']>): ApiEvent =>
  ({ kind: 'event', id: 'evt_1', data: { source: 'chat', type: 'message.posted', routed: true, ...data } }) as ApiEvent

describe('routing outcome', () => {
  it('tells matched, unmatched (went to a router), and not delivered apart', () => {
    expect(routingOutcome(ev({ routed: false }))).toBe('pending')
    expect(routingOutcome(ev({ matched: ['trigger'], deliveries: 1 }))).toBe('matched')
    expect(routingOutcome(ev({ matched: [], deliveries: 1 }))).toBe('unmatched')
    // A session's own reply: routed, delivered to nobody. Not "unmatched".
    expect(routingOutcome(ev({ matched: [], deliveries: 0 }))).toBe('nowhere')
    // Older servers without `deliveries`, and the mock's explicit fallback.
    expect(routingOutcome(ev({ matched: ['fallback'] }))).toBe('unmatched')
  })
})

const entry = (id: string, kind: string, content: unknown, meta: Record<string, unknown> = {}, parent: string | null = null) =>
  ({ id, kind, content, meta, parent, hash: id, createdAt: '2026-09-29T10:00:00.000Z' }) as unknown as ApiEntry

describe('recent ephemeral runs', () => {
  const run = (id: string, mode: 'ephemeral' | 'continuing', state: Run['data']['state'], createdAt: string, extra = {}) =>
    ({
      kind: 'run',
      id,
      createdAt,
      data: { mode, state, base: 'ent_sys', cause: { type: 'event', eventId: 'evt_1' }, steps: 2, ...extra },
    }) as unknown as Run

  it('lists finished ephemeral runs, newest first', () => {
    const runs = [
      run('run_a', 'ephemeral', 'completed', '2026-09-29T10:00:00Z'),
      run('run_b', 'continuing', 'completed', '2026-09-29T11:00:00Z'),
      run('run_c', 'ephemeral', 'running', '2026-09-29T12:00:00Z'),
      run('run_d', 'ephemeral', 'failed', '2026-09-29T13:00:00Z'),
    ]
    expect(uncommittedRuns(runs).map((r) => r.id)).toEqual(['run_d', 'run_a'])
  })

  it('summarises trigger, event, output and tokens from the run history', () => {
    const r = run('run_a', 'ephemeral', 'completed', '2026-09-29T10:00:00Z', { result: { status: 'completed', output: 'Done.' } })
    const history = [
      entry('ent_sys', 'system', { text: 'You are an employee' }),
      entry(
        'ent_ev',
        'event',
        {
          eventId: 'evt_1',
          source: 'chat',
          type: 'message.posted',
          text: '[chat message.posted thread msg_1]\n#requests: When do payouts run?',
        },
        { reason: 'trigger', triggerId: 'trg_1' },
        'ent_sys',
      ),
      entry('ent_as', 'assistant', { text: 'At 06:00.' }, { usage: { input: 100, output: 20, cached: 0 } }, 'ent_ev'),
    ]
    const s = summarizeRun(r, history, (id) => (id === 'trg_1' ? '#requests: new requests' : undefined))
    expect(s.entries.map((e) => e.id)).toEqual(['ent_ev', 'ent_as'])
    expect(s.trigger).toBe('trigger “#requests: new requests”')
    expect(s.event).toEqual({ label: 'chat · message.posted', text: 'When do payouts run?' })
    expect(s.output).toBe('Done.')
    expect(s.tokens).toBe(120)
    expect(summarizeRun(r, history, undefined, 999).tokens).toBe(999)
  })
})

const rec = <T,>(kind: string, id: string, data: T, key: string | null = null) =>
  ({ kind, id, key, version: 1, data, createdAt: '', updatedAt: '' }) as ApiRecord<T>

describe('chat helpers', () => {
  const employees = [
    rec<EmployeeData>('employee', 'emp_1', { name: 'Research Bot', tools: { allow: [], deny: [] } }, 'research-bot'),
  ]
  const contacts = [
    rec<ContactData>('contact', 'con_me', { name: 'Web Person', kind: 'person', handles: [{ system: 'mp', id: 'web' }] }),
    rec<ContactData>('contact', 'con_2', { name: 'Kim Park', kind: 'person', handles: [{ system: 'mp', id: 'kim' }] }),
    rec<ContactData>('contact', 'con_3', { name: 'No Handle', kind: 'person' }),
    rec<ContactData>('contact', 'con_ai', { name: 'Research Bot', kind: 'ai', handles: [{ system: 'mp', id: 'research-bot' }] }),
  ]
  const sessions = [
    {
      session: rec('session', 'ses_1', {
        title: 'Quarterly report',
        slug: 'quarterly-report',
        employeeId: 'emp_1',
        status: 'active',
      }),
    },
    { session: rec('session', 'ses_2', { title: 'Old', slug: 'old', employeeId: 'emp_1', status: 'done' }) },
  ] as never
  const all = tagCandidates(employees, sessions, contacts, 'con_me')

  it('suggests employees, active sessions and people with a handle, not you', () => {
    expect(all.map((s) => s.insert)).toEqual(['@research-bot', '@research-bot#quarterly-report', '@kim'])
    expect(matchSuggestions(all, 'ki').map((s) => s.insert)).toEqual(['@kim'])
    expect(matchSuggestions(all, 'quart').map((s) => s.insert)).toEqual(['@research-bot#quarterly-report'])
    expect(matchSuggestions(all, 'zzz')).toEqual([])
  })

  it('finds the @ being typed and replaces it', () => {
    expect(mentionAt('hi @ki', 6)).toEqual({ start: 3, query: 'ki' })
    expect(mentionAt('mail a@b', 8)).toBeNull()
    expect(mentionAt('@research-bot#q', 15)).toEqual({ start: 0, query: 'research-bot#q' })
    expect(applySuggestion('hi @ki there', 3, 6, all[2]!)).toEqual({ text: 'hi @kim  there', caret: 8 })
  })

  it('builds hints from real handles only', () => {
    expect(tagExamples(undefined, all)).toEqual(['@research-bot', '@research-bot#session-slug', '@kim'])
    expect(tagExamples(undefined, [])).toEqual([])
  })

  it('names a DM after the others in it', () => {
    const dm = rec('channel', 'chn_1', {
      name: 'dm-abc',
      dm: true,
      archived: false,
      createdBy: { type: 'contact', id: 'con_me' },
      members: [
        { type: 'person', id: 'con_me', label: 'Web Person' },
        { type: 'person', id: 'con_2', label: 'Kim Park' },
      ],
    }) as Channel
    expect(channelLabel(dm, 'con_me')).toBe('Kim Park')
    expect(channelLabel({ ...dm, data: { ...dm.data, dm: false, name: 'ops' } } as Channel, 'con_me')).toBe('ops')
  })

  it('counts reactions, marks yours, and replaces live updates in place', () => {
    const m = rec('message', 'msg_1', {
      text: 'ok?',
      reactions: {
        '✅': [
          { kind: 'contact', id: 'con_me' },
          { kind: 'contact', id: 'con_2' },
        ],
        '👀': [],
      },
      replyCount: 2,
    }) as unknown as Message
    expect(reactionChips(m, { kind: 'contact', id: 'con_me' })).toEqual([{ emoji: '✅', count: 2, mine: true }])
    const updated = { ...m, data: { ...m.data, text: 'ok!', replyCount: undefined } } as unknown as Message
    const list = upsertMessage([m], updated)
    expect(list).toHaveLength(1)
    expect(list[0]!.data.text).toBe('ok!')
    expect(upsertMessage([m], { ...m, id: 'msg_2' })).toHaveLength(2)
  })

  it('groups search hits by channel', () => {
    const hit = (id: string, ch: string) => ({
      message: { id } as Message,
      channel: { id: ch, name: ch, dm: false },
      threadId: id,
    })
    expect(groupByChannel([hit('a', 'x'), hit('b', 'y'), hit('c', 'x')]).map((g) => [g.channel.id, g.hits.length])).toEqual([
      ['x', 2],
      ['y', 1],
    ])
  })
})

describe('labels and links', () => {
  it('drops Id suffixes from field labels', () => {
    expect(labelFor('ownerId')).toBe('Owner')
    expect(labelFor('projectIds')).toBe('Projects')
    expect(labelFor('contextSessionId')).toBe('Context session')
  })

  it('reads links from the other end', () => {
    expect(linkRole({ from: { id: 'ses_child' }, role: 'forked_from' }, 'ses_parent')).toBe('fork')
    expect(linkRole({ from: { id: 'ses_child' }, role: 'forked_from' }, 'ses_child')).toBe('forked from')
    expect(linkRole({ from: { id: 'con_1' }, role: 'owner' }, 'pro_1')).toBe('owner')
  })

  it('turns doc links into names in plain text', () => {
    expect(plainDoc('Ask [[contact:con_01ABCDEFGHJK]] **now**', () => 'Kim')).toBe('Ask Kim now')
    expect(plainDoc('See [[project:pro_01ABCDEFGHJK|Docs]]')).toBe('See Docs')
  })
})

function renderAt(path: string) {
  const data = createMockDataLayer({ now: Date.now() })
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return { ...utils, data }
}

describe('chat page against the mock', () => {
  it('autocompletes tags from real data with the keyboard', async () => {
    renderAt(`/chat/${CHN.billing}`)
    await screen.findAllByTestId('chat-message')
    const box = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(screen.getByTestId('tag-hint').textContent).not.toMatch(/Type @ to tag an employee/))
    fireEvent.change(box, { target: { value: 'please @bil', selectionStart: 11 } })
    const list = await screen.findByTestId('tag-suggestions')
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('@billing-bot')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(box).toHaveValue('please @billing-bot '))
    expect(screen.queryByTestId('tag-suggestions')).toBeNull()
  })

  it('searches messages, grouped by channel, and opens a hit in context', async () => {
    renderAt(`/chat/${CHN.billing}`)
    await screen.findAllByTestId('chat-message')
    fireEvent.keyDown(window, { key: '/' })
    const search = screen.getByRole('textbox', { name: 'Search messages' })
    expect(search).toHaveFocus()
    fireEvent.change(search, { target: { value: 'refund' } })
    const results = await screen.findByTestId('search-results', {}, { timeout: 2000 })
    const hits = within(results).getAllByTestId('search-hit')
    expect(hits.length).toBeGreaterThan(0)
    fireEvent.click(hits[0]!)
    await waitFor(() => expect(screen.queryByTestId('search-results')).toBeNull())
  })

  it('reacts, edits and deletes your own message, live', async () => {
    const { data } = renderAt(`/chat/${CHN.billing}`)
    await screen.findAllByTestId('chat-message')
    const posted = await data.api.postMessage(CHN.billing, { text: 'typo hre' })
    const row = await waitFor(() => {
      const el = document.querySelector(`[data-message-id="${posted.id}"]`) as HTMLElement | null
      if (!el) throw new Error('not yet')
      return el
    })
    await act(async () => {
      await data.api.addReaction(posted.id, '👍')
    })
    const chip = await within(row).findByRole('button', { name: /👍 1, you reacted/ })
    fireEvent.click(chip)
    await waitFor(() => expect(within(row).queryByTestId('reactions')).toBeNull())
    await act(async () => {
      await data.api.editMessage(posted.id, 'typo here')
    })
    await within(row).findByText('(edited)')
    await act(async () => {
      await data.api.deleteMessage(posted.id)
    })
    await within(row).findByTestId('deleted-message')
  })

  it('starts a DM from the New message dialog', async () => {
    const { data } = renderAt(`/chat/${CHN.billing}`)
    await screen.findAllByTestId('chat-message')
    fireEvent.click(screen.getAllByRole('button', { name: 'New message' })[0]!)
    const dialog = await screen.findByTestId('new-message')
    const boxes = within(dialog).getAllByRole('checkbox')
    fireEvent.click(boxes.at(-1)!)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open conversation' }))
    await waitFor(async () => expect((await data.api.channels()).filter((c) => c.channel.data.dm).length).toBeGreaterThan(1))
  })

  it('shows unread badges for channels you are not in', async () => {
    const { data } = renderAt(`/chat/${CHN.billing}`)
    await screen.findAllByTestId('chat-message')
    const unread = await data.api.unread()
    expect(unread.some((u) => u.unread > 0 && u.channelId !== CHN.billing)).toBe(true)
    await waitFor(() => expect(screen.getAllByTestId('unread-badge').length).toBeGreaterThan(0))
  })
})

describe('chat composer', () => {
  it('focuses the message box when the hint row under it is pressed', async () => {
    const { Composer } = await import('../src/components/chat-composer.tsx')
    render(<Composer placeholder="Message #requests" onSend={async () => {}} />)
    const box = screen.getByLabelText('Message')
    expect(document.activeElement).not.toBe(box)
    fireEvent.mouseDown(screen.getByTestId('tag-hint'))
    expect(document.activeElement).toBe(box)
    fireEvent.mouseDown(screen.getByRole('button', { name: /send/i }))
    expect(document.activeElement).toBe(box)
  })
})
