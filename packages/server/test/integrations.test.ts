/**
 * The first-party integrations through the composition root: per-employee
 * instances and secrets, tools, webhooks in, actor mapping, and the
 * integration policies. The Slack, Linear and GitLab APIs are faked with a
 * `fetch` stub that records every call (and the token it carried).
 */
import { createHmac } from 'node:crypto'
import { type Json, silentLogger, systemClock } from '@mp/core'
import { solidPng } from '@mp/files'
import { callTools, type ModelRequest, reply, type ScriptResult } from '@mp/model'
import type { ToolContext } from '@mp/tools'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRateLimiter } from '../src/http/webhooks.ts'
import { closingReason, mergeRequestSubject, needsExternalReply } from '../src/integrations/index.ts'
import { type TestApp, testApp, until } from './helpers.ts'
import { type Backend, memoryBackend, quiet, realBackend } from './scenarios.ts'

// ─── Fake APIs ────────────────────────────────────────────────────────────────

interface ApiCall {
  system: 'slack' | 'linear' | 'gitlab'
  method: string
  path: string
  /** The credential the call carried: Slack's bearer token, Linear's key, GitLab's PRIVATE-TOKEN. */
  token: string | null
  body: any
}

const SLACK_API = 'https://slack.test/api'
const LINEAR_API = 'https://linear.test/graphql'
const GITLAB_URL = 'https://gitlab.test'

function fakeApis() {
  const calls: ApiCall[] = []
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const slackUsers: Record<string, { id: string; real_name: string; profile: { email?: string } }> = {}
  const gitlabUsers: Record<string, { id: number; username: string; name: string; public_email?: string }> = {}
  const slackFiles: Record<string, { name: string; mimetype: string; bytes: Uint8Array }> = {}
  let ts = 1_700_000_100

  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init.headers)
    const raw = typeof init.body === 'string' ? init.body : ''
    const type = headers.get('content-type') ?? ''
    const body = type.includes('json') && raw ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
    const method = (init.method ?? 'GET').toUpperCase()

    if (url.origin === new URL(SLACK_API).origin && url.pathname.startsWith('/files-pri/')) {
      calls.push({ system: 'slack', method, path: url.pathname, token: headers.get('authorization'), body: null })
      const f = slackFiles[url.pathname.split('/')[2]!.replace('T1-', '')]
      if (!f) return new Response('not found', { status: 404 })
      return new Response(Buffer.from(f.bytes), { status: 200, headers: { 'content-type': f.mimetype } })
    }
    if (url.origin === new URL(SLACK_API).origin) {
      const name = url.pathname.replace(/^\/api\//, '')
      calls.push({ system: 'slack', method, path: name, token: headers.get('authorization'), body })
      switch (name) {
        case 'auth.test':
          return json({ ok: true, user_id: 'UBOT', bot_id: 'BBOT' })
        case 'conversations.info':
          return json({ ok: true, channel: { id: body.channel, name: 'general' } })
        case 'users.info': {
          const u = slackUsers[body.user]
          return u ? json({ ok: true, user: u }) : json({ ok: false, error: 'user_not_found' })
        }
        case 'chat.postMessage':
          return json({ ok: true, channel: body.channel, ts: `${ts++}.000100` })
        case 'reactions.add':
        case 'chat.update':
          return json({ ok: true, channel: body.channel, ts: body.ts })
        case 'files.info': {
          const f = slackFiles[body.file]
          if (!f) return json({ ok: false, error: 'file_not_found' })
          const download = `${new URL(SLACK_API).origin}/files-pri/T1-${body.file}/download/${encodeURIComponent(f.name)}`
          return json({
            ok: true,
            file: {
              id: body.file,
              name: f.name,
              mimetype: f.mimetype,
              size: f.bytes.byteLength,
              mode: 'hosted',
              url_private_download: download,
            },
          })
        }
        case 'chat.postEphemeral':
          return json({ ok: true, message_ts: `${ts++}.000200` })
        default:
          return json({ ok: false, error: 'unknown_method' })
      }
    }
    if (url.origin === new URL(LINEAR_API).origin) {
      calls.push({ system: 'linear', method, path: url.pathname, token: headers.get('authorization'), body })
      const q = String(body.query ?? '')
      if (q.includes('viewer'))
        return json({
          data: {
            viewer: {
              id: 'lin-user',
              name: 'Bot',
              displayName: 'bot',
              email: 'bot@example.com',
              admin: false,
              organization: { id: 'org', name: 'Acme', urlKey: 'acme' },
            },
          },
        })
      if (q.includes('user(id')) return json({ data: { user: null } })
      return json({ data: {} })
    }
    if (url.origin === GITLAB_URL) {
      const path = url.pathname.replace(/^\/api\/v4/, '')
      calls.push({ system: 'gitlab', method, path, token: headers.get('private-token'), body })
      if (method === 'GET' && path === '/users') {
        const u = gitlabUsers[url.searchParams.get('username') ?? '']
        return json(u ? [{ id: u.id, username: u.username }] : [])
      }
      const byId = /^\/users\/(\d+)$/.exec(path)
      if (method === 'GET' && byId) {
        const u = Object.values(gitlabUsers).find((x) => String(x.id) === byId[1])
        return u ? json(u) : json({ message: '404 Not found' }, 404)
      }
      const mr = /^\/projects\/([^/]+)\/merge_requests$/.exec(path)
      if (method === 'POST' && mr) {
        const project = decodeURIComponent(mr[1]!)
        return json(
          {
            iid: 7,
            project_id: 42,
            title: body.title,
            state: 'opened',
            source_branch: body.source_branch,
            target_branch: body.target_branch,
            web_url: `${GITLAB_URL}/${project}/-/merge_requests/7`,
          },
          201,
        )
      }
      return json({ message: '404 Not found' }, 404)
    }
    throw new Error(`unexpected fetch ${url.href}`)
  }) as typeof globalThis.fetch

  return { fetch, calls, slackUsers, gitlabUsers, slackFiles, reset: () => calls.splice(0) }
}

