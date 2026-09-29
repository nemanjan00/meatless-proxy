/**
 * Live previews against a real Docker daemon, through the real preview listener. Opt-in:
 * `MP_DOCKER_TEST=1 npx vitest run --project node packages/server/test/previews-docker.test.ts`.
 *
 * An environment runs `python3 -m http.server 8000` (started with env.exec, as an employee would),
 * exposes 8000, and a viewer opens it through the preview listener: token, cookie, proxied page.
 * The project container must not reach the harness's API or preview ports.
 */
import { randomBytes } from 'node:crypto'
import { newId } from '@mp/core'
import { dockerRuntime } from '@mp/containers-docker'
import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PREVIEW_COOKIE } from '../src/previews/index.ts'
import { testApp, type TestApp } from './helpers.ts'
import { freePort, rawRequest, setCookieOf } from './preview-helpers.ts'

const ENABLED = process.env.MP_DOCKER_TEST === '1'
const PREFIX = `mp-ptest-${randomBytes(3).toString('hex')}-`

describe.skipIf(!ENABLED)('live previews with real Docker', () => {
  const docker = new Docker()
  let t: TestApp & { port: number | null }
  let pp: number
  let envId: string
  let tool: (name: string, args: unknown) => Promise<any>

  const leftovers = async () => {
    const containers = await docker.listContainers({ all: true })
    const networks = await docker.listNetworks()
    return [
      ...containers.flatMap((c) => c.Names).filter((n) => n.replace(/^\//, '').startsWith(PREFIX)),
      ...networks.map((n) => n.Name).filter((n) => n.startsWith(PREFIX)),
    ]
  }

  beforeAll(async () => {
    pp = await freePort()
    t = await testApp({
      http: true,
      env: { PREVIEW_PORT: String(pp) },
      overrides: { containers: dockerRuntime({ namePrefix: PREFIX }) },
    })
    const s = t.a.services
    const employee = (await s.directory.employees.byHandle('meatless'))!
    const ses = await s.sessions.create({ employeeId: employee.id, title: 'Python page' })
    tool = async (name, args) => {
      const callId = newId('call')
      const r = await s.tools.execute(name, args, {
        employeeId: employee.id,
        sessionId: ses.id,
        runId: 'run_docker',
        callId,
        idempotencyKey: `run_docker:0:${callId}`,
        secrets: {},
        signal: new AbortController().signal,
        logger: s.logger,
        clock: s.clock,
        emit: () => {},
      })
      if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.output)}`)
      return r.output
    }
  }, 60_000)

  afterAll(async () => {
    if (envId) await t.a.services.containers!.destroyEnv(envId).catch(() => undefined)
    await t?.close()
    // Anything this run left behind, by prefix.
    for (const c of await docker.listContainers({ all: true }))
      if (c.Names.some((n) => n.replace(/^\//, '').startsWith(PREFIX)))
        await docker
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => undefined)
    for (const n of await docker.listNetworks())
      if (n.Name.startsWith(PREFIX))
        await docker
          .getNetwork(n.Id)
          .remove()
          .catch(() => undefined)
  }, 60_000)

  it('serves the environment through the preview listener, and nothing of the harness to the project', async () => {
    const up = await tool('env.up', { image: 'python:3-alpine', expose: [8000] })
    envId = up.envId
    expect(up.previews).toHaveLength(1)
    await tool('env.exec', {
      cmd: [
        'sh',
        '-c',
        'mkdir -p /srv && echo "<h1>hello from the environment</h1>" > /srv/index.html && cd /srv && nohup python3 -m http.server 8000 >/tmp/http.log 2>&1 &',
      ],
      workdir: '/',
    })

    const tok = await t.req(
      'POST',
      '/api/previews/token',
      { envId, port: 8000 },
      { ...(await t.admin()).headers, host: `127.0.0.1:${t.port}` },
    )
    expect(tok.status).toBe(200)
    const u = new URL(tok.body.url)
    const ex = await rawRequest(pp, `${u.pathname}${u.search}`, { host: `127.0.0.1:${pp}` })
    expect(ex.status).toBe(302)
    const cookie = setCookieOf(ex.headers, PREVIEW_COOKIE)!.split(';')[0]!

    // The server may need a moment to start.
    let page = { status: 0, body: '', headers: {} as Record<string, unknown> }
    for (let i = 0; i < 50; i++) {
      page = (await rawRequest(pp, '/', { host: `127.0.0.1:${pp}`, cookie })) as typeof page
      if (page.status === 200) break
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(page.status).toBe(200)
    expect(page.body).toContain('hello from the environment')
    expect(String(page.headers['content-security-policy'])).toBe(`frame-ancestors http://127.0.0.1:${t.port}`)

    // Nothing is published on the host for the environment.
    const mine = (await docker.listContainers()).filter((c) => c.Names.some((n) => n.startsWith(`/${PREFIX}`)))
    expect(mine.flatMap((c) => c.Ports.filter((p) => p.PublicPort))).toEqual([])

    // The project container can't reach the harness's API or preview port, on any address it could try.
    const net = await docker.getNetwork(`${envId}`).inspect()
    const gateway: string | undefined = net.IPAM?.Config?.[0]?.Gateway
    const targets = [
      ['127.0.0.1', t.port],
      ['127.0.0.1', pp],
      ...(gateway
        ? [
            [gateway, t.port],
            [gateway, pp],
          ]
        : []),
      ['host.docker.internal', t.port],
    ] as [string, number][]
    const probe = targets
      .map(
        ([h, p]) =>
          `try:\n s=socket.create_connection(('${h}', ${p}), 3); print('open ${h}:${p}')\nexcept Exception as e: print('closed ${h}:${p}', type(e).__name__)`,
      )
      .join('\n')
    const r = await tool('env.exec', { cmd: ['python3', '-c', `import socket\n${probe}`], timeoutSeconds: 60 })
    expect(r.stdout).not.toMatch(/^open /m)
    expect(r.stdout.match(/^closed /gm)).toHaveLength(targets.length)

    // The preview ends with the environment.
    await tool('env.down', {})
    const after = await rawRequest(pp, '/', { host: `127.0.0.1:${pp}`, cookie })
    expect(after.status).toBe(404)
    envId = ''
    expect(await leftovers()).toEqual([])
  }, 240_000)
})
