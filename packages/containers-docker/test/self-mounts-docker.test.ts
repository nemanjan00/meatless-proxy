/**
 * Against a real Docker daemon (opt-in: `MP_DOCKER_TEST=1`). When the harness runs in a container,
 * a checkout lives at a path inside it (`/data/worktrees/…`), not on the host: an environment must
 * get the volume or host directory behind that path, not an empty bind of a path the host doesn't have.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { afterAll, describe, expect, it } from 'vitest'
import { dockerRuntime } from '../src/index.ts'

const ENABLED = process.env.MP_DOCKER_TEST === '1'
const IMAGE = 'alpine:3'
const PREFIX = `mp-itest-${randomBytes(3).toString('hex')}-`

describe.skipIf(!ENABLED)('mounts of paths inside the harness container', () => {
  const docker = new Docker()
  const cleanup: (() => Promise<unknown>)[] = []
  afterAll(async () => {
    for (const f of cleanup.reverse()) await f().catch(() => undefined)
  })

  /** A stand-in for the harness container: `mount` at /data, running `setup`, then kept running. */
  const standIn = async (name: string, mount: Record<string, unknown>, setup = 'true') => {
    const c = await docker.createContainer({
      name,
      Image: IMAGE,
      Cmd: ['sh', '-c', `${setup} && sleep 600`],
      HostConfig: { Mounts: [mount as never] },
    })
    cleanup.push(() => c.remove({ force: true }))
    await c.start()
    return c
  }
  it('mounts a path under a named volume of the harness container as that volume, at its subpath', async () => {
    const volume = `${PREFIX}data`
    await docker.createVolume({ Name: volume })
    cleanup.push(() => docker.getVolume(volume).remove({ force: true }))
    await standIn(
      `${PREFIX}self-vol`,
      { Type: 'volume', Source: volume, Target: '/data' },
      'mkdir -p /data/worktrees/x && echo hello-from-volume > /data/worktrees/x/hello.txt',
    )
    await new Promise((r) => setTimeout(r, 1500))

    const runtime = dockerRuntime({ namePrefix: PREFIX, selfContainer: `${PREFIX}self-vol` })
    const env = await runtime.createEnv({
      name: 'vol-env',
      image: IMAGE,
      mounts: [{ hostPath: '/data/worktrees/x', containerPath: '/workspace' }],
    })
    cleanup.push(() => runtime.destroyEnv(env.id))
    const r = await runtime.exec(env.id, ['cat', '/workspace/hello.txt'])
    expect(r.stdout.trim()).toBe('hello-from-volume')
  }, 120_000)

  it('mounts a path under a bind mount of the harness container at the host directory behind it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-itest-bind-'))
    cleanup.push(async () => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, 'worktrees', 'y'), { recursive: true })
    writeFileSync(join(dir, 'worktrees', 'y', 'hello.txt'), 'hello-from-bind\n')
    await standIn(`${PREFIX}self-bind`, { Type: 'bind', Source: dir, Target: '/data' })

    const runtime = dockerRuntime({ namePrefix: PREFIX, selfContainer: `${PREFIX}self-bind` })
    const env = await runtime.createEnv({
      name: 'bind-env',
      image: IMAGE,
      mounts: [{ hostPath: '/data/worktrees/y', containerPath: '/workspace' }],
    })
    cleanup.push(() => runtime.destroyEnv(env.id))
    const r = await runtime.exec(env.id, ['cat', '/workspace/hello.txt'])
    expect(r.stdout.trim()).toBe('hello-from-bind')
  }, 120_000)

  it('keeps an image with its own entrypoint running for exec (alpine/git has entrypoint git)', async () => {
    const runtime = dockerRuntime({ namePrefix: PREFIX })
    const env = await runtime.createEnv({ name: 'entrypoint-env', image: 'alpine/git:latest' })
    cleanup.push(() => runtime.destroyEnv(env.id))
    const r = await runtime.exec(env.id, ['git', '--version'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/git version/)
  }, 180_000)
})
