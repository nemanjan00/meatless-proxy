import { fakeRuntime, type FakeRuntime } from '@mp/containers'
import { newId } from '@mp/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PREVIEW_COOKIE } from '../src/previews/index.ts'
import { testApp, type TestApp } from './helpers.ts'
import { encodeFrame, freePort, nextFrame, rawRequest, rawUpgrade, setCookieOf, upstreamApp } from './preview-helpers.ts'

type T = TestApp & { port: number | null }

/** A session of the bootstrap employee, and a tool context to call stdlib tools as its run. */
async function session(t: T) {
  const s = t.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const ses = await s.sessions.create({ employeeId: employee.id, title: 'Web work' })
  const callId = newId('call')
  const ctx = {
    employeeId: employee.id,
    sessionId: ses.id,
    runId: 'run_test',
    callId,
    idempotencyKey: `run_test:0:${callId}`,
    secrets: {},
    signal: new AbortController().signal,
    logger: s.logger,
    clock: s.clock,
    emit: () => {},
  }
  const tool = async (name: string, args: unknown) => {
    const r = await s.tools.execute(name, args, ctx)
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.output)}`)
    return r.output as any
  }
  return { session: ses, tool }
}

/** A person with this access, and their bearer headers. */
async function person(t: T, name: string, access: 'viewer' | 'member' | 'admin') {
  const c = await t.a.services.directory.contacts.create({
    name,
    kind: 'person',
    access,
    email: `${name.toLowerCase()}@example.com`,
  })
  return { id: c.id, headers: await t.as(c.id, { access }) }
}

describe('live previews through the preview listener (port mode)', () => {
  let t: T
  let rt: FakeRuntime
  let up: Awaited<ReturnType<typeof upstreamApp>>
  let pp: number
  let envId: string
  let sessionId: string
  let member: { id: string; headers: Record<string, string> }
  const harnessHost = () => `127.0.0.1:${t.port}`
  const previewHost = () => `127.0.0.1:${pp}`

  /** Mints a token as `who` through the API, the way the UI does. */
  const mint = async (headers: Record<string, string>, body: unknown = { envId, port: 5173 }) => {
    const res = await t.a.app.request(`http://${harnessHost()}/api/previews/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as any }
  }
  /** Exchanges a token for the preview cookie; returns the cookie header to send. */
  const signInToPreview = async (headers = member.headers) => {
    const tok = await mint(headers)
    const u = new URL(tok.body.url)
    const res = await rawRequest(pp, `${u.pathname}${u.search}`, { host: u.host })
    expect(res.status).toBe(302)
    return `${setCookieOf(res.headers, PREVIEW_COOKIE)!.split(';')[0]}`
  }

  beforeAll(async () => {
    up = await upstreamApp()
    rt = fakeRuntime()
    pp = await freePort()
    t = await testApp({ http: true, env: { PREVIEW_PORT: String(pp) }, overrides: { containers: rt } })
    member = await person(t, 'Mira', 'member')
    const s = await session(t)
    sessionId = s.session.id
    const out = await s.tool('env.up', { image: 'node:22', expose: [5173, 8000] })
    envId = out.envId
    rt.servePreview(envId, 5173, { host: '127.0.0.1', port: up.port })
  })
  afterAll(async () => {
    await t?.close()
    await up?.close()
  })

  it('starts a preview listener of its own', () => {
    expect(t.a.previews.enabled).toBe(true)
    expect(t.a.previews.port()).toBe(pp)
    expect(pp).not.toBe(t.port)
  })

  it('tells the UI what the session previews', async () => {
    const r = await t.req('GET', `/api/sessions/${sessionId}/preview`)
    expect(r.body).toEqual({ sessionId, envId, status: 'running', ports: [5173, 8000], commit: null })
    const other = await t.a.services.sessions.create({
      employeeId: (await t.a.services.directory.employees.list()).items[0]!.id,
      title: 'x',
    })
    expect((await t.req('GET', `/api/sessions/${other.id}/preview`)).body).toEqual({
      sessionId: other.id,
      envId: null,
      status: 'none',
      ports: [],
      commit: null,
    })
    expect((await t.req('GET', '/api/sessions/ses_nope/preview')).status).toBe(404)
  })

  it('gives a member a short-lived token and the URL of the preview origin', async () => {
    const r = await mint(member.headers)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ envId, port: 5173, origin: `http://${previewHost()}` })
    expect(r.body.token).toMatch(/^mpp_/)
    expect(r.body.url).toBe(`http://${previewHost()}/__mp_preview/auth?token=${encodeURIComponent(r.body.token)}`)
    const ttl = Date.parse(r.body.expiresAt) - Date.now()
    expect(ttl).toBeGreaterThan(4 * 60_000)
    expect(ttl).toBeLessThanOrEqual(5 * 60_000)
  })

  it('refuses tokens to viewers, anonymous callers, unknown environments and ports that are not exposed', async () => {
    const viewer = await person(t, 'Vic', 'viewer')
    expect((await mint(viewer.headers)).status).toBe(403)
    expect((await mint({})).status).toBe(401)
    expect((await mint(member.headers, { envId: 'env_nope', port: 5173 })).status).toBe(404)
    expect((await mint(member.headers, { envId, port: 22 })).status).toBe(404)
    expect((await mint(member.headers, { envId })).status).toBe(400)
    expect((await mint(member.headers, { port: 5173 })).status).toBe(400)
  })

  it('exchanges a token once for a preview cookie scoped to that origin, then redirects to /', async () => {
    const tok = await mint(member.headers)
    const u = new URL(tok.body.url)
    const res = await rawRequest(pp, `${u.pathname}${u.search}`, { host: u.host })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/')
    const cookie = setCookieOf(res.headers, PREVIEW_COOKIE)!
    expect(cookie).toMatch(/; Path=\/; HttpOnly; Max-Age=43200; SameSite=Lax$/)
    expect(cookie).not.toMatch(/Domain=/i)
    expect(res.headers['content-security-policy']).toBe(`frame-ancestors http://${harnessHost()}`)
    // Once only.
    const again = await rawRequest(pp, `${u.pathname}${u.search}`, { host: u.host })
    expect(again.status).toBe(401)
    expect(again.body).toMatch(/already used/)
    // Tampered or missing.
    expect((await rawRequest(pp, `${u.pathname}?token=mpp_x.y`, { host: u.host })).status).toBe(401)
    expect((await rawRequest(pp, u.pathname, { host: u.host })).status).toBe(401)
    expect((await rawRequest(pp, '/__mp_preview/other', { host: u.host })).status).toBe(404)
  })

  it('proxies to the environment without the harness cookies or Authorization, with Host rewritten', async () => {
    const cookie = await signInToPreview()
    const harness = await t.as(member.id, { via: 'cookie' })
    const res = await rawRequest(pp, '/echo?q=1', {
      host: previewHost(),
      cookie: `${harness.cookie}; ${cookie}; app=1`,
      authorization: 'Bearer mpt_secret',
      'x-mp-csrf': harness['x-mp-csrf']!,
      origin: `http://${previewHost()}`,
      referer: `http://${previewHost()}/page`,
    })
    expect(res.status).toBe(200)
    const seen = JSON.parse(res.body)
    expect(seen.url).toBe('/echo?q=1')
    expect(seen.headers.cookie).toBe('app=1')
    expect(seen.headers.authorization).toBeUndefined()
    expect(seen.headers['x-mp-csrf']).toBeUndefined()
    expect(seen.headers.host).toBe('localhost:5173')
    expect(seen.headers.origin).toBe('http://localhost:5173')
    expect(seen.headers.referer).toBe('http://localhost:5173/page')
    expect(seen.headers['x-forwarded-host']).toBe(previewHost())
    expect(JSON.stringify(seen)).not.toContain('mp_session')
    expect(JSON.stringify(seen)).not.toContain('mpt_secret')
    expect(res.headers['content-security-policy']).toBe(`frame-ancestors http://${harnessHost()}`)
  })

  it("drops a preview's Set-Cookie for harness cookie names and other domains", async () => {
    const cookie = await signInToPreview()
    const res = await rawRequest(pp, '/cookies', { host: previewHost(), cookie })
    expect(res.headers['set-cookie']).toEqual(['app=1; Path=/; HttpOnly', 'theme=dark'])
  })

  it('keeps the app CSP and adds frame-ancestors, rewrites redirects to the inner address, streams, and posts bodies', async () => {
    const cookie = await signInToPreview()
    const csp = await rawRequest(pp, '/csp', { host: previewHost(), cookie })
    expect(csp.headers['content-security-policy']).toBe(`default-src 'self', frame-ancestors http://${harnessHost()}`)

    const redirect = await rawRequest(pp, '/redirect', { host: previewHost(), cookie })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.location).toBe('/next?x=1')
    expect((await rawRequest(pp, '/elsewhere', { host: previewHost(), cookie })).headers.location).toBe('https://example.com/out')

    let firstAt = 0
    const started = Date.now()
    const stream = await rawRequest(pp, '/stream', { host: previewHost(), cookie }, { onFirstChunk: (_t, at) => (firstAt = at) })
    expect(stream.body).toBe('first\nsecond\n')
    expect(firstAt - started).toBeLessThan(Date.now() - started - 50)

    const post = await rawRequest(
      pp,
      '/form',
      { host: previewHost(), cookie, 'content-type': 'text/plain' },
      { method: 'POST', body: 'a=1' },
    )
    expect(post.body).toBe('got a=1')
  })

  it('proxies WebSocket upgrades (hot reload), filtering cookies both ways', async () => {
    const cookie = await signInToPreview()
    const harness = await t.as(member.id, { via: 'cookie' })
    const ws = await rawUpgrade(pp, '/hmr', {
      host: previewHost(),
      origin: `http://${previewHost()}`,
      cookie: `${harness.cookie}; ${cookie}`,
    })
    expect(ws.status).toBe(101)
    expect(ws.headers['set-cookie']).toEqual(['hmr=1'])
    ws.socket!.write(encodeFrame('reload?', true))
    expect(await nextFrame(ws.socket!)).toBe('echo: reload?')
    ws.socket!.destroy()
    const seen = up.seen.filter((x) => x.method === 'UPGRADE').at(-1)!
    expect(seen.headers.cookie).toBeUndefined()
    expect(seen.headers.host).toBe('localhost:5173')
    expect(seen.headers.origin).toBe('http://localhost:5173')
  })

  it('refuses WebSockets from other origins and without the cookie', async () => {
    const cookie = await signInToPreview()
    expect((await rawUpgrade(pp, '/hmr', { host: previewHost(), origin: 'http://evil.example.com', cookie })).status).toBe(403)
    expect((await rawUpgrade(pp, '/hmr', { host: previewHost(), origin: `http://${harnessHost()}`, cookie })).status).toBe(403)
    expect((await rawUpgrade(pp, '/hmr', { host: previewHost(), origin: `http://${previewHost()}` })).status).toBe(401)
  })

  it('needs the preview cookie; a forged one or a harness session is not enough', async () => {
    const harness = await t.as(member.id, { via: 'cookie' })
    expect((await rawRequest(pp, '/', { host: previewHost() })).status).toBe(401)
    expect((await rawRequest(pp, '/', { host: previewHost(), cookie: harness.cookie! })).status).toBe(401)
    expect((await rawRequest(pp, '/', { host: previewHost(), cookie: `${PREVIEW_COOKIE}=abc.def` })).status).toBe(401)
    // The harness API isn't served here: /api is just a path of the proxied app.
    const api = await rawRequest(pp, '/api/me', { host: previewHost(), cookie: `${harness.cookie}; ${await signInToPreview()}` })
    expect(JSON.parse(api.body).url).toBe('/api/me')
  })

  it('answers 502 when the app is not listening', async () => {
    const dead = await freePort()
    rt.servePreview(envId, 8000, { host: '127.0.0.1', port: dead })
    const tok = await mint(member.headers, { envId, port: 8000 })
    const u = new URL(tok.body.url)
    const ex = await rawRequest(pp, `${u.pathname}${u.search}`, { host: u.host })
    const cookie = setCookieOf(ex.headers, PREVIEW_COOKIE)!.split(';')[0]!
    const res = await rawRequest(pp, '/', { host: previewHost(), cookie })
    expect(res.status).toBe(502)
    expect(res.body).toMatch(/0\.0\.0\.0/)
  })

  it('stops working for a viewer who lost member access', async () => {
    const lee = await person(t, 'Lee', 'member')
    const cookie = await signInToPreview(lee.headers)
    expect((await rawRequest(pp, '/', { host: previewHost(), cookie })).status).toBe(200)
    await t.a.services.directory.contacts.update(lee.id, { access: 'viewer' })
    const fresh = await person(t, 'Lou', 'member')
    const token = await mint(fresh.headers)
    await t.a.services.directory.contacts.update(fresh.id, { access: 'viewer' })
    const u = new URL(token.body.url)
    expect((await rawRequest(pp, `${u.pathname}${u.search}`, { host: u.host })).status).toBe(403)
  })

  describe('the harness refuses preview origins', () => {
    it('refuses a request from the preview origin even with a valid harness cookie', async () => {
      const harness = await t.as(member.id, { via: 'cookie' })
      const me = await t.a.app.request(`http://${harnessHost()}/api/me`, { headers: { ...harness } })
      expect(me.status).toBe(200)
      for (const [method, path] of [
        ['GET', '/api/me'],
        ['POST', '/api/previews/token'],
        ['POST', '/api/auth/logout'],
        ['POST', '/mcp'],
        ['GET', '/auth/login'],
        ['GET', '/ws'],
      ] as const) {
        const res = await t.a.app.request(`http://${harnessHost()}${path}`, {
          method,
          headers: { ...harness, origin: `http://${previewHost()}`, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify({ envId, port: 5173 }) } : {}),
        })
        expect(res.status, `${method} ${path}`).toBe(403)
      }
      // With a bearer token too.
      const bearer = await t.a.app.request(`http://${harnessHost()}/api/me`, {
        headers: { ...member.headers, origin: `http://${previewHost()}` },
      })
      expect(bearer.status).toBe(403)
    })

    it('never answers on a preview Host, over the real listener too', async () => {
      const harness = await t.as(member.id, { via: 'cookie' })
      const res = await rawRequest(t.port!, '/api/me', { host: previewHost(), cookie: harness.cookie! })
      expect(res.status).toBe(403)
      const ws = await rawUpgrade(t.port!, '/ws', {
        host: harnessHost(),
        origin: `http://${previewHost()}`,
        cookie: harness.cookie!,
      })
      expect(ws.status).toBe(403)
      // The harness's own origin still works.
      expect((await rawRequest(t.port!, '/api/me', { host: harnessHost(), cookie: harness.cookie! })).status).toBe(200)
    })

    it('frames only the preview origin, and is never framed', async () => {
      const csp = await import('../src/auth/headers.ts')
      const policy = csp.contentSecurityPolicy(t.config, harnessHost(), 'http')
      expect(policy).toContain(`frame-src http://127.0.0.1:${pp};`)
      expect(policy).toContain("frame-ancestors 'none'")
    })
  })

  it('reports commits of the checkout as preview.commit, for the UI to reload', async () => {
    const s = t.a.services
    // The session's first checkout, with a git log the test controls.
    const shas = ['a'.repeat(40), 'b'.repeat(40)]
    let i = 0
    ;(s.git as any).log = async () => [{ sha: shas[i]!, subject: `change ${i}`, author: 'x' }]
    const cur = await s.sessions.require(sessionId)
    await s.records.update('session', sessionId, {
      meta: { ...cur.data.meta, worktrees: [{ key: 'web', path: '/tmp/mp-fake-worktree' }] },
    })
    const seen: any[] = []
    const off = s.bus.subscribe('preview.commit', (m) => {
      seen.push(m.payload)
    })
    s.bus.publish('tool.result', { runId: 'run_x', sessionId, callId: 'c', name: 'git.commit', isError: false })
    await t.settle()
    expect(seen).toEqual([{ sessionId, envId, sha: shas[0], subject: 'change 0', repo: 'web' }])
    // Same commit: nothing new. Another one (e.g. commit on stop at run end): reported.
    s.bus.publish('run.state', { runId: 'run_x', sessionId, to: 'completed' })
    await t.settle()
    expect(seen).toHaveLength(1)
    i = 1
    s.bus.publish('run.state', { runId: 'run_x', sessionId, to: 'completed' })
    await t.settle()
    expect(seen.at(-1)).toMatchObject({ sha: shas[1] })
    // Errors and other tools don't look.
    i = 0
    s.bus.publish('tool.result', { runId: 'run_x', sessionId, callId: 'c', name: 'git.commit', isError: true })
    s.bus.publish('tool.result', { runId: 'run_x', sessionId, callId: 'c', name: 'fs.write', isError: false })
    await t.settle()
    expect(seen).toHaveLength(2)
    off()
    expect((await t.req('GET', `/api/sessions/${sessionId}/preview`)).body.commit).toEqual({
      sha: shas[0],
      subject: 'change 0',
      repo: 'web',
    })
  })

  it('ends with the environment: tokens and cookies for a destroyed one fail cleanly', async () => {
    const cookie = await signInToPreview()
    const tok = await mint(member.headers)
    await rt.destroyEnv(envId)
    const u = new URL(tok.body.url)
    const ex = await rawRequest(pp, `${u.pathname}${u.search}`, { host: u.host })
    expect(ex.status).toBe(404)
    expect(ex.body).toMatch(/environment is gone/)
    const res = await rawRequest(pp, '/', { host: previewHost(), cookie })
    expect(res.status).toBe(404)
    expect((await mint(member.headers)).status).toBe(404)
    expect((await t.req('GET', `/api/sessions/${sessionId}/preview`)).body).toMatchObject({ status: 'missing', ports: [] })
  })
})

