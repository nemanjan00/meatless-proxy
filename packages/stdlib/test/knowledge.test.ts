import { describe, expect, it } from 'vitest'
import { stack } from './helpers.ts'

describe('directory', () => {
  it('finds and gets contacts and projects', async () => {
    const t = await stack()
    await t.directory.contacts.update(t.ana.id, {
      handles: [
        { system: 'mp', id: 'ana' },
        { system: 'slack', id: 'U1' },
      ],
    })
    expect((await t.out('directory.find_contact', { text: 'Ana' })).contacts[0]).toMatchObject({ id: t.ana.id, name: 'Ana Lima' })
    expect((await t.out('directory.find_contact', { text: 'ana@example.com' })).contacts[0].id).toBe(t.ana.id)
    expect((await t.out('directory.find_contact', { handle: { system: 'slack', id: 'U1' } })).contacts[0].id).toBe(t.ana.id)
    expect((await t.call('directory.find_contact', {})).isError).toBe(true)

    const c = await t.out('directory.get_contact', { id: t.ana.id })
    expect(c).toMatchObject({ name: 'Ana Lima', role: 'Backend engineer', projects: [{ id: t.project.id, roles: ['owner'] }] })

    expect((await t.out('directory.find_project', { text: 'payments' })).projects[0].id).toBe(t.project.id)
    await t.docs.create({ title: 'Architecture', body: '# Arch', owner: { kind: 'project', id: t.project.id } })
    const p = await t.out('directory.get_project', { id: t.project.id })
    expect(p).toMatchObject({
      name: 'Billing',
      owner: { id: t.ana.id, name: 'Ana Lima' },
      members: [{ id: t.ana.id, roles: ['owner'] }],
      repositories: [{ index: 0, url: 'https://github.com/acme/billing.git' }],
      docs: [{ title: 'Architecture' }],
    })
    expect((await t.out('directory.projects_of', { contactId: t.ana.id, role: 'owner' })).projects[0].id).toBe(t.project.id)
    expect((await t.call('directory.get_project', { id: 'pro_nope' })).isError).toBe(true)
  })

  it('finds and gets procedures', async () => {
    const t = await stack()
    const proc = await t.directory.procedures.create({
      name: 'Production deploy',
      applies: 'deploying a service to production',
      body: '1. Get approval from the owner.\n2. Deploy.',
      ownerId: t.ana.id,
      checklist: [{ text: 'Approval recorded' }],
    })
    const f = await t.out('directory.find_procedure', { text: 'deploy billing to production' })
    expect(f.procedures[0]).toMatchObject({ id: proc.id, name: 'Production deploy' })
    const g = await t.out('directory.get_procedure', { id: proc.id })
    expect(g).toMatchObject({
      ownerId: t.ana.id,
      checklist: [{ text: 'Approval recorded' }],
      body: expect.stringContaining('Deploy.'),
    })
  })
})

