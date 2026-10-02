import { callTools, reply } from '@mp/model'
import type { ToolResultContent } from '@mp/sessions'
import { LOADED_TOOLS_META } from '@mp/tools'
import { describe, expect, it } from 'vitest'
import { harness } from './harness.ts'

/** Tools whose name starts with `rare.` wait to be loaded, for sessions that can load (have `loader.load`). */
const onDemand = (s: { data: { toolset: string[] } }) =>
  s.data.toolset.includes('loader.load') ? (n: string) => n.startsWith('rare.') : undefined

const offered = (h: ReturnType<typeof harness>, call: number) => h.model.calls[call]!.tools?.map((t) => t.function.name) ?? []

const setup = (script: Parameters<typeof harness>[0], extra: Parameters<typeof harness>[1] = {}) => {
  const h = harness(script, { onDemand, ...extra })
  h.tool({ name: 'common.read' }, async () => ({ output: 'read' }))
  h.tool({ name: 'rare.schedule' }, async () => ({ output: 'scheduled' }))
  h.tool({ name: 'rare.upload' }, async () => ({ output: 'uploaded' }))
  // A stand-in for tools.load: records the names in the session's meta, as the stdlib does.
  h.tool({ name: 'loader.load', effect: 'idempotent' }, async (a, ctx) => {
    const s = await h.sessions.require(ctx.sessionId)
    await h.sessions.update(s.id, { meta: { ...(s.data.meta ?? {}), [LOADED_TOOLS_META]: a.names } })
    return { output: { loaded: a.names } }
  })
  return h
}
const TOOLSET = ['common.read', 'loader.load', 'rare.schedule', 'rare.upload']

describe('tools on demand', () => {
  it('offers the core tools, not the on-demand ones', async () => {
    const h = setup([reply('ok')])
    const s = await h.session(TOOLSET)
    await h.runner.execute((await h.start(s.id)).id)
    expect(offered(h, 0)).toEqual(['common__read', 'loader__load'])
  })

  it('offers a loaded tool from the next model call on, and keeps it loaded in later runs', async () => {
    const h = setup([
      callTools([{ name: 'loader__load', args: { names: ['rare.schedule'] } }]),
      reply('loaded'),
      reply('later run'),
    ])
    const s = await h.session(TOOLSET)
    await h.runner.execute((await h.start(s.id)).id)
    expect(offered(h, 0)).not.toContain('rare__schedule')
    expect(offered(h, 1)).toContain('rare__schedule')
    expect(offered(h, 1)).not.toContain('rare__upload')
    await h.runner.execute((await h.start(s.id)).id)
    expect(offered(h, 2)).toContain('rare__schedule')
  })

  it('runs a call to an allowed tool that is not loaded yet, and loads it', async () => {
    const h = setup([callTools([{ name: 'rare__upload', id: 'c1' }]), reply('done')])
    const s = await h.session(TOOLSET)
    const run = await h.start(s.id)
    expect((await h.runner.execute(run.id)).status).toBe('completed')
    const result = (await h.sessions.history(s.id)).find((e) => e.kind === 'tool_result')!.content as unknown as ToolResultContent
    expect(result).toMatchObject({ name: 'rare.upload', output: 'uploaded' })
    expect(result.isError).toBeUndefined()
    expect((await h.sessions.require(s.id)).data.meta?.[LOADED_TOOLS_META]).toEqual(['rare.upload'])
    expect(offered(h, 1)).toContain('rare__upload')
  })

  it('still refuses a tool outside the toolset, or one the employee may not use', async () => {
    const h = setup(
      [
        callTools([
          { name: 'rare__upload', id: 'c1' },
          { name: 'rare__schedule', id: 'c2' },
        ]),
        reply('done'),
      ],
      {
        toolListsFor: async () => ({ allow: ['**'], deny: ['rare.schedule'] }),
      },
    )
    // rare.upload is registered and allowed, but not in this session's toolset.
    const s = await h.session(['common.read', 'loader.load', 'rare.schedule'])
    await h.runner.execute((await h.start(s.id)).id)
    const results = (await h.sessions.history(s.id))
      .filter((e) => e.kind === 'tool_result')
      .map((e) => e.content as unknown as ToolResultContent)
    expect(results.map((r) => [r.name, r.isError, (r.output as { error?: string }).error])).toEqual([
      ['rare.upload', true, 'tool rare.upload is not available in this session'],
      ['rare.schedule', true, 'tool rare.schedule is not available in this session'],
    ])
    expect((await h.sessions.require(s.id)).data.meta?.[LOADED_TOOLS_META]).toBeUndefined()
    expect(offered(h, 1)).toEqual(['common__read', 'loader__load'])
  })

  it('offers the tools a history has called (a fork inherits its parent calls)', async () => {
    const h = setup([callTools([{ name: 'rare__schedule', id: 'c1' }]), reply('parent done'), reply('fork done')])
    const parent = await h.session(TOOLSET)
    await h.runner.execute((await h.start(parent.id)).id)
    const fork = await h.sessions.fork(parent.id)
    expect(fork.data.meta?.[LOADED_TOOLS_META]).toBeUndefined()
    await h.runner.execute((await h.start(fork.id)).id)
    expect(offered(h, 2)).toContain('rare__schedule')
  })

  it('offers every tool to a session that cannot load tools, and without the option', async () => {
    const narrow = setup([reply('ok')])
    const s = await narrow.session(['common.read', 'rare.schedule'])
    await narrow.runner.execute((await narrow.start(s.id)).id)
    expect(offered(narrow, 0)).toEqual(['common__read', 'rare__schedule'])

    const off = setup([reply('ok')], { onDemand: undefined })
    const s2 = await off.session(TOOLSET)
    await off.runner.execute((await off.start(s2.id)).id)
    expect(offered(off, 0)).toEqual(['common__read', 'loader__load', 'rare__schedule', 'rare__upload'])
  })
})
