import { errorMessage, isMpError, type Logger } from '@mp/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type SlackClient, type SlackResponse, slackErrorCode } from './client.ts'

type Obj = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
const compact = <T extends Obj>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false))

/** A message as the model sees it. */
export function compactMessage(m: Obj) {
  const reactions = Array.isArray(m.reactions)
    ? (m.reactions as Obj[]).map((r) => ({ name: str(r.name), count: num(r.count) }))
    : undefined
  const files = Array.isArray(m.files) ? (m.files as Obj[]).map((f) => str(f.name) ?? str(f.id)).filter(Boolean) : undefined
  return compact({
    ts: str(m.ts),
    user: str(m.user),
    bot_id: str(m.bot_id),
    subtype: str(m.subtype),
    text: typeof m.text === 'string' ? m.text : '',
    thread_ts: str(m.thread_ts),
    reply_count: num(m.reply_count) || undefined,
    reactions: reactions?.length ? reactions : undefined,
    files: files?.length ? files : undefined,
    edited: m.edited ? true : undefined,
  })
}

/** A user as the model sees it. */
export function compactUser(u: Obj) {
  const profile = (u.profile ?? {}) as Obj
  return compact({
    id: str(u.id),
    name: str(u.name),
    real_name: str(u.real_name) ?? str(profile.real_name),
    display_name: str(profile.display_name),
    email: str(profile.email),
    title: str(profile.title),
    tz: str(u.tz),
    is_bot: u.is_bot === true || undefined,
    deleted: u.deleted === true || undefined,
  })
}

const compactChannel = (c: Obj) =>
  compact({
    id: str(c.id),
    name: str(c.name),
    is_private: c.is_private === true || undefined,
    is_member: c.is_member === true,
    topic: str((c.topic as Obj | undefined)?.value),
    purpose: str((c.purpose as Obj | undefined)?.value),
    members: num(c.num_members),
  })

const nextCursor = (r: SlackResponse) => str((r.response_metadata as Obj | undefined)?.next_cursor) ?? null

const ok = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

/** Friendlier messages for the Slack errors the model can act on. */
const HINTS: Record<string, string> = {
  not_in_channel: 'the app is not a member of this channel; ask someone to invite it (/invite @app)',
  channel_not_found: 'no such channel, or the app cannot see it; use list_channels for ids',
  thread_not_found: 'no such thread; thread_ts must be the ts of the thread root message',
  message_not_found: 'no such message in this channel',
  cant_update_message: 'only messages the app posted itself can be updated',
  users_not_found: 'no user with that email',
  user_not_found: 'no such user',
  is_archived: 'the channel is archived',
  msg_too_long: 'the text is too long; split it into several messages',
  invalid_name: 'unknown emoji name',
}

const fail = (err: unknown): CallToolResult => {
  const code = slackErrorCode(err)
  const body: Obj = { error: code ?? (isMpError(err) ? err.code : 'error'), message: errorMessage(err) }
  if (code && HINTS[code]) body.hint = HINTS[code]
  if (isMpError(err, 'unavailable')) body.retryable = true
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true }
}

const channel = z.string().min(1).describe('Channel id, e.g. C0123ABCD (a DM id from open_dm works too)')
const ts = z.string().min(1).describe('Message timestamp id, e.g. 1712345678.123456')
const limit = (max: number, def: number) =>
  z.number().int().min(1).max(max).optional().describe(`How many to return (default ${def}, max ${max})`)
const cursor = z.string().optional().describe('next_cursor from the previous page')
const emoji = z.string().min(1).describe('Emoji name without colons, e.g. eyes or white_check_mark')

const READ = { readOnlyHint: true, openWorldHint: true } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const