describe('procedures.run', () => {
  it('creates the context once, forks it, copies the checklist, links and starts the fork', async () => {
    const t = await stack()
    const proc = await t.directory.procedures.create({
      name: 'Access request',
      applies: 'someone needs access to a system',
      body: '1. Check the requester is allowed.\n2. Ask the owner.',
      checklist: [
        { text: 'Owner approved', required: true },
        { text: 'Logged', required: false },
      ],
      projectIds: [t.project.id],
    })
    const o = await t.out('procedures.run', { procedureId: proc.id, work: 'Ana needs read access to the billing DB.' })
    const ctxId = (await t.directory.procedures.require(proc.id)).data.contextSessionId
    expect(o.contextSessionId).toBe(ctxId)
    const context = await t.sessions.require(ctxId!)
    const ctxHist = await t.sessions.history(context.id)
    expect(ctxHist.map((e) => e.kind)).toEqual(['system', 'system'])
    expect((ctxHist[1]!.content as any).text).toContain('Check the requester is allowed.')

    const fork = await t.sessions.require(o.sessionId)
    expect(fork.data.parent?.sessionId).toBe(context.id)
    expect(fork.data.meta?.procedureId).toBe(proc.id)
    expect((await t.checklists.forSession(fork.id)).data.items.map((i) => [i.text, i.required])).toEqual([
      ['Owner approved', true],
      ['Logged', false],
    ])
    const roles = (await t.records.links({ from: { kind: 'session', id: fork.id } })).map((l) => `${l.role}:${l.to.id}`)
    expect(roles).toEqual(
      expect.arrayContaining([
        `procedure_for:${t.session.id}`,
        `runs_procedure:${proc.id}`,
        `works_on:${t.project.id}`,
        `requested_by:${t.ana.id}`,
      ]),
    )
    const hist = await t.sessions.runHistory(o.runId)
    expect((hist.at(-1)!.content as any).text).toContain('Ana needs read access')
    expect(t.enqueued).toEqual([o.runId])

    // A second run reuses the context.
    const o2 = await t.out('procedures.run', { procedureId: proc.id, work: 'Bo needs access too.' })
    expect(o2.contextSessionId).toBe(ctxId)
    expect(o2.sessionId).not.toBe(o.sessionId)
  })

  it('uses an existing context session', async () => {
    const t = await stack()
    const context = await t.newSession('Deploy context')
    const proc = await t.directory.procedures.create({ name: 'Deploy', applies: 'deploys', contextSessionId: context.id })
    const o = await t.out('procedures.run', { procedureId: proc.id, work: 'Deploy billing' })
    expect((await t.sessions.require(o.sessionId)).data.parent?.sessionId).toBe(context.id)
    expect((await t.call('procedures.run', { procedureId: 'prc_nope', work: 'x' })).isError).toBe(true)
  })
})

describe('docs', () => {
  it('write, read, chapters, list, search and backlinks', async () => {
    const t = await stack()
    const w = await t.out('docs.write', {
      title: 'Runbook',
      body: `# Runbook\n\nOwner: [[contact:${t.ana.id}|Ana]]\n\n## Deploy\n\nRun the pipeline.`,
      owner: { kind: 'project', id: t.project.id },
      path: 'runbooks/deploy',
    })
    expect(w).toMatchObject({ created: true, title: 'Runbook', path: 'runbooks/deploy' })
    const r = await t.out('docs.read', { id: w.id })
    expect(r.chapters).toEqual(['# Runbook', '## Deploy'])
    expect((await t.out('docs.read', { id: w.id, chapter: 'Deploy' })).body).toBe('Run the pipeline.')
    expect((await t.call('docs.read', { id: w.id, chapter: 'Nope' })).isError).toBe(true)

    await t.out('docs.write_chapter', { id: w.id, heading: 'Rollback', body: 'Revert the release.' })
    expect(await t.docs.chapter(w.id, 'Rollback')).toBe('Revert the release.')

    expect((await t.out('docs.list', { owner: { kind: 'project', id: t.project.id } })).docs.map((d: any) => d.id)).toEqual([
      w.id,
    ])
    const s = await t.out('docs.search', { text: 'pipeline' })
    expect(s.docs[0]).toMatchObject({ id: w.id, snippet: expect.stringContaining('pipeline') })
    const b = await t.out('docs.backlinks', { kind: 'contact', id: t.ana.id })
    expect(b.backlinks).toEqual([{ kind: 'doc', id: w.id, title: 'Runbook' }])

    const u = await t.out('docs.write', { id: w.id, body: 'short now' })
    expect(u.updated).toBe(true)
    expect((await t.docs.get(w.id))!.data.body).toBe('short now')
  })

  it('owns new docs by the session by default, and is idempotent per call', async () => {
    const t = await stack()
    const c = t.ctx()
    const a = await t.out('docs.write', { title: 'Notes', body: 'x' }, c)
    const b = await t.out('docs.write', { title: 'Notes', body: 'x' }, c)
    expect(b.id).toBe(a.id)
    expect(a.owner).toEqual({ kind: 'session', id: t.session.id })
    expect((await t.call('docs.write', { body: 'no title' })).isError).toBe(true)
    expect((await t.call('docs.write', { title: 't', body: 'b', owner: { kind: 'project', id: 'pro_nope' } })).isError).toBe(true)
  })

  it('truncates long documents with a note', async () => {
    const t = await stack()
    const d = await t.docs.create({ title: 'Big', body: 'x'.repeat(10_000) })
    const r = await t.out('docs.read', { id: d.id })
    expect(r.body.length).toBeLessThan(8200)
    expect(r.body).toContain('truncated: 2000 more characters')
  })
})

