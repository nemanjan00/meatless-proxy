/**
 * The employee page's server side (src/setup, src/provision.ts): creating and provisioning
 * employees, the SSH key endpoint, and the guided setup of Slack, GitLab and Linear, checked
 * live against fake APIs (an injected `fetch`; nothing real is ever called).
 */
import { signSlackRequest } from '@mp/integration-slack'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { provisionEmployee } from '../src/provision.ts'
import { SLACK_BOT_SCOPES, slackManifest } from '../src/setup/slack.ts'
import { isProtected } from '../src/setup/gitlab.ts'
import { sshFingerprint } from '../src/ssh.ts'
import { type TestApp, testApp } from './helpers.ts'
import { type Backend, memoryBackend, realBackend } from './scenarios.ts'

const SLACK_API = 'https://slack.test/api'
const LINEAR_API = 'https://linear.test/graphql'
const GITLAB_URL = 'https://gitlab.test'
const PUBLIC_URL = 'https://mp.example.com'
const SIGNING = 'abcdef0123456789abcdef0123456789'

// ─── Fake Slack, GitLab and Linear ────────────────────────────────────────────

interface FakeKey {
  id: number
  title: string
  key: string
  userId: number
}

function fakeWorld() {
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
  const w = {
    calls: [] as { system: string; method: string; path: string }[],
    slack: {
      scopes: [...SLACK_BOT_SCOPES],
      channels: [{ id: 'C1', name: 'billing', is_private: false }] as { id: string; name: string; is_private: boolean }[],
      tokens: { 'xoxb-good': { user: 'billing', user_id: 'UBILL', team: 'Acme', url: 'https://acme.slack.test/' } } as Record<
        string,
        { user: string; user_id: string; team: string; url: string }
      >,
    },
    gitlab: {
      users: {
        'glpat-good': {
          id: 7,
          username: 'billing-bot',
          name: 'Billing Bot (AI)',
          bot: true,
          avatar_url: 'https://gitlab.test/a.png',
        },
        'glpat-readonly': { id: 7, username: 'billing-bot', bot: true },
        'glpat-other': { id: 8, username: 'someone-else' },
      } as Record<
        string,
        { id: number; username: string; name?: string; bot?: boolean; avatar_url?: string; is_admin?: boolean }
      >,
      scopes: { 'glpat-good': ['api'], 'glpat-readonly': ['read_api'], 'glpat-other': ['api'] } as Record<string, string[]>,
      expiresAt: '2099-01-01' as string | null,
      keys: [] as FakeKey[],
      nextKeyId: 1,
      projects: [
        {
          id: 42,
          name: 'billing',
          description: 'Invoices and payments.',
          path_with_namespace: 'acme/billing',
          default_branch: 'main',
          web_url: 'https://gitlab.test/acme/billing',
          http_url_to_repo: 'https://gitlab.test/acme/billing.git',
          ssh_url_to_repo: 'git@gitlab.test:acme/billing.git',
          permissions: { project_access: { access_level: 30 }, group_access: null },
        },
      ] as any[],
      protected: { 42: ['main'] } as Record<number, string[]>,
    },
    linear: {
      keys: {
        lin_api_good: { id: 'lin-bill', name: 'Billing Bot', displayName: 'billing', email: 'billing@example.com' },
      } as Record<string, { id: string; name: string; displayName: string; email: string }>,
      admin: true,
      webhooks: [] as { id: string; url: string; secret?: string }[],
    },
  }

  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init.headers)
    const method = (init.method ?? 'GET').toUpperCase()
    const raw = typeof init.body === 'string' ? init.body : ''
    if (url.origin === new URL(SLACK_API).origin) {
      const name = url.pathname.replace(/^\/api\//, '')
      w.calls.push({ system: 'slack', method, path: name })
      const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '')
      const who = w.slack.tokens[token]
      if (!who) return json({ ok: false, error: 'invalid_auth' })
      if (name === 'auth.test')
        return json({ ok: true, ...who, team_id: 'T1', bot_id: 'B1' }, 200, { 'x-oauth-scopes': w.slack.scopes.join(',') })
      if (name === 'users.conversations') return json({ ok: true, channels: w.slack.channels })
      return json({ ok: false, error: 'unknown_method' })
    }
    if (url.origin === GITLAB_URL) {
      const path = url.pathname.replace(/^\/api\/v4/, '')
      w.calls.push({ system: 'gitlab', method, path })
      const token = headers.get('private-token') ?? ''
      const user = w.gitlab.users[token]
      if (!user) return json({ message: '401 Unauthorized' }, 401)
      if (method === 'GET' && path === '/user') return json(user)
      if (method === 'GET' && path === '/personal_access_tokens/self')
        return json({ name: 'mp', scopes: w.gitlab.scopes[token], expires_at: w.gitlab.expiresAt, active: true })
      if (method === 'GET' && path === '/user/keys')
        return json(w.gitlab.keys.filter((k) => k.userId === user.id).map(({ userId: _u, ...k }) => k))
      if (method === 'POST' && path === '/user/keys') {
        const body = JSON.parse(raw) as { title: string; key: string }
        if (w.gitlab.keys.some((k) => sshFingerprint(k.key) === sshFingerprint(body.key)))
          return json({ message: { key: ['has already been taken'], fingerprint_sha256: ['has already been taken'] } }, 400)
        const k = { id: w.gitlab.nextKeyId++, title: body.title, key: body.key, userId: user.id }
        w.gitlab.keys.push(k)
        return json({ id: k.id, title: k.title, key: k.key }, 201)
      }
      const del = /^\/user\/keys\/(\d+)$/.exec(path)
      if (method === 'DELETE' && del) {
        w.gitlab.keys = w.gitlab.keys.filter((k) => !(k.id === Number(del[1]) && k.userId === user.id))
        return new Response(null, { status: 204 })
      }
      if (method === 'GET' && path === '/projects') return json(w.gitlab.projects)
      const one = /^\/projects\/(\d+)$/.exec(path)
      if (method === 'GET' && one) {
        const p = w.gitlab.projects.find((x) => x.id === Number(one[1]))
        return p ? json(p) : json({ message: '404 Project Not Found' }, 404)
      }
      const pb = /^\/projects\/(\d+)\/protected_branches$/.exec(path)
      if (method === 'GET' && pb) return json((w.gitlab.protected[Number(pb[1])] ?? []).map((name) => ({ name })))
      return json({ message: '404 Not found' }, 404)
    }
    if (url.origin === new URL(LINEAR_API).origin) {
      w.calls.push({ system: 'linear', method, path: url.pathname })
      const viewer = w.linear.keys[headers.get('authorization') ?? '']
      if (!viewer)
        return json(
          { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error' } }] },
          400,
        )
      const body = JSON.parse(raw) as { query: string; variables?: any }
      if (body.query.includes('viewer')) return json({ data: { viewer, organization: { name: 'Acme', urlKey: 'acme' } } })
      if (body.query.includes('webhooks('))
        return json({ data: { webhooks: { nodes: w.linear.webhooks.map(({ id, url }) => ({ id, url })) } } })
      if (body.query.includes('webhookCreate')) {
        if (!w.linear.admin)
          return json({ errors: [{ message: 'Forbidden: admin required', extensions: { type: 'forbidden' } }] })
        const input = body.variables.input
        w.linear.webhooks.push({ id: `wh${w.linear.webhooks.length + 1}`, url: input.url, secret: input.secret })
        return json({ data: { webhookCreate: { success: true } } })
      }
      return json({ data: {} })
    }
    throw new Error(`unexpected fetch ${url.href}`)
  }) as typeof globalThis.fetch

  return { ...w, fetch, world: w }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

