import type { Json } from '@mp/core'
import type { IntegrationEvent } from '@mp/mcp'

export const SLACK_SOURCE = 'integration:slack'
export const SLACK_SYSTEM = 'slack'
/** Longest message text in an event's `text`; the full text is in the payload. */
export const SLACK_MAX_TEXT = 1000

/** The Events API outer envelope (`event_callback`). */
export interface SlackEnvelope {
  type: string
  team_id?: string
  api_app_id?: string
  event_id?: string
  event_time?: number
  event?: SlackInnerEvent
  authorizations?: { user_id?: string; is_bot?: boolean; team_id?: string }[]
}

export interface SlackMessage {
  type?: string
  subtype?: string
  user?: string
  bot_id?: string
  app_id?: string
  bot_profile?: { app_id?: string }
  text?: string
  ts?: string
  thread_ts?: string
  files?: { id?: string; name?: string }[]
}

export interface SlackInnerEvent extends SlackMessage {
  channel?: string
  channel_type?: string
  event_ts?: string
  message?: SlackMessage
  previous_message?: SlackMessage
  deleted_ts?: string
  reaction?: string
  item?: { type?: string; channel?: string; ts?: string }
  item_user?: string
}

/** Who "we" are, so the app's own messages and reactions are ignored. */
export interface SelfIdentity {
  userIds: ReadonlySet<string>
  botIds: ReadonlySet<string>
  appId?: string
}

export interface MapContext {
  self: SelfIdentity
  /** The channel's name without `#`, if known. */
  channelName(channelId: string): Promise<string | undefined>
}

/** Subtypes that are ordinary messages from a person or another bot. Everything else (joins, topic changes, …) is ignored. */
const MESSAGE_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message', 'bot_message'])

const isSelf = (m: SlackMessage | undefined, self: SelfIdentity) =>
  !!m &&
  ((m.user !== undefined && self.userIds.has(m.user)) ||
    (m.bot_id !== undefined && self.botIds.has(m.bot_id)) ||
    (self.appId !== undefined && (m.app_id === self.appId || m.bot_profile?.app_id === self.appId)))

const clip = (s: string) => (s.length > SLACK_MAX_TEXT ? `${s.slice(0, SLACK_MAX_TEXT)}…` : s)

const mentionsApp = (text: string | undefined, self: SelfIdentity) =>
  !!text && [...self.userIds].some((id) => text.includes(`<@${id}>`))

const pick = (obj: Record<string, Json | undefined>): Json =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Json

/** The subject of a message: its thread, keyed by the thread's root ts. */
export const subjectFor = (channel: string, ts: string) => ({ system: SLACK_SYSTEM, id: `${channel}/${ts}` })

/**
 * Maps one `event_callback` envelope to an integration event, or null when it
 * isn't one we route (the app's own messages, joins, unknown types, …).
 */
/** One key per Slack message, whichever event (`message` or `app_mention`) brings it. */
const messageKey = (channel: string, ts: string) => `slack:msg:${channel}:${ts}`

