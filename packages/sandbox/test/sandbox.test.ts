import { ManualClock, ValidationError, createEventBus, memoryLogger } from '@mp/core'
import { FILE_CHANGED, createFiles, memoryStorage, type FileChanged, type FileStorage } from '@mp/files'
import { createRecords } from '@mp/records'
import { memoryStore } from '@mp/store'
import { describe, expect, it } from 'vitest'
import { DEFAULT_IDLE_MS, createSandbox, fakeSandboxRuntime, sandboxName, truncate, type SandboxOptions } from '../src/index.ts'

const text = (s: string) => new TextEncoder().encode(s)
const str = (b: Uint8Array) => new TextDecoder().decode(b)

async function setup(o: { mount?: boolean; subpaths?: boolean; sandbox?: Partial<SandboxOptions> } = {}) {
  const clock = new ManualClock(Date.UTC(2026, 8, 29, 9))
  const bus = createEventBus()
  const records = createRecords({ store: memoryStore({ bus }) })
  records.kinds.define({ kind: 'contact', prefix: 'con', core: [{ name: 'name', type: 'string' }] })
  records.kinds.define({ kind: 'employee', prefix: 'emp', core: [{ name: 'contactId', type: 'ref' }] })
  const meC = (await records.create('contact', { name: 'Bot' })).id
  const otherC = (await records.create('contact', { name: 'Other' })).id
  const me = (await records.create('employee', { contactId: meC })).id
  const other = (await records.create('employee', { contactId: otherC })).id
  const base = memoryStorage()
  // Memory storage standing in for a directory on the files volume.
  const storage: FileStorage = o.mount ? { ...base, localPath: async (e) => `/volume/${e}` } : base
  const files = createFiles({ records, storage, bus })
  const changes: FileChanged[] = []
  bus.subscribe(FILE_CHANGED, (m) => void changes.push(m.payload as FileChanged))
  const rt = fakeSandboxRuntime({ clock, storage, features: { volumeSubpath: o.subpaths ?? true } })
  const log = memoryLogger()
  const sandbox = createSandbox({
    runtime: rt,
    files,
    image: 'mp-sandbox:test',
    clock,
    logger: log,
    reapIntervalMs: 0,
    ...(o.mount ? { filesVolume: 'mp-files' } : {}),
    ...o.sandbox,
  })
  const actor = { type: 'session' as const, id: 'ses_1' }
  const run = (code: string, extra: Partial<Parameters<typeof sandbox.run>[0]> = {}) =>
    sandbox.run({ employeeId: me, sessionId: 'ses_1', language: 'python', code, actor, ...extra })
  return { clock, bus, records, files, storage, rt, sandbox, me, other, meC, otherC, run, changes, log }
}