describe('memory', () => {
  it('remember, recall with visibility, link, verify, forget', async () => {
    const t = await stack()
    const m = await t.out('memory.remember', {
      summary: 'Ana prefers async reviews',
      kind: 'preference',
      scope: { type: 'contact', id: t.ana.id },
    })
    expect(m).toMatchObject({ created: true, kind: 'preference' })
    const again = await t.out('memory.remember', {
      summary: 'Ana prefers async reviews.',
      scope: { type: 'contact', id: t.ana.id },
    })
    expect(again).toMatchObject({ id: m.id, created: false })
    const stored = await t.memory.require(m.id)
    expect(stored.data).toMatchObject({ employeeId: t.employee.id, source: { sessionId: t.session.id, contactId: t.ana.id } })

    // Visible: the requester is Ana. A session without her doesn't see it.
    expect((await t.out('memory.recall', { text: 'async reviews' })).memories.map((x: any) => x.id)).toEqual([m.id])
    const other = await t.newSession('Other')
    const or = await t.startRun(other.id)
    const blind = t.ctxFor(other.id, or.id, { requesterId: undefined })
    expect((await t.out('memory.recall', { text: 'async reviews' }, blind)).memories).toEqual([])

    // Project-scoped memories need the project linked (or in scope).
    const pm = await t.out('memory.remember', {
      summary: 'Billing deploys on Tuesdays',
      scope: { type: 'project', id: t.project.id },
    })
    expect((await t.out('memory.recall', { text: 'deploys tuesdays' }, blind)).memories).toEqual([])
    await t.out('sessions.link', { ref: { kind: 'project', id: t.project.id }, role: 'works_on' }, blind)
    expect((await t.out('memory.recall', { text: 'deploys tuesdays' }, blind)).memories.map((x: any) => x.id)).toEqual([pm.id])

    await t.out('memory.link', { memoryId: pm.id, ref: { kind: 'session', id: t.session.id } })
    expect((await t.memory.links(pm.id)).some((l) => l.to.id === t.session.id)).toBe(true)
    await t.out('memory.link', { memoryId: pm.id, ref: { kind: 'session', id: t.session.id }, unlink: true })
    expect((await t.memory.links(pm.id)).some((l) => l.to.id === t.session.id)).toBe(false)
    const v = await t.out('memory.verify', { memoryId: pm.id })
    expect(v.verified).toBe(t.clock.iso())
    await t.out('memory.forget', { memoryId: pm.id })
    expect(await t.memory.get(pm.id)).toBeNull()
    expect((await t.out('memory.forget', { memoryId: pm.id })).note).toContain('already gone')
  })

  it("other employees' memories stay invisible and untouchable", async () => {
    const t = await stack()
    const other = await t.directory.employees.create({ name: 'Other Bot' })
    const { memory } = await t.memory.remember({ summary: 'secret thing', employeeId: other.id })
    expect((await t.out('memory.recall', { text: 'secret thing' })).memories).toEqual([])
    expect((await t.call('memory.verify', { memoryId: memory.id })).isError).toBe(true)
    expect((await t.call('memory.forget', { memoryId: memory.id })).isError).toBe(true)
    expect((await t.call('memory.remember', { id: memory.id, summary: 'overwrite' })).isError).toBe(true)
    // Shared memories are visible to everyone.
    await t.out('memory.remember', { summary: 'The office closes at 6', shared: true })
    expect((await t.out('memory.recall', { text: 'office closes' })).memories[0].shared).toBe(true)
  })
})

