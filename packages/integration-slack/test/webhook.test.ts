import { ManualClock } from '@mp/core'
import type { Integration, WebhookRequest } from '@mp/mcp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSlackIntegration, signSlackRequest, verifySlackSignature } from '../src/index.ts'
import { APP_ID, BOT_ID, BOT_USER, type FakeSlack, startFakeSlack, TOKEN } from './fake-slack.ts'

const SECRET = 'signing-secret-test'
let slack: FakeSlack
let clock: ManualClock
let slackIntegration: Integration

beforeEach(async () => {
  slack = await startFakeSlack()
  clock = new ManualClock(Date.UTC(2026, 8, 29, 12))
  slackIntegration = createSlackIntegration({ secrets: { botToken: TOKEN, signingSecret: SECRET }, baseUrl: slack.url, clock })
})
afterEach(async () => {
  await slack.close()
})

const nowSec = () => Math.floor(clock.now() / 1000)
const signed = (
  payload: unknown,
  opts: { ts?: number; secret?: string; headers?: Record<string, string> } = {},
): WebhookRequest => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const ts = String(opts.ts ?? nowSec())
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': signSlackRequest(opts.secret ?? SECRET, ts, body),
      ...opts.headers,
    },
    body,
    query: {},
  }
}

let eventSeq = 0
const envelope = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  token: 'legacy-verification-token',
  team_id: 'T1',
  api_app_id: APP_ID,
  event: { event_ts: '1712345000.000100', ...event },
  type: 'event_callback',
  event_id: `Ev${String(++eventSeq).padStart(4, '0')}`,
  event_time: 1712345000,
  authorizations: [{ enterprise_id: null, team_id: 'T1', user_id: BOT_USER, is_bot: true, is_enterprise_install: false }],
  ...extra,
})
const msg = (fields: Record<string, unknown>) =>
  envelope({
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U1',
    text: 'hello',
    ts: '1712345000.000100',
    ...fields,
  })

const deliver = (payload: unknown) => slackIntegration.handleWebhook(signed(payload))

