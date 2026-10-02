/**
 * Projects and who works on them (src/projects), the "Your projects" run entry
 * (src/session-projects.ts), migrations of older employees (src/bootstrap.ts)
 * and how chat labels a router context's messages (src/http/views.ts).
 */
import { type ModelRequest, reply } from '@mp/model'
import { PROJECTS_ENTRY_META } from '@mp/stdlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_EMPLOYEE, migrateEmployees, OLD_DEFAULT_PERSONALITIES } from '../src/bootstrap.ts'
import { Views } from '../src/http/views.ts'
import { repoKey } from '../src/projects/index.ts'
import { type TestApp, testApp } from './helpers.ts'
import { quiet } from './scenarios.ts'

let t: TestApp
let employeeId: string
let aiContactId: string
let member: Record<string, string>
let viewer: Record<string, string>
let ana: string
let n = 0
/** The last request the model got. */
let lastRequest: ModelRequest | null = null

beforeAll(async () => {
  t = await testApp({
    script: (req: ModelRequest) => {
      lastRequest = req
      return reply('ok')
    },
  })
  const s = t.a.services
  const e = (await s.directory.employees.byHandle('meatless'))!
  employeeId = e.id
  aiContactId = e.data.contactId
  ana = (await s.directory.contacts.create({ name: 'Ana Example', kind: 'person', email: 'ana@example.com' })).id
  const mia = await s.directory.contacts.create({ name: 'Mia', kind: 'person' })
  member = await t.as(mia.id, { access: 'member' })
  const vic = await s.directory.contacts.create({ name: 'Vic', kind: 'person' })
  viewer = await t.as(vic.id, { access: 'viewer' })
})
afterAll(async () => {
  await t.close()
})

/** A unique project name per test. */
const name = () => `Project ${++n}`

describe('repoKey', () => {
  it('makes the https and ssh URLs of one repository equal', () => {
    expect(repoKey('git@gitlab.com:Acme/Pay.git')).toBe('gitlab.com/acme/pay')
    expect(repoKey('https://gitlab.com/acme/pay')).toBe('gitlab.com/acme/pay')
    expect(repoKey('https://gitlab.com/acme/pay/-/tree/main')).toBe('gitlab.com/acme/pay')
    expect(repoKey('ssh://git@gitlab.com/acme/pay.git')).toBe('gitlab.com/acme/pay')
    expect(repoKey('not a url')).toBeNull()
    expect(repoKey('ftp://x.example.com/a')).toBeNull()
    expect(repoKey('')).toBeNull()
  })
})

