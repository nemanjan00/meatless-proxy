import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isMpError, memoryLogger, MpError, UnavailableError } from '@mp/core'
import type { ModelDelta } from '@mp/model'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mapUsage, openAiModel, parseRetryAfter, type OpenAiModelOptions } from '../src/index.ts'

const KEY = 'sk-test-secret-key'

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: any
}
type Handler = (req: Seen, res: ServerResponse) => void | Promise<void>

let server: Server
let baseUrl: string
let handlers: Handler[] = []
let seen: Seen[] = []

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const s: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
    seen.push(s)
    const h = handlers.shift()
    if (!h) {
      res.writeHead(500).end('no handler')
      return
    }
    await h(s, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})
beforeEach(() => {
  handlers = []
  seen = []
})

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}): Handler =>
  (_r, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
  }
const sse =
  (chunks: Array<unknown | string>, opts: { done?: boolean; split?: boolean } = {}): Handler =>
  async (_r, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const c of chunks) {
      const line = `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`
      if (opts.split) {
        // Write byte-by-byte-ish to exercise line reassembly.
        for (let i = 0; i < line.length; i += 7) {
          res.write(line.slice(i, i + 7))
          await new Promise((r) => setImmediate(r))
        }
      } else res.write(line)
    }
    if (opts.done !== false) res.write('data: [DONE]\n\n')
    res.end()
  }
const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'cmpl-1',
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  ...extra,
})

const make = (o: Partial<OpenAiModelOptions> = {}) =>
  openAiModel({ baseUrl, apiKey: KEY, model: 'test-model', retryBaseMs: 1, retryMaxMs: 50, random: () => 0, ...o })

describe('openAiModel non-streaming', () => {
  it('posts a chat completion and maps the response', async () => {
    handlers.push(json(completion({ content: 'Hello!' })))
    const model = make()
    expect(model.defaultModel).toBe('test-model')
    const r = await model.complete({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }],
      maxTokens: 200,
      temperature: 0.2,
    })
    expect(r).toEqual({
      message: { role: 'assistant', content: 'Hello!' },
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, reasoningTokens: 0 },
      model: 'test-model',
    })
    const req = seen[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/v1/chat/completions')
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(req.body).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }],
      max_tokens: 200,
      temperature: 0.2,
    })
  })

  it('trims a trailing slash in baseUrl, omits unset fields, uses the request model', async () => {
    handlers.push(json(completion({ content: 'x' }, { model: 'other' })))
    const model = openAiModel({ baseUrl: `${baseUrl}/`, apiKey: KEY, model: 'test-model' })
    const r = await model.complete({ model: 'other', messages: [{ role: 'user', content: 'q' }] })
    expect(seen[0]!.url).toBe('/v1/chat/completions')
    expect(seen[0]!.body).toEqual({ model: 'other', messages: [{ role: 'user', content: 'q' }] })
    expect(r.model).toBe('other')
  })

  it('round-trips tool calls, tool results and reasoning_content in history', async () => {
    handlers.push(
      json({
        model: 'test-model',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'I should call the tool',
              tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      }),
    )
    const history = [
      { role: 'user' as const, content: 'go' },
      {
        role: 'assistant' as const,
        content: null,
        reasoning_content: 'earlier thought',
        tool_calls: [{ id: 'call_0', type: 'function' as const, function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'tool' as const, content: 'result', tool_call_id: 'call_0' },
    ]
    const r = await make().complete({ messages: history })
    expect(seen[0]!.body.messages).toEqual(history)
    expect(r.finishReason).toBe('tool_calls')
    expect(r.message).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'I should call the tool',
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    })
    expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 40, totalTokens: 140, cachedTokens: 64, reasoningTokens: 30 })
  })

  it('throws a plain MpError with status on 4xx, without retrying, and without the key', async () => {
    handlers.push(json({ error: { message: `bad request, key was ${KEY}` } }, 400))
    const err = await make()
      .complete({ messages: [] })
      .catch((e) => e)
    expect(err).toBeInstanceOf(MpError)
    expect(err).not.toBeInstanceOf(UnavailableError)
    expect(err.code).toBe('model_request')
    expect(err.details.status).toBe(400)
    expect(err.message).toContain('HTTP 400: bad request')
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(KEY)
    expect(seen).toHaveLength(1)
  })

  it('does not retry 401', async () => {
    handlers.push(json({ error: { message: 'invalid key' } }, 401))
    const err = await make()
      .complete({ messages: [] })
      .catch((e) => e)
    expect(err.details.status).toBe(401)
    expect(seen).toHaveLength(1)
  })

  it('throws on a response without choices', async () => {
    handlers.push(json({ choices: [] }))
    await expect(make().complete({ messages: [] })).rejects.toMatchObject({ code: 'model_response' })
  })
})

