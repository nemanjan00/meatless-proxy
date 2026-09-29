/**
 * A desktop environment against a real Docker daemon (opt-in: `MP_DOCKER_TEST=1`). It builds the
 * desktop sidecar from docker/desktop (tag `mp-desktop:test`) and runs it next to the default profile
 * (`nemanjan00/dev:default`, or `MP_DESKTOP_TEST_IMAGE`): the display is usable from the main container,
 * both WebSocket bridges answer through the preview forwarder with the VNC handshake, a screenshot is a
 * PNG, metrics come back, and nothing is left behind.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import type { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { DESKTOP_PORTS } from '@mp/containers'
import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dockerRuntime } from '../src/index.ts'

const ENABLED = process.env.MP_DOCKER_TEST === '1'
const MAIN_IMAGE = process.env.MP_DESKTOP_TEST_IMAGE ?? 'nemanjan00/dev:default'
const DESKTOP_IMAGE = 'mp-desktop:test'
const PREFIX = `mp-dtest-${randomBytes(3).toString('hex')}-`
const CONTEXT = fileURLToPath(new URL('../../../docker/desktop', import.meta.url))

/** Opens a WebSocket to host:port and resolves with the upgrade status and the first binary frame's payload. */
function firstFrame(host: string, port: number): Promise<{ status: number; payload: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host,
      port,
      path: '/',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        'sec-websocket-protocol': 'binary',
      },
    })
    const timer = setTimeout(() => reject(new Error('no answer')), 10_000)
    req.on('upgrade', (res, socket: Socket, head) => {
      let buf = Buffer.from(head)
      const done = () => {
        if (buf.length < 2) return
        const len = buf[1]! & 0x7f
        if (buf.length < 2 + len) return
        clearTimeout(timer)
        socket.destroy()
        resolve({ status: res.statusCode ?? 0, payload: buf.subarray(2, 2 + len).toString('latin1') })
      }
      socket.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        done()
      })
      done()
    })
    req.on('response', (res) => {
      clearTimeout(timer)
      resolve({ status: res.statusCode ?? 0, payload: '' })
    })
    req.on('error', reject)
    req.end()
  })
}

describe.skipIf(!ENABLED)('a desktop environment on a real daemon', () => {
  const docker = new Docker()
  const runtime = dockerRuntime({ namePrefix: PREFIX, desktopImage: DESKTOP_IMAGE })
  let envId: string | undefined

  beforeAll(() => {
    execFileSync('docker', ['build', '-q', '-t', DESKTOP_IMAGE, CONTEXT], { stdio: 'pipe' })
  }, 600_000)

  afterAll(async () => {
    if (envId) await runtime.destroyEnv(envId).catch(() => undefined)
  })

  const leftovers = async () => {
    const containers = await docker.listContainers({ all: true })
    const networks = await docker.listNetworks()
    return [
      ...containers.flatMap((c) => c.Names).filter((n) => n.replace(/^\//, '').startsWith(PREFIX)),
      ...networks.map((n) => n.Name).filter((n) => n.startsWith(PREFIX)),
    ]
  }

  it('starts, draws, answers on both bridges, takes a screenshot, reports metrics, and cleans up', async () => {
    const env = await runtime.createEnv({ name: 'gui', image: MAIN_IMAGE, desktop: {} })
    envId = env.id
    expect(env.desktop).toBe(true)

    // Programs in the main container reach the display with the DISPLAY they were given.
    const win = await runtime.exec(env.id, ['sh', '-c', 'echo "$DISPLAY"; xwininfo -root'], { timeoutMs: 20_000 })
    expect(win.exitCode, win.stderr).toBe(0)
    expect(win.stdout).toMatch(/^:99\n/)
    expect(win.stdout).toMatch(/Width: 1440/)
    expect(win.stdout).toMatch(/Height: 900/)

    // The VNC servers listen on localhost only: the main container's own address doesn't reach them.
    const ports = await runtime.exec(env.id, ['sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6'], { timeoutMs: 10_000 })
    const listening = ports.stdout
      .split('\n')
      .filter((l) => / 0A /.test(l))
      .map((l) => l.trim().split(/\s+/)[1]!)
    const onPort = (p: number) => listening.filter((a) => a.endsWith(`:${p.toString(16).toUpperCase().padStart(4, '0')}`))
    expect(onPort(5900).length).toBeGreaterThan(0)
    for (const a of onPort(5900)) expect(['0100007F', '00000000000000000000000001000000']).toContain(a.split(':')[0])

    // Both bridges answer through the preview forwarder, with the VNC server's greeting.
    for (const port of [DESKTOP_PORTS.control, DESKTOP_PORTS.view]) {
      const t = await runtime.previewTarget!(env.id, port)
      const r = await firstFrame(t.host, t.port)
      expect(r.status).toBe(101)
      expect(r.payload).toMatch(/^RFB 003\.00\d\n/)
    }

    const png = await runtime.screenshot!(env.id)
    expect(Buffer.from(png.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a')
    // IHDR: the display's size.
    expect(Buffer.from(png).readUInt32BE(16)).toBe(1440)
    expect(Buffer.from(png).readUInt32BE(20)).toBe(900)

    await runtime.stats!(env.id)
    const stats = await runtime.stats!(env.id)
    expect(stats.containers.map((c) => c.name)).toEqual(['main', 'desktop'])
    for (const c of stats.containers) {
      expect(c.state).toBe('running')
      expect(c.memoryBytes).toBeGreaterThan(0)
      expect(c.pids).toBeGreaterThan(0)
    }
    const procs = await runtime.processes!(env.id)
    expect(procs.find((p) => p.name === 'desktop')?.processes.some((row) => row.join(' ').includes('Xvfb'))).toBe(true)

    await runtime.destroyEnv(env.id)
    envId = undefined
    expect(await leftovers()).toEqual([])
  }, 300_000)
})
