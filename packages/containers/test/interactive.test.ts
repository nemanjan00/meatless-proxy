import { ConflictError, NotFoundError, ValidationError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { runtimeContract } from '../src/contract.ts'
import { fakeRuntime, invalidEntryPath, invalidVolumeMounts } from '../src/index.ts'

runtimeContract('fake', () => shared, { image: 'alpine:3' })
const shared = fakeRuntime()

describe('fake spawn', () => {
  it('lets a handler play the process, and counts running ones', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv({ name: 'k', image: 'x' })
    rt.onSpawn(/python3/, (host) => {
      host.stderr('ready\n')
      host.onInput((t) => (t.trim() === 'quit' ? host.exit(7) : host.stdout(`echo:${t}`)))
      host.onKill(() => host.env.logs.push('killed'))
    })
    const chunks: string[] = []
    const p = await rt.spawn(env.id, ['python3', '-u'], { onOutput: (c) => chunks.push(`${c.stream}:${c.text}`), workdir: '/w' })
    expect(rt.running()).toBe(1)
    expect(rt.spawns[0]).toMatchObject({ cmd: ['python3', '-u'], workdir: '/w' })
    await p.write('hi')
    await p.write('quit\n')
    expect(await p.exited).toEqual({ exitCode: 7 })
    expect(chunks).toEqual(['stderr:ready\n', 'stdout:echo:hi'])
    expect(rt.running()).toBe(0)
    await expect(p.write('x')).rejects.toBeInstanceOf(ConflictError)

    const q = await rt.spawn(env.id, ['python3'])
    await q.kill()
    expect(await q.exited).toEqual({ exitCode: null })
    expect(rt.envs()[0]!.logs).toEqual(['killed'])
  })

  it('refuses stopped and missing environments, and empty commands', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv({ name: 'k', image: 'x' })
    await expect(rt.spawn(env.id, [])).rejects.toBeInstanceOf(ValidationError)
    rt.stop(env.id)
    await expect(rt.spawn(env.id, ['cat'])).rejects.toBeInstanceOf(ConflictError)
    await expect(rt.spawn('nope', ['cat'])).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('fake filesystem', () => {
  it('starts with / and the volume and tmpfs paths, and lets tests act as a process would', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv({ name: 'k', image: 'x', volumes: ['/work'], tmpfs: { '/tmp': {} } })
    expect([...rt.envs()[0]!.files.keys()].sort()).toEqual(['/', '/tmp', '/work'])
    rt.writeFile(env.id, '/work/files/a.txt', 'a', { uid: 1000 })
    expect(rt.readFile(env.id, '/work/files/a.txt')).toBe('a')
    expect((await rt.copyOut(env.id, '/work/files')).map((e) => e.path)).toEqual(['files', 'files/a.txt'])
    rt.removeFile(env.id, '/work/files')
    expect(rt.readFile(env.id, '/work/files/a.txt')).toBeNull()
    await expect(rt.copyIn(env.id, '/missing', [])).rejects.toBeInstanceOf(NotFoundError)
  })

  it('gives distinct, increasing modification times even with a frozen clock', async () => {
    const rt = fakeRuntime({ clock: { now: () => 1000, iso: () => new Date(1000).toISOString() } })
    const env = await rt.createEnv({ name: 'k', image: 'x', volumes: ['/work'] })
    rt.writeFile(env.id, '/work/a', '1')
    const [first] = await rt.copyOut(env.id, '/work/a')
    rt.writeFile(env.id, '/work/a', '2')
    const [second] = await rt.copyOut(env.id, '/work/a')
    expect(second!.mtimeMs).toBeGreaterThan(first!.mtimeMs!)
  })
})

describe('volume mounts', () => {
  it('validates names, subpaths and container paths', async () => {
    expect(invalidVolumeMounts([{ volume: 'mp-files', subpath: 'emp_1/x', containerPath: '/work/files' }])).toEqual([])
    expect(invalidVolumeMounts([{ volume: 'bad name', containerPath: 'rel' }])).toHaveLength(2)
    expect(invalidVolumeMounts([{ volume: 'mp-files', subpath: '../x', containerPath: '/a' }])).toEqual(['bad subpath: ../x'])
    expect(invalidEntryPath('a/./b')).toMatch(/bad path/)
    expect(invalidEntryPath('a/b/')).toBeNull()
    const rt = fakeRuntime({ features: { volumeSubpath: false } })
    expect(await rt.features()).toMatchObject({ volumeSubpath: false })
    await expect(
      rt.createEnv({ name: 'k', image: 'x', volumeMounts: [{ volume: 'mp-files', subpath: 'e', containerPath: '/w' }] }),
    ).rejects.toThrow(/subpaths are not supported/)
    await expect(
      rt.createEnv({ name: 'k', image: 'x', volumeMounts: [{ volume: 'mp-files', containerPath: '/w' }] }),
    ).resolves.toBeTruthy()
  })
})
