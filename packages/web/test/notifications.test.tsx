import type { InboxItem } from '@mp/api'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/app.tsx'
import { Burst, desktopContent, isViewing, placeOf, titleWithCount } from '../src/lib/notify.ts'
import { CHN, createMockDataLayer, mockId } from '../src/mock/index.ts'

type Layer = ReturnType<typeof createMockDataLayer>

let where = ''
function Where() {
  where = useLocation().pathname
  return null
}

async function renderAt(path: string, prepare?: (data: Layer) => Promise<void> | void) {
  const data = createMockDataLayer({ now: Date.now() })
  await prepare?.(data)
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
      <Where />
    </MemoryRouter>,
  )
  await screen.findByTestId('badge-inbox')
  return data
}

const unreadIn = (data: Layer) => data.api.db.inbox.filter((i) => !i.read).length
const badge = () => screen.getByTestId('badge-inbox').textContent

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

/** A stand-in for the browser's Notification API. */
class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static next: NotificationPermission = 'granted'
  static made: FakeNotification[] = []
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = FakeNotification.next
    return FakeNotification.next
  })
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.made.push(this)
  }
}

beforeEach(() => {
  document.title = 'meatless-proxy'
  setVisibility('visible')
  FakeNotification.permission = 'granted'
  FakeNotification.next = 'granted'
  FakeNotification.made = []
  FakeNotification.requestPermission.mockClear()
  ;(globalThis as { Notification?: unknown }).Notification = FakeNotification
})
afterEach(async () => {
  delete (globalThis as { Notification?: unknown }).Notification
  // Sonner's store is global: drop this test's toasts before the next one renders.
  act(() => {
    toast.dismiss()
  })
  await new Promise((r) => setTimeout(r, 450))
})

