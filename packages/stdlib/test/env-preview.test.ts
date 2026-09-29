import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSET } from '../src/toolsets.ts'
import { previewLink } from '../src/tools/env.ts'
import { stack } from './helpers.ts'

describe('env.up with expose', () => {
  it('passes the ports to the runtime, records them in the session meta and links their previews', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22', expose: [5173, 8000] })
    expect(t.containers.created[0]!.expose).toEqual([5173, 8000])
    expect(up.previews).toEqual([
      { port: 5173, url: `/sessions/${t.session.id}?tab=preview&port=5173` },
      { port: 8000, url: `/sessions/${t.session.id}?tab=preview&port=8000` },
    ])
    const s = await t.sessions.require(t.session.id)
    expect(s.data.meta?.env).toEqual({ id: up.envId, name: up.name, expose: [5173, 8000] })
    expect(await t.containers.previewTarget(up.envId, 5173)).toEqual({ host: '127.0.0.1', port: 5173 })
  })

  it('exposes nothing by default', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22' })
    expect(t.containers.created[0]!.expose).toBeUndefined()
    expect(up.previews).toBeUndefined()
    expect((await t.sessions.require(t.session.id)).data.meta?.env).toEqual({ id: up.envId, name: up.name })
  })

  it('refuses bad port lists without creating anything', async () => {
    const t = await stack()
    for (const expose of [[0], [70000], [5173, 5173], ['5173'], 5173]) {
      const r = await t.call('env.up', { image: 'node:22', expose })
      expect(r.isError, JSON.stringify(expose)).toBe(true)
    }
    expect(t.containers.created).toHaveLength(0)
  })

  it('returns the running environment with its previews, and says when other ports were asked for', async () => {
    const t = await stack()
    await t.out('env.up', { image: 'node:22', expose: [5173] })
    const again = await t.out('env.up', { image: 'node:22', expose: [3000] })
    expect(again.existing).toBe(true)
    expect(again.previews).toEqual([{ port: 5173, url: previewLink(t.session.id, 5173) }])
    expect(again.note).toMatch(/env.down/)
    const same = await t.out('env.up', { image: 'node:22', expose: [5173] })
    expect(same.note).toBeUndefined()
    expect(t.containers.created).toHaveLength(1)
  })
})

describe('env.preview', () => {
  it('links the preview panel of the session, never a token', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22', expose: [5173] })
    const p = await t.out('env.preview', {})
    expect(p).toEqual({
      url: `/sessions/${t.session.id}?tab=preview&port=5173`,
      port: 5173,
      envId: up.envId,
      ports: [5173],
      status: 'running',
    })
    expect(JSON.stringify(p)).not.toMatch(/token/i)
  })

  it('needs a port when several are exposed, and only an exposed one', async () => {
    const t = await stack()
    await t.out('env.up', { image: 'node:22', expose: [5173, 8000] })
    const which = await t.call('env.preview', {})
    expect(which.isError).toBe(true)
    expect(which.output).toMatchObject({ ports: [5173, 8000] })
    expect((await t.call('env.preview', { port: 22 })).isError).toBe(true)
    expect((await t.out('env.preview', { port: 8000 })).url).toBe(previewLink(t.session.id, 8000))
  })

  it('fails without an environment, without exposed ports, and once the environment is gone', async () => {
    const t = await stack()
    expect((await t.call('env.preview', {})).isError).toBe(true)
    const up = await t.out('env.up', { image: 'node:22' })
    expect((await t.call('env.preview', {})).isError).toBe(true)
    await t.out('env.down', {})
    await t.out('env.up', { image: 'node:22', expose: [5173] })
    const env = (await t.sessions.require(t.session.id)).data.meta?.env as { id: string }
    expect(env.id).not.toBe(up.envId)
    await t.containers.destroyEnv(env.id)
    const gone = await t.call('env.preview', {})
    expect(gone.isError).toBe(true)
    expect(JSON.stringify(gone.output)).toMatch(/gone/)
  })

  it('is in the default toolset', () => {
    expect(DEFAULT_TOOLSET).toContain('env.preview')
  })
})
