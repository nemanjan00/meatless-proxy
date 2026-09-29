import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applyImport,
  exportKnowledge,
  exportTree,
  formatPlan,
  parseCsv,
  parseMarkdown,
  planImport,
  readTree,
  stringifyMarkdown,
  type Tree,
} from '../src/transfer/index.ts'
import type { Services } from '../src/services.ts'
import { testApp, type TestApp } from './helpers.ts'

const apps: TestApp[] = []
const dirs: string[] = []
const DATABASE_URL = process.env.DATABASE_URL
afterAll(async () => {
  for (const a of apps) await a.close().catch(() => {})
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  if (schemas.length && DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 })
    for (const sc of schemas) await pool.query(`drop schema if exists "${sc}" cascade`).catch(() => {})
    await pool.end()
  }
})

const schemas: string[] = []
/** An app without workers; `bootstrap: false` gives an empty store. `pg` puts it in its own Postgres schema. */
async function app(bootstrap = false, pg = false) {
  const env: Record<string, string> = { MP_BOOTSTRAP: bootstrap ? '1' : '0', LOG_LEVEL: 'warn' }
  if (pg) {
    const schema = `mp_transfer_${randomBytes(5).toString('hex')}`
    schemas.push(schema)
    Object.assign(env, { DATABASE_URL: DATABASE_URL!, DATABASE_SCHEMA: schema, SECRETS_KEY: 'test-secrets-key-not-a-real-one' })
  }
  const t = await testApp({ workers: false, env })
  apps.push(t)
  return t.a.services
}

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mp-transfer-'))
  dirs.push(d)
  return d
}

/** Counts of every exported kind plus links, to prove nothing changed. */
async function snapshot(s: Services) {
  const out: Record<string, number> = {}
  for (const k of ['contact', 'employee', 'project', 'procedure', 'skill', 'doc', 'memory'])
    out[k] = await s.store.records.count(k)
  const all = await s.records.query('contact')
  let links = 0
  for (const c of all.items) links += (await s.records.links({ touching: { kind: 'contact', id: c.id } })).length
  out.links = links
  return out
}

/** A small company: people, an employee, a project with docs, a procedure, skills and memories. */
async function seed(s: Services) {
  const d = s.directory
  const ana = await d.contacts.create({
    name: 'Ana Lopez',
    email: 'Ana@Example.com',
    role: 'Staff engineer',
    team: 'Payments',
    handles: [{ system: 'slack', id: 'U0ANA' }],
    permissions: 'May ask for anything about Payments.\nNot for HR data.',
  })
  const ben = await d.contacts.create({ name: 'Ben Ode', email: 'ben@example.com', manager: ana.id, role: 'Engineer' })
  const emp = await d.employees.create({
    name: 'Scout',
    personality: 'Brief: "to the point"',
    instructions: 'Answer in the thread.',
    toolAllow: ['**'],
    toolDeny: ['env.*'],
    contact: { email: 'scout@example.com' },
  })
  const pay = await d.projects.create({
    name: 'Payments',
    aliases: ['billing'],
    status: 'active',
    description: `Refunds and invoices. Ask [[contact:${ana.id}|Ana]].`,
    repositories: [{ url: 'https://git.example.com/pay.git', defaultBranch: 'main' }],
  })
  const search = await d.projects.create({ name: 'Search', description: 'The search index: 42 shards, #1 priority.' })
  await d.contacts.update(ben.id, { bio: `Works on [[project:${search.id}|Search]] too.` })
  await d.projects.setOwner(pay.id, ana.id)
  await d.projects.addMember(pay.id, ben.id, 'reviewer', { since: '2026-01-01' })
  await d.projects.addMember(search.id, ben.id, 'owner')
  await s.docs.create({
    title: 'Deploy runbook',
    path: 'runbooks/deploy',
    owner: { kind: 'project', id: pay.id },
    body: `# Deploy\n\nPage [[contact:${ben.id}|Ben]] first. See [[project:${search.id}]].\n`,
  })
  await s.docs.create({ title: 'Overview', owner: { kind: 'project', id: pay.id }, body: 'What Payments does.' })
  const proc = await d.procedures.create({
    name: 'Access request',
    applies: 'Someone asks for access to a system',
    body: '1. Check the requester.\n2. Ask the owner.',
    ownerId: ana.id,
    approvals: [{ contactId: ana.id }, { role: 'manager' }],
    checklist: [{ text: 'Owner approved', required: true }],
    projectIds: [pay.id],
  })
  await s.skills.create({ name: 'Release notes', description: 'How to write them', body: 'Short and dated.' })
  await s.skills.create({
    name: 'Release notes',
    description: 'Payments flavour',
    body: 'Mention refunds.',
    scope: { type: 'project', projectId: pay.id },
    files: [{ path: 'template.md', content: '# Notes\n' }],
  })
  const mem = await s.memory.remember({
    summary: 'Deploys happen on Tuesdays',
    kind: 'fact',
    content: `Confirmed by [[contact:${ana.id}]].`,
    scope: { type: 'project', id: pay.id },
    about: [{ kind: 'contact', id: ana.id }],
  })
  await s.memory.verify(mem.memory.id)
  await s.memory.remember({ summary: 'The company is fully remote', employeeId: emp.id })
  return { ana, ben, emp, pay, search, proc }
}