describe('kernels', () => {
  it('keep variables between cells and echo the last expression', async () => {
    const t = await setup()
    const a = await t.run('var x = 2 ** 10; print("set")')
    expect(a).toMatchObject({ stdout: 'set\n', stderr: '', files_changed: [] })
    expect(a.result).toBeUndefined()
    const b = await t.run('x + 1')
    expect(b.result).toBe('1025')
    expect(b.duration_ms).toBeGreaterThanOrEqual(0)
    expect(t.rt.kernelsStarted).toBe(1)
    const c = await t.run('throw new TypeError("nope")')
    expect(c.error).toBe('TypeError: nope')
    expect((await t.run('x')).result).toBe('1024')
  })

  it('run in a hardened container per employee, with no network, no secrets and limits', async () => {
    const t = await setup()
    await t.run('1')
    const [env] = t.rt.envs()
    expect(env!.spec).toMatchObject({
      name: `${t.me.toLowerCase().replace(/_/g, '-')}-sandbox`,
      image: 'mp-sandbox:test',
      user: '1000:1000',
      readOnlyRootfs: true,
      volumes: ['/work'],
      tmpfs: { '/tmp': { sizeMb: 256 } },
      workdir: '/work/files',
      limits: { cpus: 1, memoryMb: 1024, pids: 256 },
      labels: { 'mp.sandbox': t.me, 'mp.employee': t.me },
    })
    expect(env!.spec.egress).toBeUndefined()
    expect(env!.spec.allowInternet).toBeUndefined()
    expect(env!.spec.env).toBeUndefined()
    expect(env!.spec.mounts).toBeUndefined()
    // Every kernel runs the driver in /work/files.
    expect(t.rt.spawns[0]).toMatchObject({ workdir: '/work/files' })
    expect(t.rt.spawns[0]!.cmd.slice(0, 3)).toEqual(['python3', '-u', '-c'])
    expect(t.rt.spawns[0]!.env).toBeUndefined()
  })

  it('reach the egress allowlist only when configured', async () => {
    const t = await setup({ sandbox: { egress: ['pypi.org', 'files.pythonhosted.org'] } })
    await t.run('1')
    const [env] = t.rt.envs()
    expect(env!.spec.egress).toEqual({ allow: ['pypi.org', 'files.pythonhosted.org'] })
    expect(t.rt.egressAllowed(env!.info.id, 'pypi.org', 443)).toBe(true)
    expect(t.rt.egressAllowed(env!.info.id, 'example.com', 443)).toBe(false)
  })

  it('follow the employee network setting, restarting when it changes', async () => {
    let allow = ['pypi.org']
    const t = await setup({ sandbox: { egress: async () => allow } })
    await t.run('var x = 1')
    expect(t.rt.envs()[0]!.spec.egress).toEqual({ allow: ['pypi.org'] })
    allow = []
    const r = await t.run('typeof x')
    expect(r.notes?.join(' ')).toMatch(/network access changed/)
    expect(t.rt.envs()[0]!.spec.egress).toBeUndefined()
  })

  it('run node too, in a kernel of its own', async () => {
    const t = await setup()
    await t.run('var x = 1')
    expect((await t.run('typeof x', { language: 'node' })).result).toBe('"undefined"')
    expect(t.rt.spawns.map((s) => s.cmd[0])).toEqual(['python3', 'node'])
    expect(t.rt.spawns[1]!.cmd).toContain('--expose-internals')
  })

  it('restart after a timeout, saying the state is gone', async () => {
    const t = await setup()
    await t.run('var x = 5')
    const r = await t.run('hang()', { timeoutMs: 1000 })
    expect(r.error).toMatch(/timed out after 1 s: the kernel was stopped/)
    expect(r.state_lost).toBe(true)
    expect(t.rt.running()).toBe(0)
    const next = await t.run('typeof x')
    expect(next.result).toBe('"undefined"')
    expect(t.rt.kernelsStarted).toBe(2)
  })

  it('report a kernel that died, and start a new one next time', async () => {
    const t = await setup()
    await t.run('var x = 5')
    const r = await t.run('die(137)')
    expect(r.error).toMatch(/kernel died \(exit code 137, probably out of memory\)/)
    expect(r.state_lost).toBe(true)
    const next = await t.run('typeof x')
    expect(next.result).toBe('"undefined"')
    expect(next.state_lost).toBeUndefined()
  })

  it('run fresh cells in a throwaway kernel', async () => {
    const t = await setup()
    await t.run('var x = 5')
    const f = await t.run('typeof x', { fresh: true })
    expect(f.result).toBe('"undefined"')
    expect(t.rt.running()).toBe(1)
    expect((await t.run('x')).result).toBe('5')
  })

  it('serialize concurrent cells of one session, and start only one kernel', async () => {
    const t = await setup()
    const order: string[] = []
    await Promise.all([
      t.run('var log = []; sleep(30).then(() => { log.push("a"); return "a" })').then((r) => order.push(r.result!)),
      t.run('log.push("b"); "b"').then((r) => order.push(r.result!)),
      t.run('log.join(",")').then((r) => order.push(r.result!)),
    ])
    expect(order).toEqual(['"a"', '"b"', '"a,b"'])
    expect(t.rt.kernelsStarted).toBe(1)
  })

  it('keep sessions apart, in one container per employee', async () => {
    const t = await setup()
    await t.run('var secret = 42')
    const other = await t.sandbox.run({ employeeId: t.me, sessionId: 'ses_2', language: 'python', code: 'typeof secret' })
    expect(other.result).toBe('"undefined"')
    expect(t.rt.envs()).toHaveLength(1)
    expect(t.rt.kernelsStarted).toBe(2)
    // Another employee gets a container of its own.
    await t.sandbox.run({ employeeId: t.other, sessionId: 'ses_3', language: 'python', code: '1' })
    expect(t.rt.envs()).toHaveLength(2)
  })

  it('truncate long output, saying how much was cut', async () => {
    const t = await setup({ sandbox: { maxOutputChars: 1000 } })
    const r = await t.run('print("x".repeat(3000)); raw("y".repeat(10)); "z".repeat(1500)')
    expect(r.stdout.startsWith('x'.repeat(1000))).toBe(true)
    expect(r.stdout).toMatch(/\[truncated: 2011 more characters\]$/)
    expect(r.result).toMatch(/\[truncated: \d+ more characters\]$/)
    expect(truncate('abc', 5)).toBe('abc')
    expect(truncate('abcdef', 3)).toBe('abc\n… [truncated: 3 more characters]')
  })

  it('pass raw output from subprocesses through', async () => {
    const t = await setup()
    const r = await t.run('raw("from a subprocess\\n"); rawErr("warning\\n"); print("printed"); 1')
    expect(r.stdout).toBe('printed\nfrom a subprocess\n')
    expect(r.stderr).toBe('warning\n')
    expect(r.result).toBe('1')
  })

  it('stop idle kernels, then idle containers, and come back on the next run', async () => {
    const t = await setup()
    await t.run('var x = 1')
    t.clock.advance(DEFAULT_IDLE_MS - 1)
    expect(await t.sandbox.reapIdle()).toEqual({ kernels: 0, containers: 0 })
    t.clock.advance(2)
    expect(await t.sandbox.reapIdle()).toEqual({ kernels: 1, containers: 1 })
    expect(t.rt.running()).toBe(0)
    expect(t.rt.envs()).toHaveLength(0)
    expect(t.sandbox.hasSession('ses_1')).toBe(false)
    expect((await t.run('typeof x')).result).toBe('"undefined"')
    expect(t.rt.envs()).toHaveLength(1)
  })

  it('reset a session and end it', async () => {
    const t = await setup()
    await t.run('var x = 1')
    await t.run('1', { language: 'node' })
    expect(await t.sandbox.reset('ses_1', 'node')).toEqual(['node'])
    expect((await t.run('x')).result).toBe('1')
    expect(await t.sandbox.reset('ses_1')).toEqual(['python'])
    expect((await t.run('typeof x')).result).toBe('"undefined"')
    await t.sandbox.endSession('ses_1')
    expect(t.sandbox.hasSession('ses_1')).toBe(false)
    expect(t.rt.running()).toBe(0)
    expect(await t.sandbox.reset('ses_1')).toEqual([])
  })

  it('recreate a dead container, and replace ones left by an earlier process', async () => {
    const t = await setup()
    await t.run('var x = 1')
    const first = t.rt.envs()[0]!.info.id
    t.rt.stop(first)
    const r = await t.run('typeof x')
    expect(r.notes?.join(' ')).toMatch(/container had stopped/)
    expect(r.result).toBe('"undefined"')
    const second = t.rt.envs()[0]!.info.id
    expect(second).not.toBe(first)

    // A new process (a restart) finds the old container and starts over.
    const again = createSandbox({ runtime: t.rt, files: t.files, image: 'mp-sandbox:test', reapIntervalMs: 0 })
    await again.run({ employeeId: t.me, sessionId: 'ses_9', language: 'python', code: '1' })
    expect(t.rt.envs().map((e) => e.info.id)).not.toContain(second)
    expect(t.rt.envs()).toHaveLength(1)
  })

  it('validate the language and the code', async () => {
    const t = await setup()
    expect(() => t.run('1', { language: 'ruby' as never })).toThrow(ValidationError)
    expect(() => t.run(42 as never)).toThrow(ValidationError)
  })

  it('clamp timeouts to the allowed range', async () => {
    const t = await setup()
    const r = await t.run('hang()', { timeoutMs: 1 })
    expect(r.error).toMatch(/after 1 s/)
  })

  it('shut down cleanly', async () => {
    const t = await setup()
    await t.run('1')
    await t.sandbox.close()
    expect(t.rt.running()).toBe(0)
    expect(t.rt.envs()).toHaveLength(0)
  })

  it('name containers readably and within limits', () => {
    expect(sandboxName('billing-bot', 'emp_1')).toBe('billing-bot-sandbox')
    const long = sandboxName('a'.repeat(80), 'emp_1')
    expect(long.length).toBeLessThanOrEqual(45)
    expect(long).toMatch(/-[0-9a-f]{6}-sandbox$/)
    expect(sandboxName('***', 'EMP_X')).toBe('emp-x-sandbox')
  })
})

