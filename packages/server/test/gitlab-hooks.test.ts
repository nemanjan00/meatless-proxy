/**
 * GitLab webhook self-provisioning through the composition root
 * (src/integrations/provisioning.ts): a fake GitLab behind a `fetch` stub
 * with project hooks, tokens with roles, and the 403 GitLab gives a Developer.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GITLAB_HOOK_KIND } from '../src/integrations/index.ts'
import type { GitlabHookData } from '../src/integrations/provisioning.ts'
import { type TestApp, testApp, until } from './helpers.ts'

const GITLAB_URL = 'https://gitlab.test'
const PUBLIC_URL = 'https://mp.example.com'

interface FakeHook {
  id: number
  project_id: number
  url: string
  token: string
  [flag: string]: unknown
}

function fakeGitlab() {
  const projects = new Map<string, number>([
    ['acme/app', 42],
    ['acme/web', 43],
    ['acme/infra', 44],
  ])
  /** Token → role. Hooks need `maintainer`. */
  const tokens = new Map<string, 'developer' | 'maintainer'>()
  const hooks: FakeHook[] = []
  const calls: { method: string; path: string; token: string | null; body: any }[] = []
  let nextId = 100
  const json = (value: unknown, status = 200) =>
    new Response(value === null ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const visible = ({ token: _, ...h }: FakeHook) => h

  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== GITLAB_URL) throw new Error(`unexpected fetch ${url.href}`)
    const method = (init.method ?? 'GET').toUpperCase()
    const token = new Headers(init.headers).get('private-token')
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null
    const path = url.pathname.replace(/^\/api\/v4/, '')
    calls.push({ method, path, token, body })
    const role = tokens.get(token ?? '')
    if (!role) return json({ message: '401 Unauthorized' }, 401)
    const m = /^\/projects\/([^/]+)\/hooks(?:\/(\d+))?$/.exec(path)
    if (!m) return json({ message: '404 Not found' }, 404)
    const ref = decodeURIComponent(m[1]!)
    const pid = projects.get(ref) ?? ([...projects.values()].includes(Number(ref)) ? Number(ref) : undefined)
    if (!pid) return json({ message: '404 Project Not Found' }, 404)
    if (role !== 'maintainer') return json({ message: '403 Forbidden' }, 403)
    const mine = hooks.filter((h) => h.project_id === pid)
    if (!m[2]) {
      if (method === 'GET') return json(mine.map(visible))
      if (method === 'POST') {
        const h: FakeHook = { push_events: true, push_events_branch_filter: '', ...body, id: nextId++, project_id: pid }
        hooks.push(h)
        return json(visible(h), 201)
      }
    }
    const h = mine.find((x) => x.id === Number(m[2]))
    if (!h) return json({ message: '404 Hook Not Found' }, 404)
    if (method === 'PUT') {
      Object.assign(h, body)
      return json(visible(h))
    }
    if (method === 'DELETE') {
      hooks.splice(hooks.indexOf(h), 1)
      return json(null, 204)
    }
    return json({ message: '404 Not found' }, 404)
  }) as typeof globalThis.fetch

  const writes = () => calls.filter((c) => c.method !== 'GET')
  return { fetch, tokens, hooks, calls, writes, projects, reset: () => calls.splice(0) }
}

type Fake = ReturnType<typeof fakeGitlab>

let t: TestApp | null = null
afterEach(async () => {
  await t?.close()
  t = null
})

async function setup(opts: { publicUrl?: string | null } = {}) {
  const gl = fakeGitlab()
  const env: Record<string, string> = { INTEGRATIONS: 'gitlab' }
  if (opts.publicUrl !== null) env.PUBLIC_URL = opts.publicUrl ?? PUBLIC_URL
  t = await testApp({
    env,
    overrides: {
      integrations: {
        fetch: gl.fetch,
        baseUrls: { gitlab: GITLAB_URL },
        provisioning: { debounceMs: 5, retry: { maxRetries: 0 } },
      },
    },
  })
  const app = t
  const s = app.a.services
  const prov = app.a.hookProvisioning!
  const quiesce = async () => {
    for (let i = 0; i < 3; i++) {
      await app.settle()
      await prov.idle()
    }
  }
  // A second employee, so "the only employee gets every project" doesn't apply.
  const bot = await s.directory.employees.create({ name: 'Billing Bot', toolAllow: ['**'] })
  const other = await s.directory.employees.create({ name: 'Other Bot', toolAllow: ['**'] })
  const project = await s.directory.projects.create({
    name: 'App',
    repositories: [{ url: `${GITLAB_URL}/acme/app.git` }, { url: 'https://github.com/acme/mirror.git' }],
  })
  await s.directory.projects.addMember(project.id, bot.data.contactId, 'member')
  const emp = (id: string) => ({ type: 'employee' as const, id })
  const hookUrl = `${PUBLIC_URL}/webhooks/gitlab/${bot.id}`
  const secretOf = async (employeeId: string) =>
    (await s.secrets.resolve(['GITLAB_WEBHOOK_SECRET'], { employeeId })).GITLAB_WEBHOOK_SECRET
  const statusOf = async (employeeId: string) =>
    (await s.records.query<GitlabHookData>(GITLAB_HOOK_KIND, { where: { employeeId } })).items
  return { gl, app, s, prov, bot, other, project, emp, hookUrl, secretOf, statusOf, quiesce }
}