describe('POST /api/projects', () => {
  it('creates a project with repositories, docs, an employee owner and members in one step', async () => {
    const r = await t.req('POST', '/api/projects', {
      name: 'Payments',
      description: 'Card payments and refunds.',
      repositories: ['git@gitlab.example.com:acme/payments.git', 'https://gitlab.example.com/acme/payments', ''],
      docs: ['https://docs.example.com/payments'],
      owner: { employeeId },
      members: [{ contactId: ana, role: 'reviewer' }],
    })
    expect(r.status).toBe(201)
    const p = r.body.project
    expect(p.data).toMatchObject({
      name: 'Payments',
      status: 'active',
      description: 'Card payments and refunds.',
      // The same repository twice (ssh and https) is kept once.
      repositories: [{ url: 'git@gitlab.example.com:acme/payments.git' }],
      links: [{ system: 'docs', ref: 'https://docs.example.com/payments' }],
    })
    expect(r.body.people).toEqual([
      { contactId: aiContactId, name: 'Meatless', kind: 'ai', employeeId, handle: 'meatless', roles: ['owner'] },
      { contactId: ana, name: 'Ana Example', kind: 'person', roles: ['reviewer'] },
    ])
    // The link is the one everything reads: the directory, GitLab hook provisioning, the run entry.
    const mine = await t.a.services.directory.projects.forContact(aiContactId)
    expect(mine.find((m) => m.project.id === p.id)?.roles).toEqual(['owner'])
    const emp = await t.req('GET', `/api/employees/${employeeId}/projects`, undefined, viewer)
    expect(emp.status).toBe(200)
    expect(emp.body.projects.find((x: any) => x.project.id === p.id)).toMatchObject({
      roles: ['owner'],
      owner: { contactId: aiContactId, name: 'Meatless' },
    })
  })

  it('refuses a taken name or repository, bad URLs and unknown people, creating nothing', async () => {
    const first = name()
    expect((await t.req('POST', '/api/projects', { name: first, repositories: ['https://git.example.com/a/one'] })).status).toBe(
      201,
    )
    const count = async () => (await t.a.services.directory.projects.list({ limit: 1000 })).items.length
    const before = await count()
    const dupName = await t.req('POST', '/api/projects', { name: first.toUpperCase() })
    expect(dupName.status).toBe(409)
    const dupRepo = await t.req('POST', '/api/projects', { name: name(), repositories: ['git@git.example.com:a/one.git'] })
    expect(dupRepo.status).toBe(409)
    expect(dupRepo.body.error.message).toContain(first)
    expect((await t.req('POST', '/api/projects', { name: name(), repositories: ['nope'] })).status).toBe(422)
    expect((await t.req('POST', '/api/projects', { name: name(), docs: ['javascript:alert(1)'] })).status).toBe(422)
    expect((await t.req('POST', '/api/projects', { name: name(), owner: { employeeId: 'emp_missing' } })).status).toBe(404)
    expect((await t.req('POST', '/api/projects', { name: name(), owner: {} })).status).toBe(400)
    expect((await t.req('POST', '/api/projects', { name: name(), members: [{ contactId: ana, role: 'identity' }] })).status).toBe(
      422,
    )
    expect((await t.req('POST', '/api/projects', { name: '  ' })).status).toBe(400)
    expect((await t.req('POST', '/api/projects', {})).status).toBe(400)
    expect(await count()).toBe(before)
  })

  it('members and admins create projects; viewers and anonymous callers cannot', async () => {
    expect((await t.req('POST', '/api/projects', { name: name() }, member)).status).toBe(201)
    expect((await t.req('POST', '/api/projects', { name: name() }, viewer)).status).toBe(403)
    expect((await t.req('POST', '/api/projects', { name: name() }, { authorization: '' })).status).toBe(401)
  })
})