const treeText = (t: Tree) => [...t].map(([p, c]) => `== ${p}\n${c}`).join('\n')

describe('frontmatter and csv', () => {
  it('writes and reads back scalars, quoted strings, lists and objects', () => {
    const fields = {
      id: 'con_1',
      name: 'Ana Lopez',
      tricky: 'a: b # c',
      yes: 'yes',
      num: '42',
      n: 3,
      flag: false,
      multi: 'line 1\nline 2',
      list: [{ system: 'slack', id: 'U1' }],
      obj: { b: 1, a: [true, null] },
    }
    const text = stringifyMarkdown(fields, '# Body\n\ntext\n\n')
    expect(text.startsWith('---\nid: con_1\nname: Ana Lopez\ntricky: "a: b # c"\nyes: "yes"\nnum: "42"\n')).toBe(true)
    const back = parseMarkdown(text)
    expect(back.fields).toEqual(fields)
    expect(back.body).toBe('# Body\n\ntext')
    expect(parseMarkdown('no frontmatter\n').body).toBe('no frontmatter')
    expect(parseMarkdown("---\na: 'it''s'\nb: plain # comment\n# note\n\n---\n").fields).toEqual({ a: "it's", b: 'plain' })
    expect(() => parseMarkdown('---\na: 1\n')).toThrow(/not closed/)
    expect(() => parseMarkdown('---\n- x\n---\n')).toThrow(/key: value/)
    expect(() => parseMarkdown('---\na: [1,\n---\n')).toThrow(/JSON/)
  })

  it('parses messy CSV: BOM, CRLF, quotes, embedded commas and newlines, blank lines, other delimiters', () => {
    const csv =
      '﻿Name, E-mail ,Notes\r\n"Lopez, Ana",ana@example.com,"said ""hi""\nthen left"\r\n\r\n  Ben ,ben@example.com,\r\n,,\r\n'
    const r = parseCsv(csv)
    expect(r.headers).toEqual(['name', 'email', 'notes'])
    expect(r.rows).toEqual([
      { line: 2, values: { name: 'Lopez, Ana', email: 'ana@example.com', notes: 'said "hi"\nthen left' } },
      { line: 5, values: { name: 'Ben', email: 'ben@example.com', notes: '' } },
    ])
    expect(parseCsv('name;email\nAna;a@example.com').rows[0]!.values).toEqual({ name: 'Ana', email: 'a@example.com' })
    expect(parseCsv('').rows).toEqual([])
  })
})

