import { isMpError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { callTools, estimateTokens, parseToolArguments, reply, scriptedModel, toolSpec, type ModelDelta } from '../src/index.ts'

const user = (content: string) => ({ role: 'user' as const, content })

describe('scriptedModel', () => {
  it('answers from an array script, in order', async () => {
    const model = scriptedModel(['hello', reply('second'), { message: { content: 'third' } }])
    expect(model.defaultModel).toBe('scripted')
    const a = await model.complete({ messages: [user('hi')] })
    expect(a.message).toEqual({ role: 'assistant', content: 'hello' })
    expect(a.finishReason).toBe('stop')
    expect(a.model).toBe('scripted')
    expect((await model.complete({ messages: [user('x')] })).message.content).toBe('second')
    expect(model.remaining()).toBe(1)
    expect((await model.complete({ messages: [user('y')], model: 'other' })).model).toBe('other')
    expect(model.remaining()).toBe(0)
  })

  it('throws a clear error when the script runs out', async () => {
    const model = scriptedModel(['only'])
    await model.complete({ messages: [user('a')] })
    const err = await model.complete({ messages: [user('what now?')] }).catch((e) => e)
    expect(isMpError(err, 'script_exhausted')).toBe(true)
    expect(err.message).toContain('call #2')
    expect(err.message).toContain('what now?')
    expect(model.calls).toHaveLength(2)
  })

  it('supports push to extend an array script', async () => {
    const model = scriptedModel([])
    model.push('late')
    expect((await model.complete({ messages: [] })).message.content).toBe('late')
    expect(() => scriptedModel(() => 'x').push('y')).toThrow()
  })

  it('accepts a function script with the call index', async () => {
    const model = scriptedModel(async (req, i) => `call ${i}: ${req.messages.at(-1)?.content}`)
    expect((await model.complete({ messages: [user('a')] })).message.content).toBe('call 0: a')
    expect((await model.complete({ messages: [user('b')] })).message.content).toBe('call 1: b')
    expect(model.remaining()).toBe(Number.POSITIVE_INFINITY)
  })

  it('mixes responder functions and errors in an array script', async () => {
    const model = scriptedModel([(req) => reply(`echo ${req.messages.length}`), new Error('boom')])
    expect((await model.complete({ messages: [user('a'), user('b')] })).message.content).toBe('echo 2')
    await expect(model.complete({ messages: [] })).rejects.toThrow('boom')
  })

  it('records copies of every request', async () => {
    const model = scriptedModel(['ok'])
    const messages = [user('original')]
    const tools = [toolSpec('t', 'a tool')]
    await model.complete({ messages, tools, maxTokens: 10 })
    messages[0]!.content = 'mutated'
    expect(model.calls[0]!.messages[0]!.content).toBe('original')
    expect(model.calls[0]!.tools).toEqual(tools)
    expect(model.calls[0]!.maxTokens).toBe(10)
  })

  it('builds tool calls with generated ids and finish reason tool_calls', async () => {
    const model = scriptedModel([
      callTools([{ name: 'a.b', args: { x: 1 } }, { name: 'c' }], 'thinking aloud'),
      { message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'z', arguments: '{}' } }] } },
    ])
    const r = await model.complete({ messages: [user('go')] })
    expect(r.finishReason).toBe('tool_calls')
    expect(r.message.content).toBe('thinking aloud')
    const calls = r.message.tool_calls!
    expect(calls).toHaveLength(2)
    expect(calls[0]!.id).toMatch(/^call_/)
    expect(calls[0]!.id).not.toBe(calls[1]!.id)
    expect(calls[0]!.function).toEqual({ name: 'a.b', arguments: '{"x":1}' })
    expect(calls[1]!.function.arguments).toBe('{}')
    expect((await model.complete({ messages: [] })).finishReason).toBe('tool_calls')
  })

  it('uses explicit ids and raw argument strings', () => {
    const r = callTools([{ id: 'call_fixed', name: 'n', args: '{"raw":true}' }])
    expect(r.message.tool_calls![0]).toEqual({
      id: 'call_fixed',
      type: 'function',
      function: { name: 'n', arguments: '{"raw":true}' },
    })
    expect(r.message.content).toBeNull()
  })

  it('estimates usage from lengths when not given', async () => {
    const model = scriptedModel([reply('x'.repeat(40)), { message: { content: 'abcd', reasoning_content: 'r'.repeat(8) } }])
    const messages = [user('y'.repeat(100))]
    const a = await model.complete({ messages })
    expect(a.usage.promptTokens).toBe(estimateTokens(JSON.stringify(messages)))
    expect(a.usage.completionTokens).toBe(10)
    expect(a.usage.totalTokens).toBe(a.usage.promptTokens + 10)
    expect(a.usage.cachedTokens).toBe(0)
    const b = await model.complete({ messages })
    expect(b.usage.reasoningTokens).toBe(2)
    expect(b.usage.completionTokens).toBe(3)
  })

  it('keeps usage the step gives, filling in the rest', async () => {
    const model = scriptedModel([reply('hi', { promptTokens: 100, completionTokens: 5, cachedTokens: 80 })])
    const r = await model.complete({ messages: [user('q')] })
    expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 5, cachedTokens: 80, reasoningTokens: 0, totalTokens: 105 })
  })

  it('streams reasoning then content in chunks', async () => {
    const model = scriptedModel([{ message: { content: 'Hello, world!', reasoning_content: 'let me think' } }], { chunkSize: 5 })
    const deltas: ModelDelta[] = []
    const r = await model.complete({ messages: [], onDelta: (d) => deltas.push(d) })
    expect(deltas).toEqual([
      { reasoning: 'let m' },
      { reasoning: 'e thi' },
      { reasoning: 'nk' },
      { content: 'Hello' },
      { content: ', wor' },
      { content: 'ld!' },
    ])
    expect(r.message.content).toBe('Hello, world!')
    expect(r.message.reasoning_content).toBe('let me think')
  })

  it('rejects an already aborted request', async () => {
    const model = scriptedModel(['never'])
    const ac = new AbortController()
    ac.abort()
    await expect(model.complete({ messages: [], signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(model.calls).toHaveLength(1)
  })

  it('aborts while streaming', async () => {
    const model = scriptedModel(['a'.repeat(100)], { chunkSize: 1 })
    const ac = new AbortController()
    const deltas: ModelDelta[] = []
    const p = model.complete({
      messages: [],
      signal: ac.signal,
      onDelta: (d) => {
        deltas.push(d)
        if (deltas.length === 3) ac.abort(new Error('stop now'))
      },
    })
    await expect(p).rejects.toThrow('stop now')
    expect(deltas).toHaveLength(3)
  })

  it('aborts while a responder is pending', async () => {
    const ac = new AbortController()
    const model = scriptedModel(async () => {
      ac.abort()
      return 'late'
    })
    await expect(model.complete({ messages: [], signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('handles concurrent calls with distinct indices', async () => {
    const model = scriptedModel((_req, i) => new Promise((r) => setTimeout(() => r(`#${i}`), 5 - i)))
    const results = await Promise.all([0, 1, 2].map(() => model.complete({ messages: [] })))
    expect(results.map((r) => r.message.content)).toEqual(['#0', '#1', '#2'])
  })
})

describe('parseToolArguments', () => {
  const call = (args: string) => ({ function: { name: 'x', arguments: args } })
  it('parses objects and treats empty as {}', () => {
    expect(parseToolArguments(call('{"a":1}'))).toEqual({ ok: true, args: { a: 1 } })
    expect(parseToolArguments(call(''))).toEqual({ ok: true, args: {} })
    expect(parseToolArguments(call('  '))).toEqual({ ok: true, args: {} })
  })
  it('reports invalid JSON and non-objects without throwing', () => {
    const bad = parseToolArguments(call('{"a":'))
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error).toContain('invalid JSON')
      expect(bad.raw).toBe('{"a":')
    }
    expect(parseToolArguments(call('[1]')).ok).toBe(false)
    expect(parseToolArguments(call('null')).ok).toBe(false)
    expect(parseToolArguments(call('"s"')).ok).toBe(false)
  })
})

describe('toolSpec', () => {
  it('builds a function tool with default parameters', () => {
    expect(toolSpec('a', 'desc')).toEqual({
      type: 'function',
      function: { name: 'a', description: 'desc', parameters: { type: 'object', properties: {} } },
    })
    const params = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    expect(toolSpec('b', 'd', params).function.parameters).toBe(params)
  })
})
