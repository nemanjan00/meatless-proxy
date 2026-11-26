import type { Json } from '@mp/core'
import type { IntegrationEvent } from '@mp/mcp'

export const SLACK_SOURCE = 'integration:slack'
export const SLACK_SYSTEM = 'slack'
/** Longest message text in an event's `text`; the full text is in the payload. */
export const SLACK_MAX_TEXT = 4000

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
  attachments?: SlackAttachment[]
  blocks?: Json[]
}

/** A forwarded or shared message (`is_share`, `is_msg_unfurl`), or an app's attachment. */
export interface SlackAttachment {
  is_share?: boolean
  is_msg_unfurl?: boolean
  text?: string
  fallback?: string
  pretext?: string
  title?: string
  author_id?: string
  author_name?: string
  from_url?: string
  /** An app's attachment in blocks (no `text`). */
  blocks?: Json[]
  /** A forwarded message in Slack's newer shape: its blocks, with no `text`. */
  message_blocks?: { message?: { blocks?: Json[] } }[]
  fields?: { title?: string; value?: string }[]
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
  /** A thread's first message, if it can be read; shown with a mention or DM in that thread. */
  threadRoot?(channelId: string, threadTs: string): Promise<SlackMessage | undefined>
}

/** Subtypes that are ordinary messages from a person or another bot. Everything else (joins, topic changes, …) is ignored. */
const MESSAGE_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message', 'bot_message'])

const isSelf = (m: SlackMessage | undefined, self: SelfIdentity) =>
  !!m &&
  ((m.user !== undefined && self.userIds.has(m.user)) ||
    (m.bot_id !== undefined && self.botIds.has(m.bot_id)) ||
    (self.appId !== undefined && (m.app_id === self.appId || m.bot_profile?.app_id === self.appId)))

/** Longest thread-root text quoted in a reply's event text; read_thread has the rest. */
export const SLACK_MAX_ROOT_TEXT = 500

const clip = (s: string) =>
  s.length > SLACK_MAX_TEXT
    ? `${s.slice(0, SLACK_MAX_TEXT)}… [${s.length - SLACK_MAX_TEXT} more characters: read_thread for the rest]`
    : s

/** Files of a message, as the model reads them: `[file: name, slack file F…]`, so it knows to call get_file. */
export const filesText = (files: SlackMessage['files']) =>
  (files ?? [])
    .filter((f) => f.id)
    .map((f) => ` [file: ${(f.name ?? f.id)!.replace(/[\]\n]/g, ' ')}, slack file ${f.id}]`)
    .join('')

/** Longest text of one shared message or attachment in an event's text. */
export const SLACK_MAX_SHARED_TEXT = 3000

const clipShared = (s: string) =>
  s.length > SLACK_MAX_SHARED_TEXT
    ? `${s.slice(0, SLACK_MAX_SHARED_TEXT)}… [${s.length - SLACK_MAX_SHARED_TEXT} more characters: read_thread for the rest]`
    : s

/** The words of Slack blocks (sections, rich text, context), for a message whose `text` is empty. */
export function blocksText(blocks: unknown): string {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (o.type === 'user' && typeof o.user_id === 'string') out.push(`<@${o.user_id}>`)
    else if (o.type === 'link' && typeof o.url === 'string') out.push(typeof o.text === 'string' ? `${o.text} (${o.url})` : o.url)
    else if (typeof o.text === 'string') out.push(o.text)
    else for (const k of ['text', 'elements', 'fields', 'blocks']) if (k in o) walk(o[k])
  }
  walk(blocks)
  return out
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** A message's text: its `text`, else the words of its blocks (some apps post blocks only). */
export const messageText = (m: Pick<SlackMessage, 'text' | 'blocks'>) => m.text || blocksText(m.blocks)

/** The messages and attachments a message carries, as the model reads them (who, where from, what). */
export function sharedOf(m: Pick<SlackMessage, 'attachments'>): { author?: string; text: string; link?: string }[] {
  return (m.attachments ?? [])
    .map((a) => {
      const body = a.text || blocksText(a.message_blocks?.map((b) => b.message?.blocks)) || blocksText(a.blocks) || a.fallback
      const fields = (a.fields ?? []).map((f) => [f.title, f.value].filter(Boolean).join(': '))
      const text = [a.pretext, a.title, body, ...fields, filesText(a.files).trim()].filter((x) => x?.trim()).join('\n')
      const author = a.author_id ? `<@${a.author_id}>` : a.author_name
      return {
        ...(author ? { author } : {}),
        text,
        ...(a.from_url ? { link: a.from_url } : {}),
        share: !!(a.is_share || a.is_msg_unfurl),
      }
    })
    .filter((a) => a.text)
    .map(({ share, ...a }) => a)
}