describe('live notifications', () => {
  it('toasts a new item with who, where and what, and Open marks it read and goes there', async () => {
    const data = await renderAt('/now')
    let item!: InboxItem
    act(() => {
      item = data.notifier.push()
    })
    const t = await screen.findByTestId('inbox-toast')
    expect(within(t).getByText('Infra Bot')).toBeInTheDocument()
    expect(within(t).getByText('AI')).toBeInTheDocument()
    expect(within(t).getByText('#inc-42-staging-disk')).toBeInTheDocument()
    expect(within(t).getByText(/Disk on staging-eu-1/)).toBeInTheDocument()
    expect(t).not.toHaveAttribute('data-warning')
    fireEvent.click(within(t).getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(where).toBe(`/chat/${CHN.inc42}/${mockId('msg', 20)}`))
    expect(data.api.db.inbox.find((i) => i.id === item.id)?.read).toBe(true)
  })

  it('Mark read marks it read without leaving the page', async () => {
    const data = await renderAt('/now')
    let item!: InboxItem
    act(() => {
      item = data.notifier.push()
    })
    const before = unreadIn(data)
    await waitFor(() => expect(badge()).toBe(String(before)))
    fireEvent.click(within(await screen.findByTestId('inbox-toast')).getByRole('button', { name: 'Mark read' }))
    await waitFor(() => expect(badge()).toBe(String(before - 1)))
    expect(data.api.db.inbox.find((i) => i.id === item.id)?.read).toBe(true)
    expect(where).toBe('/now')
  })

  it("doesn't toast while you look at that thread or channel, but still counts it", async () => {
    const data = await renderAt(`/chat/${CHN.inc42}/${mockId('msg', 20)}`)
    const before = unreadIn(data)
    act(() => {
      data.notifier.push()
    })
    await waitFor(() => expect(badge()).toBe(String(before + 1)))
    expect(screen.queryByTestId('inbox-toast')).toBeNull()
  })

  it('toasts the thread you look at when the tab is in the background', async () => {
    const data = await renderAt(`/chat/${CHN.inc42}`)
    setVisibility('hidden')
    act(() => {
      data.notifier.push()
    })
    expect(await screen.findByTestId('inbox-toast')).toBeInTheDocument()
  })

  it('groups a burst into one toast with Open inbox', async () => {
    const data = await renderAt('/now')
    act(() => {
      for (let i = 0; i < 5; i++) data.notifier.push()
    })
    const burst = await screen.findByTestId('inbox-burst-toast')
    expect(within(burst).getByText('5 new notifications')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryAllByTestId('inbox-toast')).toHaveLength(0))
    fireEvent.click(within(burst).getByRole('button', { name: 'Open inbox' }))
    await waitFor(() => expect(where).toBe('/inbox'))
  })

  it('gives paused runs the warning style', async () => {
    const data = await renderAt('/now')
    act(() => {
      data.notifier.push({
        type: 'paused_run',
        title: 'Paused: PAY-9',
        detail: 'token limit',
        channelId: undefined,
        channel: undefined,
        author: undefined,
      })
    })
    expect(await screen.findByTestId('inbox-toast')).toHaveAttribute('data-warning', 'true')
  })

  it('updates the badge and the title live, from new items and from reads on other tabs', async () => {
    const data = await renderAt('/now')
    const before = unreadIn(data)
    await waitFor(() => expect(document.title).toMatch(new RegExp(`^\\(${before}\\) `)))
    let item!: InboxItem
    act(() => {
      item = data.notifier.push()
    })
    await waitFor(() => expect(badge()).toBe(String(before + 1)))
    expect(document.title).toMatch(new RegExp(`^\\(${before + 1}\\) `))
    // Another tab marks it read: the server's inbox.read reaches this one.
    await act(() => data.api.markInboxRead({ ids: [item.id] }))
    await waitFor(() => expect(badge()).toBe(String(before)))
    await act(() => data.api.markInboxRead({ clear: true }))
    await waitFor(() => expect(screen.queryByTestId('badge-inbox')).toBeNull())
    expect(document.title).not.toMatch(/^\(\d+\)/)
  })

  it("doesn't toast a muted channel, but counts it", async () => {
    const data = await renderAt('/now', (d) => d.api.setNotificationPrefs({ mutedChannels: [CHN.inc42] }).then(() => {}))
    const before = unreadIn(data)
    act(() => {
      data.notifier.push()
    })
    await waitFor(() => expect(badge()).toBe(String(before + 1)))
    expect(screen.queryByTestId('inbox-toast')).toBeNull()
  })

  it("doesn't toast with toasts turned off", async () => {
    const data = await renderAt('/now', (d) => d.api.setNotificationPrefs({ toasts: false }).then(() => {}))
    const before = unreadIn(data)
    act(() => {
      data.notifier.push()
    })
    await waitFor(() => expect(badge()).toBe(String(before + 1)))
    expect(screen.queryByTestId('inbox-toast')).toBeNull()
  })

  it('shows a desktop notification only while the tab is hidden, and a click opens the item', async () => {
    const data = await renderAt('/now', (d) => d.api.setNotificationPrefs({ desktop: true }).then(() => {}))
    act(() => {
      data.notifier.push()
    })
    await screen.findByTestId('inbox-toast')
    expect(FakeNotification.made).toHaveLength(0)

    setVisibility('hidden')
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    let item!: InboxItem
    act(() => {
      item = data.notifier.push({ id: 'mention:hidden', channelId: CHN.billing, threadId: mockId('msg', 1) })
    })
    await waitFor(() => expect(FakeNotification.made).toHaveLength(1))
    const n = FakeNotification.made[0]!
    expect(n.title).toBe('Bob Smith · #billing › thread')
    expect(n.options.body).toContain('The customer already confirmed')
    act(() => n.onclick!())
    expect(focus).toHaveBeenCalled()
    await waitFor(() => expect(where).toBe(`/chat/${CHN.billing}/${mockId('msg', 1)}`))
    expect(data.api.db.inbox.find((i) => i.id === item.id)?.read).toBe(true)
  })

  it('hides DM text in desktop notifications when asked to', async () => {
    const data = await renderAt('/now', (d) => d.api.setNotificationPrefs({ desktop: true, hideDmText: true }).then(() => {}))
    setVisibility('hidden')
    act(() => {
      data.notifier.push()
      data.notifier.push()
      data.notifier.push() // the DM example
    })
    await waitFor(() => expect(FakeNotification.made).toHaveLength(3))
    const dm = FakeNotification.made[2]!
    expect(dm.title).toBe('Billing Bot · DM')
    expect(dm.options.body).toBe('New direct message')
    expect(FakeNotification.made[0]!.options.body).toContain('Disk on staging-eu-1')
  })

  it("never shows a desktop notification when they're off or not permitted", async () => {
    const data = await renderAt('/now', (d) => d.api.setNotificationPrefs({ desktop: true }).then(() => {}))
    setVisibility('hidden')
    FakeNotification.permission = 'denied'
    act(() => {
      data.notifier.push()
    })
    await screen.findByTestId('inbox-toast')
    expect(FakeNotification.made).toHaveLength(0)
  })
})

