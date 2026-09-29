import type { ApiClient } from '@mp/api'
import type { DataLayer } from '@/lib/api.tsx'
import type { MockDb } from './data.ts'
import { createMockApi } from './api.ts'
import { createMockDb } from './data.ts'
import { createMockLive, type MockLive, startSimulation } from './live.ts'
import { createMockNotifier, type MockNotifier } from './notifications.ts'

export { createMockApi } from './api.ts'
export { CHN, CON, createMockDb, EMP, mockId, PRC, PRO, RUN, SES } from './data.ts'
export { createMockLive, startSimulation } from './live.ts'
export { createMockNotifier, type MockNotifier } from './notifications.ts'

/**
 * The whole mock data layer: fake data, the mock API over it, and a live
 * source. With `simulate`, running sessions stream output and events arrive, and a new inbox
 * item (a mention, reply, DM, paused run or alert) comes in every so often. `notifier` sends one
 * on demand (tests call it; in dev:mock it is `window.mpMock.notifier` too).
 */
export function createMockDataLayer(
  opts: { simulate?: boolean; latencyMs?: number; now?: number } = {},
): DataLayer & { api: ApiClient & { db: MockDb }; live: MockLive; notifier: MockNotifier; stop(): void } {
  const db = createMockDb(opts.now !== undefined ? { now: opts.now } : {})
  const live = createMockLive(db.now)
  const api = createMockApi(db, { latencyMs: opts.latencyMs ?? 0, emit: live.emit })
  const notifier = createMockNotifier(db, live.emit)
  const stopSim = opts.simulate ? startSimulation(db, live) : () => {}
  if (opts.simulate) {
    notifier.start()
    ;(globalThis as { mpMock?: unknown }).mpMock = { notifier }
  }
  const stop = () => {
    stopSim()
    notifier.stop()
  }
  return { api, live, mock: true, notifier, stop }
}
