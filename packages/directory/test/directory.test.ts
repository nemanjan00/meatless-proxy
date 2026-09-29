import { ConflictError, NotFoundError, ValidationError } from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import { APPLIES_TO, IDENTITY, createDirectory, keywords, slugify, type Directory } from '../src/index.ts'

let records: Records
let dir: Directory

beforeEach(() => {
  records = createRecords({ store: memoryStore() })
  dir = createDirectory({ records })
})

describe('text helpers', () => {
  it('slugifies names', () => {
    expect(slugify('Ana López')).toBe('ana-lopez')
    expect(slugify('  @Mx. Robot 3000!! ')).toBe('mx-robot-3000')
    expect(slugify('***')).toBe('')
  })
  it('extracts keywords without stop words', () => {
    expect(keywords('How do I deploy the Checkout service to production?')).toEqual([
      'deploy',
      'checkout',
      'service',
      'production',
    ])
  })
})

describe('contacts', () => {
  it('registers the kinds', () => {
    for (const k of ['contact', 'employee', 'project', 'procedure']) expect(records.kinds.has(k)).toBe(true)
  })

  it('creates people by default and validates', async () => {
    const ana = await dir.contacts.create({ name: 'Ana', email: 'Ana@Example.com ' })
    expect(ana.id).toMatch(/^con_/)
    expect(ana.data.kind).toBe('person')
    expect(ana.data.email).toBe('ana@example.com')
    await expect(dir.contacts.create({ name: 'X', kind: 'robot' as any })).rejects.toThrow(ValidationError)
    await expect(dir.contacts.create({} as any)).rejects.toThrow(ValidationError)
    expect(await dir.contacts.require(ana.id)).toMatchObject({ id: ana.id })
    await expect(dir.contacts.require('con_missing')).rejects.toThrow(NotFoundError)
  })

  it('resolves identities across systems', async () => {
    const ana = await dir.contacts.create({
      name: 'Ana',
      handles: [
        { system: 'Slack', id: 'U123' },
        { system: 'linear', id: '9f2a' },
      ],
      email: 'ana@example.com',
    })
    const jim = await dir.contacts.create({ name: 'Jim', handles: [{ system: 'slack', id: 'U456' }] })
    expect((await dir.contacts.byHandle('slack', 'U123'))?.id).toBe(ana.id)
    expect((await dir.contacts.byHandle('SLACK', ' U123 '))?.id).toBe(ana.id)
    expect((await dir.contacts.byHandle('linear', '9f2a'))?.id).toBe(ana.id)
    expect((await dir.contacts.byHandle('slack', 'U456'))?.id).toBe(jim.id)
    expect(await dir.contacts.byHandle('linear', 'U123')).toBeNull()
    expect(await dir.contacts.byHandle('slack', 'nobody')).toBeNull()
    expect((await dir.contacts.byEmail('ANA@example.com'))?.id).toBe(ana.id)
    expect(await dir.contacts.byEmail('nobody@example.com')).toBeNull()
  })

  it('refuses a handle that belongs to someone else', async () => {
    const ana = await dir.contacts.create({ name: 'Ana', handles: [{ system: 'slack', id: 'U1' }] })
    await expect(dir.contacts.create({ name: 'Bob', handles: [{ system: 'slack', id: 'U1' }] })).rejects.toThrow(ConflictError)
    const bob = await dir.contacts.create({ name: 'Bob' })
    await expect(dir.contacts.update(bob.id, { handles: [{ system: 'slack', id: 'U1' }] })).rejects.toThrow(ConflictError)
    // Updating your own handles is fine.
    const up = await dir.contacts.update(ana.id, {
      handles: [
        { system: 'slack', id: 'U1' },
        { system: 'git', id: 'ana' },
      ],
    })
    expect(up.data.handles).toHaveLength(2)
  })

  it('searches by keywords', async () => {
    await dir.contacts.create({ name: 'Ana Lopez', team: 'Payments', role: 'Backend engineer' })
    await dir.contacts.create({ name: 'Jim Doe', team: 'Search' })
    const res = await dir.contacts.search('payments engineer')
    expect(res.map((c) => c.data.name)).toEqual(['Ana Lopez'])
    expect(await dir.contacts.search('the')).toEqual([])
    expect((await dir.contacts.list({ where: { team: 'Search' } })).items[0]?.data.name).toBe('Jim Doe')
  })

  it('supports extension fields', async () => {
    records.kinds.extend('contact', [{ name: 'timezone', type: 'string', required: true }])
    await expect(dir.contacts.create({ name: 'Ana' })).rejects.toThrow(/timezone is required/)
    const ana = await dir.contacts.create({ name: 'Ana', timezone: 'Europe/Belgrade' })
    expect(ana.data.timezone).toBe('Europe/Belgrade')
    // Re-creating the directory redefines core fields but keeps extensions.
    createDirectory({ records })
    expect(records.kinds.get('contact').extensions?.map((f) => f.name)).toEqual(['timezone'])
    expect(() => records.kinds.extend('contact', [{ name: 'name', type: 'number' }])).toThrow(ValidationError)
  })
})