describe('Settings › Notifications', () => {
  it('saves toggles and muted channels on the server', async () => {
    const data = await renderAt('/settings/notifications')
    const box = await screen.findByTestId('notification-settings')
    fireEvent.click(within(box).getByRole('switch', { name: /^Sound/ }))
    await waitFor(async () => expect((await data.api.notificationPrefs()).sound).toBe(true))
    fireEvent.click(within(box).getByRole('switch', { name: /^Hide DM text/ }))
    await waitFor(async () => expect((await data.api.notificationPrefs()).hideDmText).toBe(true))

    fireEvent.click(within(box).getByRole('button', { name: /Mute a channel/ }))
    fireEvent.click(await screen.findByRole('option', { name: /#billing/ }))
    await waitFor(async () => expect((await data.api.notificationPrefs()).mutedChannels).toEqual([CHN.billing]))
    const muted = await screen.findByTestId('muted-channels')
    expect(within(muted).getByText('#billing')).toBeInTheDocument()
    fireEvent.click(within(muted).getByRole('button', { name: 'Unmute #billing' }))
    await waitFor(async () => expect((await data.api.notificationPrefs()).mutedChannels).toEqual([]))
  })

  it('asks for permission to turn desktop notifications on, and explains a refusal', async () => {
    FakeNotification.permission = 'default'
    FakeNotification.next = 'denied'
    const data = await renderAt('/settings/notifications')
    const box = await screen.findByTestId('notification-settings')
    const sw = within(box).getByRole('switch', { name: /^Desktop notifications/ })
    fireEvent.click(sw)
    await waitFor(() => expect(within(box).getByTestId('desktop-hint')).toHaveTextContent(/blocks notifications/))
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect((await data.api.notificationPrefs()).desktop).toBe(false)
    expect(sw).toHaveAttribute('aria-checked', 'false')

    FakeNotification.permission = 'default'
    FakeNotification.next = 'granted'
    fireEvent.click(sw)
    await waitFor(async () => expect((await data.api.notificationPrefs()).desktop).toBe(true))
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
  })
})

describe('notification helpers', () => {
  const item = (over: Partial<InboxItem> = {}): InboxItem => ({
    id: 'mention:1',
    type: 'mention',
    title: 'Bob mentioned you',
    at: new Date(0).toISOString(),
    read: false,
    channelId: 'chn_1',
    threadId: 'msg_1',
    channel: { id: 'chn_1', name: 'billing', dm: false },
    ...over,
  })

  it('knows when you are looking at an item', () => {
    expect(isViewing(item(), '/chat/chn_1')).toBe(true)
    expect(isViewing(item(), '/chat/chn_1/msg_1')).toBe(true)
    expect(isViewing(item(), '/chat/chn_2')).toBe(false)
    expect(isViewing(item({ channelId: undefined, sessionId: 'ses_1' }), '/sessions/ses_1')).toBe(true)
    expect(isViewing(item(), '/inbox')).toBe(false)
  })

  it('names the place', () => {
    expect(placeOf(item())).toBe('#billing')
    expect(placeOf(item({ type: 'reply' }))).toBe('#billing › thread')
    expect(placeOf(item({ type: 'dm', channel: { id: 'c', name: 'Bob', dm: true } }))).toBe('DM')
  })

  it('puts the count in the title once', () => {
    expect(titleWithCount('meatless-proxy', 3)).toBe('(3) meatless-proxy')
    expect(titleWithCount('(3) meatless-proxy', 4)).toBe('(4) meatless-proxy')
    expect(titleWithCount('(4) meatless-proxy', 0)).toBe('meatless-proxy')
    expect(titleWithCount('x', 250)).toBe('(99+) x')
  })

  it('groups more than three items within ten seconds', () => {
    let now = 0
    const b = new Burst(() => now)
    expect(b.add('a').kind).toBe('single')
    now += 1000
    expect(b.add('b').kind).toBe('single')
    expect(b.add('c').kind).toBe('single')
    expect(b.add('d')).toEqual({ kind: 'group', count: 4, replaces: ['a', 'b', 'c'] })
    expect(b.add('e')).toEqual({ kind: 'group', count: 5, replaces: [] })
    now += 11_000
    expect(b.add('f').kind).toBe('single')
    // Spread out, they stay single.
    const c = new Burst(() => now)
    for (let i = 0; i < 6; i++) {
      now += 4000
      expect(c.add(String(i)).kind).toBe('single')
    }
  })

  it('never puts DM text in a desktop notification with hideDmText', () => {
    const dm = item({ type: 'dm', detail: 'secret plans', channel: { id: 'c', name: 'Bob', dm: true } })
    expect(desktopContent(dm, { hideDmText: true }).body).toBe('New direct message')
    expect(desktopContent(dm, { hideDmText: false }).body).toBe('secret plans')
    // A mention inside a DM is DM text too.
    expect(desktopContent({ ...dm, type: 'mention' }, { hideDmText: true }).body).toBe('New direct message')
  })
})