describe('files, copied in and out', () => {
  it('uses copy mode without a files volume, or when subpaths are not supported', async () => {
    expect(await (await setup()).sandbox.mode()).toBe('copy')
    const t = await setup({ mount: true, subpaths: false })
    expect(await t.sandbox.mode()).toBe('copy')
    expect(t.log.lines.some((l) => l.msg.includes('copied in and out'))).toBe(true)
  })

  it('copies files in, and what a cell creates, changes and deletes back out', async () => {
    const t = await setup()
    await t.storage.write(t.me, '/data/in.csv', text('a,b\n1,2\n'))
    await t.storage.write(t.me, '/old.txt', text('old'))
    const r1 = await t.run('read("data/in.csv")')
    expect(r1.result).toBe(JSON.stringify('a,b\n1,2\n'))
    expect(r1.files_changed).toEqual([])
    const env = t.rt.envs()[0]!
    expect(env.files.get('/work/files/data/in.csv')).toMatchObject({ uid: 1000, gid: 1000, mode: 0o644 })

    const r2 = await t.run('write("out/chart.png", "PNG"); write("data/in.csv", "a,b\\n1,3\\n"); remove("old.txt")')
    expect(r2.files_changed).toEqual([
      { path: '/data/in.csv', change: 'modified', size: 8 },
      { path: '/old.txt', change: 'deleted' },
      { path: '/out/chart.png', change: 'created', size: 3 },
    ])
    expect(str(await t.storage.read(t.me, '/out/chart.png'))).toBe('PNG')
    expect(str(await t.storage.read(t.me, '/data/in.csv'))).toBe('a,b\n1,3\n')
    expect(await t.storage.stat(t.me, '/old.txt')).toBeNull()
    await t.bus.idle()
    expect(t.changes.map((c) => [c.op, c.path, c.actor?.id])).toEqual([
      ['write', '/data/in.csv', 'ses_1'],
      ['delete', '/old.txt', 'ses_1'],
      ['write', '/out/chart.png', 'ses_1'],
    ])
  })

  it('copies only what changed since the last cell, and removes what was deleted outside', async () => {
    const t = await setup()
    await t.storage.write(t.me, '/a.txt', text('a'))
    await t.storage.write(t.me, '/b.txt', text('b'))
    const copied: string[][] = []
    const copyIn = t.rt.copyIn.bind(t.rt)
    t.rt.copyIn = async (id, dir, entries) => {
      copied.push(entries.filter((e) => e.type === 'file').map((e) => `${dir}/${e.path}`))
      return copyIn(id, dir, entries)
    }
    await t.run('1')
    expect(copied.flat()).toEqual(['/work/files/a.txt', '/work/files/b.txt'])
    copied.length = 0
    await t.run('2')
    expect(copied.flat()).toEqual([])
    await t.files.write(t.me, '/b.txt', 'b2')
    await t.files.delete(t.me, '/a.txt')
    const r = await t.run('Promise.all([read("b.txt"), read("a.txt").then(() => "there", () => "gone")])')
    expect(copied.flat()).toEqual(['/work/files/b.txt'])
    expect(r.result).toBe("[ 'b2', 'gone' ]")
    expect(t.rt.readFile(t.rt.envs()[0]!.info.id, '/work/files/a.txt')).toBeNull()
    expect(r.files_changed).toEqual([])
  })

  it('shows shares read-only under /work/shared/<owner>, refusing writes', async () => {
    const t = await setup()
    await t.storage.write(t.other, '/reports/q3.md', text('q3'))
    await t.storage.write(t.other, '/private.md', text('no'))
    await t.files.share(t.other, '/reports', t.meC, 'write')
    const r = await t.run(`read("/work/shared/${t.other}/reports/q3.md")`)
    expect(r.result).toBe('"q3"')
    expect(t.rt.readFile(t.rt.envs()[0]!.info.id, `/work/shared/${t.other}/private.md`)).toBeNull()
    const w = await t.run(`write("/work/shared/${t.other}/reports/q3.md", "hacked")`)
    expect(w.error).toMatch(/EACCES/)
    expect(str(await t.storage.read(t.other, '/reports/q3.md'))).toBe('q3')
    // Changes on the owner's side show up at the next cell; unsharing removes them.
    await t.storage.write(t.other, '/reports/q4.md', text('q4'))
    expect((await t.run(`read("/work/shared/${t.other}/reports/q4.md")`)).result).toBe('"q4"')
    await t.files.unshare(t.other, '/reports', t.meC)
    await t.run('1')
    expect(t.rt.readFile(t.rt.envs()[0]!.info.id, `/work/shared/${t.other}/reports/q3.md`)).toBeNull()
  })

  it('skips files over the size limit, both ways, with a note', async () => {
    const t = await setup({ sandbox: { maxFileBytes: 10 } })
    await t.storage.write(t.me, '/big.bin', text('x'.repeat(50)))
    const r = await t.run('write("huge.txt", "y".repeat(100)); write("small.txt", "ok")')
    expect(r.notes?.join(' ')).toMatch(/big.bin is too large to copy into the sandbox/)
    expect(r.files_changed).toEqual([
      { path: '/huge.txt', change: 'skipped', size: 100, note: 'larger than 10 bytes, not saved to your files' },
      { path: '/small.txt', change: 'created', size: 2 },
    ])
    expect(await t.storage.stat(t.me, '/huge.txt')).toBeNull()
  })

  it('keeps a file deleted in the sandbox when it changed outside meanwhile', async () => {
    const t = await setup()
    await t.storage.write(t.me, '/keep.txt', text('v1'))
    await t.run('1')
    const cell = t.run('remove("keep.txt"); sleep(40)')
    await new Promise((r) => setTimeout(r, 10))
    await t.files.write(t.me, '/keep.txt', 'v2') // e.g. fs.write from another session
    const r = await cell
    expect(r.files_changed).toEqual([
      { path: '/keep.txt', change: 'skipped', note: 'changed outside the sandbox since, so it was kept' },
    ])
    expect(str(await t.storage.read(t.me, '/keep.txt'))).toBe('v2')
    // And it's back in the sandbox for the next cell.
    expect((await t.run('read("keep.txt")')).result).toBe('"v2"')
  })
})

