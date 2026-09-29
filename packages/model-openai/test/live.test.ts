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
})