// ─── Webhook helpers ─────────────────────────────────────────────────────────

const SLACK_SECRET_A = 'slack-signing-secret-a'
const LINEAR_SECRET = 'linear-webhook-secret'
const GITLAB_SECRET = 'gitlab-webhook-secret'

function slackRequest(secret: string, envelope: unknown, badSignature = false) {
  const body = JSON.stringify(envelope)
  const ts = Math.floor(Date.now() / 1000)
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': String(ts),
      'x-slack-signature': badSignature ? `v0=${'0'.repeat(64)}` : sig,
    },
  }
}

/** An interactivity request: form-encoded `payload=`, signed like the Events API. */
function slackForm(secret: string, payload: unknown) {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`
  const ts = Math.floor(Date.now() / 1000)
  return {
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': String(ts),
      'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`,
    },
  }
}

const mention = (eventId: string, user: string, text: string, ts: string) => ({
  type: 'event_callback',
  event_id: eventId,
  api_app_id: 'AAPP',
  team_id: 'T1',
  authorizations: [{ user_id: 'UBOT', is_bot: true }],
  event: { type: 'app_mention', channel: 'C1', user, text, ts },
})

function linearRequest(payload: Record<string, unknown>, delivery: string) {
  const body = JSON.stringify({ ...payload, webhookTimestamp: Date.now() })
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'linear-delivery': delivery,
      'linear-signature': createHmac('sha256', LINEAR_SECRET).update(body).digest('hex'),
    },
  }
}

function gitlabRequest(payload: unknown, uuid: string, token = GITLAB_SECRET) {
  return {
    body: JSON.stringify(payload),
    headers: {
      'content-type': 'application/json',
      'x-gitlab-token': token,
      'x-gitlab-event-uuid': uuid,
      'x-gitlab-event': 'Hook',
    },
  }
}

const gitlabIssue = (iid: number, username: string) => ({
  object_kind: 'issue',
  user: { username },
  project: { path_with_namespace: 'acme/app' },
  object_attributes: { iid, title: 'Rounding bug', action: 'open', state: 'opened', description: 'Totals are off' },
  assignees: [{ username: 'bot' }],
})

const gitlabMerge = (iid: number) => ({
  object_kind: 'merge_request',
  user: { username: 'maintainer' },
  project: { path_with_namespace: 'acme/app' },
  object_attributes: { iid, title: 'Fix rounding', action: 'merge', state: 'merged' },
})

// ─── Script helpers ──────────────────────────────────────────────────────────

type Msg = ModelRequest['messages'][number]
const lastMsg = (req: ModelRequest): Msg => req.messages.at(-1)!
const lastUser = (req: ModelRequest) => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
const lastToolName = (req: ModelRequest): string | undefined => {
  const last = lastMsg(req)
  if (last.role !== 'tool') return undefined
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const call = req.messages[i]!.tool_calls?.find((c) => c.id === last.tool_call_id)
    if (call) return call.function.name.replace(/__/g, '.')
  }
  return undefined
}

const ASK_ARGS = {
  channel: 'C1',
  thread_ts: '1700000050.000100',
  text: 'Which environment?',
  fields: [
    {
      id: 'env',
      label: 'Environment',
      type: 'select',
      options: [
        { value: 'prod', label: 'Production' },
        { value: 'stg', label: 'Staging' },
      ],
    },
    { id: 'note', label: 'Note', type: 'text', optional: true },
  ],
}

/** The scripted employee: acts on each integration's event with that integration's tools. */
const script = async (req: ModelRequest): Promise<ScriptResult> => {
  const tool = lastToolName(req)
  // Asks with a form, then waits in the same run for the answer.
  if (tool === 'mcp.slack.ask') return callTools([{ name: 'sessions.wait', args: { delivery: true } }])
  if (!tool && lastUser(req).includes('interaction.answered')) return reply('Deploying to Production.')
  if (!tool && lastUser(req).includes('please ask')) return callTools([{ name: 'mcp.slack.ask', args: ASK_ARGS }])
  if (tool === 'mcp.slack.react') return reply('Hello Ana, looking into it.')
  if (tool === 'mcp.linear.viewer') return reply('Took PAY-1.')
  if (tool === 'mcp.gitlab.create_merge_request') return reply('Opened the MR.')
  if (tool) return reply('done')
  const text = lastUser(req)
  if (text.includes('merge request merged') || text.includes('moved to Done')) return reply('NO_REPLY')
  if (text.includes('integration:slack') && text.includes('please react'))
    return callTools([{ name: 'mcp.slack.react', args: { channel: 'C1', ts: '1700000000.000100', name: 'eyes' } }])
  if (text.includes('integration:slack')) return reply('NO_REPLY')
  if (text.includes('integration:linear')) return callTools([{ name: 'mcp.linear.viewer', args: {} }])
  if (text.includes('integration:gitlab'))
    return callTools([
      {
        name: 'mcp.gitlab.create_merge_request',
        args: { project: 'acme/app', source_branch: 'mp/rounding', target_branch: 'main', title: 'Fix rounding' },
      },
    ])
  return reply('NO_REPLY')
}

