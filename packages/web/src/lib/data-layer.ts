import { createApiClient, createLiveClient } from '@mp/api'
import type { DataLayer } from '@/lib/api.tsx'

/** The real data layer: HTTP on the same origin (Vite proxies /api and /ws in development). */
export function createServerDataLayer(): DataLayer {
  return {
    api: createApiClient({ baseUrl: '' }),
    live: createLiveClient({ url: '/ws' }),
    mock: false,
  }
}
