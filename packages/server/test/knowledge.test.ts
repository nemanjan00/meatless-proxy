import type * as Api from '@mp/api'
import { reply } from '@mp/model'
import { afterToolCall } from '@mp/runner'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'
import { type Backend, memoryBackend, realBackend } from './scenarios.ts'

const SLACK_API = 'https://slack.test/api'

/** A Slack Web API that opens DMs and takes messages, and remembers what it was asked. */
function fakeSlack() {
  const calls: { method: string; body: Record<string, unknown> }[] = []
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const raw = typeof init.body === 'string' ? init.body : ''
    const type = new Headers(init.headers).get('content-type') ?? ''
    const body = type.includes('json') && raw ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
    const method = url.pathname.replace(/^\/api\//, '')
    calls.push({ method, body })
    if (method === 'conversations.open')
      return body.users === 'U_BAD' ? json({ ok: false, error: 'user_not_found' }) : json({ ok: true, channel: { id: 'D_NEW' } })
    if (method === 'chat.postMessage') return json({ ok: true, channel: body.channel, ts: '1700000000.000100' })
    if (method === 'auth.test') return json({ ok: true, user_id: 'UBOT' })
    return json({ ok: false, error: 'unknown_method' })
  }) as typeof globalThis.fetch
  return { fetch: fakeFetch, calls }
}