describe('project people', () => {
  let projectId: string
  beforeEach(async () => {
    projectId = (await t.req('POST', '/api/projects', { name: name(), owner: { contactId: ana } })).body.project.id
  })

  it('adds an employee and a person, and lists them owners first', async () => {
    const r = await t.req('POST', `/api/projects/${projectId}/people`, { employeeId }, member)
    expect(r.status).toBe(200)
    expect(r.body.people.map((p: any) => [p.name, p.roles])).toEqual([
      ['Ana Example', ['owner']],
      ['Meatless', ['member']],
    ])
    // Idempotent, and a second role adds to the first.
    await t.req('POST', `/api/projects/${projectId}/people`, { employeeId })
    const two = await t.req('POST', `/api/projects/${projectId}/people`, { contactId: aiContactId, role: 'Reviewer' })
    expect(two.body.people.find((p: any) => p.contactId === aiContactId).roles).toEqual(['member', 'reviewer'])
    expect((await t.req('GET', `/api/projects/${projectId}/people`, undefined, viewer)).body).toEqual(two.body)
  })

  it('owner replaces the current owner', async () => {
    const r = await t.req('POST', `/api/projects/${projectId}/people`, { employeeId, role: 'owner' })
    expect(r.body.people.find((p: any) => p.roles.includes('owner')).contactId).toBe(aiContactId)
    expect(r.body.people.some((p: any) => p.contactId === ana)).toBe(false)
    expect((await t.a.services.directory.projects.owner(projectId))?.id).toBe(aiContactId)
  })

  it('removes one role, or every role, and drops it from an older scope', async () => {
    await t.req('POST', `/api/projects/${projectId}/people`, { employeeId })
    await t.req('POST', `/api/projects/${projectId}/people`, { employeeId, role: 'reviewer' })
    const one = await t.req('DELETE', `/api/projects/${projectId}/people/${aiContactId}?role=reviewer`, undefined, member)
    expect(one.status).toBe(200)
    expect(one.body.people.find((p: any) => p.contactId === aiContactId).roles).toEqual(['member'])
    const s = t.a.services
    await s.directory.employees.update(employeeId, { scope: { projects: [projectId] } })
    const all = await t.req('DELETE', `/api/projects/${projectId}/people/${aiContactId}`)
    expect(all.body.people.some((p: any) => p.contactId === aiContactId)).toBe(false)
    expect((await s.directory.employees.require(employeeId)).data.scope?.projects).toEqual([])
  })

  it('has a lead, who must be a person, listed first and in the project list', async () => {
    const none = await t.req('GET', `/api/projects/${projectId}/people`)
    expect(none.body.leads).toEqual([])
    expect((await t.req('GET', '/api/projects/leads', undefined, viewer)).body.leads[projectId]).toBeUndefined()

    // An AI can't lead, through the people API or a raw records link.
    const ai = await t.req('POST', `/api/projects/${projectId}/people`, { employeeId, role: 'lead' })
    expect(ai.status).toBe(422)
    expect(ai.body.error.message).toMatch(/must be a person/)
    const raw = await t.req('POST', `/api/records/contact/${aiContactId}/links`, {
      to: { kind: 'project', id: projectId },
      role: 'lead',
    })
    expect(raw.status).toBe(422)

    const bo = (await t.a.services.directory.contacts.create({ name: 'Bo Example', kind: 'person' })).id
    await t.req('POST', `/api/projects/${projectId}/people`, { employeeId })
    const r = await t.req('POST', `/api/projects/${projectId}/people`, { contactId: bo, role: 'lead' }, member)
    expect(r.status).toBe(200)
    expect(r.body.leads).toEqual([{ contactId: bo, name: 'Bo Example' }])
    expect(r.body.people.map((p: any) => [p.name, p.roles])).toEqual([
      ['Bo Example', ['lead']],
      ['Ana Example', ['owner']],
      ['Meatless', ['member']],
    ])
    const all = await t.req('GET', '/api/projects/leads', undefined, viewer)
    expect(all.status).toBe(200)
    expect(all.body.leads[projectId]).toEqual([{ contactId: bo, name: 'Bo Example' }])
    const mine = await t.req('GET', `/api/employees/${employeeId}/projects`)
    expect(mine.body.projects.find((p: any) => p.project.id === projectId).leads).toEqual([{ contactId: bo, name: 'Bo Example' }])
  })

  it('checks access, input and existence', async () => {
    expect((await t.req('POST', `/api/projects/${projectId}/people`, { employeeId }, viewer)).status).toBe(403)
    expect((await t.req('DELETE', `/api/projects/${projectId}/people/${ana}`, undefined, viewer)).status).toBe(403)
    expect((await t.req('POST', `/api/projects/${projectId}/people`, {})).status).toBe(400)
    expect((await t.req('POST', `/api/projects/${projectId}/people`, { contactId: ana, role: 'x'.repeat(41) })).status).toBe(422)
    expect((await t.req('POST', '/api/projects/pro_missing/people', { contactId: ana })).status).toBe(404)
    expect((await t.req('GET', '/api/projects/pro_missing/people')).status).toBe(404)
    expect((await t.req('GET', '/api/employees/emp_missing/projects')).status).toBe(404)
  })
})

describe('the employee always sees its current projects', () => {
  it("adds a current 'Your projects' entry to each router run, and never changes the cached prefix", async () => {
    const s = t.a.services
    const routerId = (await s.directory.employees.require(employeeId)).data.routerSessionId!
    const before = await s.sessions.history(routerId)
    const requests = (await s.chat.channelByName('requests'))!.id

    const ask = async (text: string) => {
      await t.req('POST', `/api/chat/channels/${requests}/messages`, { text })
      await quiet(t)
      const run = (await s.sessions.runs({ sessionId: routerId })).at(-1)!
      return s.sessions.runHistory(run.id)
    }
    // Assigned after the router context was created.
    const p = await t.req('POST', '/api/projects', {
      name: 'Late Project',
      description: 'Assigned after the session started.',
      repositories: ['git@git.example.com:acme/late.git'],
      members: [{ employeeId, role: 'member' }],
    })
    const h1 = await ask('What projects are you in charge of?')
    const entry = h1.find((e) => e.meta[PROJECTS_ENTRY_META] !== undefined)!
    const text = (entry.content as { text: string }).text
    expect(text).toContain(`- Late Project (${p.body.project.id}); your role: member`)
    expect(text).toContain('repos: git@git.example.com:acme/late.git')
    // After the router's history, before the event.
    const at = h1.indexOf(entry)
    expect(h1.slice(0, before.length).map((e) => e.id)).toEqual(before.map((e) => e.id))
    expect(at).toBeGreaterThanOrEqual(before.length)
    expect(h1[at + 1]!.kind).toBe('event')
    // The model saw it.
    expect(lastRequest!.messages.some((m) => (m.content ?? '').includes('Late Project'))).toBe(true)

    // Unassigned: the next run says so, and the system prompt is the same bytes throughout.
    await t.req('DELETE', `/api/projects/${p.body.project.id}/people/${aiContactId}`)
    const h2 = await ask('And now?')
    const text2 = (h2.find((e) => e.meta[PROJECTS_ENTRY_META] !== undefined)!.content as { text: string }).text
    expect(text2).not.toContain('Late Project')
    const after = await s.sessions.history(routerId)
    expect(JSON.stringify(after[0]!.content)).toBe(JSON.stringify(before[0]!.content))
    expect(after[0]!.id).toBe(before[0]!.id)
    // The ephemeral run's entry was rolled back with it: the router keeps only decisions.
    expect(after.some((e) => e.meta[PROJECTS_ENTRY_META] !== undefined)).toBe(false)
  })
})

