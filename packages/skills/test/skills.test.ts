import { ConflictError, NotFoundError, ValidationError } from '@mp/core'
import { createRecords, type Records } from '@mp/records'
import { memoryStore } from '@mp/store'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSkills, type SkillsService } from '../src/index.ts'

let records: Records
let skills: SkillsService
let p1: string
let p2: string

beforeEach(async () => {
  records = createRecords({ store: memoryStore() })
  records.kinds.define({ kind: 'project', prefix: 'pro', core: [{ name: 'name', type: 'string' }] })
  skills = createSkills({ records })
  p1 = (await records.create('project', { name: 'Checkout' })).id
  p2 = (await records.create('project', { name: 'Search' })).id
})

const base = { description: 'd', body: 'b' }

describe('skills', () => {
  it('creates company skills by default and validates', async () => {
    const s = await skills.create({ name: 'Cut a release', description: 'Release steps', body: '# Steps' })
    expect(s.id).toMatch(/^skl_/)
    expect(s.data.scope).toEqual({ type: 'company' })
    await expect(skills.create({ name: 'x', description: 'd' } as any)).rejects.toThrow(/body is required/)
    await expect(skills.create({ name: 'x', ...base, scope: { type: 'project' } })).rejects.toThrow(/projectId/)
    await expect(skills.create({ name: 'x', ...base, scope: { type: 'company', projectId: p1 } })).rejects.toThrow(
      ValidationError,
    )
    await expect(
      skills.create({
        name: 'x',
        ...base,
        files: [
          { path: 'a', content: '1' },
          { path: 'a', content: '2' },
        ],
      }),
    ).rejects.toThrow(/unique/)
  })

  it('refuses duplicate names in the same scope only', async () => {
    await skills.create({ name: 'Release', ...base })
    await expect(skills.create({ name: ' release ', ...base })).rejects.toThrow(ConflictError)
    await skills.create({ name: 'Release', ...base, scope: { type: 'project', projectId: p1 } })
    await expect(skills.create({ name: 'Release', ...base, scope: { type: 'project', projectId: p1 } })).rejects.toThrow(
      ConflictError,
    )
    await skills.create({ name: 'Release', ...base, scope: { type: 'project', projectId: p2 } })
    expect((await skills.list()).length).toBe(3)
    expect((await skills.list({ scope: { type: 'company' } })).length).toBe(1)
    expect((await skills.list({ scope: { type: 'project', projectId: p2 } })).length).toBe(1)
  })

  it('offers company skills plus the session projects, project skills overriding by name', async () => {
    const release = await skills.create({ name: 'Release', description: 'company release', body: 'company' })
    const triage = await skills.create({ name: 'Triage', description: 'bugs', body: 'triage' })
    const p1Release = await skills.create({
      name: 'release',
      description: 'checkout release',
      body: 'p1',
      scope: { type: 'project', projectId: p1 },
    })
    const p2Release = await skills.create({
      name: 'Release',
      description: 'search release',
      body: 'p2',
      scope: { type: 'project', projectId: p2 },
    })
    const p2Only = await skills.create({
      name: 'Reindex',
      description: 'reindex',
      body: 'r',
      scope: { type: 'project', projectId: p2 },
    })

    expect((await skills.available()).map((s) => s.id)).toEqual([release.id, triage.id])
    const inP1 = await skills.available({ projectIds: [p1] })
    expect(inP1.map((s) => s.id)).toEqual([p1Release.id, triage.id])
    expect(inP1[0]).toEqual({
      id: p1Release.id,
      name: 'release',
      description: 'checkout release',
      version: 1,
      scope: { type: 'project', projectId: p1 },
      overrides: release.id,
    })
    // Two projects: the first listed wins.
    const both = await skills.available({ projectIds: [p2, p1] })
    expect(both.map((s) => s.id)).toEqual([p2Only.id, p2Release.id, triage.id])

    expect((await skills.load('Release')).body).toBe('company')
    expect((await skills.load('RELEASE', { projectIds: [p1] })).body).toBe('p1')
    expect((await skills.load('release', { projectIds: [p2, p1] })).body).toBe('p2')
    await expect(skills.load('Reindex', { projectIds: [p1] })).rejects.toThrow(NotFoundError)
    await expect(skills.load('nope')).rejects.toThrow(NotFoundError)
    // By id, only when available here.
    expect((await skills.load(p2Only.id, { projectIds: [p2] })).skill.id).toBe(p2Only.id)
    await expect(skills.load(p2Only.id)).rejects.toThrow(NotFoundError)
  })

  it('loads the current version with files, and keeps history', async () => {
    const s = await skills.create({ name: 'Migrate', ...base, files: [{ path: 'scripts/check.sh', content: 'echo ok' }] })
    await skills.update(s.id, { body: 'v2' })
    const loaded = await skills.load('migrate')
    expect(loaded).toMatchObject({ body: 'v2', version: 2, files: [{ path: 'scripts/check.sh', content: 'echo ok' }] })
    expect((await records.revisions('skill', s.id)).map((r) => (r.data as any)?.body)).toEqual(['b', 'v2'])
    expect((await skills.load('Triage').catch((e) => e)) instanceof NotFoundError).toBe(true)
  })

  it('renames and rescopes, keeping names unique', async () => {
    const a = await skills.create({ name: 'A', ...base })
    await skills.create({ name: 'B', ...base })
    await expect(skills.update(a.id, { name: 'b' })).rejects.toThrow(ConflictError)
    const moved = await skills.update(a.id, { scope: { type: 'project', projectId: p1 } })
    expect(moved.data.scope.projectId).toBe(p1)
    expect((await skills.available()).map((s) => s.name)).toEqual(['B'])
    await skills.create({ name: 'A', ...base })
    await expect(skills.update(a.id, { scope: { type: 'project' } })).rejects.toThrow(ValidationError)
    await expect(skills.update(a.id, { body: 'x' }, { expectedVersion: 1 })).rejects.toThrow(ConflictError)
    await expect(skills.update('skl_missing', { body: 'x' })).rejects.toThrow(NotFoundError)
  })

  it('removes a skill', async () => {
    const s = await skills.create({ name: 'Gone', ...base })
    await skills.remove(s.id)
    expect(await skills.get(s.id)).toBeNull()
    expect(await skills.available()).toEqual([])
  })

  it('supports extension fields', async () => {
    records.kinds.extend('skill', [{ name: 'tags', type: 'list', of: { type: 'string' } }])
    await expect(skills.create({ name: 'T', ...base, tags: 'x' } as any)).rejects.toThrow(ValidationError)
    expect((await skills.create({ name: 'T', ...base, tags: ['x'] } as any)).data.tags).toEqual(['x'])
  })
})
