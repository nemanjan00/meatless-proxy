import { describe, expect, it } from 'vitest'
import { createLinearClient } from '../src/index.ts'

/** Opt-in: `MP_LIVE_LINEAR=1 LINEAR_API_KEY=… npx vitest run --project node packages/integration-linear`. One read call. */
const live = process.env.MP_LIVE_LINEAR === '1' && !!process.env.LINEAR_API_KEY

describe.skipIf(!live)('linear live smoke test', () => {
  it('reads the viewer', async () => {
    const client = createLinearClient({ apiKey: process.env.LINEAR_API_KEY!, maxRetries: 1 })
    const d = await client.request('query Viewer { viewer { id name } }')
    expect(typeof d.viewer.id).toBe('string')
  })
})
