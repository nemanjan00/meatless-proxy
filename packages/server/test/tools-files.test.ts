import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeRuntime } from '@mp/containers'
import { afterEach, describe, expect, it } from 'vitest'
import { addStdlibToolsToRouters } from '../src/router-tools.ts'
import { DEFAULT_SETTINGS, SettingNames } from '../src/settings.ts'
import { testApp, type TestApp } from './helpers.ts'

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

const routerOf = async (app: TestApp) => {
  const e = (await app.a.services.directory.employees.list()).items[0]!
  return { employee: e, router: await app.a.services.sessions.require(e.data.routerSessionId!) }
}

describe('stdlib tools in router contexts', () => {
  it('new routers get time.now, and code.run when there is a sandbox', async () => {
    t = await testApp({ overrides: { containers: fakeRuntime() } })
    const { router } = await routerOf(t)
    expect(router.data.toolset).toEqual(expect.arrayContaining(['time.now', 'code.run', 'code.reset']))
    expect(router.data.toolset.some((n) => n.startsWith('git.') || n.startsWith('env.'))).toBe(false)
    expect(t.a.services.sandbox).not.toBeNull()
  })

  it('existing routers, whose toolset is fixed, get stdlib tools added since, once', async () => {
    t = await testApp()
    const { router } = await routerOf(t)
    const s = t.a.services
    // A router context from before time.now existed.
    await s.records.update('session', router.id, { toolset: router.data.toolset.filter((n) => n !== 'time.now') })
    expect(await addStdlibToolsToRouters(s)).toBe(1)
    const after = await s.sessions.require(router.id)
    expect(after.data.toolset.filter((n) => n === 'time.now')).toHaveLength(1)
    expect(after.data.toolset.slice(0, -1)).toEqual(router.data.toolset.filter((n) => n !== 'time.now'))
    expect(await addStdlibToolsToRouters(s)).toBe(0)
    // No sandbox without containers: no code tools.
    expect(after.data.toolset).not.toContain('code.run')
    expect(s.sandbox).toBeNull()
  })

  it('time.now uses the company timezone setting, UTC by default', async () => {
    t = await testApp()
    const s = t.a.services
    const { employee, router } = await routerOf(t)
    const call = () =>
      s.tools.execute(
        'time.now',
        {},
        {
          employeeId: employee.id,
          sessionId: router.id,
          runId: 'run_x',
          callId: 'call_x',
          idempotencyKey: 'run_x:0:call_x',
          secrets: {},
          signal: new AbortController().signal,
          logger: s.logger,
          clock: s.clock,
          emit: () => {},
        },
      )
    expect(DEFAULT_SETTINGS.timezone).toBe('UTC')
    expect(((await call()).output as { timezone: string }).timezone).toBe('UTC')
    await s.settings.set(SettingNames.timezone, 'Europe/Belgrade')
    expect(((await call()).output as { timezone: string }).timezone).toBe('Europe/Belgrade')
  })
})

describe('employee files on disk', () => {
  it('are written under FILES_DIR/<employee>, and the API reads them back', async () => {
    t = await testApp()
    const { employee } = await routerOf(t)
    const w = await t.req('PUT', `/api/files/${employee.id}/content?path=/notes/a.md`, { content: '# A' })
    expect(w.status).toBe(200)
    const onDisk = join(t.config.FILES_DIR, employee.id, 'notes', 'a.md')
    expect(existsSync(onDisk)).toBe(true)
    expect(readFileSync(onDisk, 'utf8')).toBe('# A')
    expect(t.config.FILES_DIR).toBe(join(t.config.DATA_DIR, 'files'))
    expect((await t.req('GET', `/api/files/${employee.id}/content?path=/notes/a.md`)).body).toMatchObject({
      content: '# A',
      version: w.body.version,
    })
    // No file records: the database keeps only sharing grants.
    expect(await t.a.services.store.records.count('file')).toBe(0)
  })
})

describe('DEFAULT_EGRESS', () => {
  it('is a comma-separated allowlist, any public host by default, checked at start', async () => {
    const { loadConfig } = await import('../src/config.ts')
    // Permissive by default: any public host through the logging proxy; `none` turns it off.
    expect(loadConfig({}).DEFAULT_EGRESS).toEqual(['*'])
    expect(loadConfig({ DEFAULT_EGRESS: '' }).DEFAULT_EGRESS).toEqual(['*'])
    expect(loadConfig({ DEFAULT_EGRESS: 'none' }).DEFAULT_EGRESS).toEqual([])
    expect(loadConfig({ DEFAULT_EGRESS: 'pypi.org, *.github.com:443' }).DEFAULT_EGRESS).toEqual(['pypi.org', '*.github.com:443'])
    expect(() => loadConfig({ DEFAULT_EGRESS: 'pypi.org,not a host' })).toThrow(/DEFAULT_EGRESS: not hostname globs: not a host/)
  })
})