function setupSuite(backend: Backend) {
  let t: TestApp
  let cleanup: () => Promise<void>
  let fake: ReturnType<typeof fakeWorld>
  let member: Record<string, string>
  let n = 0

  beforeAll(async () => {
    const b = await backend.make()
    cleanup = b.cleanup
    fake = fakeWorld()
    t = await testApp({
      env: { ...b.env, PUBLIC_URL },
      overrides: {
        integrations: {
          fetch: (...a) => fake.fetch(...a),
          baseUrls: { slack: SLACK_API, linear: LINEAR_API, gitlab: GITLAB_URL },
        },
      },
    })
    const c = await t.a.services.directory.contacts.create({ name: 'Mia', kind: 'person' })
    member = await t.as(c.id, { access: 'member' })
  })
  afterAll(async () => {
    await t?.close()
    await cleanup?.()
  })

  /** A fresh employee per test, with a fresh fake world. */
  let emp: string
  beforeEach(async () => {
    const w = fakeWorld()
    Object.assign(fake, w)
    const r = await t.req('POST', '/api/employees', { name: `Billing ${++n}` })
    expect(r.status).toBe(201)
    emp = r.body.employee.id
  })

  const status = async (name: string, refresh = true) => {
    const r = await t.req('GET', `/api/employees/${emp}/integrations${refresh ? '?refresh=1' : ''}`)
    expect(r.status).toBe(200)
    return r.body.integrations.find((i: any) => i.name === name)
  }
  const stepOf = (i: any, id: string) => i.steps.find((s: any) => s.id === id)
  const setSecrets = (name: string, values: Record<string, string>, headers?: Record<string, string>) =>
    t.req('POST', `/api/employees/${emp}/integrations/${name}/secrets`, { values }, headers)
  const act = (name: string, action: string, input: unknown = {}, headers?: Record<string, string>) =>
    t.req('POST', `/api/employees/${emp}/integrations/${name}/actions/${action}`, input, headers)
  const ownSecrets = async () =>
    (await t.a.services.secrets.list()).filter((m) => m.scope.type === 'employee' && m.scope.id === emp).map((m) => m.name)

  describe('employees', () => {
    it('creates an employee with everything the first one gets', async () => {
      const s = t.a.services
      const r = await t.req('POST', '/api/employees', {
        name: 'Research Bot',
        handle: 'research',
        role: 'Researcher',
        description: 'Reads papers.',
        personality: 'Curious.',
        model: 'kimi-test',
      })
      expect(r.status).toBe(201)
      const e = r.body.employee
      expect(e.key).toBe('research')
      expect(e.data).toMatchObject({ name: 'Research Bot', personality: 'Curious.', model: 'kimi-test' })
      expect(e.data.sshPublicKey).toMatch(/^ssh-ed25519 /)
      const router = await s.sessions.require(r.body.routerSessionId)
      expect(router.data.meta).toMatchObject({ role: 'router' })
      expect(router.data.employeeId).toBe(e.id)
      expect(Object.keys(r.body.channels).sort()).toEqual(['general', 'requests-research'])
      const members = await s.chat.members(r.body.channels['requests-research'])
      expect(members.some((m) => m.kind === 'employee' && m.id === e.id)).toBe(true)
      expect((await s.chat.members(r.body.channels.general)).some((m) => m.id === e.id)).toBe(true)
      const trigger = await s.events.triggers.get(r.body.triggerId)
      expect(trigger?.data).toMatchObject({ employeeId: e.id, target: { type: 'router' }, fork: false, mode: 'ephemeral' })
      const contact = await s.directory.employees.contact(e.id)
      expect(contact.data).toMatchObject({ role: 'Researcher', bio: 'Reads papers.' })
    })

    it('rejects a taken handle, and only admins create employees', async () => {
      expect((await t.req('POST', '/api/employees', { name: 'Someone', handle: 'research-dup' })).status).toBe(201)
      const dup = await t.req('POST', '/api/employees', { name: 'Other', handle: 'research-dup' })
      expect(dup.status).toBe(409)
      expect((await t.req('POST', '/api/employees', { name: 'Nope' }, member)).status).toBe(403)
      expect((await t.req('POST', '/api/employees', {})).status).toBe(400)
    })

    it('a double click creates one employee with one router session', async () => {
      const [a, b] = await Promise.all([
        t.req('POST', '/api/employees', { name: 'Twin Bot' }),
        t.req('POST', '/api/employees', { name: 'Twin Bot' }),
      ])
      expect([a.status, b.status].sort()).toEqual([201, 409])
      const id = (a.status === 201 ? a : b).body.employee.id
      const routers = (await t.a.services.records.query<any>('session', { where: { employeeId: id } })).items.filter(
        (x) => x.data.meta?.role === 'router',
      )
      expect(routers).toHaveLength(1)
      const twins = (await t.a.services.directory.employees.list()).items.filter((x) => x.data.name === 'Twin Bot')
      expect(twins).toHaveLength(1)
    })

    it('provisioning is idempotent, also when it runs concurrently', async () => {
      const s = t.a.services
      const actor = { type: 'system' as const, id: 'test' }
      const e = await s.directory.employees.create({ name: 'Plain Bot', toolAllow: ['**'] })
      const runs = await Promise.all([1, 2, 3, 4].map(() => provisionEmployee(s, e.id, actor)))
      expect(new Set(runs.map((r) => r.routerSessionId)).size).toBe(1)
      expect(runs.filter((r) => r.created)).toHaveLength(1)
      const again = await provisionEmployee(s, e.id, actor)
      expect(again.created).toBe(false)
      expect(again.routerSessionId).toBe(runs[0]!.routerSessionId)
      const routers = (await s.records.query<any>('session', { where: { employeeId: e.id } })).items.filter(
        (x) => x.data.meta?.role === 'router',
      )
      expect(routers).toHaveLength(1)
      expect((await s.events.triggers.list({ employeeId: e.id })).length).toBe(1)
      expect((await s.chat.listChannels()).filter((c) => c.data.name === 'requests-plain-bot')).toHaveLength(1)
    })

    it('shows the SSH key with its fingerprint to members, and admins rotate it', async () => {
      const r = await t.req('GET', `/api/employees/${emp}/ssh-key`, undefined, member)
      expect(r.status).toBe(200)
      expect(r.body.publicKey).toMatch(/^ssh-ed25519 /)
      expect(r.body.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
      expect(r.body.createdAt).toBeTruthy()
      expect((await t.req('POST', `/api/employees/${emp}/ssh-key`, {}, member)).status).toBe(403)
      const rotated = await t.req('POST', `/api/employees/${emp}/ssh-key`, {})
      expect(rotated.status).toBe(200)
      expect(rotated.body.publicKey).not.toBe(r.body.publicKey)
      expect((await t.req('GET', `/api/employees/${emp}/ssh-key`)).body.fingerprint).not.toBe(r.body.fingerprint)
    })

    it('members read the setup status but can’t change it', async () => {
      expect((await t.req('GET', `/api/employees/${emp}/integrations`, undefined, member)).status).toBe(200)
      expect((await setSecrets('slack', { SLACK_BOT_TOKEN: 'xoxb-good' }, member)).status).toBe(403)
      expect((await t.req('GET', `/api/employees/${emp}/integrations/slack/manifest`, undefined, member)).status).toBe(403)
      expect((await t.req('POST', `/api/employees/${emp}/integrations/slack/actions/add-trigger`, {}, member)).status).toBe(403)
    })

    it('404s for an unknown employee, integration or action', async () => {
      expect((await t.req('GET', '/api/employees/emp_nope/integrations')).status).toBe(404)
      expect((await act('jira', 'add-trigger')).status).toBe(404)
      expect((await act('slack', 'explode')).status).toBe(404)
      expect((await setSecrets('slack', { GITLAB_TOKEN: 'x' })).status).toBe(400)
    })
  })

  describe('Slack', () => {
    it('starts not set up, with the manifest for this employee', async () => {
      const slack = await status('slack')
      expect(slack.state).toBe('not_set_up')
      const app = stepOf(slack, 'app')
      expect(app.status).toBe('todo')
      expect(app.data.requestUrl).toBe(`${PUBLIC_URL}/webhooks/slack/${emp}`)
      expect(app.data.createUrl).toContain('https://api.slack.com/apps?new_app=1&manifest_json=')
      const m = await t.req('GET', `/api/employees/${emp}/integrations/slack/manifest`)
      expect(m.body.manifest.settings.event_subscriptions.request_url).toBe(`${PUBLIC_URL}/webhooks/slack/${emp}`)
      expect(m.body.manifest.oauth_config.scopes.bot).toEqual(SLACK_BOT_SCOPES)
      expect(m.body.manifest.settings.interactivity).toEqual({
        is_enabled: true,
        request_url: `${PUBLIC_URL}/webhooks/slack/${emp}/interactive`,
      })
      expect(m.body.interactivityUrl).toBe(`${PUBLIC_URL}/webhooks/slack/${emp}/interactive`)
      expect(stepOf(slack, 'interactivity')).toMatchObject({ status: 'todo', data: { optional: true } })
      expect(m.body.manifest.display_information.name).toMatch(/^Billing \d+$/)
      expect(decodeURIComponent(m.body.createUrl.split('manifest_json=')[1])).toBe(JSON.stringify(m.body.manifest))
    })

    it('refuses a bad token or a user token, and stores nothing', async () => {
      const bad = await setSecrets('slack', { SLACK_BOT_TOKEN: 'xoxb-bad', SLACK_SIGNING_SECRET: SIGNING })
      expect(bad.status).toBe(422)
      expect(bad.body.error.message).toMatch(/rejected the bot token \(invalid_auth\)/)
      expect((await setSecrets('slack', { SLACK_BOT_TOKEN: 'xoxp-user' })).status).toBe(422)
      expect(await ownSecrets()).not.toContain('SLACK_BOT_TOKEN')
      expect(await ownSecrets()).not.toContain('SLACK_SIGNING_SECRET')
    })

    it('stores and checks the tokens, never returning them; then events, channels and routing', async () => {
      const r = await setSecrets('slack', { SLACK_BOT_TOKEN: 'xoxb-good', SLACK_SIGNING_SECRET: SIGNING })
      expect(r.status).toBe(200)
      expect(r.body.message).toContain('Connected as @billing in Acme')
      expect(JSON.stringify(r.body)).not.toContain('xoxb-good')
      expect(JSON.stringify(r.body)).not.toContain(SIGNING)
      expect(JSON.stringify(t.logs)).not.toContain('xoxb-good')
      expect(await ownSecrets()).toEqual(expect.arrayContaining(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']))
      const contact = await t.a.services.directory.employees.contact(emp)
      expect(contact.data.handles).toContainEqual({ system: 'slack', id: 'UBILL' })

      const slack = r.body.integration
      expect(stepOf(slack, 'tokens')).toMatchObject({ status: 'done', data: { botUser: 'billing', team: 'Acme' } })
      expect(stepOf(slack, 'events').status).toBe('todo')
      expect(stepOf(slack, 'channels')).toMatchObject({ status: 'done', data: { channels: [{ id: 'C1', name: 'billing' }] } })
      expect(stepOf(slack, 'routing').status).toBe('todo')
      expect(slack.actions).toContain('add-trigger')
      expect(slack.state).toBe('needs_attention')

      // An unsigned request doesn't count; a signed url_verification does.
      const body = JSON.stringify({ type: 'url_verification', challenge: 'c-123', token: 'x' })
      const ts = String(Math.floor(Date.now() / 1000))
      const unsigned = await t.a.app.request(`/webhooks/slack/${emp}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=00' },
        body,
      })
      expect(unsigned.status).toBe(401)
      expect(stepOf(await status('slack'), 'events').status).toBe('todo')
      const signed = await t.a.app.request(`/webhooks/slack/${emp}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': ts,
          'x-slack-signature': signSlackRequest(SIGNING, ts, body),
        },
        body,
      })
      expect(signed.status).toBe(200)
      expect(await signed.text()).toBe('c-123')
      expect(stepOf(await status('slack'), 'events')).toMatchObject({ status: 'done' })
      expect(stepOf(await status('slack'), 'interactivity').status).toBe('todo')

      // A signed interactive request (a button click) shows interactivity works; it isn't counted as events.
      const form = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: 'U1' }, actions: [] }))}`
      const interactive = await t.a.app.request(`/webhooks/slack/${emp}/interactive`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': ts,
          'x-slack-signature': signSlackRequest(SIGNING, ts, form),
        },
        body: form,
      })
      expect(interactive.status).toBe(200)
      expect(await interactive.text()).toBe('')
      expect(stepOf(await status('slack'), 'interactivity')).toMatchObject({
        status: 'done',
        data: { lastAt: expect.any(String) },
      })

      const added = await act('slack', 'add-trigger')
      expect(added.status).toBe(200)
      expect(added.body.message).toContain('Slack: mentions and DMs')
      expect(stepOf(added.body.integration, 'routing').status).toBe('done')
      expect(added.body.integration.state).toBe('connected')
      const again = await act('slack', 'add-trigger')
      expect(again.body.message).toMatch(/^Already routed/)
      expect(
        (await t.a.services.events.triggers.list({ employeeId: emp })).filter((x) => x.data.match.source === 'integration:slack'),
      ).toHaveLength(1)
    })

    it('warns about missing scopes and about no channels', async () => {
      fake.world.slack.scopes = SLACK_BOT_SCOPES.filter((sc) => sc !== 'reactions:write')
      fake.world.slack.channels = []
      await setSecrets('slack', { SLACK_BOT_TOKEN: 'xoxb-good', SLACK_SIGNING_SECRET: SIGNING })
      const slack = await status('slack')
      expect(stepOf(slack, 'tokens').status).toBe('warning')
      expect(stepOf(slack, 'tokens').detail).toContain('reactions:write')
      expect(stepOf(slack, 'channels')).toMatchObject({ status: 'todo', data: { invite: '/invite @billing' } })
    })

    it('reuses a check for 30 s unless asked to re-check', async () => {
      await setSecrets('slack', { SLACK_BOT_TOKEN: 'xoxb-good', SLACK_SIGNING_SECRET: SIGNING })
      await status('slack', true)
      const before = fake.world.calls.length
      await status('slack', false)
      await status('slack', false)
      expect(fake.world.calls.length).toBe(before)
      await status('slack', true)
      expect(fake.world.calls.length).toBeGreaterThan(before)
    })
  })

  describe('GitLab', () => {
    it('refuses a bad token and a token without the api scope', async () => {
      const bad = await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-bad' })
      expect(bad.status).toBe(422)
      expect(bad.body.error.message).toMatch(/rejected the token \(401\)/)
      const ro = await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-readonly' })
      expect(ro.status).toBe(422)
      expect(ro.body.error.message).toMatch(/needs the api scope \(it has read_api\)/)
      expect(await ownSecrets()).not.toContain('GITLAB_TOKEN')
    })

    it('stores the token, adds the handle, and adds the SSH key once', async () => {
      const r = await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-good' })
      expect(r.status).toBe(200)
      expect(r.body.message).toContain('Connected as @billing-bot')
      expect(JSON.stringify(r.body)).not.toContain('glpat-good')
      expect((await t.a.services.directory.employees.contact(emp)).data.handles).toContainEqual({
        system: 'gitlab',
        id: 'billing-bot',
      })
      const gl = r.body.integration
      expect(stepOf(gl, 'instance')).toMatchObject({ status: 'done', data: { baseUrl: GITLAB_URL } })
      expect(stepOf(gl, 'account')).toMatchObject({ status: 'done', data: { username: 'billing-bot', serviceAccount: true } })
      expect(stepOf(gl, 'token').status).toBe('done')
      expect(stepOf(gl, 'ssh-key').status).toBe('todo')
      expect(stepOf(gl, 'projects').status).toBe('done')
      expect(gl.actions).toContain('add-ssh-key')

      const added = await act('gitlab', 'add-ssh-key')
      expect(added.status).toBe(200)
      expect(added.body.message).toContain('Added the key to @billing-bot')
      expect(stepOf(added.body.integration, 'ssh-key').status).toBe('done')
      expect(fake.world.gitlab.keys).toHaveLength(1)
      const key = (await t.req('GET', `/api/employees/${emp}/ssh-key`)).body
      expect(sshFingerprint(fake.world.gitlab.keys[0]!.key)).toBe(key.fingerprint)
      expect(fake.world.gitlab.keys[0]!.title).toMatch(/^meatless-proxy billing-\d+$/)

      // Idempotent: a second click changes nothing.
      const again = await act('gitlab', 'add-ssh-key')
      expect(again.status).toBe(200)
      expect(again.body.message).toMatch(/already on @billing-bot/)
      expect(fake.world.gitlab.keys).toHaveLength(1)

      // After a rotation, adding replaces the old key.
      await t.req('POST', `/api/employees/${emp}/ssh-key`, {})
      expect(stepOf(await status('gitlab'), 'ssh-key').status).toBe('todo')
      const replaced = await act('gitlab', 'add-ssh-key')
      expect(replaced.body.message).toMatch(/Removed the old key/)
      expect(fake.world.gitlab.keys).toHaveLength(1)
      expect(stepOf(replaced.body.integration, 'ssh-key').status).toBe('done')
    })

    it('says so when the key is already on another account', async () => {
      await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-good' })
      const pub = (await t.req('GET', `/api/employees/${emp}/ssh-key`)).body.publicKey
      fake.world.gitlab.keys.push({ id: 99, title: 'someone’s', key: pub, userId: 8 })
      const r = await act('gitlab', 'add-ssh-key')
      expect(r.status).toBe(409)
      expect(r.body.error.message).toMatch(/already in use on another account/)
    })

    it('takes a separate webhook provisioning token (api scope), so the account can stay Developer', async () => {
      await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-good' })
      expect((await setSecrets('gitlab', { GITLAB_HOOKS_TOKEN: 'glpat-readonly' })).status).toBe(422)
      const ok = await setSecrets('gitlab', { GITLAB_HOOKS_TOKEN: 'glpat-other' })
      expect(ok.status).toBe(200)
      expect(ok.body.message).toMatch(/Provisioning token saved/)
      const stored = await t.a.services.secrets.resolve(['GITLAB_HOOKS_TOKEN'], { employeeId: emp })
      expect(stored.GITLAB_HOOKS_TOKEN).toBe('glpat-other')
    })

    it('warns about Maintainer access, an unprotected default branch and an expiring token', async () => {
      fake.world.gitlab.projects.push({
        id: 43,
        path_with_namespace: 'acme/infra',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 }, group_access: null },
      })
      fake.world.gitlab.projects.push({
        id: 44,
        path_with_namespace: 'acme/web',
        default_branch: 'trunk',
        permissions: { project_access: null, group_access: { access_level: 30 } },
      })
      fake.world.gitlab.protected[43] = ['main']
      fake.world.gitlab.protected[44] = ['release/*']
      fake.world.gitlab.expiresAt = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
      await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-good' })
      const gl = await status('gitlab')
      const projects = stepOf(gl, 'projects')
      expect(projects.status).toBe('warning')
      const byPath = Object.fromEntries(projects.data.projects.map((p: any) => [p.path, p]))
      expect(byPath['acme/billing']).toMatchObject({ role: 'Developer', protected: true, warnings: [] })
      expect(byPath['acme/infra'].role).toBe('Maintainer')
      // Without a provisioning token it says to add one, then drop the account to Developer.
      expect(byPath['acme/infra'].warnings[0]).toMatch(/provisioning token, then set this account to Developer/)
      expect(byPath['acme/web']).toMatchObject({ protected: false })
      expect(byPath['acme/web'].warnings[0]).toMatch(/trunk isn’t protected/)
      const token = stepOf(gl, 'token')
      expect(token.status).toBe('warning')
      expect(token.detail).toMatch(/expires in (9|10) days/)
      expect(gl.state).toBe('needs_attention')
    })

    it('adds reachable GitLab projects as harness projects with the employee as a member, idempotently', async () => {
      const s = t.a.services
      fake.world.gitlab.projects.push({
        id: 43,
        name: 'billing',
        path_with_namespace: 'other/billing',
        default_branch: 'main',
        http_url_to_repo: 'https://gitlab.test/other/billing.git',
        ssh_url_to_repo: 'git@gitlab.test:other/billing.git',
        permissions: { project_access: { access_level: 30 }, group_access: null },
      })
      await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-good' })
      const gl = await status('gitlab')
      expect(gl.actions).toContain('add-projects')
      const step = stepOf(gl, 'projects')
      expect(step.data.projects.map((p: any) => p.added)).toEqual([null, null])
      expect(step.detail).toMatch(/2 aren’t a harness project of the employee yet/)
      const contact = await s.directory.employees.contact(emp)
      const before = (await s.directory.projects.list({ limit: 1000 })).items.length

      const r = await act('gitlab', 'add-projects', { projects: [42, 43] })
      expect(r.status).toBe(200)
      expect(r.body.message).toBe('Added 2 projects: acme/billing, other/billing.')
      const mine = await s.directory.projects.forContact(contact.id)
      const byPath = new Map(
        mine.map((m) => [m.project.data.repositories?.[0]?.url, { project: m.project, roles: m.roles }] as const),
      )
      const billing = byPath.get('git@gitlab.test:acme/billing.git')!
      expect(billing.roles).toEqual(['member'])
      expect(billing.project.data).toMatchObject({
        name: expect.stringMatching(/billing$/),
        description: 'Invoices and payments.',
        repositories: [
          { url: 'git@gitlab.test:acme/billing.git', httpUrl: 'https://gitlab.test/acme/billing.git', defaultBranch: 'main' },
        ],
      })
      // The second one's short name was taken, so it is named by its path.
      expect(byPath.get('git@gitlab.test:other/billing.git')!.project.data.name).toBe('other/billing')
      const added = stepOf(r.body.integration, 'projects').data.projects
      expect(added.every((p: any) => p.added?.linked === true)).toBe(true)

      // Again: nothing new.
      const again = await act('gitlab', 'add-projects', { projects: [42] })
      expect(again.body.message).toBe('Already added: acme/billing.')
      expect((await s.directory.projects.list({ limit: 1000 })).items.length).toBe(before + 2)
      for (const m of await s.directory.projects.forContact(contact.id))
        await s.records.delete('project', m.project.id, { cascade: true })
    })

    it('only links the employee to a project whose repository the harness already has', async () => {
      const s = t.a.services
      const existing = await s.directory.projects.create({
        name: `Billing app ${n}`,
        repositories: [{ url: 'https://gitlab.test/acme/billing' }],
      })
      await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-good' })
      expect(stepOf(await status('gitlab'), 'projects').data.projects[0].added).toEqual({
        projectId: existing.id,
        name: existing.data.name,
        linked: false,
      })
      const before = (await s.directory.projects.list({ limit: 1000 })).items.length
      const r = await act('gitlab', 'add-projects', { projects: ['42'] })
      expect(r.body.message).toMatch(/^Linked Billing \d+ to 1 existing project: acme\/billing\.$/)
      expect((await s.directory.projects.list({ limit: 1000 })).items.length).toBe(before)
      const contact = await s.directory.employees.contact(emp)
      expect((await s.directory.projects.members(existing.id)).map((m) => [m.contact.id, m.roles])).toContainEqual([
        contact.id,
        ['member'],
      ])
      await s.records.delete('project', existing.id, { cascade: true })
    })

    it('add-projects checks its input, the token, and who may run it', async () => {
      expect((await act('gitlab', 'add-projects', { projects: [42] })).status).toBe(422)
      await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-good' })
      expect((await act('gitlab', 'add-projects', {})).status).toBe(422)
      expect((await act('gitlab', 'add-projects', { projects: [{}] })).status).toBe(422)
      expect((await act('gitlab', 'add-projects', { projects: [42] }, member)).status).toBe(403)
      const missing = await act('gitlab', 'add-projects', { projects: [999] })
      expect(missing.body.message).toBe('Couldn’t add: 999 (the token can’t see it).')
      const bad = await t.req('POST', `/api/employees/${emp}/integrations/gitlab/actions/add-projects`, '[1]')
      expect(bad.status).toBe(400)
    })

    it('adds a routing trigger for issues assigned to its username', async () => {
      await setSecrets('gitlab', { GITLAB_TOKEN: 'glpat-good' })
      const r = await act('gitlab', 'add-trigger')
      expect(r.status).toBe(200)
      const trig = (await t.a.services.events.triggers.list({ employeeId: emp })).find(
        (x) => x.data.match.source === 'integration:gitlab',
      )
      expect(trig?.data.match.filter).toEqual({ 'payload.assignees': 'billing-bot', 'payload.state': 'opened' })
      expect(stepOf(r.body.integration, 'routing').status).toBe('done')
    })

    it('records GitLab webhooks per project', async () => {
      await t.a.services.secrets.set('GITLAB_WEBHOOK_SECRET', 'gl-hook-secret', { type: 'employee', id: emp })
      const res = await t.a.app.request(`/webhooks/gitlab/${emp}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gitlab-token': 'gl-hook-secret', 'x-gitlab-event': 'Push Hook' },
        body: JSON.stringify({
          object_kind: 'push',
          ref: 'refs/heads/mp/x',
          project: { path_with_namespace: 'acme/billing' },
          commits: [],
        }),
      })
      expect(res.status).toBeLessThan(300)
      const a = await t.a.setup.activity.get(emp, 'gitlab')
      expect(a?.projects?.['acme/billing']).toBeTruthy()
      const wrong = await t.a.app.request(`/webhooks/gitlab/${emp}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gitlab-token': 'nope', 'x-gitlab-event': 'Push Hook' },
        body: JSON.stringify({ object_kind: 'push', project: { path_with_namespace: 'acme/evil' } }),
      })
      expect(wrong.status).toBe(401)
      expect((await t.a.setup.activity.get(emp, 'gitlab'))?.projects?.['acme/evil']).toBeUndefined()
      expect(stepOf(await status('gitlab'), 'webhooks').status).toBe('done')
    })
  })

  describe('Linear', () => {
    it('checks the key, creates the webhook once, and adds a trigger', async () => {
      expect((await setSecrets('linear', { LINEAR_API_KEY: 'lin_api_bad' })).status).toBe(422)
      const r = await setSecrets('linear', { LINEAR_API_KEY: 'lin_api_good' })
      expect(r.status).toBe(200)
      expect(stepOf(r.body.integration, 'api-key')).toMatchObject({ status: 'done', data: { viewerId: 'lin-bill' } })
      expect(r.body.integration.actions).toEqual(expect.arrayContaining(['create-webhook', 'add-trigger']))
      const wh = await act('linear', 'create-webhook')
      expect(wh.status).toBe(200)
      expect(fake.world.linear.webhooks).toEqual([expect.objectContaining({ url: `${PUBLIC_URL}/webhooks/linear/${emp}` })])
      const stored = await t.a.services.secrets.resolve(['LINEAR_WEBHOOK_SECRET'], { employeeId: emp })
      expect(stored.LINEAR_WEBHOOK_SECRET).toBe(fake.world.linear.webhooks[0]!.secret)
      expect(JSON.stringify(wh.body)).not.toContain(stored.LINEAR_WEBHOOK_SECRET!)
      expect((await act('linear', 'create-webhook')).body.message).toMatch(/already registered/)
      expect(fake.world.linear.webhooks).toHaveLength(1)
      const trig = await act('linear', 'add-trigger')
      expect(trig.status).toBe(200)
      const tr = (await t.a.services.events.triggers.list({ employeeId: emp })).find(
        (x) => x.data.match.source === 'integration:linear',
      )
      expect(tr?.data.match.where).toEqual({ 'payload.assignee.id': 'lin-bill' })
    })

    it('explains when the key may not create webhooks', async () => {
      fake.world.linear.admin = false
      await setSecrets('linear', { LINEAR_API_KEY: 'lin_api_good' })
      const r = await act('linear', 'create-webhook')
      expect(r.status).toBe(403)
      expect(await ownSecrets()).not.toContain('LINEAR_WEBHOOK_SECRET')
    })
  })
}

describe('setup helpers', () => {
  it('builds the Slack manifest and matches protected branch wildcards', () => {
    const m = slackManifest(
      'A very long employee name that goes on and on',
      'Bill Bot',
      'https://x.example.com/webhooks/slack/emp_1',
    ) as any
    expect(m.display_information.name.length).toBeLessThanOrEqual(35)
    expect(m.features.bot_user.display_name).toBe('bill-bot')
    expect(isProtected('main', ['main'])).toBe(true)
    expect(isProtected('release/1.2', ['release/*'])).toBe(true)
    expect(isProtected('main', ['release/*'])).toBe(false)
    expect(sshFingerprint('not a key')).toBeNull()
  })
})

describe('setup (memory)', () => setupSuite(memoryBackend))

const { DATABASE_URL, REDIS_URL } = process.env
describe.skipIf(!DATABASE_URL || !REDIS_URL)('setup (postgres + bullmq)', () =>
  setupSuite(realBackend(DATABASE_URL!, REDIS_URL!)),
)