export async function mapSlackEvent(env: SlackEnvelope, ctx: MapContext): Promise<IntegrationEvent | null> {
  const ev = env.event
  if (env.type !== 'event_callback' || !ev || !env.event_id) return null
  const self = ctx.self
  const channel = ev.channel ?? ev.item?.channel
  if (!channel) return null
  // Reactions carry no channel_type; DM channel ids start with D.
  const isDm = ev.channel_type === 'im' || (ev.channel_type === undefined && channel.startsWith('D'))
  const where = async () => {
    if (isDm) return 'DM'
    return `#${(await ctx.channelName(channel)) ?? channel}`
  }
  const base = (
    type: string,
    subjectTs: string,
    actor: string | undefined,
    text: string,
    payload: Json,
    dedupeKey = `slack:${env.event_id}`,
  ): IntegrationEvent => ({
    source: SLACK_SOURCE,
    type,
    dedupeKey,
    subject: subjectFor(channel, subjectTs),
    ...(actor ? { actor: { system: SLACK_SYSTEM, id: actor } } : {}),
    text,
    payload,
  })
  const common = async () => ({
    team_id: env.team_id,
    channel,
    channel_type: ev.channel_type,
    channel_name: isDm ? undefined : await ctx.channelName(channel),
  })

  switch (ev.type) {
    case 'message': {
      if (ev.subtype === 'message_changed') {
        const m = ev.message
        if (!m?.ts || isSelf(m, self)) return null
        // Slack also sends message_changed for unfurls, where the text stays the same.
        if (ev.previous_message && ev.previous_message.text === m.text) return null
        const who = m.user ?? m.bot_id
        return base(
          'message.edited',
          m.thread_ts ?? m.ts,
          m.user,
          `Slack ${await where()} ${who ?? 'someone'} edited: ${clip(m.text ?? '')}`,
          pick({
            ...(await common()),
            user: m.user,
            ts: m.ts,
            thread_ts: m.thread_ts,
            text: m.text ?? '',
            previous_text: ev.previous_message?.text,
          }),
        )
      }
      if (ev.subtype === 'message_deleted') {
        const prev = ev.previous_message
        const ts = ev.deleted_ts ?? prev?.ts
        if (!ts || isSelf(prev, self)) return null
        return base(
          'message.deleted',
          prev?.thread_ts ?? ts,
          prev?.user,
          `Slack ${await where()}: a message by ${prev?.user ?? 'someone'} was deleted (${ts})`,
          pick({ ...(await common()), user: prev?.user, ts, thread_ts: prev?.thread_ts, previous_text: prev?.text }),
        )
      }
      if (!MESSAGE_SUBTYPES.has(ev.subtype) || !ev.ts || isSelf(ev, self)) return null
      const reply = !!ev.thread_ts && ev.thread_ts !== ev.ts
      const mentioned = mentionsApp(ev.text, self)
      // Slack sends a mention twice (`message` and `app_mention`, with different event ids): both map
      // to one `message.mentioned` event with one dedupe key, so it's handled once.
      const type = isDm ? 'message.direct' : mentioned ? 'message.mentioned' : reply ? 'message.replied' : 'message.posted'
      const who = ev.user ?? ev.bot_id ?? 'someone'
      return base(
        type,
        ev.thread_ts ?? ev.ts,
        ev.user,
        `Slack ${await where()}${reply ? ' (thread reply)' : ''} ${who}: ${clip(ev.text ?? '')}`,
        pick({
          ...(await common()),
          user: ev.user,
          bot_id: ev.bot_id,
          subtype: ev.subtype,
          text: ev.text ?? '',
          ts: ev.ts,
          thread_ts: ev.thread_ts,
          is_reply: reply,
          mentions_app: mentioned,
          files: ev.files?.length ? ev.files.map((f) => pick({ id: f.id, name: f.name })) : undefined,
        }),
        messageKey(channel, ev.ts),
      )
    }
    case 'app_mention': {
      if (!ev.ts || isSelf(ev, self)) return null
      const reply = !!ev.thread_ts && ev.thread_ts !== ev.ts
      return base(
        'message.mentioned',
        ev.thread_ts ?? ev.ts,
        ev.user,
        `Slack ${await where()}${reply ? ' (thread reply)' : ''} ${ev.user ?? 'someone'}: ${clip(ev.text ?? '')}`,
        pick({
          ...(await common()),
          user: ev.user,
          text: ev.text ?? '',
          ts: ev.ts,
          thread_ts: ev.thread_ts,
          is_reply: reply,
          mentions_app: true,
        }),
        messageKey(channel, ev.ts),
      )
    }
    case 'reaction_added': {
      const item = ev.item
      if (item?.type !== 'message' || !item.ts || !ev.reaction || (ev.user && self.userIds.has(ev.user))) return null
      return base(
        'reaction.added',
        item.ts,
        ev.user,
        `Slack ${await where()} ${ev.user ?? 'someone'} reacted :${ev.reaction}: to message ${item.ts}`,
        pick({
          team_id: env.team_id,
          channel,
          channel_name: isDm ? undefined : await ctx.channelName(channel),
          user: ev.user,
          reaction: ev.reaction,
          ts: item.ts,
          item_user: ev.item_user,
          item_is_own: ev.item_user !== undefined && self.userIds.has(ev.item_user),
        }),
      )
    }
    default:
      return null
  }
}
