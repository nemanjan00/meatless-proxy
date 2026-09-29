import { reply } from '@mp/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

/** An employee's files are private: admins see everything, others only what was shared with them. */

let t: TestApp & { port: number | null }
let employeeId: string
let bobId: string
let carolId: string
let bob: Record<string, string>
let carol: Record<string, string>
let admin: Record<string, string>

const list = async (h: Record<string, string>, dir = '/') =>
  t.req('GET', `/api/files/${employeeId}?dir=${encodeURIComponent(dir)}`, undefined, h)
const read = async (h: Record<string, string>, path: string) =>
  t.req('GET', `/api/files/${employeeId}/content?path=${encodeURIComponent(path)}`, undefined, h)
const write = async (h: Record<string, string>, path: string, content: string, version?: number) =>
  t.req(
    'PUT',
    `/api/files/${employeeId}/content?path=${encodeURIComponent(path)}`,
    { content, ...(version ? { version } : {}) },
    h,
  )

beforeAll(async () => {
  t = await testApp({ workers: false, script: [reply('ok')] })
  const s = t.a.services
  employeeId = (await s.directory.employees.byHandle('meatless'))!.id
  bobId = (await s.directory.contacts.create({ name: 'Bob Example', kind: 'person', access: 'member' })).id
  carolId = (await s.directory.contacts.create({ name: 'Carol Example', kind: 'person', access: 'viewer' })).id
  bob = await t.as(bobId)
  carol = await t.as(carolId)
  admin = (await t.admin()).headers
  await s.files.write(employeeId, '/notes/a.md', 'note a')
  await s.files.write(employeeId, '/notes/b.md', 'note b')
  await s.files.write(employeeId, '/secret/pay.md', 'pay bands')
})
afterAll(() => t.close())

describe('employee files over the API', () => {
  it('shows nothing to people it was not shared with', async () => {
    for (const h of [bob, carol]) {
      const top = await list(h)
      expect(top.status).toBe(200)
      expect(top.body).toEqual([])
      expect((await list(h, '/notes')).status).toBe(403)
      const r = await read(h, '/secret/pay.md')
      expect(r.status).toBe(403)
      expect(JSON.stringify(r.body)).not.toContain('pay bands')
    }
    expect((await write(bob, '/notes/a.md', 'overwritten')).status).toBe(403)
    expect((await write(carol, '/notes/a.md', 'overwritten')).status).toBe(403)
    expect((await t.a.services.files.read(employeeId, '/notes/a.md')).content).toBe('note a')
  })

  it('lets a read grant list and read what it covers, and nothing else', async () => {
    await t.a.services.files.share(employeeId, '/notes', carolId, 'read')
    const top = await list(carol)
    expect(top.body.map((e: any) => e.path)).toEqual(['/notes'])
    const notes = await list(carol, '/notes')
    expect(notes.body.map((e: any) => [e.path, e.shared?.permission])).toEqual([
      ['/notes/a.md', 'read'],
      ['/notes/b.md', 'read'],
    ])
    const a = await read(carol, '/notes/a.md')
    expect(a.status).toBe(200)
    expect(a.body).toEqual(expect.objectContaining({ path: '/notes/a.md', content: 'note a' }))
    expect((await read(carol, '/secret/pay.md')).status).toBe(403)
    expect((await list(carol, '/secret')).status).toBe(403)
    // A viewer never writes, even with a grant.
    expect((await write(carol, '/notes/a.md', 'x')).status).toBe(403)
  })

  it('lets a write grant change files it covers, and only those', async () => {
    await t.a.services.files.share(employeeId, '/notes/a.md', bobId, 'write')
    expect((await list(bob, '/notes')).body.map((e: any) => [e.path, e.shared?.permission])).toEqual([['/notes/a.md', 'write']])
    const w = await write(bob, '/notes/a.md', 'bob was here')
    expect(w.status).toBe(200)
    expect(w.body.path).toBe('/notes/a.md')
    expect((await t.a.services.files.read(employeeId, '/notes/a.md')).content).toBe('bob was here')
    // Compare-and-swap still applies.
    expect((await write(bob, '/notes/a.md', 'stale', 1)).status).toBe(409)
    expect((await write(bob, '/notes/b.md', 'nope')).status).toBe(403)
    expect((await write(bob, '/secret/pay.md', 'nope')).status).toBe(403)
    expect((await write(bob, '/new.md', 'nope')).status).toBe(403)
  })

  it('keeps what others share with the employee, and paths outside it, away from non-admins', async () => {
    expect((await list(carol, '/shared')).status).toBe(403)
    expect((await read(carol, '/shared/emp_x/a.md')).status).toBe(403)
    expect([400, 403, 422]).toContain((await read(carol, '/../notes/a.md')).status)
  })

  it('gives admins everything', async () => {
    const top = await list(admin)
    expect(top.body.map((e: any) => e.path)).toEqual(expect.arrayContaining(['/notes', '/secret']))
    expect((await read(admin, '/secret/pay.md')).body.content).toBe('pay bands')
    expect((await write(admin, '/secret/pay.md', 'new bands')).status).toBe(200)
    expect((await write(admin, '/fresh.md', 'hello')).status).toBe(200)
    expect((await t.a.services.files.read(employeeId, '/fresh.md')).content).toBe('hello')
  })

  it('leaves the employee’s own tools unchanged', async () => {
    const own = await t.a.services.files.forEmployee(employeeId).list('/')
    expect(own.map((e) => e.path)).toEqual(expect.arrayContaining(['/notes', '/secret', '/fresh.md']))
  })
})
