import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecAbortedError, TIMEOUT_EXIT_CODE } from '@mp/containers'
import { ConflictError, DeniedError, NotFoundError, UnavailableError, ValidationError, memoryLogger } from '@mp/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { NotImplementedError, demuxBuffer, dockerRuntime, mapError } from '../src/index.ts'
import { HttpError, MockDocker, frame } from './mock-docker.ts'

let docker: MockDocker
const rt = () => dockerRuntime({ docker, labels: { 'mp.instance': 'test' } })

beforeEach(() => {
  docker = new MockDocker()
})

const spec = {
  name: 'ses-abc',
  image: 'node:22',
  mounts: [
    { hostPath: '/data/wt/ses-abc', containerPath: '/src' },
    { hostPath: '/data/cache', containerPath: '/cache', readOnly: true },
  ],
  env: { CI: '1' },
  workdir: '/src',
  limits: { cpus: 1.5, memoryMb: 512 },
  labels: { session: 'ses_1' },
  services: [{ name: 'db', image: 'postgres:18', env: { POSTGRES_PASSWORD: 'test' } }],
}

describe('createEnv', () => {
  it('pulls missing images, creates an internal network, services and the main container', async () => {
    const env = await rt().createEnv(spec)
    expect(env).toMatchObject({ id: 'mp-ses-abc', name: 'ses-abc', status: 'running' })
    expect(env.labels).toMatchObject({
      'mp.env': 'ses-abc',
      'mp.managed': 'true',
      'mp.role': 'main',
      session: 'ses_1',
      'mp.instance': 'test',
    })

    expect(docker.callsTo('pull').map((a) => a[0])).toEqual(['node:22', 'postgres:18'])
    const [net] = docker.callsTo('createNetwork')[0] as [Record<string, any>]
    expect(net).toMatchObject({ Name: 'mp-ses-abc', Internal: true, Labels: { 'mp.env': 'ses-abc', 'mp.managed': 'true' } })

    const created = docker.callsTo('createContainer').map((a) => a[0] as Record<string, any>)
    expect(created.map((c) => c.name)).toEqual(['mp-ses-abc-db', 'mp-ses-abc'])
    const [db, main] = created as [Record<string, any>, Record<string, any>]
    expect(db.NetworkingConfig.EndpointsConfig['mp-ses-abc'].Aliases).toEqual(['db'])
    expect(db.Env).toEqual(['POSTGRES_PASSWORD=test'])
    expect(db.Labels).toMatchObject({ 'mp.role': 'service', 'mp.service': 'db', 'mp.env': 'ses-abc' })
    expect(db.HostConfig).toMatchObject({ Privileged: false, NetworkMode: 'mp-ses-abc' })

    expect(main).toMatchObject({
      Image: 'node:22',
      Cmd: ['sleep', 'infinity'],
      WorkingDir: '/src',
      Env: ['CI=1'],
    })
    expect(main.User).toBeUndefined()
    expect(main.HostConfig).toMatchObject({
      Privileged: false,
      NetworkMode: 'mp-ses-abc',
      Binds: ['/data/wt/ses-abc:/src', '/data/cache:/cache:ro'],
      NanoCpus: 1_500_000_000,
      Memory: 512 * 1024 * 1024,
      SecurityOpt: ['no-new-privileges:true'],
    })
    expect(main.HostConfig.CapDrop).toContain('NET_RAW')
    expect(main.HostConfig.NetworkMode).not.toBe('host')
    expect(main.HostConfig.CapAdd).toBeUndefined()
    expect(docker.callsTo('container.start')).toHaveLength(2)
  })

  it('skips pulling present images, honours allowInternet and a custom command', async () => {
    docker.images.add('node:22')
    await rt().createEnv({ name: 'e1', image: 'node:22', allowInternet: true, command: ['node', 'server.js'] })
    expect(docker.callsTo('pull')).toEqual([])
    expect((docker.callsTo('createNetwork')[0]![0] as any).Internal).toBe(false)
    expect((docker.callsTo('createContainer')[0]![0] as any).Cmd).toEqual(['node', 'server.js'])
  })

  it('builds from a local context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-ctx-'))
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n')
    mkdirSync(join(dir, 'src'))
    try {
      const env = await rt().createEnv({ name: 'Built', build: { context: dir, dockerfile: 'Dockerfile' } })
      const [file, opts] = docker.callsTo('buildImage')[0] as [any, any]
      expect(file.context).toBe(dir)
      expect(file.src.sort()).toEqual(['Dockerfile', 'src'])
      expect(opts).toMatchObject({ t: 'mp-build/built:latest', dockerfile: 'Dockerfile' })
      expect((docker.callsTo('createContainer')[0]![0] as any).Image).toBe('mp-build/built:latest')
      expect(env.status).toBe('running')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses remote build contexts clearly', async () => {
    await expect(rt().createEnv({ name: 'x', build: { context: 'https://example.com/repo.git' } })).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })

  it('validates the spec', async () => {
    const r = rt()
    await expect(r.createEnv({ name: 'bad name!', image: 'x' })).rejects.toBeInstanceOf(ValidationError)
    await expect(r.createEnv({ name: 'x' })).rejects.toBeInstanceOf(ValidationError)
    await expect(
      r.createEnv({ name: 'x', image: 'i', mounts: [{ hostPath: 'rel', containerPath: '/a' }] }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      r.createEnv({ name: 'x', image: 'i', mounts: [{ hostPath: '/a:/etc', containerPath: '/a' }] }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(r.createEnv({ name: 'x', image: 'i', env: { 'A=B': '1' } })).rejects.toBeInstanceOf(ValidationError)
    await expect(r.createEnv({ name: 'x', image: 'i', limits: { cpus: 0 } })).rejects.toBeInstanceOf(ValidationError)
    expect(docker.callsTo('createContainer')).toEqual([])
  })

  it('rejects a name that is already in use', async () => {
    await rt().createEnv({ name: 'dup', image: 'i' })
    await expect(rt().createEnv({ name: 'dup', image: 'i' })).rejects.toBeInstanceOf(ConflictError)
  })

  it('cleans up everything when a step fails', async () => {
    const logger = memoryLogger()
    docker.failures['container.start'] = new HttpError(500, 'oci runtime error')
    await expect(dockerRuntime({ docker, logger }).createEnv(spec)).rejects.toBeInstanceOf(UnavailableError)
    expect(docker.networks.size).toBe(0)
    expect([...docker.containers.values()].every((c) => c.removed)).toBe(true)
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('fails when a pull reports an error', async () => {
    docker.pullOutput = [{ error: 'manifest unknown', errorDetail: { message: 'manifest unknown' } }]
    await expect(rt().createEnv({ name: 'x', image: 'nope:1' })).rejects.toThrow(/manifest unknown/)
    expect(docker.networks.size).toBe(0)
  })
})

describe('getEnv / listEnvs', () => {
  it('finds managed environments by id and label', async () => {
    const r = rt()
    await r.createEnv({ name: 'a', image: 'i', labels: { session: 's1' } })
    await r.createEnv({ name: 'b', image: 'i', labels: { session: 's2' }, services: [{ name: 'redis', image: 'redis' }] })
    expect(await r.getEnv('mp-a')).toMatchObject({
      id: 'mp-a',
      name: 'a',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(await r.getEnv('mp-missing')).toBeNull()
    expect(await r.getEnv('mp-b-redis')).toBeNull() // a service container is not an environment
    const all = await r.listEnvs()
    expect(all.map((e) => e.id).sort()).toEqual(['mp-a', 'mp-b'])
    expect((await r.listEnvs({ session: 's2' })).map((e) => e.name)).toEqual(['b'])
    const filter = (docker.callsTo('listContainers').at(-1)![0] as any).filters.label
    expect(filter).toEqual(['mp.managed=true', 'mp.role=main', 'session=s2'])
  })

  it('reports stopped containers', async () => {
    const r = rt()
    await r.createEnv({ name: 'a', image: 'i' })
    docker.containers.forEach((c) => {
      c.running = false
    })
    expect((await r.getEnv('mp-a'))!.status).toBe('stopped')
    expect((await r.listEnvs())[0]!.status).toBe('stopped')
  })
})

describe('exec', () => {
  it('runs with hijack, demuxes stdout and stderr and returns the exit code', async () => {
    const r = rt()
    await r.createEnv({ name: 'a', image: 'i' })
    docker.execHandler = () => ({
      frames: [
        { stream: 'stdout', data: 'hello ' },
        { stream: 'stderr', data: 'warn\n' },
        { stream: 'stdout', data: 'world\n' },
      ],
      exitCode: 3,
    })
    const chunks: string[] = []
    const res = await r.exec('mp-a', ['npm', 'test'], {
      env: { FOO: 'bar' },
      workdir: '/src',
      onOutput: (c) => chunks.push(`${c.stream}:${c.text}`),
    })
    expect(res).toMatchObject({ exitCode: 3, stdout: 'hello world\n', stderr: 'warn\n', timedOut: false })
    expect(chunks.join('')).toContain('stderr:warn')
    expect(
      chunks
        .filter((c) => c.startsWith('stdout'))
        .map((c) => c.slice(7))
        .join(''),
    ).toBe('hello world\n')
    expect(docker.execs[0]!.opts).toMatchObject({
      Cmd: ['npm', 'test'],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Env: ['FOO=bar'],
      WorkingDir: '/src',
    })
    expect(docker.execs[0]!.opts.Privileged).toBeFalsy()
    expect(docker.callsTo('exec.start')[0]![0]).toMatchObject({ hijack: true, stdin: false })
    expect(docker.callsTo('modem.demuxStream')).toHaveLength(1)
  })

  it('keeps multi-byte characters split across frames intact', async () => {
    const r = rt()
    await r.createEnv({ name: 'a', image: 'i' })
    const text = Buffer.from('ünïcødé ✓')
    docker.execHandler = () => ({
      frames: [
        { stream: 'stdout', data: text.subarray(0, 2) },
        { stream: 'stdout', data: text.subarray(2) },
      ],
    })
    expect((await r.exec('mp-a', ['echo'])).stdout).toBe('ünïcødé ✓')
  })

  it('times out and abandons a hanging exec', async () => {
    const logger = memoryLogger()
    const r = dockerRuntime({ docker, logger })
    await r.createEnv({ name: 'a', image: 'i' })
    docker.execHandler = () => ({ frames: [{ stream: 'stdout', data: 'started\n' }], hang: true })
    const res = await r.exec('mp-a', ['sleep', '100'], { timeoutMs: 30 })
    expect(res).toMatchObject({ timedOut: true, exitCode: TIMEOUT_EXIT_CODE, stdout: 'started\n' })
    expect(res.durationMs).toBeGreaterThanOrEqual(25)
    expect(docker.execs[0]!.stream!.destroyed).toBe(true)
    expect(logger.lines.some((l) => l.msg.includes('timed out'))).toBe(true)
  })

  it('aborts on signal', async () => {
    const r = rt()
    await r.createEnv({ name: 'a', image: 'i' })
    docker.execHandler = () => ({ hang: true })
    const ac = new AbortController()
    const p = r.exec('mp-a', ['sleep', '100'], { signal: ac.signal })
    setTimeout(() => ac.abort(), 10)
    await expect(p).rejects.toBeInstanceOf(ExecAbortedError)
    await expect(r.exec('mp-a', ['ls'], { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(ExecAbortedError)
  })

  it('maps stream errors and missing or stopped environments', async () => {
    const r = rt()
    await r.createEnv({ name: 'a', image: 'i' })
    docker.execHandler = () => ({ streamError: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
    await expect(r.exec('mp-a', ['ls'])).rejects.toBeInstanceOf(UnavailableError)
    await expect(r.exec('mp-nope', ['ls'])).rejects.toBeInstanceOf(NotFoundError)
    docker.containers.forEach((c) => {
      c.running = false
    })
    await expect(r.exec('mp-a', ['ls'])).rejects.toBeInstanceOf(ConflictError)
    await expect(r.exec('mp-a', [])).rejects.toBeInstanceOf(ValidationError)
  })

  it('truncates huge output', async () => {
    const r = dockerRuntime({ docker, maxOutputBytes: 10 })
    await r.createEnv({ name: 'a', image: 'i' })
    docker.execHandler = () => ({ frames: [{ stream: 'stdout', data: 'x'.repeat(50) }] })
    const res = await r.exec('mp-a', ['yes'])
    expect(res.stdout.startsWith('x'.repeat(10) + '\n[output truncated')).toBe(true)
  })

  it('runs concurrent execs independently', async () => {
    const r = rt()
    await r.createEnv({ name: 'a', image: 'i' })
    docker.execHandler = (cmd) => ({ frames: [{ stream: 'stdout', data: cmd.join(' ') }], exitCode: cmd.length })
    const res = await Promise.all([r.exec('mp-a', ['a']), r.exec('mp-a', ['b', 'c'])])
    expect(res.map((x) => [x.stdout, x.exitCode])).toEqual([
      ['a', 1],
      ['b c', 2],
    ])
  })
})

describe('logs', () => {
  it('demuxes the multiplexed log buffer and passes tail', async () => {
    const r = rt()
    await r.createEnv({ name: 'a', image: 'i' })
    const main = [...docker.containers.values()].find((c) => c.name === 'mp-a')!
    main.logs = Buffer.concat([frame('stdout', 'line 1\n'), frame('stderr', 'oops\n')])
    expect(await r.logs('mp-a', { tail: 50 })).toBe('line 1\noops\n')
    expect(docker.callsTo('container.logs')[0]![1]).toMatchObject({ stdout: true, stderr: true, follow: false, tail: 50 })
    await expect(r.logs('mp-missing')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('passes plain text through', () => {
    expect(demuxBuffer(Buffer.from('plain tty output\n'))).toBe('plain tty output\n')
    expect(demuxBuffer(Buffer.alloc(0))).toBe('')
  })
})

describe('destroyEnv', () => {
  it('removes containers (with volumes) and the network, idempotently', async () => {
    const r = rt()
    await r.createEnv(spec)
    await r.createEnv({ name: 'other', image: 'i' })
    await r.destroyEnv('mp-ses-abc')
    const alive = [...docker.containers.values()].filter((c) => !c.removed).map((c) => c.name)
    expect(alive).toEqual(['mp-other'])
    expect([...docker.networks.keys()]).toEqual(['mp-other'])
    const removes = docker.callsTo('container.remove')
    expect(removes.every((a) => (a[1] as any).force === true && (a[1] as any).v === true)).toBe(true)
    await r.destroyEnv('mp-ses-abc')
    await r.destroyEnv('mp-never-existed')
    expect(await r.getEnv('mp-ses-abc')).toBeNull()
  })

  it('cleans up a half-created environment whose main container is gone', async () => {
    const r = rt()
    await r.createEnv(spec)
    docker.containers.get([...docker.containers.values()].find((c) => c.name === 'mp-ses-abc')!.id)!.removed = true
    await r.destroyEnv('mp-ses-abc')
    expect([...docker.containers.values()].every((c) => c.removed)).toBe(true)
    expect(docker.networks.size).toBe(0)
  })

  it('surfaces daemon errors', async () => {
    docker.failures.listContainers = Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
      code: 'ECONNREFUSED',
    })
    await expect(rt().destroyEnv('mp-x')).rejects.toBeInstanceOf(UnavailableError)
  })

  it("says what to fix when the app can't use the Docker socket, instead of retrying", async () => {
    docker.failures.createNetwork = Object.assign(new Error('connect EACCES /var/run/docker.sock'), {
      code: 'EACCES',
      syscall: 'connect',
    })
    docker.images.add('node:22')
    const err = await rt()
      .createEnv({ name: 'x', image: 'node:22' })
      .catch((e) => e)
    expect(err).toBeInstanceOf(DeniedError)
    expect(err.message).toMatch(/can't use the Docker socket \(permission denied\).*DOCKER_GID/)
    docker.failures.listContainers = Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' })
    const missing = await rt()
      .destroyEnv('mp-x')
      .catch((e) => e)
    expect(missing).toBeInstanceOf(ValidationError)
    expect(missing.message).toMatch(/Docker socket isn't there.*DOCKER_SOCKET/)
  })
})

describe('mapError', () => {
  it('maps status codes', () => {
    expect(mapError(new HttpError(404, 'x'), 'thing')).toBeInstanceOf(NotFoundError)
    expect(mapError(new HttpError(409, 'x'), 'thing')).toBeInstanceOf(ConflictError)
    expect(mapError(new HttpError(400, 'x'), 'thing')).toBeInstanceOf(ValidationError)
    expect(mapError(new HttpError(500, 'x'), 'thing')).toBeInstanceOf(UnavailableError)
    expect(mapError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'thing')).toBeInstanceOf(UnavailableError)
    expect(mapError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 'thing')).toBeInstanceOf(UnavailableError)
    expect(mapError(Object.assign(new Error('denied'), { code: 'EACCES' }), 'thing')).toBeInstanceOf(DeniedError)
    expect(mapError(Object.assign(new Error('denied'), { code: 'EPERM' }), 'thing')).toBeInstanceOf(DeniedError)
    expect(mapError(Object.assign(new Error('missing'), { code: 'ENOENT' }), 'thing')).toBeInstanceOf(ValidationError)
    const plain = new Error('other')
    expect(mapError(plain, 'thing')).toBe(plain)
  })
})