describe('employees', () => {
  it('creates an AI contact with an mp handle and links them', async () => {
    const emp = await dir.employees.create({
      name: 'Robo Ana',
      personality: 'Signs off with a tiny robot.',
      scope: { teams: ['payments'] },
      toolAllow: ['git.*'],
      contact: { handles: [{ system: 'slack', id: 'UBOT' }], email: 'robo@example.com' },
    })
    expect(emp.id).toMatch(/^emp_/)
    expect(emp.key).toBe('robo-ana')
    const contact = await dir.employees.contact(emp.id)
    expect(contact.data).toMatchObject({ kind: 'ai', name: 'Robo Ana', status: 'active', email: 'robo@example.com' })
    expect(contact.data.handles).toEqual([
      { system: 'mp', id: 'robo-ana' },
      { system: 'slack', id: 'UBOT' },
    ])
    const links = await records.links({ from: { kind: 'employee', id: emp.id }, role: IDENTITY })
    expect(links.map((l) => l.to.id)).toEqual([contact.id])
    expect((await dir.employees.byContact(contact.id))?.id).toBe(emp.id)
    expect((await dir.employees.byHandle('@robo-ana'))?.id).toBe(emp.id)
    expect((await dir.employees.byHandle('Robo Ana'))?.id).toBe(emp.id)
    expect((await dir.contacts.byHandle('mp', '@Robo-Ana'.slice(1)))?.id).toBe(contact.id)
    expect((await dir.contacts.byHandle('slack', 'UBOT'))?.id).toBe(contact.id)
    expect(await dir.employees.byHandle('@nobody')).toBeNull()
    expect(await dir.employees.byHandle('@')).toBeNull()
  })

  it('supports several employees and refuses duplicates', async () => {
    const a = await dir.employees.create({ name: 'Ada' })
    const b = await dir.employees.create({ name: 'Bea', scope: { projects: [] } })
    expect((await dir.employees.list()).total).toBe(2)
    expect(a.data.contactId).not.toBe(b.data.contactId)
    await expect(dir.employees.create({ name: 'ADA' })).rejects.toThrow(ConflictError)
    await expect(dir.employees.create({ name: '!!' })).rejects.toThrow(ValidationError)
    // A failed create leaves no orphaned contact behind.
    await expect(dir.employees.create({ name: 'Cid', model: 42 as any })).rejects.toThrow(ValidationError)
    expect((await dir.contacts.list()).total).toBe(2)
  })

  it('takes an explicit handle, and refuses one that is taken', async () => {
    const e = await dir.employees.create({ name: 'Billing Bot', handle: '@Billing' })
    expect(e.key).toBe('billing')
    expect((await dir.employees.contact(e.id)).data.handles).toEqual([{ system: 'mp', id: 'billing' }])
    expect((await dir.employees.byHandle('@billing'))?.id).toBe(e.id)
    await expect(dir.employees.create({ name: 'Other', handle: 'billing' })).rejects.toThrow(ConflictError)
    await expect(dir.employees.create({ name: 'Other', handle: '!!' })).rejects.toThrow(ValidationError)
  })

  it('renames an employee together with its contact and handle', async () => {
    const e = await dir.employees.create({ name: 'Ada', contact: { handles: [{ system: 'slack', id: 'U9' }] } })
    await dir.employees.create({ name: 'Bea' })
    await expect(dir.employees.update(e.id, { name: 'Bea' })).rejects.toThrow(ConflictError)
    const up = await dir.employees.update(e.id, { name: 'Ada Two', personality: 'dry' })
    expect(up.key).toBe('ada-two')
    const c = await dir.employees.contact(e.id)
    expect(c.data.name).toBe('Ada Two')
    expect(c.data.handles).toEqual([
      { system: 'mp', id: 'ada-two' },
      { system: 'slack', id: 'U9' },
    ])
    expect((await dir.employees.byHandle('@ada-two'))?.id).toBe(e.id)
    expect(await dir.employees.byHandle('@ada')).toBeNull()
    await expect(dir.employees.update(e.id, { contactId: 'con_x' } as any)).rejects.toThrow(ValidationError)
    expect((await dir.employees.update(e.id, { model: 'kimi' })).data.model).toBe('kimi')
  })
})

