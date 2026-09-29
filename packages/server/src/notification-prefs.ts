import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@mp/api'
import { ConflictError, type KindSchema } from '@mp/core'
import { Hono } from 'hono'
import { principalOf } from './auth/guard.ts'
import { BadRequestError, jsonBody } from './http/util.ts'
import type { Services } from './services.ts'

/**
 * A person's notification preferences (docs/spec.md#notifications): what the web UI does when a
 * new inbox item arrives on their live channel. One record per contact (its key), read and
 * written only by that person through `GET/PUT /api/me/notifications`, so every device follows
 * the same settings. The kind is hidden from the records API.
 */

/** The most channels a person can mute. */
export const MAX_MUTED_CHANNELS = 500

export const notificationPrefsSchema: KindSchema = {
  kind: 'notification_prefs',
  prefix: 'ntp',
  description: "A person's notification preferences for the web UI. The record key is the contact id.",
  core: [
    { name: 'contactId', type: 'ref', ref: 'contact', required: true },
    { name: 'toasts', type: 'boolean', required: true },
    { name: 'desktop', type: 'boolean', required: true },
    { name: 'sound', type: 'boolean', required: true },
    { name: 'hideDmText', type: 'boolean', required: true },
    { name: 'mutedChannels', type: 'list', of: { type: 'string' }, required: true },
  ],
}

type PrefsData = NotificationPrefs & { contactId: string } & Record<string, unknown>

const BOOLEAN_FIELDS = ['toasts', 'desktop', 'sound', 'hideDmText'] as const

/** Checks a `PUT` body: known fields only, of the right types. */
export function parsePrefsPatch(body: Record<string, unknown>): Partial<NotificationPrefs> {
  const out: Partial<NotificationPrefs> = {}
  for (const k of Object.keys(body)) {
    if (k === 'mutedChannels') {
      const v = body[k]
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x || x.length > 100))
        throw new BadRequestError('mutedChannels must be a list of channel ids')
      if (v.length > MAX_MUTED_CHANNELS) throw new BadRequestError(`at most ${MAX_MUTED_CHANNELS} muted channels`)
      out.mutedChannels = [...new Set(v as string[])]
    } else if ((BOOLEAN_FIELDS as readonly string[]).includes(k)) {
      if (typeof body[k] !== 'boolean') throw new BadRequestError(`${k} must be a boolean`)
      out[k as (typeof BOOLEAN_FIELDS)[number]] = body[k] as boolean
    } else throw new BadRequestError(`unknown field ${k}`)
  }
  return out
}

/** Per-person notification preferences. */
export class NotificationPrefsStore {
  constructor(private s: Services) {
    if (!s.records.kinds.has(notificationPrefsSchema.kind)) s.records.kinds.define(notificationPrefsSchema)
  }

  /** Their preferences: the defaults until they change something. */
  async get(contactId: string): Promise<NotificationPrefs> {
    const r = await this.s.records.getByKey<PrefsData>(notificationPrefsSchema.kind, contactId)
    return pick({ ...DEFAULT_NOTIFICATION_PREFS, ...(r?.data ?? {}) })
  }

  /** Changes the given fields (concurrent writes retry on the record's version) and returns the result. */
  async set(contactId: string, patch: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
    for (let i = 0; ; i++) {
      const cur = await this.s.records.getByKey<PrefsData>(notificationPrefsSchema.kind, contactId)
      const next: PrefsData = { ...DEFAULT_NOTIFICATION_PREFS, ...(cur ? pick(cur.data) : {}), ...patch, contactId }
      try {
        if (!cur) await this.s.records.create<PrefsData>(notificationPrefsSchema.kind, next, { key: contactId })
        else
          await this.s.records.update<PrefsData>(notificationPrefsSchema.kind, cur.id, next, {
            replace: true,
            expectedVersion: cur.version,
          })
        return pick(next)
      } catch (err) {
        if (!(err instanceof ConflictError) || i >= 5) throw err
      }
    }
  }
}

function pick(d: NotificationPrefs): NotificationPrefs {
  return {
    toasts: d.toasts,
    desktop: d.desktop,
    sound: d.sound,
    hideDmText: d.hideDmText,
    mutedChannels: [...d.mutedChannels],
  }
}

/** `GET/PUT /api/me/notifications`: always the signed-in person's own preferences. */
export function notificationPrefsRoutes(s: Services): Hono {
  const store = new NotificationPrefsStore(s)
  const app = new Hono()
  app.get('/api/me/notifications', async (c) => c.json((await store.get(principalOf(c).contactId)) satisfies NotificationPrefs))
  app.put('/api/me/notifications', async (c) => {
    const patch = parsePrefsPatch(await jsonBody(c))
    return c.json((await store.set(principalOf(c).contactId, patch)) satisfies NotificationPrefs)
  })
  return app
}
