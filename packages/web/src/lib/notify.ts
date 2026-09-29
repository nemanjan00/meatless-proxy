import type { InboxItem, NotificationPrefs } from '@mp/api'

/** More than `max` items within `windowMs` become one grouped toast. */
export const BURST = { max: 3, windowMs: 10_000 }

/** Where an inbox item opens. */
export function inboxHref(i: InboxItem): string {
  if (i.channelId && i.threadId) return `/chat/${i.channelId}/${i.threadId}`
  if (i.sessionId) return `/sessions/${i.sessionId}`
  return '/usage'
}

/** Whether the page at `pathname` already shows the item: its channel, its thread or its session. */
export function isViewing(i: InboxItem, pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '')
  if (i.channelId && (path === `/chat/${i.channelId}` || path.startsWith(`/chat/${i.channelId}/`))) return true
  return !!i.sessionId && path === `/sessions/${i.sessionId}`
}

/** Where it happened, in one short line: `#billing › thread`, `DM` or the session. */
export function placeOf(i: InboxItem): string {
  if (i.channel?.dm) return 'DM'
  if (i.channel)
    return i.threadId && i.type !== 'mention' && i.type !== 'alert' ? `#${i.channel.name} › thread` : `#${i.channel.name}`
  if (i.type === 'paused_run' || i.type === 'limit' || i.type === 'waiting') return 'Session'
  return 'Inbox'
}

/** Items that want attention sooner get the warning style: paused runs, limits and alerts. */
export function isWarning(i: InboxItem): boolean {
  return i.type === 'paused_run' || i.type === 'limit' || i.type === 'alert'
}

/** Whether a muted channel silences the item. It still counts in the inbox. */
export function isMuted(i: InboxItem, prefs: Pick<NotificationPrefs, 'mutedChannels'>): boolean {
  return !!i.channelId && prefs.mutedChannels.includes(i.channelId)
}

/** The document title with the unread count in front: `(3) meatless-proxy`. */
export function titleWithCount(title: string, unread: number): string {
  const base = title.replace(/^\(\d+\+?\)\s*/, '')
  return unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base
}

/**
 * Groups bursts of toasts. `add` answers whether the item gets its own toast, or joins the
 * group toast (with how many it holds, and the single toasts it replaces, to dismiss).
 */
export class Burst {
  private recent: { id: string; at: number }[] = []
  private groupUntil = 0
  private groupCount = 0

  constructor(private now: () => number = Date.now) {}

  add(id: string): { kind: 'single' } | { kind: 'group'; count: number; replaces: string[] } {
    const t = this.now()
    this.recent = this.recent.filter((r) => t - r.at < BURST.windowMs)
    if (t < this.groupUntil) {
      this.groupCount++
      this.groupUntil = t + BURST.windowMs
      return { kind: 'group', count: this.groupCount, replaces: [] }
    }
    if (this.recent.length + 1 > BURST.max) {
      const replaces = this.recent.map((r) => r.id)
      this.groupCount = replaces.length + 1
      this.groupUntil = t + BURST.windowMs
      this.recent = []
      return { kind: 'group', count: this.groupCount, replaces }
    }
    this.recent.push({ id, at: t })
    return { kind: 'single' }
  }
}

/** A short, quiet two-note chime made with WebAudio (no asset). Does nothing where audio isn't available. */
export function playChime(): void {
  const AC =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return
  try {
    const ctx = new AC()
    const t = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
    gain.connect(ctx.destination)
    for (const [freq, at] of [
      [880, 0],
      [1320, 0.09],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t + at)
      osc.connect(gain)
      osc.start(t + at)
      osc.stop(t + at + 0.25)
    }
    setTimeout(() => ctx.close().catch(() => {}), 600)
  } catch {
    // Autoplay rules can refuse audio before the first interaction; a missed chime is fine.
  }
}

/** What the browser allows: `unsupported` when there is no Notification API. */
export type DesktopPermission = NotificationPermission | 'unsupported'

export function desktopPermission(): DesktopPermission {
  const N = (globalThis as { Notification?: typeof Notification }).Notification
  return N ? N.permission : 'unsupported'
}

/** Asks for permission (only from a click). */
export async function requestDesktopPermission(): Promise<DesktopPermission> {
  const N = (globalThis as { Notification?: typeof Notification }).Notification
  if (!N) return 'unsupported'
  if (N.permission !== 'default') return N.permission
  return N.requestPermission()
}

/** The desktop notification's title and body. DMs never show their text with `hideDmText`. */
export function desktopContent(i: InboxItem, prefs: Pick<NotificationPrefs, 'hideDmText'>): { title: string; body: string } {
  const who = i.author?.name ?? i.employee?.name
  const place = placeOf(i)
  const hide = prefs.hideDmText && (i.type === 'dm' || i.channel?.dm === true)
  const title = who ? `${who} · ${place}` : i.title
  return { title, body: hide ? 'New direct message' : (i.detail ?? i.title) }
}

/**
 * Shows a desktop notification for the item, only while the tab is hidden and permission was
 * granted. A click focuses the tab and runs `onClick`. Returns the notification, or null.
 */
export function showDesktop(i: InboxItem, prefs: NotificationPrefs, onClick: () => void): Notification | null {
  const N = (globalThis as { Notification?: typeof Notification }).Notification
  if (!prefs.desktop || !N || N.permission !== 'granted' || document.visibilityState !== 'hidden') return null
  const { title, body } = desktopContent(i, prefs)
  try {
    const n = new N(title, { body, tag: i.id, silent: true })
    n.onclick = () => {
      window.focus()
      onClick()
      n.close()
    }
    return n
  } catch {
    return null
  }
}