const toolCtx = (employeeId: string): ToolContext => ({
  employeeId,
  sessionId: 'ses_test',
  runId: 'run_test',
  callId: 'call_test',
  idempotencyKey: 'run_test:1:call_test',
  secrets: {},
  signal: new AbortController().signal,
  logger: silentLogger,
  clock: systemClock,
  emit() {},
})

// ─── Suite ───────────────────────────────────────────────────────────────────

function integrationSuite(backend: Backend) {
  let t: TestApp
  let cleanup: () => Promise<void>
  const api = fakeApis()
  let meatless: string
  let kai: string
  let ana: string

  const post = async (path: string, r: { body: string; headers: Record<string, string> }) => {
    const res = await t.a.app.request(path, { method: 'POST', body: r.body, headers: r.headers })
    await t.a.services.integrations!.idle()
    return { status: res.status, text: await res.text() }
  }
  const settle = async () => {
    await t.a.services.integrations!.idle()
    await quiet(t)
  }

  beforeAll(async () => {
    const b = await backend.make()
    cleanup = b.cleanup
    t = await testApp({
      script,
      env: b.env,
      overrides: { integrations: { fetch: api.fetch, baseUrls: { slack: SLACK_API, linear: LINEAR_API, gitlab: GITLAB_URL } } },
    })
    const s = t.a.services
    meatless = (await s.directory.employees.byHandle('meatless'))!.id
    kai = (await s.directory.employees.create({ name: 'Kai', toolAllow: ['**'] })).id
    ana = (await s.directory.contacts.create({ name: 'Ana', kind: 'person', handles: [{ system: 'slack', id: 'U_ANA' }] })).id
    const emp = (id: string) => ({ type: 'employee' as const, id })
    await s.secrets.set('SLACK_BOT_TOKEN', 'xoxb-meatless', emp(meatless))
    await s.secrets.set('SLACK_SIGNING_SECRET', SLACK_SECRET_A, emp(meatless))
    await s.secrets.set('LINEAR_API_KEY', 'lin_api_meatless', emp(meatless))
    await s.secrets.set('LINEAR_WEBHOOK_SECRET', LINEAR_SECRET, emp(meatless))
    // GitLab: tokens per employee, the webhook secret deployment-wide (a group hook).
    await s.secrets.set('GITLAB_TOKEN', 'glpat-meatless', emp(meatless))
    await s.secrets.set('GITLAB_TOKEN', 'glpat-kai', emp(kai))
    await s.secrets.set('GITLAB_WEBHOOK_SECRET', GITLAB_SECRET, { type: 'global' })

    await s.events.triggers.create({
      name: 'Slack: mentions and DMs',
      employeeId: meatless,
      match: { source: 'integration:slack', filter: { type: { $in: ['message.mentioned', 'message.direct'] } } },
      target: { type: 'router' },
      fork: true,
      mode: 'continuing',
    })
    await s.events.triggers.create({
      name: 'Linear: assigned to Meatless',
      employeeId: meatless,
      match: { source: 'integration:linear', type: 'issue.assigned', where: { 'payload.assignee.id': 'lin-meatless' } },
      target: { type: 'router' },
      fork: true,
      mode: 'continuing',
    })
    await s.events.triggers.create({
      name: 'GitLab: new issues',
      employeeId: meatless,
      match: { source: 'integration:gitlab', type: 'issue.opened' },
      target: { type: 'router' },
      fork: true,
      mode: 'continuing',
    })
  }, 30_000)

  afterAll(async () => {
    await t?.close().catch(() => {})
    await cleanup?.().catch(() => {})
  })

  it('registers every integration tool once, with the effect classes of the tables', () => {
    const s = t.a.services
    const names = s.integrations!.toolNames
    expect(names).toContain('mcp.slack.reply')
    expect(names).toContain('mcp.linear.create_issue')
    expect(names).toContain('mcp.gitlab.create_merge_request')
    expect(names.filter((n) => n === 'mcp.slack.reply')).toHaveLength(1)
    const effect = (n: string) => s.tools.get(n)!.def.effect
    expect(effect('mcp.slack.read_thread')).toBe('read')
    expect(effect('mcp.slack.post_message')).toBe('non_idempotent')
    expect(effect('mcp.slack.react')).toBe('idempotent')
    expect(effect('mcp.linear.update_issue')).toBe('idempotent')
    expect(effect('mcp.linear.comment')).toBe('non_idempotent')
    expect(effect('mcp.gitlab.update_merge_request')).toBe('idempotent')
    expect(effect('mcp.gitlab.create_merge_request')).toBe('non_idempotent')
    expect(effect('mcp.gitlab.pipeline_status')).toBe('read')
    // Nothing that merges.
    expect(names.some((n) => /merge_merge|approve|accept/.test(n))).toBe(false)
    // The bootstrap employee allows everything, so its router context has them.
    expect(s.tools.isAllowed('mcp.slack.reply', { allow: ['**'], deny: [] })).toBe(true)
  })

  it("offers an integration's tools only to employees with its token", async () => {
    const s = t.a.services
    const deny = async (id: string) => [...(await s.toolListsFor(id)).deny, ...(await s.integrations!.hiddenToolsFor(id))]
    // Meatless has every token; Kai only GitLab's.
    expect((await deny(meatless)).filter((p) => p.startsWith('mcp.'))).toEqual([])
    expect(await deny(kai)).toEqual(expect.arrayContaining(['mcp.slack.*', 'mcp.linear.*']))
    expect(await deny(kai)).not.toContain('mcp.gitlab.*')
    const lists = { ...(await s.toolListsFor(kai)), deny: await deny(kai) }
    expect(s.tools.isAllowed('mcp.slack.post_message', lists)).toBe(false)
    expect(s.tools.isAllowed('mcp.gitlab.get_project', lists)).toBe(true)
  })

  it('slack end to end: a signed mention is routed to the router, the tool acts with the right bot, and the answer goes back out', async () => {
    const s = t.a.services
    api.reset()
    const r = await post(
      '/webhooks/slack/meatless',
      slackRequest(SLACK_SECRET_A, mention('Ev1', 'U_ANA', '<@UBOT> please react', '1700000000.000100')),
    )
    expect(r.status).toBe(200)
    await settle()

    const [event] = await s.rawEvents.query({ source: 'integration:slack' })
    expect(event!.data).toMatchObject({
      type: 'message.mentioned',
      employeeId: meatless,
      actorContactId: ana,
      subject: { system: 'slack', id: 'C1/1700000000.000100' },
    })
    expect(event!.data.text).toContain('please react')
    // Routed through the trigger to a fork of the router context.
    const runs = await s.sessions.runs({ state: ['completed'] })
    const run = runs.find((x) => x.data.cause.eventId === event!.id)!
    expect(run).toBeTruthy()
    const session = await s.sessions.require(run.data.sessionId)
    expect(session.data.parent?.sessionId).toBe(await s.routerSessionFor(meatless))

    // The instant "on it": the bot reacted :eyes: as soon as the mention set work going.
    // (the scripted model then reacts too: two reactions, the harness's first).
    const reactions = api.calls.filter((c) => c.path === 'reactions.add')
    expect(reactions).toHaveLength(2)
    expect(reactions[0]!.body).toMatchObject({ name: 'eyes' })
    const react = reactions.at(-1)!
    expect(react.token).toBe('Bearer xoxb-meatless')
    expect(react.body).toMatchObject({ channel: 'C1', timestamp: '1700000000.000100', name: 'eyes' })
    // The final text went back to the thread, as the same bot.
    const posted = await until(() => api.calls.find((c) => c.path === 'chat.postMessage'), 'the reply')
    expect(posted.token).toBe('Bearer xoxb-meatless')
    expect(posted.body).toMatchObject({ channel: 'C1', thread_ts: '1700000000.000100', text: 'Hello Ana, looking into it.' })
    // And the session follows the thread from now on.
    const subs = await s.events.subscriptions.forSubject({ system: 'slack', id: 'C1/1700000000.000100' })
    expect(subs.map((x) => x.data.sessionId)).toEqual([session.id])
  })

  it('slack: a NO_REPLY answer posts nothing back', async () => {
    api.reset()
    const r = await post(
      '/webhooks/slack/meatless',
      slackRequest(SLACK_SECRET_A, mention('Ev2', 'U_ANA', 'thanks!', '1700000001.000100')),
    )
    expect(r.status).toBe(200)
    await settle()
    expect(api.calls.filter((c) => c.path === 'chat.postMessage')).toEqual([])
  })

  it('slack ask: a question with inputs, answered in Slack, wakes the session that asked', async () => {
    const s = t.a.services
    api.reset()
    const root = ASK_ARGS.thread_ts
    const r = await post(
      '/webhooks/slack/meatless',
      slackRequest(SLACK_SECRET_A, mention('Ev-ask', 'U_ANA', '<@UBOT> please ask', root)),
    )
    expect(r.status).toBe(200)
    await settle()

    // Posted with blocks; the model got an interaction id, not the question back.
    const posted = api.calls.find((c) => c.path === 'chat.postMessage' && c.body.blocks)!
    expect(posted.body.blocks.map((b: any) => b.type)).toEqual(['section', 'input', 'input', 'actions'])
    const [itr] = (await s.records.query<any>('interaction', { where: { channel: 'C1' } })).items
    expect(itr!.data).toMatchObject({
      employeeId: meatless,
      channel: 'C1',
      ts: expect.any(String),
      threadTs: root,
      status: 'open',
    })
    const waiting = await until(async () => {
      const [run] = await s.sessions.runs({ state: ['suspended'] })
      return run?.data.wait?.type === 'delivery' ? run : undefined
    }, 'the run waiting for the answer')
    expect(itr!.data.sessionId).toBe(waiting.data.sessionId)
    const history = await s.sessions.runHistory(waiting.id)
    const askResult = history.find((e) => e.kind === 'tool_result' && (e.content as any).name === 'mcp.slack.ask')!
    expect((askResult.content as any).output).toMatchObject({
      interactionId: itr!.id,
      ts: itr!.data.ts,
      subject: `slack:C1/${root}`,
    })
    expect((askResult.content as any).output.ask).toBeUndefined()
    // The session follows the thread.
    const subs = await s.events.subscriptions.forSubject({ system: 'slack', id: `C1/${root}` })
    expect(subs.map((x) => x.data.sessionId)).toContain(waiting.data.sessionId)

    // Ana picks Production and presses Submit.
    const click = (user: string) => ({
      type: 'block_actions',
      api_app_id: 'AAPP',
      user: { id: user },
      container: { type: 'message', message_ts: itr!.data.ts, channel_id: 'C1', is_ephemeral: false },
      channel: { id: 'C1', name: 'general' },
      message: { ts: itr!.data.ts, thread_ts: root },
      state: {
        values: {
          'mp_field:env': { env: { type: 'static_select', selected_option: { value: 'prod' } } },
          'mp_field:note': { note: { type: 'plain_text_input', value: 'ship it' } },
        },
      },
      actions: [{ action_id: 'mp_button:submit', block_id: 'mp_actions', type: 'button', value: 'submit', action_ts: '1.2' }],
    })
    const answer = await post('/webhooks/slack/meatless/interactive', slackForm(SLACK_SECRET_A, click('U_ANA')))
    expect(answer).toEqual({ status: 200, text: '' })
    await settle()

    const update = api.calls.find((c) => c.path === 'chat.update')!
    expect(update.token).toBe('Bearer xoxb-meatless')
    expect(update.body).toMatchObject({ channel: 'C1', ts: itr!.data.ts })
    expect(JSON.stringify(update.body.blocks)).toContain('Answered by <@U_ANA>')
    const [event] = await s.rawEvents.query({ source: 'integration:slack', type: 'interaction.answered' })
    expect(event!.data).toMatchObject({
      employeeId: meatless,
      actorContactId: ana,
      subject: { system: 'slack', id: `C1/${root}` },
      payload: { interactionId: itr!.id, values: { env: 'prod', note: 'ship it' }, button: 'submit', answeredBy: 'U_ANA' },
    })
    const stored = (await s.records.get<any>('interaction', itr!.id))!.data
    expect(stored).toMatchObject({ status: 'answered', answeredBy: 'U_ANA', answeredByContactId: ana, eventId: event!.id })
    // The waiting run woke with the answer, and finished.
    const done = await until(async () => {
      const run = await s.sessions.getRun(waiting.id)
      return run?.data.state === 'completed' ? run : undefined
    }, 'the woken run')
    expect(done.data.result?.output).toBe('Deploying to Production.')
    const after = await s.sessions.runHistory(waiting.id)
    const delivered = after.find((e) => e.kind === 'event' && (e.content as any).type === 'interaction.answered')!
    expect((delivered.content as any).expectedToAct).toBe(true)
    expect((delivered.content as any).text).toContain('Environment: Production [prod]')

    // A second click changes nothing; a click on another message and a bad signature neither.
    api.reset()
    expect((await post('/webhooks/slack/meatless/interactive', slackForm(SLACK_SECRET_A, click('U_ANA')))).status).toBe(200)
    const other = { ...click('U_ANA'), container: { type: 'message', message_ts: '1699999999.000100', channel_id: 'C1' } }
    expect((await post('/webhooks/slack/meatless/interactive', slackForm(SLACK_SECRET_A, other))).status).toBe(200)
    expect((await post('/webhooks/slack/meatless/interactive', slackForm('not-the-secret', click('U_ANA')))).status).toBe(401)
    await settle()
    expect(api.calls.filter((c) => c.path === 'chat.update')).toEqual([])
    expect(await s.rawEvents.query({ source: 'integration:slack', type: 'interaction.answered' })).toHaveLength(1)
  })

  it('slack get_file: the server downloads the file into the employee’s files; the model gets the path', async () => {
    const s = t.a.services
    api.reset()
    api.slackFiles.F9 = { name: 'q3 report.csv', mimetype: 'text/csv', bytes: new TextEncoder().encode('a,b\n1,2\n') }
    api.slackFiles.F10 = { name: 'shot.png', mimetype: 'image/png', bytes: solidPng(2, 2, [255, 0, 0, 255]) }
    const r = await s.tools.execute('mcp.slack.get_file', { file_id: 'F9' }, toolCtx(meatless))
    expect(r.isError).toBeFalsy()
    expect(r.output).toEqual({
      path: '/slack/F9-q3_report.csv',
      name: 'q3 report.csv',
      mime: 'text/csv',
      size: 8,
      text: 'a,b\n1,2\n',
    })
    const saved = await s.files.read(meatless, '/slack/F9-q3_report.csv')
    expect(saved.content).toBe('a,b\n1,2\n')
    const download = api.calls.find((c) => c.path.startsWith('/files-pri/'))!
    expect(download.token).toBe('Bearer xoxb-meatless')

    const img = await s.tools.execute('mcp.slack.get_file', { file_id: 'F10' }, toolCtx(meatless))
    expect(img.output).toMatchObject({ path: '/slack/F10-shot.png', mime: 'image/png' })
    expect((img.output as any).text).toBeUndefined()
    expect((await s.files.read(meatless, '/slack/F10-shot.png')).encoding).toBe('base64')

    const missing = await s.tools.execute('mcp.slack.get_file', { file_id: 'F404' }, toolCtx(meatless))
    expect(missing).toMatchObject({ isError: true, output: { error: 'not_found' } })
    // Kai has no Slack token.
    const none = await s.tools.execute('mcp.slack.get_file', { file_id: 'F9' }, toolCtx(kai))
    expect(none.isError).toBe(true)
  })

  it('a bad signature gets 401 and nothing is ingested', async () => {
    const s = t.a.services
    const before = (await s.rawEvents.query({ source: 'integration:slack' })).length
    const bad = await post(
      '/webhooks/slack/meatless',
      slackRequest(SLACK_SECRET_A, mention('Ev-bad', 'U_ANA', 'hi', '1700000002.000100'), true),
    )
    expect(bad.status).toBe(401)
    // Signed with another employee's (or no) secret: also refused.
    const wrong = await post('/webhooks/slack/meatless', slackRequest('not-the-secret', mention('Ev-bad2', 'U_ANA', 'hi', '1.2')))
    expect(wrong.status).toBe(401)
    const gl = await post('/webhooks/gitlab', gitlabRequest(gitlabIssue(99, 'mallory'), 'uuid-bad', 'wrong-token'))
    expect(gl.status).toBe(401)
    expect((await s.rawEvents.query({ source: 'integration:slack' })).length).toBe(before)
    expect((await s.rawEvents.query({ source: 'integration:gitlab' })).some((e) => (e.data.payload as any)?.iid === 99)).toBe(
      false,
    )
  })

  it('webhook URLs: unknown integrations and employees are 404, and so is a URL whose secret is not set', async () => {
    const r1 = await post('/webhooks/jira', { body: '{}', headers: {} })
    expect(r1.status).toBe(404)
    const r2 = await post('/webhooks/slack/nobody', slackRequest(SLACK_SECRET_A, mention('Ev3', 'U_ANA', 'hi', '1.3')))
    expect(r2.status).toBe(404)
    // Slack has no deployment-wide signing secret, and Kai has none of its own.
    const r3 = await post('/webhooks/slack', slackRequest(SLACK_SECRET_A, mention('Ev4', 'U_ANA', 'hi', '1.4')))
    expect(r3.status).toBe(404)
    expect(r3.text).toContain('SLACK_SIGNING_SECRET')
    const r4 = await post(`/webhooks/slack/${kai}`, slackRequest(SLACK_SECRET_A, mention('Ev5', 'U_ANA', 'hi', '1.5')))
    expect(r4.status).toBe(404)
  })

  it('slack url_verification is answered with the challenge', async () => {
    const res = await t.a.app.request('/webhooks/slack/meatless', {
      method: 'POST',
      ...slackRequest(SLACK_SECRET_A, { type: 'url_verification', challenge: 'abc123' }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc123')
  })

  it('bodies over 1 MB are refused', async () => {
    const res = await t.a.app.request('/webhooks/slack/meatless', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })
    expect(res.status).toBe(413)
  })

  it('linear end to end: an assignment to the employee starts work, and the tool uses its own API key', async () => {
    const s = t.a.services
    api.reset()
    const r = await post(
      `/webhooks/linear/${meatless}`,
      linearRequest(
        {
          type: 'Issue',
          action: 'create',
          actor: { id: 'lin-ana', name: 'Ana' },
          data: {
            id: 'issue-1',
            identifier: 'PAY-1',
            title: 'Refunds fail',
            state: { name: 'Todo', type: 'unstarted' },
            assignee: { id: 'lin-meatless', name: 'Meatless', email: 'meatless@example.com' },
          },
        },
        'delivery-1',
      ),
    )
    expect(r.status).toBe(200)
    await settle()
    const events = await s.rawEvents.query({ source: 'integration:linear' })
    expect(events.map((e) => e.data.type).sort()).toEqual(['issue.assigned', 'issue.created'])
    expect(events.every((e) => e.data.employeeId === meatless)).toBe(true)
    const viewer = api.calls.find((c) => c.system === 'linear' && String(c.body.query).includes('viewer'))!
    expect(viewer.token).toBe('lin_api_meatless')
  })

  it('linear: an issue moved to a completed state ends the subscriptions to it', async () => {
    const s = t.a.services
    const session = await s.sessions.create({ employeeId: meatless, title: 'PAY-1 work', toolset: [] })
    await s.events.subscriptions.subscribe(session.id, { system: 'linear', id: 'PAY-1' }, { primary: true })
    const r = await post(
      `/webhooks/linear/${meatless}`,
      linearRequest(
        {
          type: 'Issue',
          action: 'update',
          actor: { id: 'lin-ana', name: 'Ana' },
          updatedFrom: { stateId: 'st-todo' },
          data: {
            id: 'issue-1',
            identifier: 'PAY-1',
            title: 'Refunds fail',
            stateId: 'st-done',
            state: { name: 'Done', type: 'completed' },
          },
        },
        'delivery-2',
      ),
    )
    expect(r.status).toBe(200)
    await settle()
    await until(async () => (await s.events.subscriptions.forSubject({ system: 'linear', id: 'PAY-1' })).length === 0, 'ended')
    const ended = await s.events.subscriptions.forSession(session.id)
    expect(ended).toEqual([])
  })

  it('gitlab end to end: a deployment-wide hook, the employee’s own token, and the MR subscription after create_merge_request', async () => {
    const s = t.a.services
    api.reset()
    api.gitlabUsers.bob = { id: 5, username: 'bob', name: 'Bob', public_email: 'bob@example.com' }
    const bob = await s.directory.contacts.create({ name: 'Bob', kind: 'person', email: 'bob@example.com' })

    const r = await post('/webhooks/gitlab', gitlabRequest(gitlabIssue(3, 'bob'), 'uuid-issue-3'))
    expect(r.status).toBe(200)
    await settle()

    const event = (await s.rawEvents.query({ source: 'integration:gitlab', type: 'issue.opened' })).at(-1)!
    expect(event.data.employeeId).toBeUndefined()
    // No handle matched, so the user was looked up and matched by email, and the handle recorded.
    expect(event.data.actorContactId).toBe(bob.id)
    expect((await s.directory.contacts.require(bob.id)).data.handles).toContainEqual({ system: 'gitlab', id: 'bob' })
    expect(await s.directory.contacts.byHandle('gitlab', 'bob')).toMatchObject({ id: bob.id })

    const create = api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/merge_requests'))!
    expect(create.token).toBe('glpat-meatless')
    expect(create.body).toMatchObject({ source_branch: 'mp/rounding', target_branch: 'main', title: 'Fix rounding' })

    const run = (await s.sessions.runs({ state: ['completed'] })).find((x) => x.data.cause.eventId === event.id)!
    const subs = await s.events.subscriptions.forSubject({ system: 'gitlab', id: 'acme/app!7' })
    expect(subs.map((x) => [x.data.sessionId, x.data.primary])).toEqual([[run.data.sessionId, true]])

    // The MR is merged: the event is delivered to the session, then its subscriptions end.
    api.reset()
    const merged = await post('/webhooks/gitlab', gitlabRequest(gitlabMerge(7), 'uuid-merge-7'))
    expect(merged.status).toBe(200)
    await settle()
    const mergedEvent = (await s.rawEvents.query({ source: 'integration:gitlab', type: 'merge_request.merged' })).at(-1)!
    const delivered = (await s.sessions.runs({ sessionId: run.data.sessionId })).some(
      (x) => x.data.cause.eventId === mergedEvent.id,
    )
    expect(delivered).toBe(true)
    await until(
      async () => (await s.events.subscriptions.forSubject({ system: 'gitlab', id: 'acme/app!7' })).length === 0,
      'ended',
    )
  })

  it('actors: an unknown user with no matching email maps to nobody, and no contact is created', async () => {
    const s = t.a.services
    const count = (await s.directory.contacts.list({ limit: 500 })).items.length
    const r = await post('/webhooks/gitlab', gitlabRequest(gitlabIssue(4, 'stranger'), 'uuid-issue-4'))
    expect(r.status).toBe(200)
    await settle()
    const event = (await s.rawEvents.query({ source: 'integration:gitlab', type: 'issue.opened' })).find(
      (e) => (e.data.payload as any)?.iid === 4,
    )!
    expect(event.data.actorContactId).toBeUndefined()
    expect((await s.directory.contacts.list({ limit: 500 })).items.length).toBe(count)
  })

  it('two employees with different tokens: each call uses its own', async () => {
    const s = t.a.services
    api.reset()
    const args = { project: 'acme/app', source_branch: 'mp/x', target_branch: 'main', title: 'X' }
    const a = await s.tools.execute('mcp.gitlab.create_merge_request', args, toolCtx(meatless))
    const b = await s.tools.execute('mcp.gitlab.create_merge_request', args, toolCtx(kai))
    expect(a.isError).toBeFalsy()
    expect(b.isError).toBeFalsy()
    expect((a.output as any).web_url).toBe(`${GITLAB_URL}/acme/app/-/merge_requests/7`)
    expect(api.calls.map((c) => c.token)).toEqual(['glpat-meatless', 'glpat-kai'])
  })

  it('a missing secret gives a clear error', async () => {
    const s = t.a.services
    api.reset()
    const r = await s.tools.execute('mcp.slack.post_message', { channel: 'C1', text: 'hi' }, toolCtx(kai))
    expect(r.isError).toBe(true)
    expect(r.output).toEqual({ error: "Slack isn't set up for this employee: set the SLACK_BOT_TOKEN secret" })
    const l = await s.tools.execute('mcp.linear.viewer', {}, toolCtx(kai))
    expect((l.output as any).error).toBe("Linear isn't set up for this employee: set the LINEAR_API_KEY secret")
    expect(api.calls).toEqual([])
  })

  it('a deployment-wide secret is the fallback, and a changed secret takes effect at once', async () => {
    const s = t.a.services
    api.reset()
    await s.secrets.set('SLACK_BOT_TOKEN', 'xoxb-global', { type: 'global' })
    await s.bus.idle()
    await s.tools.execute('mcp.slack.post_message', { channel: 'C1', text: 'one' }, toolCtx(kai))
    await s.secrets.set('SLACK_BOT_TOKEN', 'xoxb-kai', { type: 'employee', id: kai })
    await s.bus.idle()
    await s.tools.execute('mcp.slack.post_message', { channel: 'C1', text: 'two' }, toolCtx(kai))
    // Meatless keeps its own.
    await s.tools.execute('mcp.slack.post_message', { channel: 'C1', text: 'three' }, toolCtx(meatless))
    expect(api.calls.map((c) => [c.body.text, c.token])).toEqual([
      ['one', 'Bearer xoxb-global'],
      ['two', 'Bearer xoxb-kai'],
      ['three', 'Bearer xoxb-meatless'],
    ])
    await s.secrets.delete('SLACK_BOT_TOKEN', { type: 'global' })
    await s.secrets.delete('SLACK_BOT_TOKEN', { type: 'employee', id: kai })
    await s.bus.idle()
  })

  it("the employee's tool deny list still applies", async () => {
    const s = t.a.services
    await s.directory.employees.update(kai, { toolDeny: ['mcp.slack.*'] })
    const lists = await until(async () => {
      const l = await s.toolListsFor(kai)
      return l.deny.length ? l : null
    })
    expect(s.tools.isAllowed('mcp.slack.post_message', lists)).toBe(false)
    expect(s.tools.isAllowed('mcp.gitlab.get_project', lists)).toBe(true)
  })
}

describe('integrations (memory)', () => integrationSuite(memoryBackend))

const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL
describe.skipIf(!DATABASE_URL || !REDIS_URL)('integrations (postgres+bullmq)', () =>
  integrationSuite(realBackend(DATABASE_URL!, REDIS_URL!)),
)

// ─── Units ───────────────────────────────────────────────────────────────────

describe('integration helpers', () => {
  it('closingReason: merged and closed MRs, removed and finished Linear issues', () => {
    const subject = { system: 'x', id: '1' }
    const ev = (source: string, type: string, payload: Json = {}) => ({ source, type, payload, subject })
    expect(closingReason(ev('integration:gitlab', 'merge_request.merged'))).toBe('merge request merged')
    expect(closingReason(ev('integration:gitlab', 'merge_request.closed'))).toBe('merge request closed')
    expect(closingReason(ev('integration:gitlab', 'merge_request.updated'))).toBeNull()
    expect(closingReason(ev('integration:linear', 'issue.removed'))).toBe('issue removed')
    expect(closingReason(ev('integration:linear', 'issue.state_changed', { stateType: 'canceled' }))).toBe('issue canceled')
    expect(closingReason(ev('integration:linear', 'issue.state_changed', { stateType: 'started' }))).toBeNull()
    expect(closingReason({ source: 'integration:gitlab', type: 'merge_request.merged', payload: {} })).toBeNull()
  })

  it('mergeRequestSubject: from web_url, also under a sub-path', () => {
    expect(mergeRequestSubject({ iid: 12, web_url: 'https://gitlab.com/acme/platform/billing/-/merge_requests/12' })).toEqual({
      system: 'gitlab',
      id: 'acme/platform/billing!12',
    })
    expect(
      mergeRequestSubject(
        { iid: 3, web_url: 'https://git.example.com/gitlab/acme/app/-/merge_requests/3' },
        'https://git.example.com/gitlab',
      ),
    ).toEqual({ system: 'gitlab', id: 'acme/app!3' })
    expect(mergeRequestSubject({ iid: 3 })).toBeNull()
    expect(mergeRequestSubject('text')).toBeNull()
  })

  it('needsExternalReply: asked, final text, no answer tool and no hand-off', () => {
    const event = (source: string, expectedToAct: boolean) => ({ kind: 'event', content: { source, expectedToAct } }) as any
    const result = (name: string, isError = false) => ({ kind: 'tool_result', content: { name, isError, output: {} } }) as any
    const tools = ['mcp.slack.reply', 'mcp.slack.post_message']
    const src = 'integration:slack'
    expect(needsExternalReply([event(src, true)], 'hi', src, tools)).toBe(true)
    expect(needsExternalReply([event(src, false)], 'hi', src, tools)).toBe(false)
    expect(needsExternalReply([event('chat', true)], 'hi', src, tools)).toBe(false)
    expect(needsExternalReply([event(src, true)], 'NO_REPLY: just thanks', src, tools)).toBe(false)
    expect(needsExternalReply([event(src, true)], '  ', src, tools)).toBe(false)
    expect(needsExternalReply([event(src, true), result('mcp.slack.reply')], 'hi', src, tools)).toBe(false)
    expect(needsExternalReply([event(src, true), result('mcp.slack.reply', true)], 'hi', src, tools)).toBe(true)
    expect(needsExternalReply([event(src, true), result('mcp.slack.read_thread')], 'hi', src, tools)).toBe(true)
    expect(needsExternalReply([event(src, true), result('sessions.fork')], 'hi', src, tools)).toBe(false)
  })

  it('the webhook rate limiter counts per key and per minute', () => {
    let now = 0
    const limiter = createRateLimiter(2, { now: () => now, iso: () => new Date(now).toISOString() })
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a'), limiter.hit('b')]).toEqual([true, true, false, true])
    now += 60_000
    expect(limiter.hit('a')).toBe(true)
  })
})
