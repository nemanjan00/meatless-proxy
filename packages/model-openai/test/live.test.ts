import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { openAiModel } from '../src/index.ts'

// Opt-in: one tiny call to the real provider. Needs MP_LIVE_MODEL_TEST=1 and
// OPENAI_BASE_URL, OPENAI_API_KEY, MODEL in the environment.
const live = process.env.MP_LIVE_MODEL_TEST === '1'

describe.skipIf(!live)('openAiModel live smoke test (MP_LIVE_MODEL_TEST=1)', () => {
  it('gets a non-empty answer', { timeout: 120_000 }, async () => {
    const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env
    if (!OPENAI_BASE_URL || !OPENAI_API_KEY || !MODEL) throw new Error('set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL')
    const model = openAiModel({
      baseUrl: OPENAI_BASE_URL,
      apiKey: OPENAI_API_KEY,
      model: MODEL,
      maxRetries: 1,
      timeoutMs: 110_000,
    })
    let streamed = ''
    const r = await model.complete({
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      maxTokens: 200,
      onDelta: (d) => (streamed += d.content ?? ''),
    })
    expect((r.message.content ?? '').trim().length).toBeGreaterThan(0)
    expect(streamed).toBe(r.message.content)
    expect(r.usage.totalTokens).toBeGreaterThan(0)
  })

  it('sees an image returned by a tool: a red square', { timeout: 120_000 }, async () => {
    const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env
    if (!OPENAI_BASE_URL || !OPENAI_API_KEY || !MODEL) throw new Error('set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL')
    const model = openAiModel({
      baseUrl: OPENAI_BASE_URL,
      apiKey: OPENAI_API_KEY,
      model: MODEL,
      maxRetries: 1,
      timeoutMs: 110_000,
    })
    const data = Buffer.from(redSquarePng()).toString('base64')
    const r = await model.complete({
      maxTokens: 2000,
      messages: [
        { role: 'user', content: 'Look at the image, then answer with one word: what colour is it?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'image__view', arguments: '{"path":"/red.png"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '{"image":"red.png"}',
          images: [{ type: 'image', mime: 'image/png', name: 'red.png', width: 32, height: 32, data }],
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'image__view', description: 'Look at an image.', parameters: { type: 'object', properties: {} } },
        },
      ],
    })
    expect((r.message.content ?? '').toLowerCase()).toContain('red')
  })
})

/** A 32x32 red PNG, built here so the test needs nothing else. */
function redSquarePng(): Uint8Array {
  const w = 32
  const raw = Buffer.alloc((w * 3 + 1) * w)
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) raw.set([220, 20, 20], y * (w * 3 + 1) + 1 + x * 3)
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), body])) >>> 0)
    return Buffer.concat([len, Buffer.from(type), body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(w, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