describe('projects and links', () => {
  it('stores ownership once and reads it from both sides', async () => {
    const ana = await dir.contacts.create({ name: 'Ana' })
    const jim = await dir.contacts.create({ name: 'Jim' })
    const checkout = await dir.projects.create({ name: 'Checkout', aliases: ['new checkout flow'], status: 'active' })
    const search = await dir.projects.create({ name: 'Search' })
    await dir.projects.addMember(checkout.id, ana.id, 'owner')
    await dir.projects.addMember(checkout.id, jim.id, 'reviewer')
    await dir.projects.addMember(checkout.id, jim.id, 'member')
    await dir.projects.addMember(search.id, ana.id)
    // Idempotent.
    await dir.projects.addMember(checkout.id, jim.id, 'reviewer')

    expect((await dir.projects.owner(checkout.id))?.id).toBe(ana.id)
    expect(await dir.projects.owner(search.id)).toBeNull()
    const members = await dir.projects.members(checkout.id)
    expect(members.map((m) => [m.contact.data.name, m.roles])).toEqual([
      ['Ana', ['owner']],
      ['Jim', ['reviewer', 'member']],
    ])
    expect((await dir.projects.members(checkout.id, { role: 'reviewer' })).map((m) => m.contact.id)).toEqual([jim.id])

    const anas = await dir.projects.forContact(ana.id)
    expect(anas.map((m) => [m.project.data.name, m.roles])).toEqual([
      ['Checkout', ['owner']],
      ['Search', ['member']],
    ])
    expect((await dir.projects.forContact(ana.id, { role: 'owner' })).map((m) => m.project.id)).toEqual([checkout.id])

    await dir.projects.removeMember(checkout.id, jim.id, 'reviewer')
    expect((await dir.projects.members(checkout.id)).find((m) => m.contact.id === jim.id)?.roles).toEqual(['member'])
    await dir.projects.removeMember(checkout.id, jim.id)
    expect((await dir.projects.forContact(jim.id)).length).toBe(0)
  })

  it('keeps extra link fields', async () => {
    const ana = await dir.contacts.create({ name: 'Ana' })
    const p = await dir.projects.create({ name: 'Billing' })
    await dir.projects.addMember(p.id, ana.id, 'member', { since: '2026-01-01', allocation: 0.5 })
    const [m] = await dir.projects.members(p.id)
    expect(m?.links[0]?.data).toEqual({ since: '2026-01-01', allocation: 0.5 })
  })

  it('lets an AI employee own a project, and setOwner replaces the owner', async () => {
    const ana = await dir.contacts.create({ name: 'Ana' })
    const emp = await dir.employees.create({ name: 'Robo' })
    const p = await dir.projects.create({ name: 'Docs site' })
    await dir.projects.setOwner(p.id, ana.id)
    await dir.projects.setOwner(p.id, emp.data.contactId)
    const owner = await dir.projects.owner(p.id)
    expect(owner?.data.kind).toBe('ai')
    expect(owner?.id).toBe(emp.data.contactId)
    expect((await dir.projects.members(p.id, { role: 'owner' })).length).toBe(1)
    expect((await dir.projects.forContact(emp.data.contactId, { role: 'owner' }))[0]?.project.id).toBe(p.id)
  })

  it('enforces referential integrity', async () => {
    const p = await dir.projects.create({ name: 'X' })
    await expect(dir.projects.addMember(p.id, 'con_missing', 'owner')).rejects.toThrow(NotFoundError)
    await expect(dir.projects.setOwner('pro_missing', 'con_missing')).rejects.toThrow(NotFoundError)
    const ana = await dir.contacts.create({ name: 'Ana' })
    await expect(dir.projects.addMember(p.id, ana.id, ' ')).rejects.toThrow(ValidationError)
  })

  it('finds projects by name, alias and keywords', async () => {
    const c = await dir.projects.create({ name: 'Checkout', aliases: ['New Checkout Flow'], description: 'Payments UI' })
    await dir.projects.create({ name: 'Search', description: 'Search index' })
    expect((await dir.projects.byName('checkout'))?.id).toBe(c.id)
    expect((await dir.projects.byName('new checkout flow'))?.id).toBe(c.id)
    expect(await dir.projects.byName('check')).toBeNull()
    expect((await dir.projects.search('payments'))[0]?.id).toBe(c.id)
    await expect(dir.projects.create({ name: 'Bad', status: 'dead' as any })).rejects.toThrow(ValidationError)
    await expect(dir.projects.create({ name: 'Bad', repositories: [{} as any] })).rejects.toThrow(/url is required/)
  })
})

