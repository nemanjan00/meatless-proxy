import { createApiClient, createLiveClient } from '@mp/api'
import type { DataLayer } from '@/lib/api.tsx'
import { UNAUTHORIZED_EVENT, csrfToken } from '@/lib/auth.tsx'

/**
 * The real data layer: HTTP on the same origin (Vite proxies /api, /auth and /ws in development).
 * The session cookie goes along by itself; the CSRF cookie is echoed in `x-mp-csrf`, and a 401
 * sends the app to the login page.
 */
export function createServerDataLayer(): DataLayer {
  return {
    api: createApiClient({
      baseUrl: '',
      headers: (): Record<string, string> => {
        const csrf = csrfToken()
        return csrf ? { 'x-mp-csrf': csrf } : {}
      },
      onUnauthorized: () => window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)),
    }),
    live: createLiveClient({ url: '/ws' }),
    mock: false,
  }
}
