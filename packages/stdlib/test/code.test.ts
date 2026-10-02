import { globMatch } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSET, ROUTER_EXCLUDED_TOOLS, employeePrompt } from '../src/index.ts'
import { stack } from './helpers.ts'

describe('code.run', () => {
  it('runs cells that keep their state, and reports results', async () => {
    const t = await stack()
    expect(await t.out('code.run', { language: 'python', code: 'var x = 2n ** 100n' })).toMatchObject({
      stdout: '',
      files_changed: [],
    })
    const r = await t.out('code.run', { language: 'python', code: 'x + 1n' })
    expect(r.result).toBe('1267650600228229401496703205377n')
    expect(r.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('works on the same files as fs.*, attributing changes to the session', async () => {
    const t = await stack()
    await t.out('fs.write', { path: '/data/sales.csv', content: 'q,amount\nq1,10\nq2,32\n' })
    const r = await t.out('code.run', {
      language: 'node',
      code: 'read("data/sales.csv").then((csv) => { const total = csv.trim().split("\\n").slice(1).reduce((s, l) => s + Number(l.split(",")[1]), 0); return write("report.txt", "total " + total).then(() => total) })',
    })
    expect(r.result).toBe('42')
    expect(r.files_changed).toEqual([{ path: '/report.txt', sandboxPath: '/work/files/report.txt', change: 'created', size: 8 }])
    expect((await t.out('fs.read', { path: '/report.txt' })).content).toBe('total 42')
  })

  it('returns cell errors as tool errors, and a timeout loses the state', async () => {
    const t = await stack()
    const bad = await t.call('code.run', { language: 'python', code: 'throw new Error("nope")' })
    expect(bad.isError).toBe(true)
    expect((bad.output as { error: string }).error).toBe('Error: nope')
    await t.out('code.run', { language: 'python', code: 'var y = 1' })
    const slow = await t.call('code.run', { language: 'python', code: 'hang()', timeoutMs: 1000 })
    expect(slow.isError).toBe(true)
    expect(slow.output).toMatchObject({ state_lost: true })
    expect((await t.out('code.run', { language: 'python', code: 'typeof y' })).result).toBe('"undefined"')
  })

  it('rejects unknown languages before running anything', async () => {
    const t = await stack()
    const r = await t.call('code.run', { language: 'ruby', code: '1' })
    expect(r.isError).toBe(true)
    expect(t.sandboxRuntime.kernelsStarted).toBe(0)
  })

  it('is classified as non-idempotent, reset as idempotent', async () => {
    const t = await stack()
    expect(t.tools.get('code.run')!.def.effect).toBe('non_idempotent')
    expect(t.tools.get('code.reset')!.def.effect).toBe('idempotent')
    expect(DEFAULT_TOOLSET).toEqual(expect.arrayContaining(['code.run', 'code.reset', 'time.now']))
    // Router contexts may answer a quick calculation themselves, and the sessions they start inherit their tools.
    expect(ROUTER_EXCLUDED_TOOLS.some((p) => globMatch(p, 'code.run'))).toBe(false)
  })

  it('isn’t registered without a sandbox', async () => {
    const t = await stack({ sandbox: false })
    expect(t.tools.get('code.run')).toBeNull()
  })
})

describe('code.reset and session ends', () => {
  it('reset drops the state of one language or both', async () => {
    const t = await stack()
    await t.out('code.run', { language: 'python', code: 'var x = 1' })
    await t.out('code.run', { language: 'node', code: 'var x = 2' })
    expect(await t.out('code.reset', { language: 'node' })).toEqual({ reset: ['node'] })
    expect((await t.out('code.run', { language: 'python', code: 'x' })).result).toBe('1')
    expect(await t.out('code.reset', {})).toEqual({ reset: ['python'] })
    expect(await t.out('code.reset', {})).toEqual({ reset: [], note: 'there was no running kernel' })
  })

  it("stops a session's kernels when the session is done", async () => {
    const t = await stack()
    await t.out('code.run', { language: 'python', code: 'var x = 1' })
    expect(t.sandbox.hasSession(t.session.id)).toBe(true)
    await t.sessions.update(t.session.id, { status: 'done' })
    await t.bus.idle()
    await new Promise((r) => setTimeout(r, 10))
    expect(t.sandbox.hasSession(t.session.id)).toBe(false)
    expect(t.sandboxRuntime.running()).toBe(0)
  })
})

describe('the prompt', () => {
  it('points at code.run for math, data and charts', async () => {
    const t = await stack()
    const contact = await t.directory.contacts.require(t.employee.data.contactId)
    const p = employeePrompt({ employee: t.employee, contact, now: 'now' })
    expect(p).toContain('compute with code.run (your Python/Node sandbox')
    expect(p).toContain('/work/files')
  })
})
