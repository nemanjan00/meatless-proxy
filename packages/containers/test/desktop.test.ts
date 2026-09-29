import { isMpError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { DESKTOP_PORTS, FAKE_PNG, fakeRuntime, invalidDesktop } from '../src/index.ts'

describe('desktop specs', () => {
  it('accepts sizes in range, refuses others and clashes with exposed ports', () => {
    expect(invalidDesktop(undefined)).toEqual([])
    expect(invalidDesktop({})).toEqual([])
    expect(invalidDesktop({ width: 1920, height: 1080 })).toEqual([])
    expect(invalidDesktop({ width: 100 })).toEqual(['desktop.width must be an integer from 320 to 3840'])
    expect(invalidDesktop({ height: 1.5 })).toHaveLength(1)
    expect(invalidDesktop(true)).toEqual(['desktop must be an object'])
    expect(invalidDesktop({}, [5173, DESKTOP_PORTS.view])).toEqual([`port ${DESKTOP_PORTS.view} is taken by the desktop`])
  })
})

describe('the fake runtime’s desktops, metrics and processes', () => {
  it('reaches the desktop ports, takes screenshots, and refuses them without a desktop', async () => {
    const rt = fakeRuntime()
    const gui = await rt.createEnv({ name: 'gui', image: 'x', desktop: {} })
    const plain = await rt.createEnv({ name: 'plain', image: 'x', expose: [5173] })
    expect(gui.desktop).toBe(true)
    expect(plain.desktop).toBeUndefined()
    expect((await rt.previewTarget(gui.id, DESKTOP_PORTS.control)).port).toBe(DESKTOP_PORTS.control)
    expect(isMpError(await rt.previewTarget(plain.id, DESKTOP_PORTS.control).catch((e) => e), 'not_found')).toBe(true)
    expect([...(await rt.screenshot(gui.id))]).toEqual([...FAKE_PNG])
    expect(isMpError(await rt.screenshot(plain.id).catch((e) => e), 'not_found')).toBe(true)
    rt.setScreenshot(gui.id, new Error('display gone'))
    await expect(rt.screenshot(gui.id)).rejects.toThrow('display gone')
    await expect(rt.createEnv({ name: 'bad', image: 'x', desktop: {}, expose: [6080] })).rejects.toThrow(/invalid desktop/)
    expect((await rt.features()).desktop).toBe(true)
  })

  it('reports metrics per container, overridable, and processes', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv({ name: 'e', image: 'x', desktop: {}, services: [{ name: 'db', image: 'postgres' }] })
    const s = await rt.stats(env.id)
    expect(s.containers.map((c) => c.name)).toEqual(['main', 'db', 'desktop'])
    rt.setStats(env.id, 'main', { cpuPercent: 42 })
    expect((await rt.stats(env.id)).containers[0]!.cpuPercent).toBe(42)
    rt.stop(env.id)
    expect((await rt.stats(env.id)).containers[1]).toMatchObject({ state: 'exited', memoryBytes: null })
    expect((await rt.processes(env.id)).map((p) => p.name)).toEqual(['main', 'db'])
    await rt.destroyEnv(env.id)
    expect(isMpError(await rt.stats(env.id).catch((e) => e), 'not_found')).toBe(true)
  })
})