describe('openAiModel retries', () => {
  it('retries 429 and 5xx, then succeeds', async () => {
    const logger = memoryLogger()
    handlers.push(json({ error: { message: 'slow down' } }, 429), json({}, 503), json(completion({ content: 'ok' })))
    const r = await make({ logger }).complete({ messages: [] })
    expect(r.message.content).toBe('ok')
    expect(seen).toHaveLength(3)
    const warns = logger.lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(2)
    expect(JSON.stringify(logger.lines)).not.toContain(KEY)
  })

  it('throws UnavailableError after exhausting retries', async () => {
    handlers.push(json({}, 500), json({}, 502), json({}, 500))
    const err = await make({ maxRetries: 2 })
      .complete({ messages: [] })
      .catch((e) => e)
    expect(err).toBeInstanceOf(UnavailableError)
    expect(err.details).toMatchObject({ attempts: 3, status: 500 })
    expect(seen).toHaveLength(3)
  })

  it('respects Retry-After (seconds), capped by retryMaxMs', async () => {
    handlers.push(json({}, 429, { 'retry-after': '0.2' }), json(completion({ content: 'ok' })))
    const t0 = Date.now()
    await make({ retryMaxMs: 1000 }).complete({ messages: [] })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180)

    handlers.push(json({}, 429, { 'retry-after': '100' }), json(completion({ content: 'ok' })))
    const t1 = Date.now()
    await make({ retryMaxMs: 20 }).complete({ messages: [] })
    expect(Date.now() - t1).toBeLessThan(1000)
  })

  it('retries network errors', async () => {
    let n = 0
    const flaky: typeof fetch = async (input, init) => {
      if (n++ === 0) throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') })
      return fetch(input, init)
    }
    handlers.push(json(completion({ content: 'ok' })))
    const r = await make({ fetch: flaky }).complete({ messages: [] })
    expect(r.message.content).toBe('ok')
    expect(n).toBe(2)
  })

  it('reports network failures as UnavailableError', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    const err = await make({ fetch: down, maxRetries: 1 })
      .complete({ messages: [] })
      .catch((e) => e)
    expect(err).toBeInstanceOf(UnavailableError)
    expect(err.message).toContain('network error')
  })

  it('computes exponential backoff with jitter', async () => {
    const delays: number[] = []
    const logger = memoryLogger()
    handlers.push(json({}, 500), json({}, 500), json({}, 500), json(completion({ content: 'ok' })))
    await make({ logger, retryBaseMs: 4, retryMaxMs: 100, random: () => 0.999 }).complete({ messages: [] })
    for (const l of logger.lines) if (l.level === 'warn') delays.push(l.fields.delayMs as number)
    expect(delays).toEqual([4, 8, 16])
  })
})

