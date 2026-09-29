import { DEFAULT_NOTIFICATION_PREFS, type InboxItem, type LiveEvent, type NotificationPrefs } from '@mp/api'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { InboxBurstToast, InboxToast } from '@/components/inbox-toast.tsx'
import { useApi, useLive, useLiveReload, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { Burst, inboxHref, isMuted, isViewing, isWarning, playChime, showDesktop, titleWithCount } from '@/lib/notify.ts'

/** The id of the grouped toast. */
export const BURST_TOAST_ID = 'inbox-burst'

export interface Notifications {
  /** The inbox, newest first, kept up to date by the live stream. Undefined while it loads. */
  items: InboxItem[] | undefined
  error: Error | undefined
  unread: number
  reload(): void
  /** Marks items read (or clears the inbox): here at once, on the server, and on your other tabs. */
  markRead(q: { ids?: string[]; clear?: boolean }): void
  prefs: NotificationPrefs
  /** Saves preference changes (on the server, so every device follows them). */
  setPrefs(patch: Partial<NotificationPrefs>): Promise<void>
}

const Ctx = createContext<Notifications | null>(null)

export function useNotifications(): Notifications {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useNotifications outside NotificationsProvider')
  return ctx
}

/**
 * The signed-in person's inbox and live notifications (docs/spec.md#notifications): it subscribes
 * to `person:<contactId>`, adds new items to the inbox, and tells them with a toast (unless they
 * are looking at that channel, thread or session), a quiet sound and a desktop notification while
 * the tab is hidden, as their preferences say. Bursts become one toast. The unread count goes in
 * the document title.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const { me } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const contactId = me?.contactId
  const inbox = useLoad((a) => a.inbox(), [contactId])
  const prefsLoad = useLoad((a) => a.notificationPrefs(), [contactId])
  // Paused runs that resumed leave the inbox: the list is rebuilt when run states change.
  useLiveReload(['now'], inbox.reload, ['run.state'], 600)
  const prefs = prefsLoad.data ?? DEFAULT_NOTIFICATION_PREFS

  const burst = useRef(new Burst())
  /** Items already told about (an item arrives once, but a reconnect or a second tab must not repeat it). */
  const told = useRef(new Set<string>())
  const inboxRef = useRef(inbox.data)
  inboxRef.current = inbox.data
  const ref = useRef({ pathname, prefs })
  ref.current = { pathname, prefs }

  const markRead = useCallback(
    (q: { ids?: string[]; clear?: boolean }) => {
      inbox.setData((prev) =>
        prev ? (q.clear ? [] : prev.map((i) => (q.ids?.includes(i.id) ? { ...i, read: true } : i))) : prev,
      )
      for (const id of q.ids ?? []) toast.dismiss(id)
      api.markInboxRead(q).catch(() => inbox.reload())
    },
    [api, inbox.setData, inbox.reload],
  )

  const open = useCallback(
    (item: InboxItem) => {
      if (!item.read) markRead({ ids: [item.id] })
      toast.dismiss(item.id)
      navigate(inboxHref(item))
    },
    [markRead, navigate],
  )

  const tell = useCallback(
    (item: InboxItem) => {
      const { prefs: p, pathname: path } = ref.current
      if (isMuted(item, p)) return
      const visible = document.visibilityState === 'visible'
      if (visible && isViewing(item, path)) return
      if (p.sound) playChime()
      showDesktop(item, p, () => open(item))
      if (!p.toasts) return
      const b = burst.current.add(item.id)
      if (b.kind === 'single') {
        toast.custom(
          (t) => (
            <InboxToast
              item={item}
              onOpen={() => {
                toast.dismiss(t)
                open(item)
              }}
              onMarkRead={() => {
                toast.dismiss(t)
                markRead({ ids: [item.id] })
              }}
              onClose={() => toast.dismiss(t)}
            />
          ),
          { id: item.id, duration: isWarning(item) ? 10_000 : 6000 },
        )
        return
      }
      for (const id of b.replaces) toast.dismiss(id)
      toast.custom(
        (t) => (
          <InboxBurstToast
            count={b.count}
            onOpen={() => {
              toast.dismiss(t)
              navigate('/inbox')
            }}
            onClose={() => toast.dismiss(t)}
          />
        ),
        { id: BURST_TOAST_ID, duration: 8000 },
      )
    },
    [markRead, navigate, open],
  )

  useLive(
    [contactId ? `person:${contactId}` : null],
    (e: LiveEvent) => {
      if (e.topic === 'inbox.item') {
        const item = e.payload.item
        const known = inboxRef.current?.some((i) => i.id === item.id) || told.current.has(item.id)
        told.current.add(item.id)
        inbox.setData((prev) => [item, ...(prev ?? []).filter((i) => i.id !== item.id)])
        if (!known && !item.read) tell(item)
      } else if (e.topic === 'inbox.read') {
        const { ids, clear } = e.payload
        inbox.setData((prev) => (prev ? (clear ? [] : prev.map((i) => (ids?.includes(i.id) ? { ...i, read: true } : i))) : prev))
        for (const id of ids ?? []) toast.dismiss(id)
        if (clear) toast.dismiss(BURST_TOAST_ID)
      }
    },
    ['inbox.item', 'inbox.read'],
  )

  const unread = inbox.data?.filter((i) => !i.read).length ?? 0
  useEffect(() => {
    document.title = titleWithCount(document.title, unread)
  }, [unread])
  useEffect(() => () => void (document.title = titleWithCount(document.title, 0)), [])

  const setPrefs = useCallback(
    async (patch: Partial<NotificationPrefs>) => {
      const before = prefsLoad.data
      prefsLoad.setData((p) => ({ ...(p ?? DEFAULT_NOTIFICATION_PREFS), ...patch }))
      try {
        prefsLoad.setData(await api.setNotificationPrefs(patch))
      } catch (err) {
        prefsLoad.setData(() => before)
        throw err
      }
    },
    [api, prefsLoad.data, prefsLoad.setData],
  )

  const value = useMemo<Notifications>(
    () => ({ items: inbox.data, error: inbox.error, unread, reload: inbox.reload, markRead, prefs, setPrefs }),
    [inbox.data, inbox.error, unread, inbox.reload, markRead, prefs, setPrefs],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