describe('export', () => {
  it('writes a deterministic folder of markdown with an index, and no secrets or runtime pointers', async () => {
    const s = await app()
    const { ana, pay, emp } = await seed(s)
    const t1 = await exportTree(s)
    const t2 = await exportTree(s)
    expect(treeText(t1)).toBe(treeText(t2))
    expect([...t1.keys()]).toEqual([
      'contacts/ana-lopez.md',
      'contacts/ben-ode.md',
      'contacts/scout.md',
      'employees/scout.md',
      'index.json',
      expect.stringMatching(/^memories\/mem_\w+\.md$/),
      expect.stringMatching(/^memories\/mem_\w+\.md$/),
      'procedures/access-request.md',
      'projects/payments.md',
      'projects/payments/docs/overview.md',
      'projects/payments/docs/runbooks/deploy.md',
      'projects/search.md',
      'skills/company/release-notes.md',
      'skills/payments/release-notes.md',
    ])
    const project = parseMarkdown(t1.get('projects/payments.md')!)
    expect(project.body).toBe(`Refunds and invoices. Ask [[contact:${ana.id}|Ana]].`)
    expect(project.fields.members).toEqual(
      expect.arrayContaining([
        { contact: ana.id, role: 'owner' },
        { contact: expect.any(String), role: 'reviewer', data: { since: '2026-01-01' } },
      ]),
    )
    const employee = parseMarkdown(t1.get('employees/scout.md')!)
    expect(employee.fields).toMatchObject({ id: emp.id, name: 'Scout', toolDeny: ['env.*'] })
    expect(employee.body).toBe('Answer in the thread.')
    const all = treeText(t1)
    expect(all).not.toMatch(/sshPublicKey|sshKeyCreatedAt|routerSessionId|createdAt|updatedAt|ssh-ed25519/)
    const index = JSON.parse(t1.get('index.json')!)
    expect(index.format).toBe('meatless-proxy.knowledge')
    expect(index.records).toHaveLength(13)
    expect(index.links).toEqual([
      { from: { kind: 'memory', id: expect.any(String) }, to: { kind: 'contact', id: ana.id }, role: 'about' },
      { from: { kind: 'memory', id: expect.any(String) }, to: { kind: 'project', id: pay.id }, role: 'about' },
    ])
  })

  it('writes into an empty folder or a previous export, and refuses other folders', async () => {
    const s = await app()
    await seed(s)
    const dir = tmp()
    const r = await exportKnowledge(s, dir)
    expect(r.files).toBe(14)
    expect(treeText(readTree(dir))).toBe(treeText(await exportTree(s)))
    // A stale file from an earlier export disappears; unrelated files stay.
    mkdirSync(join(dir, 'contacts'), { recursive: true })
    writeFileSync(join(dir, 'contacts', 'gone.md'), '---\nname: Gone\n---\n')
    writeFileSync(join(dir, 'README.md'), 'mine')
    await exportKnowledge(s, dir)
    const again = readTree(dir)
    expect(again.has('contacts/gone.md')).toBe(false)
    expect(again.get('README.md')).toBe('mine')

    const other = tmp()
    writeFileSync(join(other, 'notes.txt'), 'x')
    await expect(exportKnowledge(s, other)).rejects.toThrow(/refusing/)
    await exportKnowledge(s, other, { force: true })
    expect(readTree(other).has('index.json')).toBe(true)
  })
})

