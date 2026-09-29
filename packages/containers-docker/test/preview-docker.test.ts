import { spawn } from 'node:child_process'
import { createServer, request, type Server } from 'node:http'
import { createServer as createTcpServer, connect, type AddressInfo, type Server as TcpServer } from 'node:net'
import { isMpError } from '@mp/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LABEL_EXPOSE,
  PREVIEW_FORWARDER_SOURCE,
  PREVIEW_READY_MARKER,
  createPreviewForwarder,
  dockerRuntime,
} from '../src/index.ts'
import { MockDocker } from './mock-docker.ts'

let docker: MockDocker
const rt = (o: Parameters<typeof dockerRuntime>[0] = {}) => dockerRuntime({ docker, ...o })

beforeEach(() => {
  docker = new MockDocker()
  // The forwarder says it's listening, like the real one.
  const start = docker.getContainer.bind(docker)
  docker.getContainer = (id: string) => {
    const c = start(id)
    const orig = c.start.bind(c)
    c.start = async (o) => {
      const r = await orig(o)
      const mc = [...docker.containers.values()].find((x) => (x.name === id || x.id === id) && !x.removed)
      if (mc && String(mc.opts.Cmd?.at(-1) ?? '').includes('createPreviewForwarder'))
        mc.logs = Buffer.concat([mc.logs, frameOf(`${PREVIEW_READY_MARKER} 5173\n`)])
      return r
    }
    return c
  }
})

const frameOf = (text: string) => {
  const body = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = 2
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

const spec = {
  name: 'bot-web',
  image: 'node:22',
  expose: [5173, 8000],
  labels: { 'mp.session': 'ses_1' },
}

describe('preview forwarder sidecar', () => {
  it('creates an internal preview network and a forwarder on both networks, labels the exposed ports', async () => {
    await rt().createEnv(spec)
    const nets = docker.callsTo('createNetwork').map((a) => a[0] as Record<string, any>)
    expect(nets.map((n) => [n.Name, n.Internal])).toEqual([
      ['mp-bot-web', true],
      ['mp-bot-web-preview', true],
    ])
    expect(nets[1]!.Labels).toMatchObject({ 'mp.role': 'preview', 'mp.env': 'bot-web', 'mp.session': 'ses_1' })

    const created = docker.callsTo('createContainer').map((a) => a[0] as Record<string, any>)
    expect(created.map((c) => c.name)).toEqual(['mp-bot-web', 'mp-bot-web-preview'])
    const [main, fwd] = created as [Record<string, any>, Record<string, any>]
    expect(main.Labels[LABEL_EXPOSE]).toBe('5173,8000')
    // Nothing is published on the host.
    expect(main.HostConfig.PortBindings).toBeUndefined()
    expect(main.ExposedPorts).toBeUndefined()

    expect(fwd.Cmd).toEqual(['node', '-e', PREVIEW_FORWARDER_SOURCE])
    expect(fwd.Env).toEqual([
      'TARGET=main',
      `FORWARDS=${JSON.stringify([
        { listen: 5173, port: 5173 },
        { listen: 8000, port: 8000 },
      ])}`,
    ])
    expect(fwd.HostConfig).toMatchObject({ NetworkMode: 'mp-bot-web', ReadonlyRootfs: true, Privileged: false })
    expect(fwd.HostConfig.PortBindings).toBeUndefined()
    expect(fwd.User).toBe('65534:65534')
    expect(fwd.Labels).toMatchObject({ 'mp.role': 'preview', 'mp.env': 'bot-web' })
    expect(docker.callsTo('network.connect')).toEqual([['mp-bot-web-preview', { Container: 'mp-bot-web-preview' }]])
  })

  it('makes no forwarder without exposed ports', async () => {
    await rt().createEnv({ name: 'plain', image: 'node:22' })
    expect(docker.callsTo('createContainer').map((a) => (a[0] as any).name)).toEqual(['mp-plain'])
    expect(docker.networks.has('mp-plain-preview')).toBe(false)
  })

  it('previewTarget is the forwarder on the preview network', async () => {
    const r = rt()
    const env = await r.createEnv(spec)
    const fwd = [...docker.containers.values()].find((c) => c.name === 'mp-bot-web-preview')!
    const ip = docker.networksOf(fwd)['mp-bot-web-preview']!.IPAddress
    expect(await r.previewTarget!(env.id, 5173)).toEqual({ host: ip, port: 5173 })
    expect(await r.previewTarget!(env.id, 8000)).toEqual({ host: ip, port: 8000 })
    await expect(r.previewTarget!(env.id, 22)).rejects.toSatisfy((e) => isMpError(e, 'not_found'))
    await expect(r.previewTarget!('mp-nope', 5173)).rejects.toSatisfy((e) => isMpError(e, 'not_found'))
    // Without a self container, the harness isn't connected to anything.
    expect(docker.callsTo('network.connect')).toHaveLength(1)
  })

  it('connects the harness container to the preview network once, and disconnects it on destroy', async () => {
    await docker.createContainer({ name: 'harness-app', Image: 'app' })
    const r = rt({ selfContainer: 'harness-app' })
    const env = await r.createEnv(spec)
    await r.previewTarget!(env.id, 5173)
    await r.previewTarget!(env.id, 8000)
    expect(docker.callsTo('network.connect').slice(1)).toEqual([['mp-bot-web-preview', { Container: 'harness-app' }]])
    // The harness is on the preview network only, never on the environment's own network.
    expect(docker.networks.get('mp-bot-web')!.connected ?? []).not.toContain('harness-app')

    // A new runtime (a restart) finds it already connected, which is fine.
    const again = rt({ selfContainer: 'harness-app' })
    await expect(again.previewTarget!(env.id, 5173)).resolves.toMatchObject({ port: 5173 })

    await r.destroyEnv(env.id)
    expect(docker.callsTo('network.disconnect')).toEqual([['mp-bot-web-preview', { Container: 'harness-app', Force: true }]])
    expect(docker.networks.size).toBe(0)
    expect([...docker.containers.values()].filter((c) => !c.removed).map((c) => c.name)).toEqual(['harness-app'])
  })

  it('removes the forwarder and its network on destroy, and cleans up a failed create', async () => {
    const r = rt()
    const env = await r.createEnv(spec)
    await r.destroyEnv(env.id)
    expect([...docker.containers.values()].filter((c) => !c.removed)).toHaveLength(0)
    expect(docker.networks.size).toBe(0)

    const failing = new MockDocker()
    failing.failures['network.connect'] = new Error('boom')
    await expect(dockerRuntime({ docker: failing }).createEnv(spec)).rejects.toThrow(/boom/)
    expect([...failing.containers.values()].filter((c) => !c.removed)).toHaveLength(0)
    expect(failing.networks.size).toBe(0)
  })

  it('validates expose, and keeps the service name "preview" for the forwarder', async () => {
    await expect(rt().createEnv({ ...spec, expose: [0, 5173, 5173] })).rejects.toSatisfy((e) => isMpError(e, 'validation'))
    await expect(rt().createEnv({ ...spec, services: [{ name: 'preview', image: 'x' }] })).rejects.toThrow(/invalid/)
    await expect(rt().createEnv({ name: 'ok', image: 'x', services: [{ name: 'preview', image: 'x' }] })).resolves.toBeTruthy()
  })
})

// ── The forwarder itself, against real local servers ─────────────────────────

const listen = (s: Server | TcpServer) =>
  new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)))