describe('signature verification', () => {
  it('accepts a valid signature', async () => {
    const r = await deliver(msg({}))
    expect(r.status).toBe(200)
    expect(r.events).toHaveLength(1)
  })

  it('rejects a bad signature, a missing one, and one made with another secret', async () => {
    const req = signed(msg({}))
    const tampered = { ...req, body: req.body.replace('hello', 'hellO') }
    expect((await slackIntegration.handleWebhook(tampered)).status).toBe(401)
    const other = signed(msg({}), { secret: 'another-secret' })
    expect((await slackIntegration.handleWebhook(other)).status).toBe(401)
    const { 'x-slack-signature': _, ...noSig } = req.headers
    const missing = await slackIntegration.handleWebhook({ ...req, headers: noSig })
    expect(missing.status).toBe(401)
    expect(missing.events).toEqual([])
    const short = await slackIntegration.handleWebhook({ ...req, headers: { ...req.headers, 'x-slack-signature': 'v0=abc' } })
    expect(short.status).toBe(401)
  })

  it('rejects timestamps more than 5 minutes old or ahead', async () => {
    expect((await slackIntegration.handleWebhook(signed(msg({}), { ts: nowSec() - 301 }))).status).toBe(401)
    expect((await slackIntegration.handleWebhook(signed(msg({}), { ts: nowSec() + 301 }))).status).toBe(401)
    expect((await slackIntegration.handleWebhook(signed(msg({}), { ts: nowSec() - 299 }))).status).toBe(200)
    const req = signed(msg({}))
    const bad = await slackIntegration.handleWebhook({ ...req, headers: { ...req.headers, 'x-slack-request-timestamp': 'abc' } })
    expect(bad.status).toBe(401)
  })

  it('a replayed delivery keeps its dedupe key; after 5 minutes it is rejected', async () => {
    const req = signed(msg({}))
    const first = await slackIntegration.handleWebhook(req)
    const retry = await slackIntegration.handleWebhook({
      ...req,
      headers: { ...req.headers, 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' },
    })
    expect(retry.events[0]?.dedupeKey).toBe(first.events[0]?.dedupeKey)
    // New messages are keyed by channel and ts (a mention arrives as two Slack events).
    expect(first.events[0]?.dedupeKey).toMatch(/^slack:msg:C\w+:[\d.]+$/)
    clock.advance(301_000)
    expect((await slackIntegration.handleWebhook(req)).status).toBe(401)
  })

  it('matches the example from the Slack docs', () => {
    // https://api.slack.com/authentication/verifying-requests-from-slack
    const body =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c'
    const check = verifySlackSignature({
      signingSecret: '8f742231b10e8888abcd99yyyzzz85a5',
      signature: 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
      timestamp: '1531420618',
      body,
      nowMs: 1531420618 * 1000,
    })
    expect(check).toEqual({ ok: true })
  })

  it('rejects non-POST requests and bodies that are not JSON envelopes', async () => {
    expect((await slackIntegration.handleWebhook({ ...signed(msg({})), method: 'GET' })).status).toBe(405)
    expect((await slackIntegration.handleWebhook(signed('payload=%7B%7D'))).status).toBe(400)
    expect((await slackIntegration.handleWebhook(signed('{"no":"type"}'))).status).toBe(400)
  })
})

describe('Events API envelopes', () => {
  it('answers url_verification with the challenge', async () => {
    const r = await deliver({ token: 'x', challenge: 'chal-123', type: 'url_verification' })
    expect(r).toEqual({ status: 200, body: 'chal-123', headers: { 'content-type': 'text/plain' }, events: [] })
  })

  it('does not answer an unsigned url_verification', async () => {
    const req = signed({ challenge: 'chal', type: 'url_verification' }, { secret: 'wrong' })
    const r = await slackIntegration.handleWebhook(req)
    expect(r.status).toBe(401)
    expect(r.body).not.toContain('chal')
  })

  it('acknowledges app_rate_limited and unknown envelope types without events', async () => {
    expect(
      await deliver({ type: 'app_rate_limited', minute_rate_limited: 1518467820, team_id: 'T1', api_app_id: APP_ID }),
    ).toEqual({
      status: 200,
      events: [],
    })
    expect((await deliver({ type: 'something_new' })).events).toEqual([])
  })
})

describe('event mapping', () => {
  it('message → message.posted, with the channel name resolved (a message mentioning the app is message.mentioned)', async () => {
    const r = await deliver(msg({ text: 'deploy is <@UBOT> ready?' }))
    expect(r.events).toEqual([
      {
        source: 'integration:slack',
        type: 'message.mentioned',
        dedupeKey: expect.stringMatching(/^slack:msg:/),
        subject: { system: 'slack', id: 'C1/1712345000.000100' },
        actor: { system: 'slack', id: 'U1' },
        text: 'Slack #general U1: deploy is <@UBOT> ready?',
        payload: {
          team_id: 'T1',
          channel: 'C1',
          channel_type: 'channel',
          channel_name: 'general',
          user: 'U1',
          text: 'deploy is <@UBOT> ready?',
          ts: '1712345000.000100',
          is_reply: false,
          mentions_app: true,
        },
      },
    ])
  })

  it('a thread root (thread_ts = ts) is still message.posted', async () => {
    const r = await deliver(msg({ thread_ts: '1712345000.000100' }))
    expect(r.events[0]?.type).toBe('message.posted')
  })

  it('message in a thread → message.replied, subject is the thread', async () => {
    const r = await deliver(msg({ ts: '1712345001.000200', thread_ts: '1712345000.000100', text: 'answer' }))
    expect(r.events[0]).toMatchObject({
      type: 'message.replied',
      subject: { system: 'slack', id: 'C1/1712345000.000100' },
      text: 'Slack #general (thread reply) U1: answer',
      payload: { is_reply: true, thread_ts: '1712345000.000100', ts: '1712345001.000200' },
    })
  })

  it('thread_broadcast and file_share are messages too', async () => {
    const b = await deliver(msg({ subtype: 'thread_broadcast', ts: '2.0', thread_ts: '1.0' }))
    expect(b.events[0]).toMatchObject({ type: 'message.replied', payload: { subtype: 'thread_broadcast' } })
    const f = await deliver(
      msg({ subtype: 'file_share', files: [{ id: 'F1', name: 'log.txt', url_private: 'https://files.example.com/x' }] }),
    )
    expect(f.events[0]?.payload).toMatchObject({ files: [{ id: 'F1', name: 'log.txt' }] })
    expect(JSON.stringify(f.events[0]?.payload)).not.toContain('url_private')
  })

  it("ignores the app's own messages: by user id, bot id or app id", async () => {
    expect((await deliver(msg({ user: BOT_USER }))).events).toEqual([])
    expect((await deliver(msg({ user: undefined, bot_id: 'B999', app_id: APP_ID, subtype: 'bot_message' }))).events).toEqual([])
    expect((await deliver(msg({ user: undefined, bot_id: 'B999', bot_profile: { app_id: APP_ID } }))).events).toEqual([])
    // A bot message without an app id: recognised through auth.test's bot_id.
    expect((await deliver(msg({ user: undefined, bot_id: BOT_ID, subtype: 'bot_message' }))).events).toEqual([])
    expect(slack.callsTo('auth.test')).toHaveLength(1)
  })

  it("keeps other bots' messages", async () => {
    const r = await deliver(
      msg({ user: undefined, bot_id: 'BCI', app_id: 'ACI', subtype: 'bot_message', text: 'pipeline failed' }),
    )
    expect(r.events[0]).toMatchObject({ type: 'message.posted', text: 'Slack #general BCI: pipeline failed' })
    expect(r.events[0]?.actor).toBeUndefined()
  })

  it('without authorizations, the own user id comes from auth.test (looked up once)', async () => {
    const e1 = msg({ user: BOT_USER })
    delete (e1 as { authorizations?: unknown }).authorizations
    delete (e1 as { api_app_id?: unknown }).api_app_id
    expect((await deliver(e1)).events).toEqual([])
    const e2 = msg({})
    delete (e2 as { authorizations?: unknown }).authorizations
    expect((await deliver(e2)).events).toHaveLength(1)
    expect(slack.callsTo('auth.test')).toHaveLength(1)
  })

  it('ignores join, leave, topic and other subtypes', async () => {
    for (const subtype of ['channel_join', 'channel_leave', 'channel_topic', 'message_replied', 'pinned_item']) {
      expect((await deliver(msg({ subtype }))).events).toEqual([])
    }
  })

  it('message_changed → message.edited', async () => {
    const r = await deliver(
      envelope({
        type: 'message',
        subtype: 'message_changed',
        channel: 'C1',
        channel_type: 'channel',
        hidden: true,
        ts: '1712345009.000000',
        message: {
          type: 'message',
          user: 'U1',
          text: 'fixed typo',
          ts: '1712345001.000200',
          thread_ts: '1712345000.000100',
          edited: { user: 'U1', ts: '1712345009.000000' },
        },
        previous_message: {
          type: 'message',
          user: 'U1',
          text: 'fixd typo',
          ts: '1712345001.000200',
          thread_ts: '1712345000.000100',
        },
      }),
    )
    expect(r.events[0]).toMatchObject({
      type: 'message.edited',
      subject: { system: 'slack', id: 'C1/1712345000.000100' },
      actor: { system: 'slack', id: 'U1' },
      text: 'Slack #general U1 edited: fixed typo',
      payload: { ts: '1712345001.000200', text: 'fixed typo', previous_text: 'fixd typo' },
    })
  })

  it('message_changed without a text change (unfurls) and edits of own messages are ignored', async () => {
    const same = { type: 'message', user: 'U1', text: 'see https://example.com', ts: '1.0' }
    expect(
      (
        await deliver(
          envelope({ type: 'message', subtype: 'message_changed', channel: 'C1', message: same, previous_message: same }),
        )
      ).events,
    ).toEqual([])
    const own = { type: 'message', user: BOT_USER, bot_id: BOT_ID, text: 'v2', ts: '1.0' }
    expect(
      (
        await deliver(
          envelope({
            type: 'message',
            subtype: 'message_changed',
            channel: 'C1',
            message: own,
            previous_message: { ...own, text: 'v1' },
          }),
        )
      ).events,
    ).toEqual([])
  })

  it('message_deleted → message.deleted', async () => {
    const r = await deliver(
      envelope({
        type: 'message',
        subtype: 'message_deleted',
        channel: 'C1',
        channel_type: 'channel',
        hidden: true,
        ts: '1712345010.000000',
        deleted_ts: '1712345000.000100',
        previous_message: { type: 'message', user: 'U1', text: 'oops', ts: '1712345000.000100' },
      }),
    )
    expect(r.events[0]).toMatchObject({
      type: 'message.deleted',
      subject: { system: 'slack', id: 'C1/1712345000.000100' },
      actor: { system: 'slack', id: 'U1' },
      payload: { ts: '1712345000.000100', previous_text: 'oops' },
    })
    expect(r.events[0]?.text).toContain('deleted')
  })

  it('app_mention → message.mentioned', async () => {
    const r = await deliver(
      envelope({ type: 'app_mention', user: 'U1', text: '<@UBOT> can you look?', ts: '1712345020.000100', channel: 'C1' }),
    )
    expect(r.events[0]).toMatchObject({
      type: 'message.mentioned',
      subject: { system: 'slack', id: 'C1/1712345020.000100' },
      actor: { system: 'slack', id: 'U1' },
      text: 'Slack #general U1: <@UBOT> can you look?',
    })
    const inThread = await deliver(
      envelope({ type: 'app_mention', user: 'U1', text: '<@UBOT>', ts: '5.0', thread_ts: '4.0', channel: 'C1' }),
    )
    expect(inThread.events[0]?.subject).toEqual({ system: 'slack', id: 'C1/4.0' })
  })

  it('a mention Slack sends twice (message and app_mention) becomes one message.mentioned event', async () => {
    const asMessage = await deliver(
      envelope({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '<@UBOT> test', ts: '7.0' }),
    )
    const asMention = await deliver(envelope({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> test', ts: '7.0' }))
    const a = asMessage.events[0]!
    const b = asMention.events[0]!
    expect(a.type).toBe('message.mentioned')
    expect(b.type).toBe('message.mentioned')
    expect(a.dedupeKey).toBe('slack:msg:C1:7.0')
    expect(b.dedupeKey).toBe(a.dedupeKey)
    expect(a.payload).toMatchObject({ mentions_app: true })
    // A plain message keeps its type and gets the same per-message key.
    const plain = await deliver(
      envelope({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'hi', ts: '8.0' }),
    )
    expect(plain.events[0]).toMatchObject({ type: 'message.posted', dedupeKey: 'slack:msg:C1:8.0' })
  })

  it('reaction_added → reaction.added; own reactions and non-message items are ignored', async () => {
    const r = await deliver(
      envelope({
        type: 'reaction_added',
        user: 'U2',
        reaction: 'thumbsup',
        item_user: BOT_USER,
        item: { type: 'message', channel: 'C1', ts: '1712345000.000100' },
      }),
    )
    expect(r.events[0]).toMatchObject({
      type: 'reaction.added',
      subject: { system: 'slack', id: 'C1/1712345000.000100' },
      actor: { system: 'slack', id: 'U2' },
      text: 'Slack #general U2 reacted :thumbsup: to message 1712345000.000100',
      payload: { reaction: 'thumbsup', item_user: BOT_USER, item_is_own: true, channel_name: 'general' },
    })
    expect(
      (
        await deliver(
          envelope({
            type: 'reaction_added',
            user: BOT_USER,
            reaction: 'eyes',
            item: { type: 'message', channel: 'C1', ts: '1.0' },
          }),
        )
      ).events,
    ).toEqual([])
    expect(
      (await deliver(envelope({ type: 'reaction_added', user: 'U1', reaction: 'eyes', item: { type: 'file', file: 'F1' } })))
        .events,
    ).toEqual([])
  })

  it('DMs to the app → message.direct', async () => {
    slack.channels.set('D1', { id: 'D1', is_member: true, is_im: true, messages: [] })
    const r = await deliver(msg({ channel: 'D1', channel_type: 'im', text: 'can you help?' }))
    expect(r.events[0]).toMatchObject({
      type: 'message.direct',
      subject: { system: 'slack', id: 'D1/1712345000.000100' },
      actor: { system: 'slack', id: 'U1' },
      text: 'Slack DM U1: can you help?',
      payload: { channel_type: 'im' },
    })
    expect(r.events[0]?.payload).not.toHaveProperty('channel_name')
    expect(slack.callsTo('conversations.info')).toHaveLength(0)
    const threaded = await deliver(msg({ channel: 'D1', channel_type: 'im', ts: '2.0', thread_ts: '1.0' }))
    expect(threaded.events[0]).toMatchObject({ type: 'message.direct', subject: { id: 'D1/1.0' }, payload: { is_reply: true } })
  })

  it('group DMs (mpim) are channel messages', async () => {
    const r = await deliver(msg({ channel: 'GMP1', channel_type: 'mpim' }))
    expect(r.events[0]?.type).toBe('message.posted')
    expect(r.events[0]?.text).toBe('Slack #GMP1 U1: hello')
  })

  it('unknown event types map to nothing', async () => {
    expect((await deliver(envelope({ type: 'team_join', user: { id: 'U9' } }))).events).toEqual([])
    expect((await deliver(envelope({ type: 'message', subtype: undefined, channel: 'C1' }))).events).toEqual([])
  })

  it('marks a message that mentions someone else, and not this app, as addressed to others', async () => {
    const payloadOf = async (text: string, ts: string) =>
      (await deliver(msg({ text, ts }))).events[0]?.payload as { addressedToOthers?: boolean; mentions_app?: boolean }
    expect((await payloadOf('<@UOTHERBOT>, build a json viewer', '1700000101.000100')).addressedToOthers).toBe(true)
    expect(
      (await payloadOf(`<@${BOT_USER}> and <@UOTHERBOT>, both of you`, '1700000102.000100')).addressedToOthers,
    ).toBeUndefined()
    expect((await payloadOf('anyone around?', '1700000103.000100')).addressedToOthers).toBeUndefined()
  })

  it('clips long text in the rendering, keeps it whole in the payload', async () => {
    const long = 'x'.repeat(5000)
    const e = (await deliver(msg({ text: long }))).events[0]
    expect(e?.text.length).toBeLessThan(4200)
    expect(e?.text).toContain('… [1000 more characters: read_thread for the rest]')
    expect((e?.payload as { text?: string } | undefined)?.text).toHaveLength(5000)
    // A long request (a spec) fits whole: the router decides and briefs from this text.
    const spec = (await deliver(msg({ text: 'y'.repeat(3000), ts: '1700000077.000100' }))).events[0]
    expect(spec?.text).not.toContain('…')
  })
})

describe('channel names', () => {
  it('are looked up once and cached, also under concurrency', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => deliver(msg({ ts: `${i}.0` }))))
    await deliver(msg({ ts: '9.0' }))
    expect(slack.callsTo('conversations.info')).toHaveLength(1)
  })

  it('expire after the TTL', async () => {
    await deliver(msg({}))
    clock.advance(60 * 60 * 1000 + 1)
    await deliver(msg({}))
    expect(slack.callsTo('conversations.info')).toHaveLength(2)
  })

  it('fall back to the channel id when the lookup fails, without retrying or blocking', async () => {
    slack.script('conversations.info', { status: 429, headers: { 'retry-after': '30' } })
    const r = await deliver(msg({}))
    expect(r.status).toBe(200)
    expect(r.events[0]?.text).toBe('Slack #C1 U1: hello')
    expect(r.events[0]?.payload).not.toHaveProperty('channel_name')
    // A failed lookup is remembered for a minute.
    await deliver(msg({}))
    expect(slack.callsTo('conversations.info')).toHaveLength(1)
    clock.advance(61_000)
    expect((await deliver(msg({}))).events[0]?.text).toBe('Slack #general U1: hello')
  })
})

describe('resolveUser', () => {
  it('returns the handle, email, real name and display name', async () => {
    expect(await slackIntegration.resolveUser?.('U1')).toEqual({
      handle: { system: 'slack', id: 'U1' },
      email: 'ana@example.com',
      name: 'Ana Example',
      displayName: 'ana',
    })
  })
  it('returns null for unknown users and throws other failures', async () => {
    expect(await slackIntegration.resolveUser?.('U404')).toBeNull()
    slack.failWith('users.info', 'missing_scope', 1)
    await expect(slackIntegration.resolveUser?.('U1')).rejects.toThrow(/missing_scope/)
  })
  it('omits missing fields', async () => {
    slack.users.set('U3', { id: 'U3', name: 'nomail' })
    expect(await slackIntegration.resolveUser?.('U3')).toEqual({ handle: { system: 'slack', id: 'U3' }, displayName: 'nomail' })
  })
  it('leaves out a display name equal to the real name, and marks bots and Slackbot', async () => {
    slack.users.set('U5', { id: 'U5', name: 'Same', real_name: 'Same' })
    expect((await slackIntegration.resolveUser?.('U5'))?.displayName).toBeUndefined()
    slack.users.set('UB1', { id: 'UB1', name: 'deploy', real_name: 'Deploy bot', is_bot: true })
    expect(await slackIntegration.resolveUser?.('UB1')).toMatchObject({ bot: true, name: 'Deploy bot' })
    slack.users.set('USLACKBOT', { id: 'USLACKBOT', name: 'slackbot', real_name: 'Slackbot' })
    expect((await slackIntegration.resolveUser?.('USLACKBOT'))?.bot).toBe(true)
  })
})