describe('import from an export folder', () => {
  it('round trip: export, import into a fresh app, export again gives the identical tree', async () => {
    const a = await app()
    const { ana, ben, pay, search } = await seed(a)
    const treeA = await exportTree(a)

    const b = await app()
    const plan = await planImport(b, { tree: treeA })
    expect(plan.errors).toEqual([])
    expect(plan.warnings).toEqual([])
    expect(plan.counts).toEqual({ create: 18, update: 0, unchanged: 0 })
    const res = await applyImport(b, plan)
    expect(res.errors).toEqual([])
    const treeB = await exportTree(b)
    expect(treeText(treeB)).toBe(treeText(treeA))

    // The links behind the files work in the new app.
    expect((await b.directory.projects.owner(pay.id))?.id).toBe(ana.id)
    expect((await b.directory.projects.owner(search.id))?.id).toBe(ben.id)
    const emp = (await b.directory.employees.byHandle('scout'))!
    expect((await b.directory.employees.contact(emp.id)).data.email).toBe('scout@example.com')
    expect((await b.skills.available({ projectIds: [pay.id] })).map((x) => x.description)).toEqual(['Payments flavour'])
    expect((await b.directory.procedures.find('access', { projectIds: [pay.id] })).length).toBe(1)
    const recalled = await b.memory.recall({ refs: [{ kind: 'contact', id: ana.id }] })
    expect(recalled.map((r) => r.memory.data.summary)).toEqual(['Deploys happen on Tuesdays'])
    // Mentions, including the forward one (Ben's bio mentions a project imported after him).
    const benBacklinks = (await b.records.backlinks({ kind: 'contact', id: ben.id })).map((r) => r.kind)
    expect(benBacklinks).toEqual(['doc'])
    expect((await b.records.backlinks({ kind: 'project', id: search.id })).map((r) => r.kind).sort()).toEqual(['contact', 'doc'])
  })

  it('is idempotent: importing the same folder twice, or into the app it came from, changes nothing', async () => {
    const a = await app()
    await seed(a)
    const tree = await exportTree(a)
    const self = await planImport(a, { tree })
    expect(self.counts).toEqual({ create: 0, update: 0, unchanged: 18 })

    const b = await app()
    await applyImport(b, await planImport(b, { tree }))
    const before = await snapshot(b)
    const second = await planImport(b, { tree })
    expect(second.counts).toEqual({ create: 0, update: 0, unchanged: 18 })
    const res = await applyImport(b, second)
    expect(res.counts).toEqual({ create: 0, update: 0, unchanged: 18 })
    expect(await snapshot(b)).toEqual(before)
  })

  it('a dry run (plan only) changes nothing', async () => {
    const a = await app()
    await seed(a)
    const tree = await exportTree(a)
    const b = await app(true)
    const before = await snapshot(b)
    const treeBefore = treeText(await exportTree(b))
    const plan = await planImport(b, { tree })
    expect(plan.counts.create).toBeGreaterThan(0)
    expect(await snapshot(b)).toEqual(before)
    expect(treeText(await exportTree(b))).toBe(treeBefore)
    const text = formatPlan(plan)
    expect(text).toContain('create    contact   Ana Lopez  [contacts/ana-lopez.md]')
    expect(text).toMatch(/Plan: create \d+, update 0, unchanged \d+; 0 error\(s\)/)
    expect(text).toContain('  project   create 2, update 0, unchanged 0')
  })

  it('doc links round-trip onto existing records with other ids, and edits show as updates', async () => {
    const a = await app()
    const { ana } = await seed(a)
    const tree = await exportTree(a)

    const b = await app(true)
    const anaB = await b.directory.contacts.create({ name: 'Ana L.', email: 'ana@example.com' })
    expect(anaB.id).not.toBe(ana.id)
    const plan = await planImport(b, { tree })
    const anaItem = plan.items.find((i) => i.kind === 'contact' && i.label === 'Ana Lopez')!
    expect(anaItem).toMatchObject({ op: 'update', id: anaB.id })
    expect(anaItem.changes.map((c) => c.field)).toEqual(['handles', 'name', 'permissions', 'role', 'team'])
    expect(formatPlan(plan)).toContain('~ name: "Ana L." -> "Ana Lopez"')
    await applyImport(b, plan)

    const pay = (await b.directory.projects.byName('Payments'))!
    expect(pay.data.description).toBe(`Refunds and invoices. Ask [[contact:${anaB.id}|Ana]].`)
    expect((await b.directory.projects.owner(pay.id))?.id).toBe(anaB.id)
    expect((await b.records.backlinks({ kind: 'contact', id: anaB.id })).map((r) => r.kind).sort()).toEqual(['memory', 'project'])
    const proc = (await b.directory.procedures.find('access request'))[0]!.record
    expect(proc.data.ownerId).toBe(anaB.id)
    expect(proc.data.approvals).toEqual([{ contactId: anaB.id }, { role: 'manager' }])
    // Exporting from b and importing into b again changes nothing.
    expect((await planImport(b, { tree: await exportTree(b) })).counts.create).toBe(0)
    expect((await planImport(b, { tree })).counts).toMatchObject({ create: 0, update: 0 })

    // A hand edit in the folder is an update with a diff.
    const edited = new Map(tree)
    edited.set('projects/search.md', tree.get('projects/search.md')!.replace('status', 'x').replace('42 shards', '48 shards'))
    const p2 = await planImport(b, { tree: edited })
    expect(p2.items.filter((i) => i.op !== 'unchanged').map((i) => [i.op, i.label, i.changes.map((c) => c.field)])).toEqual([
      ['update', 'Search', ['description']],
    ])
  })

  it('reports broken files without aborting, and --strict refuses to apply', async () => {
    const a = await app()
    await seed(a)
    const tree = new Map(await exportTree(a))
    tree.set('contacts/broken.md', '---\nname: [oops\n---\n')
    tree.set('contacts/nameless.md', '---\nrole: Ghost\n---\n')
    tree.set('projects/nowhere/docs/x.md', '---\ntitle: X\n---\nbody')
    tree.set('random/thing.md', 'hi')
    tree.set('memories/dup.md', tree.get([...tree.keys()].find((k) => k.startsWith('memories/'))!)!)
    const b = await app()
    const plan = await planImport(b, { tree })
    expect(plan.errors.map((e) => e.source).sort()).toEqual([
      'contacts/broken.md',
      'contacts/nameless.md',
      'memories/dup.md',
      'projects/nowhere/docs/x.md',
    ])
    expect(plan.errors.find((e) => e.source === 'contacts/nameless.md')!.message).toMatch(/name is required/)
    expect(plan.warnings).toEqual([{ source: 'random/thing.md', message: expect.stringContaining('ignored') }])
    await expect(applyImport(b, plan, { strict: true })).rejects.toThrow(/plan has errors/)
    expect(await b.store.records.count('contact')).toBe(0)
    const res = await applyImport(b, plan)
    expect(res.errors).toEqual([])
    expect(await b.store.records.count('contact')).toBe(3)
  })
})

