/**
 * Against a real Docker daemon. Opt-in, because it pulls images and needs the
 * network: `MP_DOCKER_TEST=1 npx vitest run --project node packages/containers-docker`.
 *
 * It checks what the mock can't: that an environment really starts, that exec
 * really returns output and exit codes, that containers can't reach the
 * internet directly, that the egress proxy lets allowlisted hosts through and
 * refuses the rest, and that destroying an environment leaves nothing behind.
 */
import { randomBytes } from 'node:crypto'
import Docker from 'dockerode'
import { afterAll, describe, expect, it } from 'vitest'
import { dockerRuntime } from '../src/index.ts'

const ENABLED = process.env.MP_DOCKER_TEST === '1'
const IMAGE = 'alpine:3'
/** Has curl, which behaves like real tooling (npm, git) behind a proxy: CONNECT for HTTPS. */
const CURL_IMAGE = 'curlimages/curl:latest'
const PREFIX = `mp-itest-${randomBytes(3).toString('hex')}-`

describe.skipIf(!ENABLED)('docker runtime against a real daemon', () => {
  const docker = new Docker()
  const runtime = dockerRuntime({ namePrefix: PREFIX })
  const created: string[] = []

  afterAll(async () => {
    for (const id of created) await runtime.destroyEnv(id).catch(() => undefined)
  })

  /** Everything this test run left behind: containers and networks carrying our prefix. */
  const leftovers = async () => {
    const containers = await docker.listContainers({ all: true })
    const networks = await docker.listNetworks()
    return [
      ...containers.flatMap((c) => c.Names).filter((n) => n.replace(/^\//, '').startsWith(PREFIX)),
      ...networks.map((n) => n.Name).filter((n) => n.startsWith(PREFIX)),
    ]
  }

  it('starts an environment, runs commands, and cleans up completely', async () => {
    const env = await runtime.createEnv({ name: 'basic', image: IMAGE, env: { GREETING: 'hello' } })
    created.push(env.id)
    expect(env.status).toBe('running')

    const ok = await runtime.exec(env.id, [
      'sh',
      '-c',
      'echo "$GREETING from $(cat /etc/alpine-release | cut -d. -f1)"; echo oops >&2',
    ])
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toMatch(/^hello from 3/)
    expect(ok.stderr.trim()).toBe('oops')

    const fail = await runtime.exec(env.id, ['sh', '-c', 'exit 7'])
    expect(fail.exitCode).toBe(7)

    const slow = await runtime.exec(env.id, ['sleep', '30'], { timeoutMs: 500 })
    expect(slow.timedOut).toBe(true)

    // No network at all by default: not even DNS resolves.
    const net = await runtime.exec(env.id, ['sh', '-c', 'wget -q -T 3 -O- http://example.com >/dev/null 2>&1; echo $?'])
    expect(net.stdout.trim()).not.toBe('0')

    await runtime.destroyEnv(env.id)
    await runtime.destroyEnv(env.id) // idempotent
    expect(await runtime.getEnv(env.id)).toBeNull()
    expect(await leftovers()).toEqual([])
  }, 180_000)

  it('lets allowlisted hosts through the egress proxy, and nothing else', async () => {
    const env = await runtime.createEnv({
      name: 'egress',
      image: CURL_IMAGE,
      egress: { allow: ['example.com', 'example.com:443'] },
    })
    created.push(env.id)
    const run = (script: string) => runtime.exec(env.id, ['sh', '-c', script], { timeoutMs: 30_000 })

    // Through the proxy (HTTP_PROXY and HTTPS_PROXY are set for us): allowed.
    const allowed = await run('curl -s -m 10 http://example.com | head -c 300')
    expect(allowed.stdout).toMatch(/Example Domain/i)

    // Through the proxy: refused with 403.
    const blocked = await run('curl -s -m 10 -o /dev/null -w "%{http_code}" http://github.com')
    expect(blocked.stdout.trim()).toBe('403')

    // HTTPS via CONNECT: the allowed host tunnels, a blocked host is refused.
    const tls = await run('curl -s -m 10 https://example.com | head -c 300')
    expect(tls.stdout).toMatch(/Example Domain/i)
    const tlsBlocked = await run('curl -s -m 10 -o /dev/null -w "%{http_code}" https://github.com; echo " exit=$?"')
    expect(tlsBlocked.stdout).toMatch(/^(403|000) exit=(?!0)/)

    // Around the proxy: no direct route out.
    const direct = await run('curl -s -m 5 --noproxy "*" -o /dev/null http://example.com; echo $?')
    expect(direct.stdout.trim()).not.toBe('0')

    const log = (await runtime.egressLog?.(env.id)) ?? []
    expect(log.some((l) => l.host === 'example.com' && l.allowed)).toBe(true)
    expect(log.some((l) => l.host === 'github.com' && !l.allowed)).toBe(true)

    await runtime.destroyEnv(env.id)
    expect(await leftovers()).toEqual([])
  }, 300_000)
})