describe('live previews on their own domain', () => {
  let t: T
  let rt: FakeRuntime
  let up: Awaited<ReturnType<typeof upstreamApp>>
  let pp: number
  let envId: string

  beforeAll(async () => {
    up = await upstreamApp()
    rt = fakeRuntime()
    pp = await freePort()
    t = await testApp({
      http: true,
      env: { PREVIEW_PORT: String(pp), PREVIEW_DOMAIN: 'preview.test', PUBLIC_URL: 'http://mp.test' },
      overrides: { containers: rt },
    })
    const s = await session(t)
    envId = (await s.tool('env.up', { image: 'node:22', expose: [5173] })).envId
    rt.servePreview(envId, 5173, { host: '127.0.0.1', port: up.port })
  })
  afterAll(async () => {
    await t?.close()
    await up?.close()
  })

  const label = () => `${envId.toLowerCase()}-5173.preview.test`

  it('gives each preview its own origin, and binds its cookie to that host', async () => {
    const tok = await t.req('POST', '/api/previews/token', { envId, port: 5173 })
    expect(tok.status).toBe(200)
    expect(tok.body.origin).toBe(`http://${label()}`)
    const u = new URL(tok.body.url)
    // Exchanged on another preview's host: refused (and the token is not used up).
    const wrong = await rawRequest(pp, `${u.pathname}${u.search}`, { host: 'mp-other-5173.preview.test' })
    expect(wrong.status).toBe(403)
    const ok = await rawRequest(pp, `${u.pathname}${u.search}`, { host: label() })
    expect(ok.status).toBe(302)
    const cookie = setCookieOf(ok.headers, PREVIEW_COOKIE)!.split(';')[0]!
    expect(ok.headers['content-security-policy']).toBe('frame-ancestors http://mp.test')

    const res = await rawRequest(pp, '/echo', { host: label(), cookie })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).headers.host).toBe('localhost:5173')
    // The same cookie sent to another preview's host (a browser wouldn't) is refused.
    expect((await rawRequest(pp, '/echo', { host: 'mp-other-5173.preview.test', cookie })).status).toBe(403)
  })

  it('the harness refuses preview hosts and origins, and frames *.PREVIEW_DOMAIN only', async () => {
    const harness = await t.as((await t.admin()).contactId, { via: 'cookie' })
    const fromPreview = await t.a.app.request('http://mp.test/api/me', { headers: { ...harness, origin: `http://${label()}` } })
    expect(fromPreview.status).toBe(403)
    const onPreviewHost = await t.a.app.request(`http://${label()}/api/me`, { headers: harness })
    expect(onPreviewHost.status).toBe(403)
    expect((await t.a.app.request('http://mp.test/api/me', { headers: harness })).status).toBe(200)
    const { contentSecurityPolicy } = await import('../src/auth/headers.ts')
    expect(contentSecurityPolicy(t.config)).toContain('frame-src http://*.preview.test;')
  })
})

describe('previews off', () => {
  it('without a runtime: no listener, and tokens are unavailable', async () => {
    const t = await testApp({ http: true })
    try {
      expect(t.a.previews.enabled).toBe(false)
      expect(t.a.previews.port()).toBeNull()
      const r = await t.req('POST', '/api/previews/token', { envId: 'env_x', port: 5173 })
      expect(r.status).toBe(503)
    } finally {
      await t.close()
    }
  })

  it('in domain mode without PUBLIC_URL (no harness origin to allow framing)', async () => {
    const t = await testApp({ env: { PREVIEW_DOMAIN: 'preview.test' }, overrides: { containers: fakeRuntime() } })
    try {
      expect(t.a.previews.enabled).toBe(false)
    } finally {
      await t.close()
    }
  })
})
