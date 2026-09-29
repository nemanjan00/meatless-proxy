/**
 * The GitLab projects step's own listing (src/setup/gitlab-listing.ts): search and paging passed to
 * GitLab, access levels per row, `added` matching, the default branch check per row, and who may call
 * it. Against a fake GitLab (an injected `fetch`; nothing real is ever called).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type TestApp, testApp } from './helpers.ts'
import { type Backend, memoryBackend, realBackend } from './scenarios.ts'

const GITLAB_URL = 'https://gitlab.test'
const TOKEN = 'glpat-test-listing'

interface FakeProject {
  id: number
  name: string
  path_with_namespace: string
  default_branch: string | null
  web_url: string
  http_url_to_repo: string
  ssh_url_to_repo: string
  level: number
}

function fakeGitlab(count: number) {
  const projects: FakeProject[] = Array.from({ length: count }, (_, i) => {
    const id = i + 1
    const path = `acme/${id % 3 === 0 ? 'billing' : 'service'}-${id}`
    return {
      id,
      name: path.split('/')[1]!,
      path_with_namespace: path,
      default_branch: id === 5 ? null : 'main',
      web_url: `${GITLAB_URL}/${path}`,
      http_url_to_repo: `${GITLAB_URL}/${path}.git`,
      ssh_url_to_repo: `git@gitlab.test:${path}.git`,
      level: id === 2 ? 40 : 30,
    }
  })
  const w = {
    projects,
    protected: { 1: ['main'], 2: ['release/*'] } as Record<number, string[]>,
    listings: [] as URLSearchParams[],
    calls: [] as string[],
    /** Next listing answers with this status. */
    listStatus: 200,
    headers: [] as Headers[],
  }
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== GITLAB_URL) throw new Error(`unexpected fetch ${url.href}`)
    const headers = new Headers(init.headers)
    w.headers.push(headers)
    const path = url.pathname.replace(/^\/api\/v4/, '')
    w.calls.push(path)
    if (headers.get('private-token') !== TOKEN) return json({ message: '401 Unauthorized' }, 401)
    if (path === '/user') return json({ id: 7, username: 'billing-bot', bot: true })
    if (path === '/personal_access_tokens/self') return json({ scopes: ['api'], expires_at: null })
    if (path === '/user/keys') return json([])
    const view = (p: FakeProject, simple: boolean) => {
      const { level, ...rest } = p
      return simple ? rest : { ...rest, permissions: { project_access: { access_level: level }, group_access: null } }
    }
    if (path === '/projects') {
      w.listings.push(url.searchParams)
      if (w.listStatus !== 200) return json({ message: 'nope' }, w.listStatus)
      const q = url.searchParams
      const search = (q.get('search') ?? '').toLowerCase()
      const hits = w.projects.filter((p) => !search || p.path_with_namespace.toLowerCase().includes(search))
      const page = Number(q.get('page') ?? 1)
      const per = Number(q.get('per_page') ?? 20)
      const rows = hits.slice((page - 1) * per, page * per)
      const next = page * per < hits.length ? String(page + 1) : ''
      return json(
        rows.map((p) => view(p, q.get('simple') === 'true')),
        200,
        { 'x-next-page': next, 'x-total': String(hits.length), 'x-page': String(page) },
      )
    }
    const one = /^\/projects\/(\d+)$/.exec(path)
    if (one) {
      const p = w.projects.find((x) => x.id === Number(one[1]))
      return p ? json(view(p, false)) : json({ message: '404 Project Not Found' }, 404)
    }
    const pb = /^\/projects\/(\d+)\/protected_branches$/.exec(path)
    if (pb) return json((w.protected[Number(pb[1])] ?? []).map((name) => ({ name })))
    return json({ message: '404 Not found' }, 404)
  }) as typeof globalThis.fetch
  return { ...w, world: w, fetch }
}

