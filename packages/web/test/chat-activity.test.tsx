import type { Channel, ChatActivityItem, Message } from '@mp/api'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import {
  addPending,
  applyDone,
  applyItem,
  DELIVERING_MS,
  emptyActivity,
  expectsWork,
  loadItems,
  NOTICE_MS,
  nextExpiry,
  pruneActivity,
  stateText,
  threadActivity,
} from '../src/lib/chat-activity.ts'
import { CHN, createMockDataLayer, EMP, mockId, RUN, SES } from '../src/mock/index.ts'

const T = 'msg_thread'
const item = (over: Partial<ChatActivityItem> = {}): ChatActivityItem => ({
  channelId: 'chn_1',
  threadId: T,
  messageId: T,
  sessionId: 'ses_router',
  employee: { id: 'emp_1', name: 'Meatless', handle: 'meatless' },
  sessionLabel: '@meatless',
  router: true,
  runId: 'run_1',
  state: 'running',
  since: '2026-09-29T10:00:00.000Z',
  ...over,
})
const message = (over: Partial<Message['data']> = {}, id = T): Message => ({
  kind: 'message',
  id,
  version: 1,
  key: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
  data: {
    channelId: 'chn_1',
    threadId: null,
    author: { type: 'person', id: 'con_1', name: 'Ana' },
    text: 'hi',
    tags: [],
    mentions: [],
    ...over,
  },
})
const channel = (over: Partial<Channel['data']> = {}): Channel => ({
  kind: 'channel',
  id: 'chn_1',
  version: 1,
  key: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
  data: { name: 'general', archived: false, createdBy: { type: 'contact', id: 'con_1' }, members: [], ...over },
})

describe('chat activity state', () => {
  it('shows "delivering…" after sending, until any news about the thread', () => {
    let s = addPending(emptyActivity(), message(), 1000)
    expect(threadActivity(s, T).pending).toHaveLength(1)
    s = applyItem(s, item())
    expect(threadActivity(s, T)).toMatchObject({ pending: [], items: [expect.objectContaining({ runId: 'run_1' })] })
    // An outcome answers it too, and a quiet expiry drops it.
    s = addPending(emptyActivity(), message(), 1000)
    expect(applyDone(s, { channelId: 'chn_1', threadId: T, messageId: T, outcome: 'unrouted' }, 2000).pending).toEqual([])
    expect(pruneActivity(s, 1000 + DELIVERING_MS).pending).toEqual([])
    expect(pruneActivity(s, 1500)).toBe(s)
  })

  it('turns outcomes into notices: nothing for a reply, brief hand-off and no-reply notices, lasting failures', () => {
    const s = applyItem(emptyActivity(), item())
    const done = (o: Parameters<typeof applyDone>[1]) => applyDone(s, o, 0)
    const base = {
      channelId: 'chn_1',
      threadId: T,
      messageId: T,
      runId: 'run_1',
      sessionId: 'ses_router',
      employee: item().employee,
    }
    expect(done({ ...base, outcome: 'replied' })).toMatchObject({ items: {}, notices: [] })
    expect(
      done({ ...base, outcome: 'handed_off', handedTo: { sessionId: 'ses_2', sessionLabel: '@meatless#pay-refund' } }).notices,
    ).toEqual([
      expect.objectContaining({ text: 'Handed to @meatless#pay-refund', href: '/sessions/ses_2', until: NOTICE_MS.handed_off }),
    ])
    expect(done({ ...base, outcome: 'no_reply' }).notices).toEqual([
      expect.objectContaining({ text: 'Meatless looked, no reply needed', until: NOTICE_MS.no_reply }),
    ])
    // A subscribed session's run that no message caused says nothing when it had nothing to say.
    expect(done({ ...base, messageId: undefined, outcome: 'no_reply' }).notices).toEqual([])
    const failed = done({ ...base, outcome: 'failed', reason: 'model unavailable' })
    expect(failed.notices).toEqual([
      expect.objectContaining({ text: "Meatless couldn't finish: model unavailable", href: '/sessions/ses_router?tab=runs' }),
    ])
    expect(failed.notices[0]!.until).toBeUndefined()
    expect(nextExpiry(failed)).toBeUndefined()
    expect(done({ channelId: 'chn_1', threadId: T, messageId: T, outcome: 'unrouted' }).notices).toEqual([
      expect.objectContaining({ text: 'Nobody picked this up', hint: 'Tag someone, or post in #requests' }),
    ])
  })

  it('replaces items on load, and describes states', () => {
    const s = loadItems(applyItem(emptyActivity(), item({ runId: 'old' })), [item()])
    expect(Object.keys(s.items)).toEqual(['run_1'])
    expect(stateText(item())).toBe('is working…')
    expect(stateText(item({ state: 'queued' }))).toBe('is queued')
    expect(stateText(item({ state: 'waiting', waitingOn: 'reply' }))).toBe('is waiting on a reply')
    expect(stateText(item({ state: 'paused', pauseReason: 'needs approval' }))).toBe('paused: needs approval')
  })

  it('expects work for tags, routed channels, DMs with an employee and AI threads, not for plain chat', () => {
    const tagged = message({ tags: [{ type: 'employee', id: 'emp_1', text: '@meatless' }] })
    expect(expectsWork(tagged, channel())).toBe(true)
    expect(expectsWork(message(), channel())).toBe(false)
    expect(expectsWork(message(), channel({ contextId: 'ses_ctx' }))).toBe(true)
    expect(expectsWork(message(), channel({ dm: true, members: [{ type: 'employee', id: 'emp_1', label: 'Meatless' }] }))).toBe(
      true,
    )
    const reply = message({ threadId: 'msg_root' }, 'msg_r')
    expect(expectsWork(reply, channel({ contextId: 'ses_ctx' }), { aiInThread: false })).toBe(false)
    expect(expectsWork(reply, channel(), { aiInThread: true })).toBe(true)
  })
})