describe('openAiModel streaming', () => {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: null, ...extra }],
  })

  it('streams content and reasoning to onDelta and assembles the message', async () => {
    handlers.push(
      sse(
        [
          chunk({ role: 'assistant', reasoning_content: 'Think' }),
          chunk({ reasoning_content: 'ing.' }),
          chunk({ content: 'Hel' }),
          chunk({ content: 'lo' }),
          chunk({}, { finish_reason: 'stop' }),
          {
            model: 'test-model',
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16, cached_tokens: 3 },
          },
        ],
        { split: true },
      ),
    )
    const deltas: ModelDelta[] = []
    const r = await make().complete({ messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => deltas.push(d) })
    expect(seen[0]!.body.stream).toBe(true)
    expect(seen[0]!.body.stream_options).toEqual({ include_usage: true })
    expect(seen[0]!.headers.accept).toBe('text/event-stream')
    expect(deltas).toEqual([{ reasoning: 'Think' }, { reasoning: 'ing.' }, { content: 'Hel' }, { content: 'lo' }])
    expect(r.message).toEqual({ role: 'assistant', content: 'Hello', reasoning_content: 'Thinking.' })
    expect(r.finishReason).toBe('stop')
    expect(r.usage).toEqual({ promptTokens: 7, completionTokens: 9, totalTokens: 16, cachedTokens: 3, reasoningTokens: 0 })
  })

  it('assembles tool calls split across chunks by index', async () => {
    handlers.push(
      sse([
        chunk({ content: 'Let me check.' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
        chunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"id"' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: ':3}' } }] }),
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'tool_calls',
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            },
          ],
        },
      ]),
    )
    const r = await make({ stream: true }).complete({ messages: [] })
    expect(r.finishReason).toBe('tool_calls')
    expect(r.message.content).toBe('Let me check.')
    expect(r.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } },
      { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"id":3}' } },
    ])
    // Kimi puts usage inside the final choice.
    expect(r.usage.totalTokens).toBe(3)
  })

  it('gives null content for tool-call-only streams', async () => {
    handlers.push(
      sse([
        chunk({ content: '', tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{}' } }] }),
        chunk({}, { finish_reason: 'tool_calls' }),
      ]),
    )
    const r = await make().complete({ messages: [], onDelta: () => {} })
    expect(r.message.content).toBeNull()
    expect(r.message.tool_calls).toHaveLength(1)
  })

  it('reads reasoning token details from streamed usage', async () => {
    handlers.push(
      sse([
        chunk({ content: 'a' }, { finish_reason: 'stop' }),
        {
          choices: [],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 120,
            total_tokens: 170,
            prompt_tokens_details: { cached_tokens: 48 },
            completion_tokens_details: { reasoning_tokens: 100 },
          },
        },
      ]),
    )
    const r = await make().complete({ messages: [], onDelta: () => {} })
    expect(r.usage).toEqual({ promptTokens: 50, completionTokens: 120, totalTokens: 170, cachedTokens: 48, reasoningTokens: 100 })
  })

  it('does not stream when stream is false even with onDelta', async () => {
    handlers.push(json(completion({ content: 'plain' })))
    const deltas: ModelDelta[] = []
    const r = await make({ stream: false }).complete({ messages: [], onDelta: (d) => deltas.push(d) })
    expect(seen[0]!.body.stream).toBeUndefined()
    expect(r.message.content).toBe('plain')
    expect(deltas).toEqual([])
  })

  it('retries a stream that breaks before any output', async () => {
    handlers.push(sse([], { done: false }), sse([chunk({ content: 'ok' }, { finish_reason: 'stop' })]))
    const r = await make().complete({ messages: [], onDelta: () => {} })
    expect(r.message.content).toBe('ok')
    expect(seen).toHaveLength(2)
  })

  it('fails without retrying when a stream breaks after output', async () => {
    handlers.push(sse([chunk({ content: 'partial' })], { done: false }))
    const err = await make()
      .complete({ messages: [], onDelta: () => {} })
      .catch((e) => e)
    expect(err).toBeInstanceOf(UnavailableError)
    expect(err.message).toContain('stream broke')
    expect(seen).toHaveLength(1)
  })

  it('surfaces an error event in the stream', async () => {
    handlers.push(sse([{ error: { message: 'context too long' } }]))
    await expect(make().complete({ messages: [], onDelta: () => {} })).rejects.toThrow('context too long')
  })
})