const freePort = async () => {
  const s = createTcpServer()
  const p = await listen(s)
  await new Promise((r) => s.close(r))
  return p
}
const get = (port: number, path = '/') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''
      res.on('data', (d) => {
        body += d
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
      .on('error', reject)
      .end()
  })

describe('createPreviewForwarder', () => {
  const closers: (() => void)[] = []
  afterEach(() => {
    for (const c of closers.splice(0)) c()
  })

  it('forwards HTTP and raw TCP both ways to the target port only', async () => {
    const http = createServer((req, res) => res.end(`hello ${req.url}`))
    const upstream = await listen(http)
    closers.push(() => http.close())
    const echo = createTcpServer((s) => s.pipe(s))
    const echoPort = await listen(echo)
    closers.push(() => echo.close())

    const [a, b] = createPreviewForwarder({
      target: '127.0.0.1',
      forwards: [
        { listen: 0, port: upstream },
        { listen: 0, port: echoPort },
      ],
    })
    const pa = await listen(a!.server)
    const pb = await listen(b!.server)
    closers.push(
      () => a!.server.close(),
      () => b!.server.close(),
    )

    expect(await get(pa, '/x')).toEqual({ status: 200, body: 'hello /x' })
    const text = await new Promise<string>((resolve) => {
      const s = connect(pb, '127.0.0.1', () => s.end('ping'))
      let got = ''
      s.on('data', (d) => {
        got += d
      })
      s.on('end', () => resolve(got))
    })
    expect(text).toBe('ping')
  })

  it('closes the client when the target refuses', async () => {
    const dead = await freePort()
    const [f] = createPreviewForwarder({ target: '127.0.0.1', forwards: [{ listen: 0, port: dead }] })
    const p = await listen(f!.server)
    closers.push(() => f!.server.close())
    await expect(get(p)).rejects.toThrow()
  })

  it('runs as the node -e sidecar script', async () => {
    const http = createServer((_req, res) => res.end('from main'))
    const upstream = await listen(http)
    closers.push(() => http.close())
    const port = await freePort()
    const child = spawn(process.execPath, ['-e', PREVIEW_FORWARDER_SOURCE], {
      env: { TARGET: '127.0.0.1', FORWARDS: JSON.stringify([{ listen: port, port: upstream }]) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    closers.push(() => child.kill('SIGKILL'))
    await new Promise<void>((resolve, reject) => {
      let err = ''
      child.stderr.on('data', (d) => {
        err += d
        if (err.includes(PREVIEW_READY_MARKER)) resolve()
      })
      child.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)))
    })
    expect(await get(port)).toEqual({ status: 200, body: 'from main' })
  })

  it('the sidecar script refuses a missing forward list', async () => {
    const child = spawn(process.execPath, ['-e', PREVIEW_FORWARDER_SOURCE], { env: {}, stdio: 'ignore' })
    const code = await new Promise((r) => child.on('exit', r))
    expect(code).toBe(2)
  })
})