/** Builds the MCP server exposing the Slack tools over `client`. */
export function createSlackMcpServer(client: SlackClient, logger: Logger): McpServer {
  const server = new McpServer({ name: 'slack', version: '0.0.0' })
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    annotations: Obj,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) => {
    // The SDK's generic callback typing doesn't survive this wrapper, hence the casts.
    server.registerTool(name, { description, inputSchema, annotations }, (async (args: unknown) => {
      try {
        return ok(await run(args as z.infer<z.ZodObject<S>>))
      } catch (err) {
        logger.warn('slack tool failed', { tool: name, err: errorMessage(err) })
        return fail(err)
      }
    }) as never)
  }

  const post = async (args: { channel: string; text: string; thread_ts?: string | undefined }) => {
    const r = await client.call(
      'chat.postMessage',
      { channel: args.channel, text: args.text, thread_ts: args.thread_ts, mrkdwn: true },
      { write: true, json: true },
    )
    return compact({ channel: str(r.channel), ts: str(r.ts), thread_ts: args.thread_ts })
  }

  tool(
    'post_message',
    'Post a message in a Slack channel or DM. Text is Slack mrkdwn (*bold*, _italic_, `code`, <@U123> mentions, <https://x|links>). Pass thread_ts to post inside a thread. Returns the new message ts.',
    {
      channel,
      text: z.string().min(1).describe('Message text (mrkdwn)'),
      thread_ts: ts.optional().describe('Thread root ts, to reply in a thread'),
    },
    WRITE,
    post,
  )
  tool(
    'reply',
    'Reply in a Slack thread. thread_ts is the ts of the thread root message (the subject of a Slack event is slack:<channel>/<thread_ts>).',
    { channel, thread_ts: ts.describe('Thread root ts'), text: z.string().min(1).describe('Reply text (mrkdwn)') },
    WRITE,
    post,
  )
  tool(
    'read_channel',
    'Read recent messages of a channel, newest first. Messages with reply_count have a thread: read it with read_thread.',
    {
      channel,
      limit: limit(200, 20),
      cursor,
      oldest: ts.optional().describe('Only messages after this ts'),
      latest: ts.optional().describe('Only messages before this ts'),
    },
    READ,
    async (a) => {
      const r = await client.call('conversations.history', {
        channel: a.channel,
        limit: a.limit ?? 20,
        cursor: a.cursor,
        oldest: a.oldest,
        latest: a.latest,
      })
      return { messages: ((r.messages as Obj[]) ?? []).map(compactMessage), next_cursor: nextCursor(r) }
    },
  )
  tool(
    'read_thread',
    'Read a thread: the root message first, then replies in order.',
    { channel, thread_ts: ts.describe('Thread root ts'), limit: limit(200, 50), cursor },
    READ,
    async (a) => {
      const r = await client.call('conversations.replies', {
        channel: a.channel,
        ts: a.thread_ts,
        limit: a.limit ?? 50,
        cursor: a.cursor,
      })
      return { messages: ((r.messages as Obj[]) ?? []).map(compactMessage), next_cursor: nextCursor(r) }
    },
  )
  tool(
    'react',
    'Add an emoji reaction to a message, e.g. eyes to show you are on it.',
    { channel, ts, name: emoji },
    WRITE,
    async (a) => {
      const name = a.name.replace(/^:|:$/g, '')
      try {
        await client.call('reactions.add', { channel: a.channel, timestamp: a.ts, name }, { write: true, json: true })
        return { ok: true }
      } catch (err) {
        if (slackErrorCode(err) === 'already_reacted') return { ok: true, already: true }
        throw err
      }
    },
  )
  tool('unreact', 'Remove an emoji reaction the app added to a message.', { channel, ts, name: emoji }, WRITE, async (a) => {
    const name = a.name.replace(/^:|:$/g, '')
    try {
      await client.call('reactions.remove', { channel: a.channel, timestamp: a.ts, name }, { write: true, json: true })
      return { ok: true }
    } catch (err) {
      if (slackErrorCode(err) === 'no_reaction') return { ok: true, already: true }
      throw err
    }
  })
  tool(
    'lookup_user',
    'Look up a Slack user by id (U…) or by email. Returns name, real name, email, title and time zone.',
    { user: z.string().optional().describe('User id, e.g. U0123ABCD'), email: z.string().optional().describe('Email address') },
    READ,
    async (a) => {
      if (!a.user === !a.email) throw new Error('pass exactly one of user or email')
      const r = a.user
        ? await client.call('users.info', { user: a.user })
        : await client.call('users.lookupByEmail', { email: a.email })
      return compactUser((r.user ?? {}) as Obj)
    },
  )
  tool(
    'open_dm',
    'Open (or find) a direct message with one user, or a group DM with up to 8 users. Returns the channel id to use with post_message.',
    {
      user: z.string().optional().describe('User id for a 1:1 DM'),
      users: z.array(z.string().min(1)).min(1).max(8).optional().describe('User ids for a group DM'),
    },
    WRITE,
    async (a) => {
      const users = [...(a.user ? [a.user] : []), ...(a.users ?? [])]
      if (!users.length) throw new Error('pass user or users')
      const r = await client.call(
        'conversations.open',
        { users: [...new Set(users)].join(','), return_im: true },
        { write: true, json: true },
      )
      return { channel: str((r.channel as Obj | undefined)?.id) }
    },
  )
  tool(
    'list_channels',
    'List public and private channels, with ids. By default only channels the app is a member of (it can read and post only there). A page may be short; keep paging while next_cursor is set.',
    {
      member_only: z.boolean().optional().describe('Only channels the app is in (default true)'),
      limit: limit(1000, 200),
      cursor,
    },
    READ,
    async (a) => {
      const r = await client.call('conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: a.limit ?? 200,
        cursor: a.cursor,
      })
      const memberOnly = a.member_only ?? true
      const channels = ((r.channels as Obj[]) ?? []).filter((c) => !memberOnly || c.is_member === true).map(compactChannel)
      return { channels, next_cursor: nextCursor(r) }
    },
  )
  tool(
    'update_message',
    "Edit a message the app posted earlier (other people's messages can't be edited).",
    { channel, ts, text: z.string().min(1).describe('New text (mrkdwn)') },
    WRITE,
    async (a) => {
      const r = await client.call('chat.update', { channel: a.channel, ts: a.ts, text: a.text }, { write: true, json: true })
      return { channel: str(r.channel), ts: str(r.ts) }
    },
  )
  return server
}
