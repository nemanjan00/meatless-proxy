import { createChatAttachments, createImageDescriber } from '@mp/chat'
import { encodePng, memoryStorage } from '@mp/files'
import { openAiModel } from '@mp/model-openai'
import { createRecords } from '@mp/records'
import { memoryStore } from '@mp/store'
import { describe, expect, it } from 'vitest'

// Opt-in: one real describe call (MP_LIVE_MODEL_TEST=1, with OPENAI_BASE_URL, OPENAI_API_KEY and MODEL set).
const live = process.env.MP_LIVE_MODEL_TEST === '1'

/** 5x7 bitmap glyphs, enough for the word. */
const GLYPHS: Record<string, string[]> = {
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
}

/** A PNG with `word` drawn in black on white, `scale` pixels per dot. No dependencies: our own PNG encoder. */
export function wordPng(word: string, scale = 12): Uint8Array {
  const margin = 2 * scale
  const width = margin * 2 + word.length * 6 * scale - scale
  const height = margin * 2 + 7 * scale
  const data = new Uint8Array(width * height * 4).fill(255)
  ;[...word].forEach((ch, i) => {
    GLYPHS[ch]!.forEach((row, y) => {
      ;[...row].forEach((bit, x) => {
        if (bit !== '1') return
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const px = margin + (i * 6 + x) * scale + dx
            const py = margin + y * scale + dy
            data.fill(0, (py * width + px) * 4, (py * width + px) * 4 + 3)
          }
      })
    })
  })
  return encodePng({ width, height, data })
}

describe.skipIf(!live)('image descriptions, live (MP_LIVE_MODEL_TEST=1)', () => {
  it('describes a generated PNG with a word drawn in it, and reads the word', { timeout: 180_000 }, async () => {
    const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env
    if (!OPENAI_BASE_URL || !OPENAI_API_KEY || !MODEL) throw new Error('set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL')
    const model = openAiModel({
      baseUrl: OPENAI_BASE_URL,
      apiKey: OPENAI_API_KEY,
      model: MODEL,
      maxRetries: 1,
      timeoutMs: 170_000,
    })
    const records = createRecords({ store: memoryStore() })
    const attachments = createChatAttachments({ records, storage: memoryStorage() })
    const usage: number[] = []
    const describer = createImageDescriber({
      records,
      attachments,
      model,
      vision: true,
      onUsage: async (u) => {
        usage.push(u.usage.totalTokens)
      },
    })
    const out = await describer.describeBytes(wordPng('HELLO'))
    console.log('live describe:', JSON.stringify(out, null, 2), 'tokens:', usage)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(`${out.description.description} ${out.description.text ?? ''}`.toUpperCase()).toContain('HELLO')
    expect(usage[0]).toBeGreaterThan(0)
  })
})