const enableBot = async (
  x: Awaited<ReturnType<typeof setup>>,
  token = 'glpat-bot',
  role: 'developer' | 'maintainer' = 'maintainer',
) => {
  x.gl.tokens.set(token, role)
  await x.s.secrets.set('GITLAB_TOKEN', token, x.emp(x.bot.id))
  await x.quiesce()
}

const hooksOf = (gl: Fake, url: string) => gl.hooks.filter((h) => h.url === url)

describe('gitlab webhook provisioning', () => {
  it('creates the hook when the token is set, with a generated per-employee secret', async () => {
    const x = await setup()
    expect(x.prov.enabled).toBe(true)
    await x.quiesce()
    expect(x.gl.hooks).toHaveLength(0) // no GITLAB_TOKEN yet: GitLab isn't set up for anyone
    await enableBot(x)

    const [hook, ...more] = hooksOf(x.gl, x.hookUrl)
    expect(more).toHaveLength(0)
    expect(x.gl.hooks).toHaveLength(1) // the GitHub mirror is ignored, the other employee has no token
    const secret = await x.secretOf(x.bot.id)
    expect(secret).toMatch(/^[\w-]{40,}$/)
    expect(hook).toMatchObject({
      project_id: 42,
      token: secret,
      push_events: true,
      note_events: true,
      issues_events: true,
      merge_requests_events: true,
      job_events: true,
      pipeline_events: true,
      enable_ssl_verification: true,
    })
    expect(hook!.push_events_branch_filter ?? '').toBe('')
    // The secret is the employee's own, not a global one.
    const metas = await x.s.secrets.list()
    expect(metas.find((m) => m.name === 'GITLAB_WEBHOOK_SECRET')?.scope).toEqual({ type: 'employee', id: x.bot.id })

    const [status] = await x.statusOf(x.bot.id)
    expect(status!.data).toMatchObject({
      gitlabProject: 'acme/app',
      projectIds: [x.project.id],
      url: x.hookUrl,
      hookId: hook!.id,
      status: 'ok',
      lastAction: 'created',
    })
    expect(JSON.stringify(status!.data)).not.toContain(secret!)
  })

  it('is idempotent: running again makes no second hook and no writes', async () => {
    const x = await setup()
    await enableBot(x)
    x.gl.reset()
    const r1 = await x.prov.run(x.bot.id)
    const r2 = await x.prov.run(x.bot.id)
    expect(r1.outcome).toBe('done')
    expect(r2.hooks[0]!.data.lastAction).toBe('unchanged')
    expect(x.gl.writes()).toEqual([])
    expect(x.gl.hooks).toHaveLength(1)
  })

  it('repairs changed events, a deleted hook, a duplicate and a changed secret', async () => {
    const x = await setup()
    await enableBot(x)
    const id = x.gl.hooks[0]!.id

    Object.assign(x.gl.hooks[0]!, { job_events: false, enable_ssl_verification: false })
    const events = await x.prov.run(x.bot.id)
    expect(events.hooks[0]!.data.lastAction).toBe('updated')
    expect(x.gl.hooks[0]).toMatchObject({ id, job_events: true, enable_ssl_verification: true })
    expect(x.gl.writes().at(-1)!.body).not.toHaveProperty('token') // the token was known: not sent again

    x.gl.hooks.push({ ...x.gl.hooks[0]!, id: 999, token: 'stale' })
    await x.prov.run(x.bot.id)
    expect(x.gl.hooks.map((h) => h.id)).toEqual([id])

    x.gl.hooks.splice(0)
    await x.prov.run(x.bot.id)
    expect(hooksOf(x.gl, x.hookUrl)).toHaveLength(1)
    expect(x.gl.hooks[0]!.id).not.toBe(id)
    expect(x.gl.hooks[0]!.token).toBe(await x.secretOf(x.bot.id))

    // A new secret (set by an admin) goes onto the hook by itself.
    await x.s.secrets.set('GITLAB_WEBHOOK_SECRET', 'rotated-webhook-secret', x.emp(x.bot.id))
    await x.quiesce()
    expect(x.gl.hooks).toHaveLength(1)
    expect(x.gl.hooks[0]!.token).toBe('rotated-webhook-secret')
  })

  it('prefers the provisioning token over the employee’s own', async () => {
    const x = await setup()
    x.gl.tokens.set('glpat-hooks', 'maintainer')
    await x.s.secrets.set('GITLAB_HOOKS_TOKEN', 'glpat-hooks', { type: 'global' })
    await enableBot(x, 'glpat-dev', 'developer')
    expect(x.gl.hooks).toHaveLength(1)
    const hookCalls = x.gl.calls.filter((c) => c.path.includes('/hooks'))
    expect(hookCalls.length).toBeGreaterThan(0)
    expect(hookCalls.every((c) => c.token === 'glpat-hooks')).toBe(true)
    const [status] = await x.statusOf(x.bot.id)
    expect(status!.data.status).toBe('ok')
  })

  it('records a 403 with a message that says what to do', async () => {
    const x = await setup()
    await enableBot(x, 'glpat-dev', 'developer')
    expect(x.gl.hooks).toHaveLength(0)
    const [status] = await x.statusOf(x.bot.id)
    expect(status!.data).toMatchObject({ status: 'error', gitlabProject: 'acme/app' })
    expect(status!.data.error).toBe(
      'the token needs Maintainer on acme/app to register webhooks; set GITLAB_HOOKS_TOKEN (a Maintainer or group Owner) or give the service account Maintainer',
    )
    expect(status!.data.error).not.toContain('glpat')

    // Fixing it (a provisioning token) clears the error.
    x.gl.tokens.set('glpat-hooks', 'maintainer')
    await x.s.secrets.set('GITLAB_HOOKS_TOKEN', 'glpat-hooks', { type: 'global' })
    await x.quiesce()
    const [fixed] = await x.statusOf(x.bot.id)
    expect(fixed!.data.status).toBe('ok')
    expect(fixed!.data.error).toBeUndefined()
  })

  it('is off without PUBLIC_URL, and says so once', async () => {
    const x = await setup({ publicUrl: null })
    await enableBot(x)
    expect(x.prov.enabled).toBe(false)
    expect(x.prov.reason).toContain('PUBLIC_URL')
    expect(x.gl.calls).toEqual([])
    expect((await x.prov.run(x.bot.id)).outcome).toBe('off')
    const lines = x.app.logs.filter((l) => l.msg.includes('webhook provisioning is off'))
    expect(lines).toHaveLength(1)
    const status = await x.app.req('GET', '/api/integrations/status')
    expect(status.body.gitlabHooks).toMatchObject({ enabled: false, reason: expect.stringContaining('PUBLIC_URL') })
  })

  it('follows repository and link changes: new repos get hooks, dropped ones lose them', async () => {
    const x = await setup()
    await enableBot(x)
    await x.s.directory.projects.update(x.project.id, {
      repositories: [{ url: `${GITLAB_URL}/acme/app.git` }, { url: 'git@gitlab.test:acme/web.git' }],
    })
    await x.quiesce()
    expect(x.gl.hooks.map((h) => h.project_id).sort()).toEqual([42, 43])

    // A session of the employee works on another project.
    const infra = await x.s.directory.projects.create({ name: 'Infra', repositories: [{ url: `${GITLAB_URL}/acme/infra` }] })
    await x.quiesce()
    expect(x.gl.hooks.map((h) => h.project_id).sort()).toEqual([42, 43]) // not linked yet
    const session = await x.s.sessions.create({ employeeId: x.bot.id, title: 'Infra work' })
    await x.s.records.link({ kind: 'session', id: session.id }, { kind: 'project', id: infra.id }, 'works_on')
    await x.quiesce()
    expect(x.gl.hooks.map((h) => h.project_id).sort()).toEqual([42, 43, 44])

    // Dropping a repository removes its hook and its status.
    await x.s.directory.projects.update(x.project.id, { repositories: [{ url: `${GITLAB_URL}/acme/app.git` }] })
    await x.quiesce()
    expect(x.gl.hooks.map((h) => h.project_id).sort()).toEqual([42, 44])
    expect((await x.statusOf(x.bot.id)).map((r) => r.data.gitlabProject).sort()).toEqual(['acme/app', 'acme/infra'])

    // Leaving the project removes that hook too.
    await x.s.directory.projects.removeMember(x.project.id, x.bot.data.contactId)
    await x.quiesce()
    expect(x.gl.hooks.map((h) => h.project_id)).toEqual([44])
  })

  it('gives the only employee every project', async () => {
    const x = await setup()
    // Remove everyone but the bot (the bootstrap employee and the other one).
    for (const e of (await x.s.directory.employees.list()).items)
      if (e.id !== x.bot.id) await x.s.records.delete('employee', e.id, { cascade: true })
    await x.s.directory.projects.create({ name: 'Web', repositories: [{ url: `${GITLAB_URL}/acme/web.git` }] })
    await enableBot(x)
    expect(x.gl.hooks.map((h) => h.project_id).sort()).toEqual([42, 43])
  })

  it('accepts a webhook signed with the generated secret on the per-employee route, end to end', async () => {
    const x = await setup()
    await enableBot(x)
    const hook = x.gl.hooks[0]!
    const path = new URL(hook.url).pathname
    const payload = {
      object_kind: 'issue',
      event_type: 'issue',
      user: { id: 5, username: 'ana', name: 'Ana' },
      project: { id: 42, path_with_namespace: 'acme/app', web_url: `${GITLAB_URL}/acme/app` },
      object_attributes: { iid: 9, title: 'Broken', state: 'opened', action: 'open', url: `${GITLAB_URL}/acme/app/-/issues/9` },
      assignees: [],
      labels: [],
    }
    const send = (token: string, uuid: string) =>
      x.app.a.app.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gitlab-event': 'Issue Hook',
          'x-gitlab-event-uuid': uuid,
          'x-gitlab-token': token,
        },
        body: JSON.stringify(payload),
      })
    expect((await send('not-the-secret', 'uuid-bad')).status).toBe(401)
    const ok = await send(hook.token, 'uuid-good')
    expect(ok.status).toBe(200)
    await x.s.integrations!.idle()
    const event = await until(
      async () => (await x.s.rawEvents.query({ source: 'integration:gitlab' })).find((e) => (e.data.payload as any)?.iid === 9),
      'the issue event',
    )
    expect(event.data).toMatchObject({ type: 'issue.opened', employeeId: x.bot.id })
  })

  it('exposes the status to admins only', async () => {
    const x = await setup()
    await enableBot(x, 'glpat-dev', 'developer')
    const r = await x.app.req('GET', '/api/integrations/status')
    expect(r.status).toBe(200)
    expect(r.body.enabled).toEqual(['gitlab'])
    expect(r.body.gitlabHooks).toMatchObject({ enabled: true, provisioningToken: false })
    const bot = r.body.employees.find((e: any) => e.id === x.bot.id)
    expect(bot.integrations.gitlab).toEqual({ token: true, webhookSecret: true })
    expect(bot.gitlabHooks).toEqual([
      expect.objectContaining({ gitlabProject: 'acme/app', status: 'error', error: expect.stringContaining('Maintainer') }),
    ])
    const other = r.body.employees.find((e: any) => e.id === x.other.id)
    expect(other).toMatchObject({ integrations: { gitlab: { token: false, webhookSecret: false } }, gitlabHooks: [] })
    expect(JSON.stringify(r.body)).not.toContain('glpat-dev')

    const member = await x.s.directory.contacts.create({ name: 'Mia', kind: 'person', email: 'mia@example.com' })
    const denied = await x.app.req('GET', '/api/integrations/status', undefined, await x.app.as(member.id, { access: 'member' }))
    expect(denied.status).toBe(403)
  })
})

describe('gitlab hook errors', () => {
  it("say which token GitLab answered for, and how to fix a hooks token that can't see the project", async () => {
    const { hookErrorMessage } = await import('../src/integrations/provisioning.ts')
    const { NotFoundError } = await import('@mp/core')
    const notFound = new NotFoundError('project', 'acme/app', { status: 404 })
    expect(hookErrorMessage(notFound, 'acme/app', true)).toContain("GITLAB_HOOKS_TOKEN can't see it (404)")
    expect(hookErrorMessage(notFound, 'acme/app', true)).toContain('Maintainer of the project or its group')
    expect(hookErrorMessage(notFound, 'acme/app', false)).toContain("the employee's GITLAB_TOKEN can't see it")
  })
})
