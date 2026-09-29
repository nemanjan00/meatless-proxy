import { DESKTOP_PORTS, FAKE_PNG } from '@mp/containers'
import type { BusMessage } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSET } from '../src/toolsets.ts'
import { desktopLink } from '../src/tools/env.ts'
import { stack } from './helpers.ts'

/** A PNG of `w`x`h` as far as its header goes (what env.screenshot reads the size from). */
const pngOf = (w: number, h: number) => {
  const b = Buffer.alloc(33)
  Buffer.from(FAKE_PNG.subarray(0, 16)).copy(b)
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return new Uint8Array(b)
}

describe('env.up with a desktop', () => {
  it('asks the runtime for a desktop, records it, and links the desktop viewer (never a token)', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22', desktop: true, expose: [5173] })
    expect(t.containers.created[0]!.desktop).toEqual({})
    expect(t.containers.created[0]!.expose).toEqual([5173])
    expect(up.desktop).toMatchObject({ url: `/sessions/${t.session.id}?tab=preview&desktop=1`, display: ':99' })
    expect(up.desktop.note).toMatch(/DISPLAY=:99/)
    expect(up.desktop.url).toBe(desktopLink(t.session.id))
    expect(JSON.stringify(up)).not.toMatch(/token|mpp_/)
    const env = (await t.sessions.require(t.session.id)).data.meta?.env as Record<string, unknown>
    expect(env).toMatchObject({ id: up.envId, desktop: true, image: 'node:22', expose: [5173] })
    // The desktop's ports are reachable like exposed ones, but aren't listed as the app's previews.
    expect((await t.containers.previewTarget(up.envId, DESKTOP_PORTS.control)).port).toBe(DESKTOP_PORTS.control)
    expect(up.previews.map((p: { port: number }) => p.port)).toEqual([5173])
  })

  it('has no desktop unless asked for, and says so for a running environment without one', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22' })
    expect(up.desktop).toBeUndefined()
    expect(t.containers.created[0]!.desktop).toBeUndefined()
    const again = await t.out('env.up', { image: 'node:22', desktop: true })
    expect(again.existing).toBe(true)
    expect(again.note).toMatch(/without a desktop: env.down, then env.up with desktop: true/)
    expect(t.containers.created).toHaveLength(1)
  })

  it('returns the running desktop again', async () => {
    const t = await stack()
    await t.out('env.up', { image: 'node:22', desktop: true })
    const again = await t.out('env.up', {})
    expect(again.existing).toBe(true)
    expect(again.desktop.url).toBe(desktopLink(t.session.id))
  })

  it('refuses a desktop the runtime cannot run, and a desktop that is not a boolean', async () => {
    const t = await stack()
    ;(t.containers as { features: () => Promise<unknown> }).features = async () => ({ volumeSubpath: true, desktop: false })
    const r = await t.call('env.up', { image: 'node:22', desktop: true })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toMatch(/no desktops/)
    expect((await t.call('env.up', { image: 'node:22', desktop: 'yes' })).isError).toBe(true)
    expect(t.containers.created).toHaveLength(0)
  })

  it('records the checkouts, services and profile for the Environments page', async () => {
    const t = await stack()
    await t.out('env.up', { profile: 'analyst', services: [{ name: 'db', image: 'postgres:18' }] })
    const env = (await t.sessions.require(t.session.id)).data.meta?.env as Record<string, unknown>
    expect(env).toMatchObject({ profile: 'analyst', image: 'nemanjan00/dev:analyst', services: ['db'] })
  })

  it('tells who listens when an environment starts and goes down', async () => {
    const t = await stack()
    const seen: BusMessage[] = []
    t.bus.subscribe('env.changed', (m) => void seen.push(m))
    const up = await t.out('env.up', { image: 'node:22', desktop: true })
    await t.out('env.down', {})
    expect(seen.map((m) => m.payload)).toEqual([
      { sessionId: t.session.id, envId: up.envId, op: 'up' },
      { sessionId: t.session.id, envId: up.envId, op: 'down' },
    ])
  })
})

describe('env.exec in progress', () => {
  it('says when a command starts and finishes, also when it fails', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22' })
    const seen: { topic: string; payload: any }[] = []
    t.bus.subscribe('env.exec.*', (m) => void seen.push({ topic: m.topic, payload: m.payload }))
    await t.out('env.exec', { cmd: ['npm', 'test'] })
    t.containers.on('boom', { error: new Error('docker went away') })
    expect((await t.call('env.exec', { cmd: ['boom'] }).catch((e) => ({ thrown: e }))) as object).toBeTruthy()
    expect(seen.map((s) => [s.topic, s.payload.cmd.join(' ')])).toEqual([
      ['env.exec.started', 'npm test'],
      ['env.exec.finished', 'npm test'],
      ['env.exec.started', 'boom'],
      ['env.exec.finished', 'boom'],
    ])
    expect(seen[0]!.payload).toMatchObject({ sessionId: t.session.id, envId: up.envId, runId: expect.any(String) })
    expect(seen[0]!.payload.startedAt).toMatch(/^2026-/)
  })
})

describe('env.screenshot', () => {
  it('is in the default toolset', () => {
    expect(DEFAULT_TOOLSET).toContain('env.screenshot')
  })

  it('saves the desktop as a PNG in the employee’s files and says how to look at it', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22', desktop: true })
    t.containers.setScreenshot(up.envId, pngOf(1440, 900))
    const shot = await t.out('env.screenshot', {})
    expect(shot).toMatchObject({ bytes: 33, width: 1440, height: 900, envId: up.envId })
    expect(shot.path).toMatch(/^\/screenshots\/.+\.png$/)
    expect(shot.note).toContain(`image.view { path: "${shot.path}" }`)
    const file = await t.files.read(t.employee.id, shot.path)
    expect(file.mime).toBe('image/png')
    expect(Buffer.from(file.content, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47')

    const named = await t.out('env.screenshot', { path: '/shots/login.png' })
    expect(named.path).toBe('/shots/login.png')
  })

  it('refuses without an environment, without a desktop, and for a path that is not a PNG', async () => {
    const t = await stack()
    expect(JSON.stringify((await t.call('env.screenshot', {})).output)).toMatch(/no environment/)
    await t.out('env.up', { image: 'node:22' })
    expect(JSON.stringify((await t.call('env.screenshot', {})).output)).toMatch(/has no desktop/)
    const t2 = await stack()
    await t2.out('env.up', { image: 'node:22', desktop: true })
    expect(JSON.stringify((await t2.call('env.screenshot', { path: '/a.jpg' })).output)).toMatch(/\.png/)
  })

  it('passes a failing capture on as an error', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22', desktop: true })
    t.containers.setScreenshot(up.envId, new Error('the display is gone'))
    const r = await t.call('env.screenshot', {}).catch((e: Error) => ({ isError: true, output: { error: e.message } }))
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toMatch(/the display is gone/)
  })

  it('gives a retried call the first result, without a second capture', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22', desktop: true })
    const c = t.ctx()
    const first = await t.out('env.screenshot', {}, c)
    t.containers.setScreenshot(up.envId, new Error('should not be asked again'))
    t.clock.advance(1000)
    expect(await t.out('env.screenshot', {}, c)).toEqual(first)
  })
})
