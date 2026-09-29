import { FILE_WRITE_MAX_BYTES } from '@mp/api'
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

  it('uploads binary files as base64, within the same permissions', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe])
    const b64 = bytes.toString('base64')
    const upload = (h: Record<string, string>, path: string, body: Record<string, unknown>) =>
      t.req('PUT', `/api/files/${employeeId}/content?path=${encodeURIComponent(path)}`, body, h)

    const w = await upload(admin, '/uploads/logo.png', { content: b64, encoding: 'base64', version: 0 })
    expect(w.status).toBe(200)
    expect(w.body).toMatchObject({ path: '/uploads/logo.png', encoding: 'base64', size: bytes.length })
    const stored = await t.a.services.files.read(employeeId, '/uploads/logo.png')
    expect(Buffer.from(stored.content, 'base64').equals(bytes)).toBe(true)
    const r = await read(admin, '/uploads/logo.png')
    expect(r.body).toMatchObject({ encoding: 'base64', content: b64, size: bytes.length })
    // Version 0 means "only if it doesn't exist yet".
    expect((await upload(admin, '/uploads/logo.png', { content: b64, encoding: 'base64', version: 0 })).status).toBe(409)

    // A write grant on a directory lets a member add files to it; nothing else does.
    await t.a.services.files.write(employeeId, '/inbox/.keep', '')
    await t.a.services.files.share(employeeId, '/inbox', bobId, 'write')
    expect((await upload(bob, '/inbox/scan.bin', { content: b64, encoding: 'base64' })).status).toBe(200)
    expect((await upload(bob, '/uploads/other.bin', { content: b64, encoding: 'base64' })).status).toBe(403)
    expect((await upload(carol, '/notes/c.bin', { content: b64, encoding: 'base64' })).status).toBe(403)
    expect((await upload(bob, '/shared/emp_x/a.bin', { content: b64, encoding: 'base64' })).status).toBe(403)
  })

  it('refuses bad encodings and files over the size limit', async () => {
    const upload = (body: Record<string, unknown>) =>
      t.req('PUT', `/api/files/${employeeId}/content?path=/uploads/big.bin`, body, admin)
    expect((await upload({ content: 'abc', encoding: 'hex' })).status).toBe(400)
    expect([400, 422]).toContain((await upload({ content: 'not base64!', encoding: 'base64' })).status)
    const big = Buffer.alloc(FILE_WRITE_MAX_BYTES + 1).toString('base64')
    const r = await upload({ content: big, encoding: 'base64' })
    expect(r.status).toBe(413)
    expect(r.body.error.message).toContain('10 MB')
    expect((await upload({ content: 'x'.repeat(FILE_WRITE_MAX_BYTES + 1) })).status).toBe(413)
    await expect(t.a.services.files.read(employeeId, '/uploads/big.bin')).rejects.toThrow()
    // Exactly at the limit is fine.
    const ok = await upload({ content: Buffer.alloc(FILE_WRITE_MAX_BYTES).toString('base64'), encoding: 'base64' })
    expect(ok.status).toBe(200)
    expect(ok.body.size).toBe(FILE_WRITE_MAX_BYTES)
  })

  it('leaves the employee’s own tools unchanged', async () => {
    const own = await t.a.services.files.forEmployee(employeeId).list('/')
    expect(own.map((e) => e.path)).toEqual(expect.arrayContaining(['/notes', '/secret', '/fresh.md']))
  })
})