/** Shared messages and attachments in an event's text: a forwarded message is otherwise invisible to the model. */
export const sharedText = (m: Pick<SlackMessage, 'attachments'>) =>
  sharedOf(m)
    .map(
      (a) =>
        ` [shared message${a.author ? ` from ${a.author}` : ''}${a.link ? ` (${a.link})` : ''}: "${clipShared(a.text.replace(/\s+/g, ' ').trim())}"]`,
    )
    .join('')

/**
 * Where a reply sits, for the event text: the thread's root ts, labelled so it isn't taken for the reply's own,
 * and, when known, who started the thread and what it says (a bare mention in a thread is about its root).
 */
const threadLabel = (threadTs: string, root: SlackMessage | undefined, self: SelfIdentity) => {
  if (!root) return ` (reply in thread ${threadTs})`
  const who = isSelf(root, self) ? 'you' : root.user ? `<@${root.user}>` : (root.bot_id ?? 'someone')
  const text = messageText(root).replace(/\s+/g, ' ').trim()
  const quoted = text.length > SLACK_MAX_ROOT_TEXT ? `${text.slice(0, SLACK_MAX_ROOT_TEXT)}… [read_thread for the rest]` : text
  return ` (reply in thread ${threadTs}, started by ${who}: "${quoted}"${filesText(root.files)})`
}

const mentionsApp = (text: string | undefined, self: SelfIdentity) =>
  !!text && [...self.userIds].some((id) => text.includes(`<@${id}>`))

/** Whether a message mentions someone, and not this app: it's addressed to them (the router doesn't fall back to this employee). */
const addressedToOthers = (text: string | undefined, self: SelfIdentity) => {
  const mentioned = [...(text ?? '').matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!)
  return mentioned.length > 0 && !mentioned.some((id) => self.userIds.has(id))
}

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
  const rootOf = async (threadTs: string) => (ctx.threadRoot ? ctx.threadRoot(channel, threadTs) : undefined)
  const rootPayload = (root: SlackMessage | undefined) =>
    root ? pick({ user: root.user, bot_id: root.bot_id, text: root.text ?? '' }) : undefined
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
      // The root is looked up only for what's addressed to this app: plain replies go to the sessions following the thread.
      const root = reply && (mentioned || isDm) ? await rootOf(ev.thread_ts!) : undefined
      return base(
        type,
        ev.thread_ts ?? ev.ts,
        ev.user,
        `Slack ${await where()}${reply ? threadLabel(ev.thread_ts!, root, self) : ''} ${who}: ${clip(messageText(ev))}${filesText(ev.files)}${sharedText(ev)}`,
        pick({
          ...(await common()),
          user: ev.user,
          bot_id: ev.bot_id,
          subtype: ev.subtype,
          text: messageText(ev),
          ts: ev.ts,
          thread_ts: ev.thread_ts,
          is_reply: reply,
          thread_root: rootPayload(root),
          mentions_app: mentioned,
          addressedToOthers: !isDm && !mentioned && addressedToOthers(ev.text, self) ? true : undefined,
          // A channel message that doesn't mention this app is people talking (the app's threads reach it by subscription).
          plainConversation: !isDm && !mentioned ? true : undefined,
          files: ev.files?.length ? ev.files.map((f) => pick({ id: f.id, name: f.name })) : undefined,
          shared: sharedOf(ev).length ? (sharedOf(ev) as Json) : undefined,
        }),
        messageKey(channel, ev.ts),
      )
    }
    case 'app_mention': {
      if (!ev.ts || isSelf(ev, self)) return null
      const reply = !!ev.thread_ts && ev.thread_ts !== ev.ts
      const root = reply ? await rootOf(ev.thread_ts!) : undefined
      return base(
        'message.mentioned',
        ev.thread_ts ?? ev.ts,
        ev.user,
        `Slack ${await where()}${reply ? threadLabel(ev.thread_ts!, root, self) : ''} ${ev.user ?? 'someone'}: ${clip(messageText(ev))}${filesText(ev.files)}${sharedText(ev)}`,
        pick({
          ...(await common()),
          user: ev.user,
          text: messageText(ev),
          ts: ev.ts,
          thread_ts: ev.thread_ts,
          is_reply: reply,
          thread_root: rootPayload(root),
          mentions_app: true,
          files: ev.files?.length ? ev.files.map((f) => pick({ id: f.id, name: f.name })) : undefined,
          shared: sharedOf(ev).length ? (sharedOf(ev) as Json) : undefined,
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