describe('files, mounted from the volume', () => {
  it('mounts own files and each share through volume subpaths', async () => {
    const t = await setup({ mount: true })
    await t.storage.write(t.other, '/reports/q3.md', text('q3'))
    await t.storage.write(t.other, '/notes/n.md', text('n'))
    await t.files.share(t.other, '/reports', t.meC, 'read')
    await t.files.share(t.other, '/notes', t.meC, 'write')
    await t.files.share(t.other, '/gone', t.meC, 'read')
    expect(await t.sandbox.mode()).toBe('mount')
    await t.run('1')
    const spec = t.rt.envs()[0]!.spec
    expect(spec.volumeMounts).toEqual([
      { volume: 'mp-files', subpath: t.me, containerPath: '/work/files' },
      { volume: 'mp-files', subpath: `${t.other}/notes`, containerPath: `/work/shared/${t.other}/notes`, readOnly: false },
      { volume: 'mp-files', subpath: `${t.other}/reports`, containerPath: `/work/shared/${t.other}/reports`, readOnly: true },
    ])
    expect(spec.labels?.['mp.sandbox.mounts']).toMatch(/^[0-9a-f]{16}$/)
  })

  it('writes land in storage directly and are reported from a before/after scan', async () => {
    const t = await setup({ mount: true })
    await t.storage.write(t.me, '/in.txt', text('in'))
    await t.storage.write(t.other, '/notes/n.md', text('n'))
    await t.storage.write(t.other, '/reports/q3.md', text('q3'))
    await t.files.share(t.other, '/notes', t.meC, 'write')
    await t.files.share(t.other, '/reports', t.meC, 'read')
    const r = await t.run(
      `write("chart.png", "PNG"); remove("in.txt"); write("/work/shared/${t.other}/notes/n.md", "edited"); read("/work/shared/${t.other}/reports/q3.md")`,
    )
    expect(r.result).toBe('"q3"')
    expect(r.files_changed).toEqual([
      { path: '/chart.png', change: 'created', size: 3 },
      { path: '/in.txt', change: 'deleted' },
      { path: `/shared/${t.other}/notes/n.md`, change: 'modified', size: 6 },
    ])
    expect(str(await t.storage.read(t.other, '/notes/n.md'))).toBe('edited')
    const ro = await t.run(`write("/work/shared/${t.other}/reports/q3.md", "hacked")`)
    expect(ro.error).toMatch(/EROFS/)
    expect(str(await t.storage.read(t.other, '/reports/q3.md'))).toBe('q3')
    await t.bus.idle()
    expect(t.changes.map((c) => [c.ownerEmployeeId, c.op, c.path])).toEqual([
      [t.me, 'write', '/chart.png'],
      [t.me, 'delete', '/in.txt'],
      [t.other, 'write', '/notes/n.md'],
    ])
    // Nothing is copied in mount mode.
    expect(t.rt.envs()[0]!.files.has('/work/files/chart.png')).toBe(false)
  })

  it('recreates the container when shares change, saying so', async () => {
    const t = await setup({ mount: true })
    await t.storage.write(t.other, '/reports/q3.md', text('q3'))
    await t.run('var x = 1')
    const first = t.rt.envs()[0]!.info.id
    expect((await t.run('x')).notes).toBeUndefined()
    await t.files.share(t.other, '/reports', t.meC, 'read')
    const r = await t.run(`typeof x`)
    expect(r.notes?.join(' ')).toMatch(/files shared with you or your network access changed, so the sandbox restarted/)
    expect(r.result).toBe('"undefined"')
    expect(t.rt.envs()[0]!.info.id).not.toBe(first)
    expect(t.rt.envs()[0]!.spec.volumeMounts).toHaveLength(2)
  })

  it('waits for other sessions to finish before recreating for a share change', async () => {
    const t = await setup({ mount: true })
    await t.storage.write(t.other, '/reports/q3.md', text('q3'))
    await t.run('1')
    const slow = t.sandbox.run({ employeeId: t.me, sessionId: 'ses_2', language: 'python', code: 'sleep(60)' })
    await new Promise((r) => setTimeout(r, 10))
    await t.files.share(t.other, '/reports', t.meC, 'read')
    const r = await t.run('2')
    expect(r.notes?.join(' ')).toMatch(/applies once the sandbox is idle/)
    await slow
    const later = await t.run('3')
    expect(later.notes?.join(' ')).toMatch(/sandbox restarted/)
  })
})