describe('migrateEmployees', () => {
  it('replaces exactly the old default personality, tells the router context, and leaves custom ones alone', async () => {
    const s = t.a.services
    const old = OLD_DEFAULT_PERSONALITIES[0]!
    expect(DEFAULT_EMPLOYEE.personality).not.toMatch(/Signs off/)
    await s.directory.employees.update(employeeId, { personality: old })
    const custom = await s.directory.employees.create({ name: `Custom ${++n}`, personality: `${old} Also sings.` })
    const routerId = (await s.directory.employees.require(employeeId)).data.routerSessionId!

    const r = await migrateEmployees(s)
    expect(r.personalities).toBe(1)
    expect((await s.directory.employees.require(employeeId)).data.personality).toBe(DEFAULT_EMPLOYEE.personality)
    expect((await s.directory.employees.require(custom.id)).data.personality).toBe(`${old} Also sings.`)
    const note = (await s.sessions.history(routerId)).at(-1)!
    expect(note.kind).toBe('system')
    expect((note.content as { text: string }).text).toMatch(/Don't sign off/)

    // Idempotent.
    const len = (await s.sessions.history(routerId)).length
    expect((await migrateEmployees(s)).personalities).toBe(0)
    expect((await s.sessions.history(routerId)).length).toBe(len)
  })

  it('turns older scope projects into member links', async () => {
    const s = t.a.services
    const p = await s.directory.projects.create({ name: name() })
    const e = await s.directory.employees.create({ name: `Scoped ${++n}`, scope: { projects: [p.id, 'pro_gone'], teams: ['a'] } })
    const r = await migrateEmployees(s)
    expect(r.projects).toBeGreaterThanOrEqual(2)
    expect((await s.directory.projects.forContact(e.data.contactId)).map((m) => [m.project.id, m.roles])).toEqual([
      [p.id, ['member']],
    ])
    expect((await s.directory.employees.require(e.id)).data.scope).toEqual({ projects: [], teams: ['a'] })
  })
})

describe('chat labels for a router context', () => {
  it("shows the router context's messages as the employee, and other sessions as @employee#slug", async () => {
    const s = t.a.services
    const routerId = (await s.directory.employees.require(employeeId)).data.routerSessionId!
    const v = new Views(s)
    expect(await v.author({ kind: 'session', id: routerId })).toEqual({
      type: 'employee',
      id: employeeId,
      name: 'Meatless',
      handle: 'meatless',
    })
    expect(await v.member({ kind: 'session', id: routerId })).toEqual({ type: 'employee', id: employeeId, label: 'Meatless' })
    const other = await s.sessions.create({ employeeId, title: 'Refund', slug: 'refund-1', toolset: [] })
    expect(await v.author({ kind: 'session', id: other.id })).toEqual({
      type: 'session',
      id: other.id,
      name: '@meatless#refund-1',
    })
    expect(await v.author({ kind: 'contact', id: aiContactId })).toEqual({
      type: 'employee',
      id: employeeId,
      name: 'Meatless',
      handle: 'meatless',
    })
  })
})