describe('chat activity in the chat page', () => {
  const realMatchMedia = window.matchMedia
  afterEach(() => {
    window.matchMedia = realMatchMedia
  })

  const renderChat = async (path = `/chat/${CHN.billing}`) => {
    const data = createMockDataLayer({ now: Date.now() })
    render(
      <MemoryRouter initialEntries={[path]}>
        <App data={data} />
      </MemoryRouter>,
    )
    await screen.findAllByTestId('chat-message')
    return data
  }
  const rowsUnder = (messageId: string) => {
    const el = document.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement
    return within(el)
  }

  it('shows who is working under a message, and follows it live to the outcome', async () => {
    const data = await renderChat()
    const root = mockId('msg', 1)
    const row = await rowsUnder(root).findByTestId('activity-row')
    expect(row).toHaveTextContent('Billing Bot')
    expect(row).toHaveTextContent('#pay-123-refund')
    expect(row).toHaveTextContent('is working…')
    expect(row).toHaveTextContent('writing docs')
    expect(row).toHaveAttribute('href', `/sessions/${SES.pay123}`)
    expect(within(row).getByTestId('activity-spinner')).toBeInTheDocument()

    const live: ChatActivityItem = {
      channelId: CHN.billing,
      threadId: root,
      sessionId: SES.pay123,
      employee: { id: EMP.billing, name: 'Billing Bot' },
      sessionLabel: '@billing-bot#pay-123-refund',
      runId: RUN.r2,
      state: 'paused',
      pauseReason: 'needs approval',
      since: new Date().toISOString(),
    }
    act(() => data.live.emit('chat.activity', { channelId: CHN.billing, item: live }))
    await waitFor(() => expect(rowsUnder(root).getByTestId('activity-row')).toHaveTextContent('paused: needs approval'))
    expect(rowsUnder(root).getByTestId('activity-row')).toHaveAttribute('data-state', 'paused')

    act(() =>
      data.live.emit('chat.activity.done', {
        channelId: CHN.billing,
        threadId: root,
        messageId: root,
        runId: RUN.r2,
        sessionId: SES.pay123,
        employee: live.employee,
        outcome: 'failed',
        reason: 'model unavailable',
      }),
    )
    await waitFor(() => expect(rowsUnder(root).queryByTestId('activity-row')).toBeNull())
    const notice = rowsUnder(root).getByTestId('activity-notice')
    expect(notice).toHaveTextContent("Billing Bot couldn't finish: model unavailable")
    expect(notice).toHaveAttribute('href', `/sessions/${SES.pay123}?tab=runs`)
  })

  it('collapses three or more workers into "3 working"', async () => {
    const data = await renderChat()
    const root = mockId('msg', 6)
    const base = {
      channelId: CHN.billing,
      threadId: root,
      employee: { id: EMP.billing, name: 'Billing Bot' },
      state: 'running' as const,
      since: new Date().toISOString(),
    }
    act(() => {
      for (const n of [1, 2, 3])
        data.live.emit('chat.activity', {
          channelId: CHN.billing,
          item: { ...base, sessionId: `ses_${n}`, sessionLabel: `@billing-bot#s-${n}`, runId: `run_x${n}` },
        })
    })
    const collapsed = await rowsUnder(root).findByTestId('activity-collapsed')
    expect(collapsed).toHaveTextContent('3 working')
    fireEvent.click(collapsed)
    expect(rowsUnder(root).getAllByTestId('activity-row')).toHaveLength(3)
  })

  it('says "delivering…" after sending, then who picked it up, and the hand-off', async () => {
    await renderChat()
    const box = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(box, { target: { value: '@billing-bot please check INV-1003', selectionStart: 34 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    const delivering = await screen.findByTestId('activity-delivering')
    expect(delivering).toHaveTextContent('Delivering…')
    const container = delivering.closest('[data-testid="chat-message"]') as HTMLElement
    // The mock's router picks it up: the "delivering…" row is replaced by the worker.
    const row = await within(container).findByTestId('activity-row', {}, { timeout: 3000 })
    expect(row).toHaveTextContent('Billing Bot')
    expect(row).toHaveTextContent('is working…')
    expect(within(container).queryByTestId('activity-delivering')).toBeNull()
    const handed = await within(container).findByText(/Handed to @billing-bot#please-check-inv-1003/, {}, { timeout: 4000 })
    expect(handed).toBeInTheDocument()
    await waitFor(() => expect(within(container).getByTestId('activity-row')).toHaveTextContent('#please-check-inv-1003'))
  }, 10_000)

  it('says nothing for plain chat between people', async () => {
    await renderChat(`/chat/${CHN.inc42}`)
    const box = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(box, { target: { value: 'lunch at noon?', selectionStart: 14 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByText('lunch at noon?')
    expect(screen.queryByTestId('activity-delivering')).toBeNull()
  })

  it('shows a static dot instead of a spinner with reduced motion', async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList
    await renderChat()
    const row = await rowsUnder(mockId('msg', 1)).findByTestId('activity-row')
    expect(within(row).getByTestId('activity-dot')).toBeInTheDocument()
    expect(within(row).queryByTestId('activity-spinner')).toBeNull()
  })
})