describe('procedures', () => {
  it('finds procedures by keywords and project', async () => {
    const p1 = await dir.projects.create({ name: 'Checkout' })
    const p2 = await dir.projects.create({ name: 'Search' })
    const deploy = await dir.procedures.create({
      name: 'Production deploy',
      applies: 'Whenever a change goes to production',
      body: '1. Open a PR\n2. Get approval',
      approvals: [{ role: 'owner' }],
      checklist: [{ text: 'CI green', required: true }],
      projectIds: [p1.id],
    })
    const access = await dir.procedures.create({ name: 'Access request', applies: 'Someone needs access to a system' })
    const found = await dir.procedures.find('deploy this change to production')
    expect(found[0]?.record.id).toBe(deploy.id)
    expect(found[0]!.score).toBeGreaterThan(0)
    expect((await dir.procedures.find('need access')).map((f) => f.record.id)).toEqual([access.id])
    // Scoped: the deploy procedure only applies to Checkout; the access request to everything.
    expect((await dir.procedures.find('production access', { projectIds: [p2.id] })).map((f) => f.record.id)).toEqual([access.id])
    expect((await dir.procedures.find('production', { projectIds: [p1.id] })).map((f) => f.record.id)).toEqual([deploy.id])
    expect(await dir.procedures.find('')).toEqual([])
  })

  it('links procedures to their projects and validates', async () => {
    const p1 = await dir.projects.create({ name: 'A' })
    const p2 = await dir.projects.create({ name: 'B' })
    const prc = await dir.procedures.create({ name: 'Release', applies: 'releases', projectIds: [p1.id] })
    const linked = async () =>
      (await records.links({ from: { kind: 'procedure', id: prc.id }, role: APPLIES_TO })).map((l) => l.to.id)
    expect(await linked()).toEqual([p1.id])
    await dir.procedures.update(prc.id, { projectIds: [p2.id] })
    expect(await linked()).toEqual([p2.id])
    await expect(dir.procedures.update(prc.id, { projectIds: ['pro_missing'] })).rejects.toThrow(NotFoundError)
    await expect(dir.procedures.create({ name: 'X' } as any)).rejects.toThrow(/applies is required/)
    await expect(dir.procedures.create({ name: 'X', applies: 'y', checklist: [{ required: true } as any] })).rejects.toThrow(
      ValidationError,
    )
    expect((await dir.procedures.list()).total).toBe(1)
  })

  it('keeps [[kind:id]] mentions in bodies as backlinks', async () => {
    const ana = await dir.contacts.create({ name: 'Ana' })
    const prc = await dir.procedures.create({ name: 'Deploy', applies: 'deploys', body: `Ask [[contact:${ana.id}|Ana]] first.` })
    expect((await records.backlinks({ kind: 'contact', id: ana.id })).map((r) => r.id)).toEqual([prc.id])
  })
})

describe('project egress', () => {
  it('stores an egress allowlist and validates its shape', async () => {
    const p = await dir.projects.create({ name: 'Billing', egress: { allow: ['registry.npmjs.org', '*.github.com:443'] } })
    expect((await dir.projects.require(p.id)).data.egress).toEqual({ allow: ['registry.npmjs.org', '*.github.com:443'] })
    await dir.projects.update(p.id, { egress: { allow: [] } })
    expect((await dir.projects.require(p.id)).data.egress).toEqual({ allow: [] })
    await expect(dir.projects.create({ name: 'X', egress: { allow: 'npm' } as any })).rejects.toThrow(ValidationError)
    await expect(dir.projects.create({ name: 'Y', egress: {} as any })).rejects.toThrow(ValidationError)
  })
})

describe('employee network setting', () => {
  it('takes none, project or an allowlist, and refuses anything else', async () => {
    const { invalidNetwork } = await import('../src/index.ts')
    const e = await dir.employees.create({ name: 'Net', network: { allow: ['pypi.org'] } })
    expect(e.data.network).toEqual({ allow: ['pypi.org'] })
    expect((await dir.employees.update(e.id, { network: 'none' })).data.network).toBe('none')
    expect((await dir.employees.update(e.id, { network: 'project' })).data.network).toBe('project')
    await expect(dir.employees.update(e.id, { network: 'all' as never })).rejects.toBeInstanceOf(ValidationError)
    await expect(dir.employees.create({ name: 'Bad', network: { allow: [''] } })).rejects.toBeInstanceOf(ValidationError)
    expect(invalidNetwork(undefined)).toBeNull()
    expect(invalidNetwork({ allow: ['a'], extra: 1 })).toMatch(/network must be/)
    expect(invalidNetwork(['a'])).toMatch(/network must be/)
  })
})
