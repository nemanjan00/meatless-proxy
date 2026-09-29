import { isMpError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { MAX_EXPOSED_PORTS, fakeRuntime, invalidExpose } from '../src/index.ts'

describe('invalidExpose', () => {
  it('accepts a list of distinct ports, or nothing', () => {
    expect(invalidExpose(undefined)).toEqual([])
    expect(invalidExpose([])).toEqual([])
    expect(invalidExpose([5173, 8000, 1, 65535])).toEqual([])
  })

  it('names every problem', () => {
    expect(invalidExpose('5173')).toEqual(['expose must be a list of ports'])
    expect(invalidExpose([0, 65536, 3.5, '80', 8000, 8000])).toEqual([
      'bad port: 0',
      'bad port: 65536',
      'bad port: 3.5',
      'bad port: 80',
      'duplicate port: 8000',
    ])
    const many = Array.from({ length: MAX_EXPOSED_PORTS + 1 }, (_, i) => 3000 + i)
    expect(invalidExpose(many)).toEqual([`at most ${MAX_EXPOSED_PORTS} exposed ports`])
  })
})

describe('fake runtime previews', () => {
  it('points exposed ports at 127.0.0.1 by default, or where a test says', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv({ name: 'web', image: 'node:22', expose: [5173, 8000] })
    expect(await rt.previewTarget(env.id, 5173)).toEqual({ host: '127.0.0.1', port: 5173 })
    rt.servePreview(env.id, 8000, { host: '127.0.0.1', port: 41234 })
    expect(await rt.previewTarget(env.id, 8000)).toEqual({ host: '127.0.0.1', port: 41234 })
    expect(rt.envs()[0]!.spec.expose).toEqual([5173, 8000])
  })

  it('uses the previewTarget option', async () => {
    const rt = fakeRuntime({ previewTarget: (e, port) => ({ host: `${e.info.name}.test`, port: port + 1 }) })
    const env = await rt.createEnv({ name: 'web', image: 'node:22', expose: [3000] })
    expect(await rt.previewTarget(env.id, 3000)).toEqual({ host: 'web.test', port: 3001 })
  })

  it('refuses ports that are not exposed, and environments that are gone', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv({ name: 'web', image: 'node:22', expose: [5173] })
    await expect(rt.previewTarget(env.id, 22)).rejects.toSatisfy((e) => isMpError(e, 'not_found'))
    expect(() => rt.servePreview(env.id, 22, { host: 'x', port: 1 })).toThrow(/exposed port/)
    rt.servePreview(env.id, 5173, { host: '127.0.0.1', port: 1234 })
    await rt.destroyEnv(env.id)
    await expect(rt.previewTarget(env.id, 5173)).rejects.toSatisfy((e) => isMpError(e, 'not_found'))
    const none = await rt.createEnv({ name: 'plain', image: 'node:22' })
    await expect(rt.previewTarget(none.id, 5173)).rejects.toSatisfy((e) => isMpError(e, 'not_found'))
  })

  it('validates expose on create', async () => {
    const rt = fakeRuntime()
    await expect(rt.createEnv({ name: 'bad', image: 'node:22', expose: [0, 5173, 5173] })).rejects.toSatisfy((e) =>
      isMpError(e, 'validation'),
    )
    expect(rt.envs()).toHaveLength(0)
  })
})