function listingSuite(backend: Backend) {
  let t: TestApp
  let cleanup: () => Promise<void>
  let fake: ReturnType<typeof fakeGitlab>
  let member: Record<string, string>
  let emp: string
  let n = 0

  beforeAll(async () => {
    const b = await backend.make()
    cleanup = b.cleanup
    fake = fakeGitlab(130)
    t = await testApp({
      env: { ...b.env, PUBLIC_URL: 'https://mp.example.com' },
      overrides: { integrations: { fetch: (...a) => fake.fetch(...a), baseUrls: { gitlab: GITLAB_URL } } },
    })
    const c = await t.a.services.directory.contacts.create({ name: 'Mia', kind: 'person' })
    member = await t.as(c.id, { access: 'member' })
  })
  afterAll(async () => {
    await t?.close()
    await cleanup?.()
  })
  beforeEach(async () => {
    Object.assign(fake, fakeGitlab(130))
    const r = await t.req('POST', '/api/employees', { name: `Lister ${++n}` })
    expect(r.status).toBe(201)
    emp = r.body.employee.id
  })

  const list = (query = '', headers?: Record<string, string>) =>
    t.req('GET', `/api/employees/${emp}/integrations/gitlab/projects${query}`, undefined, headers)
  const connect = async () => {
    await t.a.services.secrets.set('GITLAB_TOKEN', TOKEN, { type: 'employee', id: emp })
  }

  it('asks for the token first, and is for admins only', async () => {
    const none = await list()
    expect(none.status).toBe(422)
    expect(none.body.error.message).toMatch(/token first/)
    await connect()
    expect((await list('', member)).status).toBe(403)
    expect(
      (await t.req('GET', `/api/employees/${emp}/integrations/gitlab/projects/1/protection`, undefined, member)).status,
    ).toBe(403)
    expect((await list('', { authorization: '' })).status).toBe(401)
    expect((await t.req('GET', '/api/employees/emp_nope/integrations/gitlab/projects')).status).toBe(404)
  })

  it('lists a page with simple=true, access levels per row, and GitLab’s paging headers', async () => {
    await connect()
    const r = await list()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ search: '', page: 1, perPage: 50, nextPage: 2, total: 130 })
    expect(r.body.projects).toHaveLength(50)
    const q = fake.world.listings[0]!
    expect(Object.fromEntries(q)).toMatchObject({
      membership: 'true',
      archived: 'false',
      simple: 'true',
      order_by: 'last_activity_at',
      page: '1',
      per_page: '50',
    })
    expect(q.has('search')).toBe(false)
    const first = r.body.projects[0]
    expect(first).toEqual({
      id: 1,
      path: 'acme/service-1',
      name: 'service-1',
      webUrl: `${GITLAB_URL}/acme/service-1`,
      accessLevel: 30,
      role: 'Developer',
      defaultBranch: 'main',
      protected: null,
      warnings: [],
      added: null,
    })
    const maintainer = r.body.projects.find((p: any) => p.id === 2)
    expect(maintainer.role).toBe('Maintainer')
    expect(maintainer.warnings[0]).toMatch(/Maintainer: it could merge or push to protected branches/)
    // One project read per row on the page, no protected branch listing.
    expect(fake.world.calls.filter((c) => /^\/projects\/\d+$/.test(c))).toHaveLength(50)
    expect(fake.world.calls.some((c) => c.endsWith('/protected_branches'))).toBe(false)

    const last = await list('?page=3&perPage=50')
    expect(last.body).toMatchObject({ page: 3, nextPage: null, total: 130 })
    expect(last.body.projects).toHaveLength(30)
    expect(last.body.projects[0].id).toBe(101)
  })

  it('passes the search through to GitLab, with namespaces', async () => {
    await connect()
    const r = await list(`?search=${encodeURIComponent('  billing ')}&perPage=10`)
    expect(r.status).toBe(200)
    const q = fake.world.listings.at(-1)!
    expect(q.get('search')).toBe('billing')
    expect(q.get('search_namespaces')).toBe('true')
    expect(q.get('per_page')).toBe('10')
    expect(r.body.search).toBe('billing')
    expect(r.body.total).toBe(43)
    expect(r.body.projects.every((p: any) => p.path.includes('billing'))).toBe(true)
    const none = await list('?search=nothing-like-it')
    expect(none.body).toMatchObject({ projects: [], total: 0, nextPage: null })
  })

  it('caps perPage at 100 and refuses bad paging', async () => {
    await connect()
    const r = await list('?perPage=500')
    expect(r.body.perPage).toBe(100)
    expect(fake.world.listings.at(-1)!.get('per_page')).toBe('100')
    expect((await list('?page=0')).status).toBe(400)
    expect((await list('?perPage=abc')).status).toBe(400)
  })

  it('marks projects the harness has, and whether the employee is on them', async () => {
    const s = t.a.services
    await connect()
    const other = await s.directory.projects.create({
      name: `Service one ${n}`,
      repositories: [{ url: `${GITLAB_URL}/acme/service-1` }],
    })
    const mine = await s.directory.projects.create({
      name: `Billing three ${n}`,
      repositories: [{ url: 'git@gitlab.test:acme/billing-3.git' }],
    })
    const contact = await s.directory.employees.contact(emp)
    expect((await t.req('POST', `/api/projects/${mine.id}/people`, { contactId: contact.id, role: 'member' })).status).toBe(200)
    const rows = (await list('?perPage=5')).body.projects
    expect(rows[0].added).toEqual({ projectId: other.id, name: other.data.name, linked: false })
    expect(rows[2].added).toEqual({ projectId: mine.id, name: mine.data.name, linked: true })
    expect(rows[1].added).toBeNull()
    await s.records.delete('project', other.id, { cascade: true })
    await s.records.delete('project', mine.id, { cascade: true })
  })

  it('never returns the token, and explains a rejected token or a GitLab failure', async () => {
    await connect()
    const ok = await list()
    expect(JSON.stringify(ok.body)).not.toContain(TOKEN)
    expect(fake.world.headers.every((h) => h.get('private-token') === TOKEN)).toBe(true)
    fake.world.listStatus = 500
    const down = await list()
    expect(down.status).toBe(503)
    expect(JSON.stringify(down.body)).not.toContain(TOKEN)
    await t.a.services.secrets.set('GITLAB_TOKEN', 'glpat-wrong', { type: 'employee', id: emp })
    fake.world.listStatus = 200
    const bad = await list()
    expect(bad.status).toBe(422)
    expect(bad.body.error.message).toMatch(/rejected the token/)
    expect(JSON.stringify(bad.body)).not.toContain('glpat-wrong')
  })

  it('checks one project’s default branch on demand', async () => {
    await connect()
    const at = (id: number | string) => t.req('GET', `/api/employees/${emp}/integrations/gitlab/projects/${id}/protection`)
    expect((await at(1)).body).toEqual({ projectId: 1, defaultBranch: 'main', protected: true, warning: null })
    const open = (await at(2)).body
    expect(open).toMatchObject({ projectId: 2, defaultBranch: 'main', protected: false })
    expect(open.warning).toMatch(/main isn’t protected/)
    expect((await at(5)).body).toEqual({ projectId: 5, defaultBranch: null, protected: null, warning: null })
    expect((await at(9999)).status).toBe(404)
    expect((await at('abc')).status).toBe(400)
  })

  it('keeps the status check to its small first page, with the total', async () => {
    await connect()
    const r = await t.req('GET', `/api/employees/${emp}/integrations?refresh=1`)
    const gl = r.body.integrations.find((i: any) => i.name === 'gitlab')
    const step = gl.steps.find((s: any) => s.id === 'projects')
    expect(step.data.projects).toHaveLength(50)
    expect(step.data.total).toBe(130)
    expect(gl.actions).toContain('add-projects')
  })
}

describe('GitLab projects listing (memory)', () => listingSuite(memoryBackend))

const { DATABASE_URL, REDIS_URL } = process.env
describe.skipIf(!DATABASE_URL || !REDIS_URL)('GitLab projects listing (postgres + bullmq)', () =>
  listingSuite(realBackend(DATABASE_URL!, REDIS_URL!)),
)
