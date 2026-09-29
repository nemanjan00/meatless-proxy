import type { ApiClient } from '@mp/api'
import type { DataLayer } from '@/lib/api.tsx'
import type { MockDb } from './data.ts'
import { createMockApi } from './api.ts'
import { createMockDb } from './data.ts'
import { createMockLive, type MockLive, startSimulation } from './live.ts'

export { createMockApi } from './api.ts'
export { CHN, CON, createMockDb, EMP, mockId, PRO, RUN, SES } from './data.ts'
export { createMockLive, startSimulation } from './live.ts'

/**
 * The whole mock data layer: fake data, the mock API over it, and a live
 * source. With `simulate`, running sessions stream output and events arrive.
 */
export function createMockDataLayer(
  opts: { simulate?: boolean; latencyMs?: number; now?: number } = {},
): DataLayer & { api: ApiClient & { db: MockDb }; live: MockLive; stop(): void } {
  const db = createMockDb(opts.now !== undefined ? { now: opts.now } : {})
  const live = createMockLive(db.now)
  const api = createMockApi(db, { latencyMs: opts.latencyMs ?? 0, emit: live.emit })
  const stop = opts.simulate ? startSimulation(db, live) : () => {}
  return { api, live, mock: true, stop }
}
