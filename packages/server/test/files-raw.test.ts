import { reply } from '@mp/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

/** `GET /api/files/:employeeId/raw`: a file's bytes for previews and downloads, with the read permissions of `/content`. */

let t: TestApp & { port: number | null }
let employeeId: string
let otherId: string
let bobId: string
let carolId: string
let daveId: string
let admin: Record<string, string>
let bob: Record<string, string>
let carol: Record<string, string>
let dave: Record<string, string>

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
/** The start of a PNG: signature and IHDR, enough to sniff its type and size. */
const PNG = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  13,
  0x49,
  0x48,
  0x44,
  0x52,
  ...u32(3),
  ...u32(2),
  8,
  6,
  0,
  0,
  0,
  1,
  2,
  3,
  4,
])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>'

const raw = (h: Record<string, string>, path: string, query = '', extra: Record<string, string> = {}) =>
  t.a.app.request(`/api/files/${employeeId}/raw?path=${encodeURIComponent(path)}${query}`, { headers: { ...h, ...extra } })
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer())

beforeAll(async () => {
  t = await testApp({ workers: false, script: [reply('ok')] })
  const s = t.a.services
  employeeId = (await s.directory.employees.byHandle('meatless'))!.id
  otherId = (await s.directory.employees.create({ name: 'Kai', toolAllow: ['**'] })).id
  bobId = (await s.directory.contacts.create({ name: 'Bob Example', kind: 'person', access: 'member' })).id
  carolId = (await s.directory.contacts.create({ name: 'Carol Example', kind: 'person', access: 'viewer' })).id
  daveId = (await s.directory.contacts.create({ name: 'Dave Example', kind: 'person', access: 'member' })).id
  admin = (await t.admin()).headers
  bob = await t.as(bobId)
  carol = await t.as(carolId)
  dave = await t.as(daveId)
  const b64 = { encoding: 'base64' as const }
  await s.files.write(employeeId, '/pics/logo.png', PNG.toString('base64'), b64)
  // The name says PNG; the bytes are a JPEG. The bytes win.
  await s.files.write(employeeId, '/pics/photo.png', JPEG.toString('base64'), b64)
  // The name says image; the bytes are not one.
  await s.files.write(employeeId, '/pics/fake.png', Buffer.from('not an image').toString('base64'), b64)
  await s.files.write(employeeId, '/pics/icon.svg', SVG)
  await s.files.write(employeeId, '/pics/page.html', '<script>alert(1)</script>')
  await s.files.write(employeeId, '/notes/a.md', '# A')
  await s.files.share(employeeId, '/pics', bobId, 'read')
  await s.files.share(employeeId, '/pics', carolId, 'read')
  // Kai shares one folder with this employee: it shows under /shared/<kai>/ for admins.
  await s.files.write(otherId, '/public/chart.png', PNG.toString('base64'), b64)
  await s.files.write(otherId, '/private/pay.png', PNG.toString('base64'), b64)
  await s.files.share(otherId, '/public', (await s.files.contactOf(employeeId))!, 'read')
})
afterAll(() => t.close())

describe('file bytes over the API', () => {
  it('serves images inline with the sniffed type, nosniff and a sandbox', async () => {
    const res = await raw(admin, '/pics/logo.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="logo.png"/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(res.headers.get('content-length')).toBe(String(PNG.length))
    expect((await bytes(res)).equals(PNG)).toBe(true)
    // By the bytes, not the name.
    const photo = await raw(admin, '/pics/photo.png')
    expect(photo.headers.get('content-type')).toBe('image/jpeg')
    expect(photo.headers.get('content-disposition')).toMatch(/^inline/)
    const fake = await raw(admin, '/pics/fake.png')
    expect(fake.headers.get('content-type')).toBe('text/plain')
    expect(fake.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('never serves SVG or HTML as something a browser would render', async () => {
    for (const p of ['/pics/icon.svg', '/pics/page.html']) {
      const res = await raw(admin, p)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-security-policy')).toContain('sandbox')
    }
    expect((await bytes(await raw(admin, '/pics/icon.svg'))).toString()).toBe(SVG)
  })

  it('makes an image an attachment on request', async () => {
    const res = await raw(admin, '/pics/logo.png', '&download=1')
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="logo.png"/)
  })

  it('caches by version: immutable for the current one, revalidated otherwise, 304 on a match', async () => {
    const f = await t.a.services.files.read(employeeId, '/pics/logo.png')
    const current = await raw(admin, '/pics/logo.png', `&v=${f.version}`)
    expect(current.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(current.headers.get('etag')).toBe(`"${f.version}"`)
    expect((await raw(admin, '/pics/logo.png', '&v=1')).headers.get('cache-control')).toBe('private, no-cache')
    expect((await raw(admin, '/pics/logo.png')).headers.get('cache-control')).toBe('private, no-cache')
    const again = await raw(admin, '/pics/logo.png', '', { 'if-none-match': `"${f.version}"` })
    expect(again.status).toBe(304)
    expect((await again.arrayBuffer()).byteLength).toBe(0)
    expect((await raw(admin, '/pics/logo.png', '', { 'if-none-match': '"0"' })).status).toBe(200)
  })

  it('has the read permissions of /content: grants for members and viewers, nothing without one', async () => {
    for (const h of [bob, carol]) {
      const ok = await raw(h, '/pics/logo.png')
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toBe('image/png')
      const denied = await raw(h, '/notes/a.md')
      expect(denied.status).toBe(403)
      expect(await denied.text()).not.toContain('# A')
    }
    // A member without a grant sees nothing.
    expect((await raw(dave, '/pics/logo.png')).status).toBe(403)
    // Signed out: nothing.
    expect([401, 403]).toContain((await raw({ authorization: '' }, '/pics/logo.png')).status)
    expect((await raw(admin, '/pics/missing.png')).status).toBe(404)
    expect((await t.a.app.request(`/api/files/${employeeId}/raw`, { headers: admin })).status).toBe(400)
    expect((await t.a.app.request('/api/files/emp_nope/raw?path=/a.png', { headers: admin })).status).toBe(404)
  })

  it('serves what other employees share under /shared to admins, within the grant', async () => {
    const ok = await raw(admin, `/shared/${otherId}/public/chart.png`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(ok.headers.get('content-disposition')).toMatch(/^inline; filename="chart.png"/)
    expect([403, 404]).toContain((await raw(admin, `/shared/${otherId}/private/pay.png`)).status)
    // Non-admins never reach /shared, even with a grant on the employee's own files.
    expect((await raw(bob, `/shared/${otherId}/public/chart.png`)).status).toBe(403)
  })

  it('types files on /content and versions them in listings', async () => {
    const png = await t.req('GET', `/api/files/${employeeId}/content?path=/pics/logo.png`)
    expect(png.body).toMatchObject({ encoding: 'base64', mime: 'image/png', width: 3, height: 2 })
    const svg = await t.req('GET', `/api/files/${employeeId}/content?path=/pics/icon.svg`)
    expect(svg.body).toMatchObject({ encoding: 'utf8', mime: 'image/svg+xml' })
    expect(svg.body.width).toBeUndefined()
    const ls = await t.req('GET', `/api/files/${employeeId}?dir=/pics`)
    const logo = ls.body.find((e: any) => e.name === 'logo.png')
    expect(logo.version).toBe((await t.a.services.files.read(employeeId, '/pics/logo.png')).version)
    const top = await t.req('GET', `/api/files/${employeeId}?dir=/`)
    expect(top.body.find((e: any) => e.name === 'pics').version).toBeUndefined()
  })
})