describe('skills', () => {
  it('lists company and project skills and loads one, recording its version', async () => {
    const t = await stack()
    await t.skills.create({ name: 'release', description: 'Cut a release', body: 'Company release steps' })
    await t.skills.create({
      name: 'release',
      description: 'Cut a billing release',
      body: 'Billing release steps',
      scope: { type: 'project', projectId: t.project.id },
      files: [{ path: 'check.sh', content: 'echo ok' }],
    })
    expect((await t.out('skills.list', {})).skills).toEqual([{ name: 'release', description: 'Cut a release' }])
    await t.out('sessions.link', { ref: { kind: 'project', id: t.project.id }, role: 'works_on' })
    expect((await t.out('skills.list', {})).skills).toEqual([
      { name: 'release', description: 'Cut a billing release', projectId: t.project.id },
    ])
    const l = await t.out('skills.load', { name: 'release', file: 'check.sh' })
    expect(l).toMatchObject({ body: 'Billing release steps', files: ['check.sh'], file: { content: 'echo ok' } })
    expect((await t.sessions.require(t.session.id)).data.meta?.skills).toEqual({ release: 1 })
    expect((await t.call('skills.load', { name: 'nope' })).isError).toBe(true)
    expect((await t.call('skills.load', { name: 'release', file: 'nope' })).isError).toBe(true)
  })
})

describe('fs', () => {
  it('write, read, list, move, delete', async () => {
    const t = await stack()
    await t.out('fs.write', { path: '/notes/a.md', content: '# A' })
    expect((await t.out('fs.read', { path: '/notes/a.md' })).content).toBe('# A')
    expect((await t.out('fs.list', {})).entries).toEqual([{ name: 'notes', path: '/notes', type: 'dir' }])
    await t.out('fs.move', { from: '/notes/a.md', to: '/notes/b.md' })
    expect((await t.out('fs.move', { from: '/notes/a.md', to: '/notes/b.md' })).note).toBe('already moved')
    expect((await t.out('fs.list', { path: '/notes' })).entries.map((e: any) => e.name)).toEqual(['b.md'])
    await t.out('fs.delete', { path: '/notes/b.md' })
    expect((await t.out('fs.delete', { path: '/notes/b.md' })).note).toContain('already gone')
    expect((await t.call('fs.read', { path: '/notes/b.md' })).isError).toBe(true)
    expect((await t.call('fs.write', { path: '../etc/passwd', content: 'x' })).isError).toBe(true)
  })

  it('shares with another employee and a person', async () => {
    const t = await stack()
    const other = await t.directory.employees.create({ name: 'Ops Bot' })
    await t.out('fs.write', { path: '/exports/report.csv', content: 'a,b' })
    const s = await t.out('fs.share', { path: '/exports', with: 'ops-bot' })
    expect(s).toMatchObject({
      shared: '/exports',
      with: other.data.contactId,
      permission: 'read',
      as: `/shared/${t.employee.id}/exports`,
    })
    const theirs = t.files.forEmployee(other.id)
    expect((await theirs.read(`/shared/${t.employee.id}/exports/report.csv`)).content).toBe('a,b')
    await expect(theirs.write(`/shared/${t.employee.id}/exports/x.csv`, 'no')).rejects.toThrow(/no write access/)

    await t.out('fs.share', { path: '/exports/report.csv', with: t.ana.id, permission: 'write' })
    await t.files.forContact(t.ana.id).write(`/shared/${t.employee.id}/exports/report.csv`, 'a,b,c')
    expect((await t.out('fs.read', { path: '/exports/report.csv' })).content).toBe('a,b,c')

    await t.out('fs.share', { path: '/exports', with: other.id, unshare: true })
    await expect(theirs.read(`/shared/${t.employee.id}/exports/report.csv`)).rejects.toThrow()
    expect((await t.call('fs.share', { path: '/exports', with: 'nobody' })).isError).toBe(true)
  })
})
