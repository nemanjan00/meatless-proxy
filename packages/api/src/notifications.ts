// ─── Notifications: how a person hears about new inbox items ────────────────
//
// Served by packages/server/src/notification-prefs.ts. New inbox items arrive live on the
// WebSocket channel `person:<contactId>` (topic `inbox.item`), and `inbox.read` tells every tab
// of the same person that items were read or the inbox cleared. Only the signed-in person can
// subscribe to their own channel. These preferences decide what the web UI does with an item;
// they are stored per person on the server, so every device follows them.

/** A person's notification preferences. */
export interface NotificationPrefs {
  /** Show a toast for a new item. */
  toasts: boolean
  /** Show a desktop notification for a new item while the tab is hidden (the browser asks for permission). */
  desktop: boolean
  /** Play a short, quiet sound for a new item. */
  sound: boolean
  /** Desktop notifications for DMs say who wrote, never what. */
  hideDmText: boolean
  /** Channel ids that never toast, sound or notify. Their items still count in the inbox. */
  mutedChannels: string[]
}

/** What a person has before they change anything. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  toasts: true,
  desktop: false,
  sound: false,
  hideDmText: false,
  mutedChannels: [],
}

/** The routes of this section (merged into `ROUTES`). */
export const NOTIFICATION_ROUTES = {
  notificationPrefs: ['GET', '/api/me/notifications'],
  setNotificationPrefs: ['PUT', '/api/me/notifications'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface NotificationsApi {
  /** `GET /api/me/notifications` → your preferences (the defaults until you change them). */
  notificationPrefs(): Promise<NotificationPrefs>
  /**
   * `PUT /api/me/notifications` body: the fields to change → your preferences after the change.
   * Anyone signed in can change their own; nobody can read or change someone else's.
   */
  setNotificationPrefs(patch: Partial<NotificationPrefs>): Promise<NotificationPrefs>
}

type Call = <T>(
  route: keyof typeof NOTIFICATION_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `NotificationsApi` half of `createApiClient`. */
export function notificationsMethods(call: Call): NotificationsApi {
  return {
    notificationPrefs: () => call('notificationPrefs'),
    setNotificationPrefs: (patch) => call('setNotificationPrefs', undefined, undefined, patch),
  }
}
