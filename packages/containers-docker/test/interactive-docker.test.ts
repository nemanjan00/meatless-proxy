import { ValidationError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { apiAtLeast, dockerRuntime } from '../src/index.ts'
import { packTar, unpackTar } from '../src/tar.ts'
import { MockDocker } from './mock-docker.ts'

const sandboxSpec = {
  name: 'bot-sandbox',
  image: 'mp-sandbox:test',
  user: '1000:1000',
  readOnlyRootfs: true,
  volumes: ['/work'],
  tmpfs: { '/tmp': { sizeMb: 128 } },
  volumeMounts: [
    { volume: 'mp-files', subpath: 'emp_1', containerPath: '/work/files' },
    { volume: 'mp-files', subpath: 'emp_2/reports', containerPath: '/work/shared/emp_2/reports', readOnly: true },
  ],
  limits: { cpus: 1, memoryMb: 512, pids: 128 },
}

const setup = async () => {
  const docker = new MockDocker()
  docker.images.add('mp-sandbox:test')
  const rt = dockerRuntime({ docker })
  return { docker, rt }
}

describe('hardened environments', () => {
  it('maps user, read-only root, tmpfs, fresh volumes, volume subpaths and the pids limit', async () => {
    const { docker, rt } = await setup()
    await rt.createEnv(sandboxSpec)
    const main = docker
      .callsTo('createContainer')
      .map((a) => a[0] as any)
      .find((o) => o.name === 'mp-bot-sandbox')
    expect(main.User).toBe('1000:1000')
    expect(main.Volumes).toBeUndefined()
    expect(main.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=128m' },
      PidsLimit: 128,
      NanoCpus: 1e9,
      Memory: 512 * 1024 * 1024,
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true'],
      Mounts: [
        // A fresh anonymous volume, labelled with the environment and the deployment.
        {
          Type: 'volume',
          Target: '/work',
          VolumeOptions: {
            Labels: expect.objectContaining({ 'mp.deployment': 'mp-', 'mp.managed': 'true', 'mp.env': 'bot-sandbox' }),
          },
        },
        {
          Type: 'volume',
          Source: 'mp-files',
          Target: '/work/files',
          ReadOnly: false,
          VolumeOptions: { NoCopy: true, Subpath: 'emp_1' },
        },
        {
          Type: 'volume',
          Source: 'mp-files',
          Target: '/work/shared/emp_2/reports',
          ReadOnly: true,
          VolumeOptions: { NoCopy: true, Subpath: 'emp_2/reports' },
        },
      ],
    })
    // No Docker socket, no host paths.
    expect(main.HostConfig.Binds).toEqual([])
  })

  it('mounts only mp-* volumes, with safe subpaths, and needs a daemon that supports subpaths', async () => {
    const { docker, rt } = await setup()
    await expect(
      rt.createEnv({ ...sandboxSpec, volumeMounts: [{ volume: 'postgres-data', containerPath: '/x' }] }),
    ).rejects.toThrow(/only volumes named mp-\*/)
    await expect(
      rt.createEnv({ ...sandboxSpec, volumeMounts: [{ volume: 'mp-files', subpath: '../etc', containerPath: '/x' }] }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(rt.createEnv({ ...sandboxSpec, user: 'root; rm -rf' })).rejects.toThrow(/bad user/)
    await expect(rt.createEnv({ ...sandboxSpec, tmpfs: { tmp: {} } })).rejects.toThrow(/bad container path/)
    docker.apiVersion = '1.44'
    const old = dockerRuntime({ docker })
    expect(await old.features!()).toEqual({ volumeSubpath: false, desktop: true })
    await expect(old.createEnv(sandboxSpec)).rejects.toThrow(/Docker Engine 26/)
    expect(docker.callsTo('createContainer')).toEqual([])
  })

  it('reports features once per runtime, and compares API versions numerically', async () => {
    const { docker, rt } = await setup()
    expect(await rt.features!()).toEqual({ volumeSubpath: true, desktop: true })
    await rt.features!()
    expect(docker.callsTo('version')).toHaveLength(1)
    expect(apiAtLeast('1.45', '1.45')).toBe(true)
    expect(apiAtLeast('1.100', '1.45')).toBe(true)
    expect(apiAtLeast('1.9', '1.45')).toBe(false)
    expect(apiAtLeast('2.0', '1.45')).toBe(true)
    expect(apiAtLeast(undefined, '1.45')).toBe(false)
  })
})

describe('copyIn and copyOut', () => {
  it('round-trips files, directories, owners and modes through the archive API', async () => {
    const { docker, rt } = await setup()
    const env = await rt.createEnv({ name: 'copy', image: 'mp-sandbox:test' })
    const c = [...docker.containers.values()].find((x) => x.name === 'mp-copy')!
    c.files.set('/work', { path: '/work', type: 'dir' })
    await rt.copyIn!(env.id, '/work', [
      { path: 'files', type: 'dir', uid: 1000, gid: 1000 },
      { path: 'files/a.txt', type: 'file', content: new TextEncoder().encode('hello'), uid: 1000, gid: 1000, mode: 0o640 },
      { path: `files/${'deep/'.repeat(30)}long.txt`, type: 'file', content: new TextEncoder().encode('long') },
    ])
    const out = await rt.copyOut!(env.id, '/work/files')
    expect(out.map((e) => e.path)).toEqual(['files', 'files/a.txt', `files/${'deep/'.repeat(30)}long.txt`])
    const a = out.find((e) => e.path === 'files/a.txt')!
    expect(new TextDecoder().decode(a.content)).toBe('hello')
    expect(a).toMatchObject({ uid: 1000, gid: 1000, mode: 0o640, type: 'file' })
    expect(await rt.copyOut!(env.id, '/work/missing')).toEqual([])
    await expect(rt.copyIn!(env.id, '/nowhere', [{ path: 'x', type: 'file' }])).rejects.toThrow()
    await expect(rt.copyIn!(env.id, '/work', [{ path: '../x', type: 'file' }])).rejects.toBeInstanceOf(ValidationError)
    await expect(rt.copyIn!(env.id, 'work', [])).rejects.toBeInstanceOf(ValidationError)
  })

  it('packs and unpacks tar, including long names', () => {
    const long = `${'x'.repeat(120)}/${'y'.repeat(90)}.txt`
    const tar = packTar([
      { path: 'd', type: 'dir', mode: 0o555 },
      { path: long, type: 'file', content: new Uint8Array([1, 2, 3]), mtimeMs: 1_790_000_000_000 },
    ])
    expect(tar.length % 512).toBe(0)
    const back = unpackTar(tar)
    expect(back.map((e) => [e.path, e.type])).toEqual([
      ['d', 'dir'],
      [long, 'file'],
    ])
    expect(back[0]!.mode).toBe(0o555)
    expect([...back[1]!.content!]).toEqual([1, 2, 3])
    expect(back[1]!.mtimeMs).toBe(1_790_000_000_000)
  })
})

describe('spawn', () => {
  it('runs an interactive process: stdin in, output out, pid marker hidden, exit code', async () => {
    const { docker, rt } = await setup()
    const env = await rt.createEnv({ name: 'repl', image: 'mp-sandbox:test' })
    docker.execHandler = (cmd) => {
      if (cmd[0] === 'sh' && cmd[2]?.startsWith('echo "mp-pid-')) {
        const marker = /echo "(mp-pid-[0-9a-f]+:)/.exec(cmd[2])![1]!
        return {
          interactive: (io) => {
            io.send('stderr', `${marker}4242\nwarming up\n`)
            io.onInput((t) => io.send('stdout', t.toUpperCase()))
            io.onStdinEnd(() => io.end(3))
          },
        }
      }
      return { exitCode: 0 }
    }
    const chunks: { stream: string; text: string }[] = []
    const p = await rt.spawn!(env.id, ['python3', '-i'], { onOutput: (c) => chunks.push(c), workdir: '/work' })
    const exec = docker.callsTo('container.exec').at(-1)![1] as any
    expect(exec).toMatchObject({ AttachStdin: true, WorkingDir: '/work' })
    expect(exec.Cmd.slice(3)).toEqual(['sh', 'python3', '-i'])
    await p.write('print(1)\n')
    await new Promise((r) => setTimeout(r, 20))
    p.end()
    expect(await p.exited).toEqual({ exitCode: 3 })
    expect(
      chunks
        .filter((c) => c.stream === 'stdout')
        .map((c) => c.text)
        .join(''),
    ).toBe('PRINT(1)\n')
    const err = chunks
      .filter((c) => c.stream === 'stderr')
      .map((c) => c.text)
      .join('')
    expect(err).toBe('warming up\n')
    await expect(p.write('more')).rejects.toThrow(/ended/)
  })

  it('kills the process (and its group) by the pid it reported', async () => {
    const { docker, rt } = await setup()
    const env = await rt.createEnv({ name: 'hang', image: 'mp-sandbox:test' })
    const kills: string[][] = []
    docker.execHandler = (cmd) => {
      if (cmd[2]?.startsWith('echo "mp-pid-')) {
        const marker = /echo "(mp-pid-[0-9a-f]+:)/.exec(cmd[2])![1]!
        return { interactive: (io) => io.send('stderr', `${marker}77\n`) }
      }
      if (cmd.join(' ').includes('kill -KILL')) kills.push(cmd)
      return { exitCode: 0 }
    }
    const p = await rt.spawn!(env.id, ['node', 'driver.js'])
    await p.kill()
    expect(await p.exited).toEqual({ exitCode: null })
    expect(kills).toHaveLength(1)
    expect(kills[0]!.at(-1)).toBe('77')
    await p.kill() // idempotent
    expect(kills).toHaveLength(1)
  })
})