describe('import from CSV', () => {
  const contactsCsv = [
    '﻿Name,Email,Role,Team,Manager Email,Slack Handle,Permissions',
    'Ana Lopez, ANA@example.com ,Staff engineer,Payments,,@U0ANA,"Anything about Payments, not HR"',
    '"Ode, Ben",ben@example.com,Engineer,Payments,ana@example.com,U0BEN,',
    '',
    ',nobody@example.com,Ghost,,,,',
    'Cara,not-an-email,,,,,',
    'Dan,dan@example.com,,,cara@example.com,,',
    'Eve,ben@example.com,,,,,',
    'Finn,finn@example.com,Intern,,zed@example.com,,',
    'Gia,gia@example.com,,,,U 0GIA,',
    'Hal,hal@example.com,Manager,Payments,,,',
  ].join('\r\n')
  const projectsCsv = [
    'name,description,owner email,members',
    'Payments,Refunds and invoices,ana@example.com,"ben@example.com:reviewer; hal@example.com"',
    'Search,,ben@example.com,',
    'Broken,,,ghost@example.com:member',
    'Weird,,,not an email',
    ',no name,,',
  ].join('\n')

  it('imports valid rows, reports each bad row, resolves managers and members across files', async () => {
    const s = await app()
    const plan = await planImport(s, { contactsCsv, projectsCsv })
    expect(plan.errors.map((e) => [e.source, e.line, e.message])).toEqual([
      ['contacts.csv', 5, 'name is required'],
      ['contacts.csv', 6, 'invalid email "not-an-email"'],
      ['contacts.csv', 8, 'duplicate of line 3 (email ben@example.com)'],
      ['contacts.csv', 10, 'invalid slack handle "U 0GIA"'],
      ['projects.csv', 5, 'invalid member "not an email": expected email:role'],
      ['projects.csv', 6, 'name is required'],
      ['projects.csv', 4, 'ghost@example.com is not a known contact'],
    ])
    expect(plan.warnings.map((w) => [w.line, w.message])).toEqual([
      [7, 'manager cara@example.com is not a known contact: left unset'],
      [9, 'manager zed@example.com is not a known contact: left unset'],
    ])
    const res = await applyImport(s, plan)
    expect(res.errors).toEqual([])
    expect(res.counts.create).toBe(5 + 2 + 4)

    const ana = (await s.directory.contacts.byEmail('ana@example.com'))!
    expect(ana.data).toMatchObject({
      name: 'Ana Lopez',
      handles: [{ system: 'slack', id: 'U0ANA' }],
      permissions: 'Anything about Payments, not HR',
      kind: 'person',
    })
    const ben = (await s.directory.contacts.byHandle('slack', 'U0BEN'))!
    expect(ben.data).toMatchObject({ name: 'Ode, Ben', manager: ana.id })
    const pay = (await s.directory.projects.byName('payments'))!
    expect((await s.directory.projects.owner(pay.id))?.id).toBe(ana.id)
    const members = await s.directory.projects.members(pay.id)
    expect(members.map((m) => [m.contact.data.name, m.roles])).toEqual([
      ['Ana Lopez', ['owner']],
      ['Ode, Ben', ['reviewer']],
      ['Hal', ['member']],
    ])

    // Running it again changes nothing.
    const again = await planImport(s, { contactsCsv, projectsCsv })
    expect(again.counts).toEqual({ create: 0, update: 0, unchanged: 11 })
    expect((await applyImport(s, again)).counts.unchanged).toBe(11)
  })

  it('matches by email, then handle, then name, and only sets the fields a row has', async () => {
    const s = await app(true)
    const byEmail = await s.directory.contacts.create({ name: 'A. Lopez', email: 'ana@example.com', bio: 'kept' })
    const byHandle = await s.directory.contacts.create({
      name: 'Benjamin',
      handles: [
        { system: 'slack', id: 'U0BEN' },
        { system: 'mp', id: 'ben' },
      ],
    })
    const byName = await s.directory.contacts.create({ name: 'Hal', role: 'Manager' })
    const plan = await planImport(s, {
      contactsCsv: 'name,email,slack handle,role\nAna Lopez,ana@example.com,,\nBen,ben@example.com,U0BEN,\nhal,,,Director\n',
    })
    expect(plan.items.map((i) => [i.op, i.id, i.changes.map((c) => c.field)])).toEqual([
      ['update', byEmail.id, ['name']],
      ['update', byHandle.id, ['email', 'name']],
      ['update', byName.id, ['name', 'role']],
    ])
    await applyImport(s, plan)
    expect((await s.directory.contacts.get(byEmail.id))!.data.bio).toBe('kept')
    expect((await s.directory.contacts.get(byHandle.id))!.data.handles).toEqual([
      { system: 'slack', id: 'U0BEN' },
      { system: 'mp', id: 'ben' },
    ])
    // A new slack handle replaces the old one and keeps the others.
    const p2 = await planImport(s, { contactsCsv: 'name,slack handle,email\nBen,U0NEW,ben@example.com\n' })
    expect(p2.items[0]!.changes).toEqual([
      {
        field: 'handles',
        from: [
          { system: 'slack', id: 'U0BEN' },
          { system: 'mp', id: 'ben' },
        ],
        to: [
          { system: 'slack', id: 'U0NEW' },
          { system: 'mp', id: 'ben' },
        ],
      },
    ])
    expect(formatPlan(p2)).toContain('update    contact   Ben  [contacts.csv:2]')
  })

  it('a new owner from CSV replaces the old one, and the plan says so', async () => {
    const s = await app()
    await applyImport(s, await planImport(s, { contactsCsv, projectsCsv }))
    const plan = await planImport(s, { projectsCsv: 'name,owner email\nPayments,hal@example.com\n' })
    const link = plan.items.find((i) => i.kind === 'link')!
    expect(link).toMatchObject({ op: 'create', label: 'Hal -> Payments (owner)' })
    expect(link.changes).toEqual([{ field: 'owner', from: 'Ana Lopez', to: 'Hal' }])
    await applyImport(s, plan)
    const pay = (await s.directory.projects.byName('Payments'))!
    expect((await s.directory.projects.members(pay.id, { role: 'owner' })).map((m) => m.contact.data.name)).toEqual(['Hal'])
  })

  it('reports a missing column once instead of every row', async () => {
    const s = await app()
    const plan = await planImport(s, { contactsCsv: 'email,role\na@example.com,x\n' })
    expect(plan.errors).toEqual([{ source: 'contacts.csv', message: 'missing column: name' }])
    expect(plan.items).toEqual([])
  })
})

describe.skipIf(!DATABASE_URL)('import and export on Postgres', () => {
  it('round-trips between two Postgres apps and a memory app, identically and idempotently', async () => {
    const a = await app(false, true)
    await seed(a)
    const tree = await exportTree(a)
    const b = await app(false, true)
    const res = await applyImport(b, await planImport(b, { tree }))
    expect(res.errors).toEqual([])
    expect(treeText(await exportTree(b))).toBe(treeText(tree))
    expect((await planImport(b, { tree })).counts).toEqual({ create: 0, update: 0, unchanged: 18 })
    const m = await app()
    await applyImport(m, await planImport(m, { tree }))
    expect(treeText(await exportTree(m))).toBe(treeText(tree))
  })
})