/** Memory, skills and people (src/knowledge): access rules, memory privacy, deactivation and sign-in links. */
function knowledgeSuite(backend: Backend) {
  let t: TestApp
  let cleanup: () => Promise<void>
  let employeeId: string
  let mia: string
  let vic: string
  let bob: string
  let project: string
  let member: Record<string, string>
  let viewer: Record<string, string>
  const slack = fakeSlack()
  let n = 0
  const uniq = () => `${++n}${Math.random().toString(36).slice(2, 6)}`

  beforeAll(async () => {
    const b = await backend.make()
    cleanup = b.cleanup
    t = await testApp({
      env: b.env,
      script: () => reply('ok'),
      overrides: { integrations: { fetch: slack.fetch, baseUrls: { slack: SLACK_API } } },
    })
    const s = t.a.services
    employeeId = (await s.directory.employees.byHandle('meatless'))!.id
    mia = (await s.directory.contacts.create({ name: 'Mia Member', kind: 'person', email: `mia${uniq()}@example.com` })).id
    vic = (await s.directory.contacts.create({ name: 'Vic Viewer', kind: 'person' })).id
    bob = (await s.directory.contacts.create({ name: 'Bob Other', kind: 'person' })).id
    project = (await s.directory.projects.create({ name: `Payments ${uniq()}`, description: 'd', status: 'active' } as never)).id
    member = await t.as(mia, { access: 'member' })
    viewer = await t.as(vic, { access: 'viewer' })
  })
  afterAll(async () => {
    await t.close()
    await cleanup()
  })

  const remember = (body: Partial<Api.CreateMemoryBody>, headers?: Record<string, string>) =>
    t.req<Api.CreatedMemory>('POST', '/api/memories', { summary: `A fact ${uniq()}.`, ...body }, headers)
  const listed = async (headers?: Record<string, string>, q = '') =>
    (await t.req<Api.MemoryPage>('GET', `/api/memories${q}`, undefined, headers)).body

  // ── Memory ────────────────────────────────────────────────────────────────

  describe('memory', () => {
    let company: string
    let aboutMia: string
    let aboutVic: string
    let onProject: string

    beforeAll(async () => {
      company = (await remember({ summary: `Deploys happen on Tuesdays ${uniq()}.` })).body.memory.memory.id
      aboutMia = (
        await remember({
          summary: `Mia likes short updates ${uniq()}.`,
          kind: 'preference',
          about: [{ kind: 'contact', id: mia }],
        })
      ).body.memory.memory.id
      aboutVic = (await remember({ summary: `Vic is on leave in May ${uniq()}.`, scope: { type: 'contact', id: vic } })).body
        .memory.memory.id
      onProject = (
        await remember({
          summary: `Refund keys are invoice ids ${uniq()}.`,
          kind: 'decision',
          about: [{ kind: 'project', id: project }],
          employeeId,
        })
      ).body.memory.memory.id
    })

    it('shows people the memories about themselves and the non-personal ones; admins see all', async () => {
      const ids = (p: Api.MemoryPage) => p.items.map((i) => i.memory.id)
      const asAdmin = ids(await listed())
      expect(asAdmin).toEqual(expect.arrayContaining([company, aboutMia, aboutVic, onProject]))
      const asMia = ids(await listed(member))
      expect(asMia).toEqual(expect.arrayContaining([company, aboutMia, onProject]))
      expect(asMia).not.toContain(aboutVic)
      const asVic = ids(await listed(viewer))
      expect(asVic).toEqual(expect.arrayContaining([company, aboutVic, onProject]))
      expect(asVic).not.toContain(aboutMia)
      // One memory at a time too, and its facets never name what's hidden.
      expect((await t.req('GET', `/api/memories/${aboutVic}`, undefined, member)).status).toBe(404)
      expect((await t.req('GET', `/api/memories/${aboutVic}`, undefined, viewer)).status).toBe(200)
      expect((await listed(member)).facets.subjects.map((x) => x.id)).not.toContain(vic)
      const row = (await listed(member)).items.find((i) => i.memory.id === aboutMia)!
      expect(row).toMatchObject({ personal: true, canEdit: true, about: [{ kind: 'contact', id: mia, name: 'Mia Member' }] })
      expect(row.source.person).toMatchObject({ name: expect.any(String), kind: 'person' })
    })

    it('keeps the generic records API from leaking memories', async () => {
      expect((await t.req('GET', '/api/records/memory', undefined, member)).status).toBe(403)
      expect((await t.req('GET', '/api/records/memory', undefined)).status).toBe(200)
      expect((await t.req('GET', `/api/records/memory/${aboutVic}`, undefined, member)).status).toBe(404)
      expect((await t.req('GET', `/api/records/memory/${aboutVic}/revisions`, undefined, member)).status).toBe(404)
      expect((await t.req('GET', `/api/records/memory/${aboutMia}`, undefined, member)).status).toBe(200)
      expect((await t.req('PATCH', `/api/records/memory/${company}`, { data: { summary: 'x' } }, member)).status).toBe(403)
      // Links from a person to memories about them are shown to them and admins only.
      const links = await t.req<Api.ApiLinkedRecord[]>('GET', `/api/records/contact/${mia}/links`, undefined, viewer)
      expect(links.body.map((l) => l.record.id)).not.toContain(aboutMia)
      const own = await t.req<Api.ApiLinkedRecord[]>('GET', `/api/records/contact/${mia}/links`, undefined, member)
      expect(own.body.map((l) => l.record.id)).toContain(aboutMia)
    })

    it('lets anyone correct or forget a memory about themselves, and only members change the rest', async () => {
      // Vic is a viewer: not allowed to add or edit company knowledge…
      expect((await remember({}, viewer)).status).toBe(403)
      expect((await t.req('PATCH', `/api/memories/${company}`, { summary: 'Nope.' }, viewer)).status).toBe(403)
      expect((await t.req('DELETE', `/api/memories/${company}`, undefined, viewer)).status).toBe(403)
      // …but may correct what's about him, with a note that shows in the history.
      const fixed = await t.req<Api.MemoryDetail>(
        'PATCH',
        `/api/memories/${aboutVic}`,
        { summary: 'Vic is on leave in June.', note: 'It moved to June.' },
        viewer,
      )
      expect(fixed.status).toBe(200)
      expect(fixed.body.memory.data).toMatchObject({
        summary: 'Vic is on leave in June.',
        correction: { note: 'It moved to June.', contactId: vic },
      })
      expect(fixed.body.memory.data.verified).toBeTruthy()
      expect(fixed.body.history[0]).toMatchObject({
        note: 'It moved to June.',
        changed: expect.arrayContaining(['summary', 'correction']),
      })
      expect(fixed.body.history.at(-1)).toMatchObject({ op: 'create' })
      expect((await t.req('PATCH', `/api/memories/${aboutVic}`, { note: '  ' }, viewer)).status).toBe(400)
      // Mia can't touch it at all (she can't see it).
      expect((await t.req('PATCH', `/api/memories/${aboutVic}`, { summary: 'x' }, member)).status).toBe(404)
      expect((await t.req('DELETE', `/api/memories/${aboutVic}`, undefined, member)).status).toBe(404)
      // A stale version is refused.
      const stale = await t.req('PATCH', `/api/memories/${aboutVic}`, { content: 'more', version: 1 }, viewer)
      expect(stale.status).toBe(409)
      // Forgetting it.
      expect((await t.req('DELETE', `/api/memories/${aboutVic}`, undefined, viewer)).status).toBe(204)
      expect((await t.req('GET', `/api/memories/${aboutVic}`)).status).toBe(404)
      // Members edit shared knowledge.
      const edited = await t.req<Api.MemoryDetail>('PATCH', `/api/memories/${company}`, { kind: 'decision' }, member)
      expect(edited.body.memory.data.kind).toBe('decision')
    })

    it('adds a memory a person teaches, merges the same fact, and filters', async () => {
      const summary = `The billing cutoff is the 25th ${uniq()}.`
      const first = await remember(
        { summary, kind: 'fact', content: 'From finance.', employeeId, about: [{ kind: 'project', id: project }] },
        member,
      )
      expect(first.status).toBe(201)
      expect(first.body.created).toBe(true)
      expect(first.body.memory).toMatchObject({
        employee: { id: employeeId },
        source: { person: { contactId: mia, name: 'Mia Member' }, session: null },
        about: [{ kind: 'project', id: project }],
        personal: false,
      })
      const again = await remember({ summary: summary.toUpperCase(), employeeId, content: 'From finance, twice.' }, member)
      expect(again.status).toBe(200)
      expect(again.body).toMatchObject({ created: false, memory: { memory: { id: first.body.memory.memory.id } } })
      // Filters.
      const id = first.body.memory.memory.id
      expect((await listed(member, `?employeeId=${employeeId}`)).items.map((i) => i.memory.id)).toContain(id)
      expect((await listed(member, '?employeeId=shared')).items.map((i) => i.memory.id)).not.toContain(id)
      expect((await listed(member, `?about=${project}&kind=fact`)).items.map((i) => i.memory.id)).toEqual([id])
      expect((await listed(member, `?taughtBy=${mia}&text=cutoff`)).items.map((i) => i.memory.id)).toEqual([id])
      expect((await listed(member, '?mine=true')).items.every((i) => i.about.some((a) => a.id === mia))).toBe(true)
      const facets = (await listed(member)).facets
      expect(facets.employees.find((e) => e.id === employeeId)?.count).toBeGreaterThan(0)
      expect(facets.teachers.map((x) => x.contactId)).toContain(mia)
      // Bad input.
      expect((await remember({ kind: 'rumour' as never }, member)).status).toBe(400)
      expect((await remember({ about: [{ kind: 'contact', id: 'con_missing' }] }, member)).status).toBe(404)
      expect((await remember({ summary: ' ' }, member)).status).toBe(400)
      // Replacing what it's about.
      const moved = await t.req<Api.MemoryDetail>(
        'PATCH',
        `/api/memories/${id}`,
        { about: [{ kind: 'contact', id: bob }] },
        member,
      )
      expect(moved.body.about.map((a) => a.id)).toEqual([bob])
      expect(moved.body.personal).toBe(true)
      expect((await t.req('GET', `/api/memories/${id}`, undefined, member)).status).toBe(404)
    })

    it("refuses to merge into a personal memory the caller can't change", async () => {
      const summary = `Bob's badge number ${uniq()}.`
      expect((await remember({ summary, scope: { type: 'contact', id: bob } })).status).toBe(201)
      const clash = await remember({ summary, scope: { type: 'contact', id: bob } }, member)
      expect(clash.status).toBe(409)
    })

    it('tracks when employees recalled a memory', async () => {
      const s = t.a.services
      const session = { id: 'ses_test' } as never
      const run = { data: { employeeId } } as never
      await s.hooks.transform(afterToolCall, {
        run,
        session,
        tool: { name: 'memory.recall' } as never,
        result: { output: { memories: [{ id: onProject }] } },
      })
      await t.settle()
      await new Promise((r) => setTimeout(r, 50))
      const d = await t.req<Api.MemoryDetail>('GET', `/api/memories/${onProject}`)
      expect(d.body.uses).toBe(1)
      expect(d.body.lastUsedAt).toBeTruthy()
      const sorted = await listed(undefined, '?sort=used')
      expect(sorted.items[0]!.memory.id).toBe(onProject)
    })
  })

  // ── Skills ────────────────────────────────────────────────────────────────

  describe('skills', () => {
    it('creates, groups, versions, restores, switches off and deletes skills', async () => {
      const name = `cut-release-${uniq()}`
      const made = await t.req<Api.SkillDetail>(
        'POST',
        '/api/skills',
        { name, description: 'Cut a release branch.', whenToUse: 'Before a release.', body: '# v1' },
        member,
      )
      expect(made.status).toBe(201)
      expect(made.body).toMatchObject({ project: null, overrides: null, usedBy: [], updatedBy: { name: 'Mia Member' } })
      const id = made.body.skill.id
      const proj = await t.req<Api.SkillDetail>(
        'POST',
        '/api/skills',
        { name: name.toUpperCase(), description: 'For payments.', body: '# p', scope: { type: 'project', projectId: project } },
        member,
      )
      expect(proj.status).toBe(201)
      expect(proj.body.overrides).toEqual({ id, name })
      expect(proj.body.project?.id).toBe(project)
      // A taken name, a viewer, a missing project.
      const dup = await t.req('POST', '/api/skills', { name, description: 'd', body: 'b' }, member)
      expect(dup.status).toBe(409)
      expect(dup.body.error.message).toMatch(/already a skill called/)
      expect((await t.req('POST', '/api/skills', { name: 'x', description: 'd', body: 'b' }, viewer)).status).toBe(403)
      expect(
        (
          await t.req(
            'POST',
            '/api/skills',
            { name: 'x', description: 'd', body: 'b', scope: { type: 'project', projectId: 'pro_x' } },
            member,
          )
        ).status,
      ).toBe(404)
      // Company skills come first.
      const list = await t.req<Api.SkillListItem[]>('GET', '/api/skills', undefined, viewer)
      const order = list.body.map((i) => i.skill.id)
      expect(order.indexOf(id)).toBeLessThan(order.indexOf(proj.body.skill.id))
      // Edits make versions; a stale one is refused; an old one can be restored.
      const v2 = await t.req<Api.SkillDetail>('PATCH', `/api/skills/${id}`, { body: '# v2', version: 1 }, member)
      expect(v2.body.skill.version).toBe(2)
      expect((await t.req('PATCH', `/api/skills/${id}`, { body: '# v3', version: 1 }, member)).status).toBe(409)
      expect(v2.body.versions.map((v) => v.version)).toEqual([2, 1])
      expect(v2.body.versions[0]!.changed).toEqual(['body'])
      const restored = await t.req<Api.SkillDetail>('POST', `/api/skills/${id}/restore`, { version: 1 }, member)
      expect(restored.body.skill.data.body).toBe('# v1')
      expect(restored.body.skill.version).toBe(3)
      expect((await t.req('POST', `/api/skills/${id}/restore`, { version: 99 }, member)).status).toBe(404)
      // Switched off: employees don't see it.
      await t.req('PATCH', `/api/skills/${id}`, { enabled: false }, member)
      expect((await t.a.services.skills.available()).map((k) => k.id)).not.toContain(id)
      expect((await t.req<Api.SkillListItem[]>('GET', '/api/skills?disabled=false')).body.map((i) => i.skill.id)).not.toContain(
        id,
      )
      // Procedures that name it.
      await t.a.services.directory.procedures.create({ name: `Release ${uniq()}`, applies: 'x', skills: [name] })
      expect((await t.req<Api.SkillDetail>('GET', `/api/skills/${id}`)).body.procedures).toHaveLength(1)
      // Used lately.
      const session = { id: 'ses_test' } as never
      await t.a.services.skills.update(id, { enabled: true })
      await t.a.services.hooks.transform(afterToolCall, {
        run: { data: { employeeId } } as never,
        session,
        tool: { name: 'skills.load' } as never,
        result: { output: { name, version: 4 } },
      })
      await new Promise((r) => setTimeout(r, 50))
      const used = await t.req<Api.SkillDetail>('GET', `/api/skills/${id}`)
      expect(used.body.usedBy).toMatchObject([{ employee: { id: employeeId }, count: 1 }])
      expect((await t.req('DELETE', `/api/skills/${id}`, undefined, viewer)).status).toBe(403)
      expect((await t.req('DELETE', `/api/skills/${id}`, undefined, member)).status).toBe(204)
      expect((await t.req('GET', `/api/skills/${id}`)).status).toBe(404)
    })
  })

  // ── People ────────────────────────────────────────────────────────────────

  describe('people', () => {
    it('lets admins add a person with a sign-in link, sent as a Slack DM when possible', async () => {
      // Without a Slack handle the link is only shown.
      const plain = await t.req<Api.CreatedPerson>('POST', '/api/people', {
        name: 'Noa New',
        email: `noa${uniq()}@example.com`,
        access: 'member',
        role: 'Designer',
        team: 'Design',
        manager: mia,
        sendSignInLink: true,
      })
      expect(plain.status).toBe(201)
      expect(plain.body.person).toMatchObject({
        access: 'member',
        type: 'person',
        deactivated: false,
        manager: { contactId: mia },
      })
      expect(plain.body.signInLink).toMatchObject({ sentVia: null, notSent: expect.stringMatching(/no Slack handle/) })
      const link = new URL(plain.body.signInLink!.url)
      const signin = await t.a.app.request(`/auth/login?token=${encodeURIComponent(link.searchParams.get('token')!)}`)
      expect(signin.status).toBe(303)
      expect(signin.headers.get('location')).toBe('/')
      // With one, and no Slack token set up: still only shown.
      const noToken = await t.req<Api.CreatedPerson>('POST', '/api/people', {
        name: 'Sam Slack',
        handles: [{ system: 'slack', id: 'U_SAM' }],
        sendSignInLink: true,
      })
      expect(noToken.body.signInLink).toMatchObject({ sentVia: null, notSent: expect.stringMatching(/no bot token/) })
      // With Slack set up it's sent as a DM.
      await t.a.services.secrets.set('SLACK_BOT_TOKEN', 'xoxb-test', { type: 'global' })
      const sent = await t.req<Api.SignInLinkResult>('POST', `/api/people/${noToken.body.person.contact.id}/sign-in-link`, {})
      expect(sent.status).toBe(201)
      expect(sent.body.sentVia).toBe('slack')
      expect(slack.calls.find((c) => c.method === 'conversations.open')?.body.users).toBe('U_SAM')
      expect(String(slack.calls.find((c) => c.method === 'chat.postMessage')?.body.text)).toContain(sent.body.url)
      const bad = await t.req<Api.CreatedPerson>('POST', '/api/people', {
        name: 'Wrong Id',
        handles: [{ system: 'slack', id: 'U_BAD' }],
        sendSignInLink: true,
      })
      expect(bad.body.signInLink).toMatchObject({ sentVia: null, notSent: expect.stringMatching(/couldn't open a DM/) })
      // Members may not add people; emails and handles are unique; a repeated request adds one person.
      expect((await t.req('POST', '/api/people', { name: 'X' }, member)).status).toBe(403)
      expect(
        (await t.req('POST', '/api/people', { name: 'Noa Again', email: link.host && plain.body.person.contact.data.email }))
          .status,
      ).toBe(409)
      expect((await t.req('POST', '/api/people', { name: 'Sam 2', handles: [{ system: 'slack', id: 'U_SAM' }] })).status).toBe(
        409,
      )
      expect((await t.req('POST', '/api/people', { name: 'Bad', email: 'not-an-email' })).status).toBe(400)
      const key = `k-${uniq()}`
      const [a, b] = await Promise.all([
        t.req<Api.CreatedPerson>('POST', '/api/people', { name: 'Once Only', idempotencyKey: key }),
        t.req<Api.CreatedPerson>('POST', '/api/people', { name: 'Once Only', idempotencyKey: key }),
      ])
      const ok = [a, b].filter((r) => r.status === 201 || r.status === 200)
      expect(ok.length).toBeGreaterThan(0)
      const again = await t.req<Api.CreatedPerson>('POST', '/api/people', { name: 'Once Only', idempotencyKey: key })
      expect(again.status).toBe(200)
      expect(again.body.created).toBe(false)
      const onceOnly = (await t.req<Api.PersonItem[]>('GET', '/api/people?text=once%20only')).body
      expect(onceOnly).toHaveLength(1)
    })

    it('deactivates a person: no sign-in, sessions and tokens revoked, history kept; reactivates', async () => {
      const s = t.a.services
      const zed = (await s.directory.contacts.create({ name: `Zed ${uniq()}`, kind: 'person' })).id
      const tokenHeaders = await t.as(zed, { access: 'member' })
      const cookieHeaders = await t.as(zed, { via: 'cookie' })
      expect((await t.req('GET', '/api/me', undefined, tokenHeaders)).status).toBe(200)
      expect((await t.req('GET', '/api/me', undefined, cookieHeaders)).status).toBe(200)
      const pending = await s.records.query('login_link', { where: { contactId: zed }, limit: 1 })
      const unused = await t.req<Api.SignInLinkResult>('POST', `/api/people/${zed}/sign-in-link`, { send: false })
      // Only admins deactivate; nobody deactivates themselves.
      expect((await t.req('POST', `/api/people/${zed}/deactivate`, {}, member)).status).toBe(403)
      const admin = await t.admin()
      expect((await t.req('POST', `/api/people/${admin.contactId}/deactivate`, {})).status).toBe(422)
      const d = await t.req<Api.PersonDetail>('POST', `/api/people/${zed}/deactivate`, {})
      expect(d.status).toBe(200)
      expect(d.body.deactivated).toBe(true)
      expect(d.body.tokens?.every((x) => x.revoked)).toBe(true)
      expect((await t.req('GET', '/api/me', undefined, tokenHeaders)).status).toBe(401)
      expect((await t.req('GET', '/api/me', undefined, cookieHeaders)).status).toBe(401)
      const token = new URL(unused.body.url).searchParams.get('token')!
      const res = await t.a.app.request(`/auth/login?token=${encodeURIComponent(token)}`)
      expect(res.headers.get('location')).toMatch(/error=invalid_link/)
      expect((await t.req('POST', `/api/people/${zed}/sign-in-link`, {})).status).toBe(422)
      expect(pending.total).toBeGreaterThan(0)
      // Members can't undo it through the records API.
      expect((await t.req('PATCH', `/api/records/contact/${zed}`, { data: { deactivatedAt: null } }, member)).status).toBe(403)
      // Their record stays, shown as deactivated.
      const row = (await t.req<Api.PersonItem[]>('GET', '/api/people')).body.find((p) => p.contact.id === zed)!
      expect(row.deactivated).toBe(true)
      expect((await t.req<Api.PersonItem[]>('GET', '/api/people?deactivated=false')).body.map((p) => p.contact.id)).not.toContain(
        zed,
      )
      // Back: a new link works, old tokens stay revoked.
      expect((await t.req('POST', `/api/people/${zed}/reactivate`, {})).body.deactivated).toBe(false)
      const fresh = await t.req<Api.SignInLinkResult>('POST', `/api/people/${zed}/sign-in-link`, { send: false })
      const back = await t.a.app.request(
        `/auth/login?token=${encodeURIComponent(new URL(fresh.body.url).searchParams.get('token')!)}`,
      )
      expect(back.status).toBe(303)
      expect(back.headers.get('location')).toBe('/')
      expect((await t.req('GET', '/api/me', undefined, tokenHeaders)).status).toBe(401)
    })

    it('keeps the last admin, and only admins change access', async () => {
      const admin = await t.admin()
      expect((await t.req('PATCH', `/api/people/${vic}`, { access: 'admin' }, member)).status).toBe(403)
      const team = await t.req<Api.PersonDetail>('PATCH', `/api/people/${vic}`, { team: 'Support', role: 'Agent' }, member)
      expect(team.body.contact.data).toMatchObject({ team: 'Support', role: 'Agent' })
      expect((await t.req('PATCH', `/api/people/${vic}`, { team: 'x' }, viewer)).status).toBe(403)
      expect((await t.req('PATCH', `/api/people/${vic}`, { manager: vic })).status).toBe(400)
      // Demoting the only admin is refused (other admins may exist from other tests: count them).
      const admins = (await t.req<Api.PersonItem[]>('GET', '/api/people?access=admin')).body.filter((p) => !p.deactivated)
      if (admins.length === 1)
        expect((await t.req('PATCH', `/api/people/${admin.contactId}`, { access: 'member' })).status).toBe(422)
      // AI employees are the admins' to edit.
      const ai = (await t.a.services.directory.employees.require(employeeId)).data.contactId
      expect((await t.req('PATCH', `/api/people/${ai}`, { team: 'Bots' }, member)).status).toBe(403)
      expect((await t.req('PATCH', `/api/people/${ai}`, { access: 'admin' })).status).toBe(400)
    })

    it('lists people and employees with filters, and shows sign-ins and tokens to admins and the person only', async () => {
      await t.a.services.directory.projects.addMember(project, mia, 'owner')
      const all = (await t.req<Api.PersonItem[]>('GET', '/api/people', undefined, viewer)).body
      const emp = all.find((p) => p.type === 'ai' && p.employeeId === employeeId)
      expect(emp).toMatchObject({ access: null })
      const m = all.find((p) => p.contact.id === mia)!
      expect(m.projects).toEqual([{ id: project, name: expect.any(String), roles: ['owner'] }])
      // Vic can't see when Mia signed in, but Mia can, and admins can.
      expect(m.lastSignInAt).toBeNull()
      await t.as(mia, { via: 'cookie' })
      const own = (await t.req<Api.PersonDetail>('GET', `/api/people/${mia}`, undefined, member)).body
      expect(own.lastSignInAt).toBeTruthy()
      expect(own.tokens?.length).toBeGreaterThan(0)
      expect(own.memoriesAbout).toBeGreaterThanOrEqual(1)
      const other = (await t.req<Api.PersonDetail>('GET', `/api/people/${mia}`, undefined, viewer)).body
      expect(other).toMatchObject({ tokens: null, memoriesAbout: null, lastSignInAt: null, canEdit: false, canAdmin: false })
      expect((await t.req<Api.PersonDetail>('GET', `/api/people/${mia}`)).body).toMatchObject({ canAdmin: true, canEdit: true })
      // Filters.
      const q = async (s: string) => (await t.req<Api.PersonItem[]>('GET', `/api/people?${s}`)).body
      expect((await q('type=ai')).every((p) => p.type === 'ai')).toBe(true)
      expect((await q('access=viewer')).every((p) => p.access === 'viewer')).toBe(true)
      expect((await q('team=support')).map((p) => p.contact.id)).toContain(vic)
      expect((await q('text=mia%20member')).map((p) => p.contact.id)).toEqual([mia])
      expect((await t.req('GET', '/api/people/con_missing')).status).toBe(404)
    })
  })
}

describe('knowledge (memory)', () => knowledgeSuite(memoryBackend))

const { DATABASE_URL, REDIS_URL } = process.env
describe.skipIf(!DATABASE_URL || !REDIS_URL)('knowledge (postgres + bullmq)', () =>
  knowledgeSuite(realBackend(DATABASE_URL!, REDIS_URL!)),
)