describe('openAiModel abort and timeout', () => {
  const hang: Handler = () => {}

  it('aborts an in-flight request via signal, without retrying', async () => {
    handlers.push(hang)
    const ac = new AbortController()
    const p = make().complete({ messages: [], signal: ac.signal })
    setTimeout(() => ac.abort(), 30)
    const err = await p.catch((e) => e)
    expect(err.name).toBe('AbortError')
    expect(seen).toHaveLength(1)
  })

  it('aborts during a stream', async () => {
    const ac = new AbortController()
    handlers.push(async (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })}\n\n`)
    })
    const err = await make()
      .complete({ messages: [], signal: ac.signal, onDelta: () => ac.abort(new Error('user stop')) })
      .catch((e) => e)
    expect(err.message).toBe('user stop')
  })

  it('rejects immediately when already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(make().complete({ messages: [], signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen).toHaveLength(0)
  })

  it('aborts during backoff', async () => {
    handlers.push(json({}, 503))
    const ac = new AbortController()
    const p = make({ retryBaseMs: 5000, retryMaxMs: 5000 }).complete({ messages: [], signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('times out and retries, then gives UnavailableError', async () => {
    handlers.push(hang, hang)
    const err = await make({ timeoutMs: 50, maxRetries: 1 })
      .complete({ messages: [] })
      .catch((e) => e)
    expect(err).toBeInstanceOf(UnavailableError)
    expect(err.message).toContain('timed out after 50 ms')
    expect(seen).toHaveLength(2)
  })

  it('recovers when a retry after a timeout succeeds', async () => {
    handlers.push(hang, json(completion({ content: 'fine' })))
    const r = await make({ timeoutMs: 50 }).complete({ messages: [] })
    expect(r.message.content).toBe('fine')
  })
})

describe('helpers', () => {
  it('mapUsage handles missing and partial usage', () => {
    expect(mapUsage(undefined)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    })
    expect(mapUsage({ prompt_tokens: 3, completion_tokens: 4 }).totalTokens).toBe(7)
    expect(mapUsage({ prompt_tokens: 3, cached_tokens: 2 }).cachedTokens).toBe(2)
    expect(mapUsage({ prompt_tokens_details: { cached_tokens: 5 }, cached_tokens: 2 }).cachedTokens).toBe(5)
  })
  it('parseRetryAfter handles seconds and dates', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined()
    expect(parseRetryAfter('2', 0)).toBe(2000)
    const now = Date.UTC(2026, 0, 1)
    expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBe(3000)
    expect(parseRetryAfter('garbage', now)).toBeUndefined()
  })
  it('never puts the API key into thrown errors', async () => {
    const leaky: typeof fetch = async () => {
      throw new Error(`failed with ${KEY}`)
    }
    const err = await make({ fetch: leaky, maxRetries: 0 })
      .complete({ messages: [] })
      .catch((e) => e)
    expect(isMpError(err, 'unavailable')).toBe(true)
    expect(err.message).not.toContain(KEY)
  })
})

describe('image input', () => {
  const img = (name: string, data?: string) => ({
    type: 'image' as const,
    mime: 'image/png',
    name,
    width: 2,
    height: 3,
    ...(data ? { data } : {}),
  })

  it('sends a tool result as text and its images in one user message after the last tool message', async () => {
    handlers.push(json(completion({ content: 'red' })))
    await make().complete({
      messages: [
        { role: 'user', content: 'look' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'image__view', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'image__view', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"image":"a.png"}', images: [img('a.png', 'QUFB')] },
        { role: 'tool', tool_call_id: 'c2', content: '{"image":"b.png"}', images: [img('b.png', 'QkJC'), img('gone.png')] },
      ],
    })
    const msgs = seen[0]!.body.messages
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    expect(msgs[2].content).toBe('{"image":"a.png"}\n[image a.png, 2x3, attached below]')
    expect(msgs[3].content).toContain('[image gone.png: no longer available]')
    expect(typeof msgs[3].content).toBe('string')
    expect(msgs[4].content).toEqual([
      { type: 'text', text: '[the 2 images from the tool results above]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUFB' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QkJC' } },
    ])
    // No image field leaks into the wire format.
    expect(JSON.stringify(msgs)).not.toContain('"images"')
  })

  it('puts a user message’s images in its content parts, and flushes tool images before the next message', async () => {
    handlers.push(json(completion({ content: 'ok' })))
    await make().complete({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'done', images: [img('a.png', 'QUFB')] },
        { role: 'user', content: 'and this one?', images: [img('c.png', 'Q0ND'), img('d.png')] },
      ],
    })
    const msgs = seen[0]!.body.messages
    expect(msgs.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'user', 'user'])
    expect(msgs[2].content[1].image_url.url).toBe('data:image/png;base64,QUFB')
    expect(msgs[3].content).toEqual([
      { type: 'text', text: 'and this one?\n[image d.png: no longer available]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,Q0ND' } },
    ])
  })

  it('leaves messages without images exactly as before', async () => {
    handlers.push(json(completion({ content: 'ok' })))
    await make().complete({ messages: [{ role: 'user', content: 'hi', images: [] }] })
    expect(seen[0]!.body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('capabilities', () => {
  it('reads supports_image_in or modalities from GET /models, cached per model', async () => {
    const list = {
      data: [
        { id: 'test-model', supports_image_in: true },
        { id: 'text-only', modalities: { input: ['text'] } },
        { id: 'silent' },
      ],
    }
    handlers.push(json(list), json(list), json(list))
    const m = make()
    expect(await m.capabilities!()).toEqual({ vision: true })
    expect(await m.capabilities!()).toEqual({ vision: true })
    expect(await m.capabilities!('text-only')).toEqual({ vision: false })
    expect(await m.capabilities!('silent')).toEqual({})
    expect(seen.map((x) => x.url)).toEqual(['/v1/models', '/v1/models', '/v1/models'])
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('answers null for unknown models, provider errors and broken responses', async () => {
    handlers.push(
      json({ data: [] }),
      json({ error: { message: 'nope' } }, 404),
      (_r, res) => void res.writeHead(200).end('not json'),
    )
    const m = make()
    expect(await m.capabilities!()).toBeNull()
    expect(await m.capabilities!('other')).toBeNull()
    expect(await m.capabilities!('broken')).toBeNull()
    expect(seen).toHaveLength(3)
  })
})
