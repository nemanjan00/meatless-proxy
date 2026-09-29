import { callTools, reply, type ChatMessage, type ImageRef } from '@mp/model'
import type { ToolResultContent } from '@mp/sessions'
import { describe, expect, it } from 'vitest'
import { createImageResolver, VISION_TAG } from '../src/index.ts'
import { harness } from './harness.ts'

const ref = (name = 'chart.png', sha256 = 'abc'): ImageRef => ({
  source: 'file',
  owner: 'emp_test',
  path: `/${name}`,
  sha256,
  name,
  mime: 'image/png',
  width: 4,
  height: 3,
})

const viewTool = (h: ReturnType<typeof harness>, refs: ImageRef[] = [ref()]) =>
  h.tool({ name: 'image.view', tags: [VISION_TAG] }, async () => ({ output: { image: refs[0]!.name }, images: refs }))

describe('images in runs', () => {
  it('keeps a reference in the history, never the bytes, and loads them for every request', async () => {
    const loads: ImageRef[] = []
    const h = harness([callTools([{ name: 'image__view' }]), reply('It is red.'), reply('Still red.')], {
      vision: true,
      loadImage: async (r) => {
        loads.push(r)
        return { mime: 'image/png', data: 'UkVE' }
      },
    })
    viewTool(h)
    const s = await h.session(['image.view'])
    await h.runner.execute((await h.start(s.id, 'look')).id)
    const hist = await h.sessions.history(s.id)
    const result = hist.find((e) => e.kind === 'tool_result')!.content as unknown as ToolResultContent
    expect(result.images).toEqual([ref()])
    expect(JSON.stringify(hist)).not.toContain('UkVE')
    // The model got the bytes, attached to the tool message.
    const tool = h.model.calls[1]!.messages.find((m) => m.role === 'tool')!
    expect(tool.images).toEqual([
      { type: 'image', mime: 'image/png', data: 'UkVE', ref: ref(), name: 'chart.png', width: 4, height: 3 },
    ])
    // A later run sees the same image again, byte for byte, from the cache.
    await h.runner.execute((await h.start(s.id, 'again')).id)
    const again = h.model.calls[2]!.messages.find((m) => m.role === 'tool')!
    expect(again.images![0]!.data).toBe('UkVE')
    expect(loads).toHaveLength(1)
  })

  it('shows a missing or changed image as no longer available', async () => {
    const h = harness([callTools([{ name: 'image__view' }]), reply('gone')], { vision: true, loadImage: async () => null })
    viewTool(h)
    const s = await h.session(['image.view'])
    await h.runner.execute((await h.start(s.id)).id)
    const tool = h.model.calls[1]!.messages.find((m) => m.role === 'tool')!
    expect(tool.images).toHaveLength(1)
    expect(tool.images![0]!.data).toBeUndefined()
  })

  it('without vision, neither offers nor runs vision tools', async () => {
    let ran = false
    const h = harness([callTools([{ name: 'image__view' }]), reply('ok')])
    h.tool({ name: 'image.view', tags: [VISION_TAG] }, async () => {
      ran = true
      return { output: 'x' }
    })
    h.tool({ name: 'time.now' }, async () => ({ output: 'now' }))
    const s = await h.session(['image.view', 'time.now'])
    await h.runner.execute((await h.start(s.id)).id)
    expect(h.model.calls[0]!.tools!.map((t) => t.function.name)).toEqual(['time__now'])
    expect(ran).toBe(false)
    const result = (await h.sessions.history(s.id)).find((e) => e.kind === 'tool_result')!.content as any
    expect(result).toMatchObject({ isError: true, output: { error: "this model can't see images" } })
  })
})

describe('createImageResolver', () => {
  const msgs = (): ChatMessage[] => [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'c', content: 'r', images: [{ type: 'image', mime: 'image/png', ref: ref() }] },
  ]

  it('returns the same array when there are no images', async () => {
    const m = [{ role: 'user' as const, content: 'hi' }]
    expect(await createImageResolver({ vision: true })(m)).toBe(m)
  })

  it('replaces images with a note when the model is blind', async () => {
    const out = await createImageResolver({ vision: false, load: async () => ({ mime: 'image/png', data: 'x' }) })(msgs())
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'c', content: "r\n[an image not shown: this model can't see images]" })
  })

  it('survives a loader that throws, and caches only hits', async () => {
    let n = 0
    const resolve = createImageResolver({
      vision: true,
      load: async () => {
        n++
        if (n === 1) throw new Error('disk on fire')
        return { mime: 'image/png', data: 'QQ==', width: 2, height: 1 }
      },
    })
    const input = msgs()
    expect((await resolve(input))[1]!.images![0]!.data).toBeUndefined()
    expect((await resolve(input))[1]!.images![0]).toMatchObject({ data: 'QQ==', width: 2, height: 1 })
    await resolve(input)
    expect(n).toBe(2)
    // The input wasn't changed.
    expect(input[1]!.images![0]!.data).toBeUndefined()
  })

  it('evicts the oldest image past the cache size', async () => {
    const loaded: string[] = []
    const resolve = createImageResolver({
      vision: true,
      cacheSize: 1,
      load: async (r) => {
        loaded.push(r.sha256)
        return { mime: 'image/png', data: r.sha256 }
      },
    })
    const one = (sha: string) => [
      { role: 'user' as const, content: '', images: [{ type: 'image' as const, mime: 'image/png', ref: ref('a.png', sha) }] },
    ]
    await resolve(one('a'))
    await resolve(one('b'))
    await resolve(one('a'))
    expect(loaded).toEqual(['a', 'b', 'a'])
  })
})
