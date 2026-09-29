import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

const DATABASE_URL = process.env.DATABASE_URL
const schema = `mp_login_cli_${process.pid}`
const cli = fileURLToPath(new URL('../src/login-link-cli.ts', import.meta.url))
const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))

function run(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(tsx, [cli, ...args], { env: { ...process.env, DOTENV_PATH: '/nonexistent', ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    )
  })
}

describe.skipIf(!DATABASE_URL)('npm run login-link (Postgres)', () => {
  let t: TestApp | undefined
  afterAll(async () => {
    await t?.close()
    const pool = new pg.Pool({ connectionString: DATABASE_URL })
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await pool.end()
  })

  it('prints a link that signs the contact in once, found by id or email', async () => {
    const env = { DATABASE_URL: DATABASE_URL!, DATABASE_SCHEMA: schema, SECRETS_KEY: 'test-secrets-key-0123456789' }
    t = await testApp({ workers: false, env })
    const ana = await t.a.services.directory.contacts.create({ name: 'Ana', kind: 'person', email: 'ana@example.com' })

    const byEmail = await run(['--contact', 'ana@example.com'], env)
    expect(byEmail.code).toBe(0)
    const url = new URL(byEmail.stdout.trim())
    expect(url.pathname).toBe('/auth/login')
    const res = await t.a.app.request(`/auth/login${url.search}`)
    expect(res.headers.get('location')).toBe('/')
    expect((await t.a.app.request(`/auth/login${url.search}`)).headers.get('location')).toBe('/login?error=invalid_link')

    const byId = await run(['--contact', ana.id], env)
    expect(byId.code).toBe(0)
    const missing = await run(['--contact', 'nobody@example.com'], env)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('no contact nobody@example.com')
    const ai = (await t.a.services.directory.employees.byHandle('meatless'))!.data.contactId
    const refused = await run(['--contact', ai], env)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("can't sign in")
  }, 60_000)

  it('creates the person with --create, signs in as the first admin with --admin, and explains what to do otherwise', async () => {
    const env = { DATABASE_URL: DATABASE_URL!, DATABASE_SCHEMA: schema, SECRETS_KEY: 'test-secrets-key-0123456789' }
    t ??= await testApp({ workers: false, env })
    const missing = await run(['--contact', 'nobody@example.com'], env)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('--create --access admin')
    expect(missing.stderr).toContain('--admin')

    const made = await run(['--contact', 'boss@example.com', '--create', '--access', 'admin', '--name', 'Boss'], env)
    expect(made.code).toBe(0)
    expect(made.stderr).toContain('created boss@example.com (admin)')
    const boss = await t.a.services.directory.contacts.byEmail('boss@example.com')
    expect(boss?.data).toMatchObject({ name: 'Boss', kind: 'person', access: 'admin' })
    const res = await t.a.app.request(`/auth/login${new URL(made.stdout.trim()).search}`)
    expect(res.headers.get('location')).toBe('/')

    // Running it again finds the person instead of creating a second one.
    expect((await run(['--contact', 'boss@example.com', '--create'], env)).stderr).not.toContain('created')
    const admin = await run(['--admin'], env)
    expect(admin.code).toBe(0)
    expect(new URL(admin.stdout.trim()).pathname).toBe('/auth/login')
    expect((await run(['--contact', 'x@example.com', '--create', '--access', 'root'], env)).code).toBe(2)
  })
})

describe('npm run login-link', () => {
  it('prints its usage without --contact', async () => {
    const r = await run([], {})
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('npm run login-link -- --contact')
  }, 30_000)
})
