/**
 * Stale chunks: a tab still running an old build asks for a code-split chunk (`/assets/<hash>.js`) that
 * the new deployment no longer has, so the page's dynamic import fails. The app reloads once to pick up
 * the new build; the guard keeps that from looping.
 */

/** What each browser (and Vite's preload helper) says when a dynamic import or its CSS can't load. */
const CHUNK_ERROR_PATTERNS = [
  // Chrome, Edge
  /failed to fetch dynamically imported module/i,
  // Firefox
  /error loading dynamically imported module/i,
  // Safari
  /importing a module script failed/i,
  // An HTML page served instead of the chunk
  /expected a javascript(-or-wasm)? module script/i,
  /is not a valid javascript mime type/i,
  // Vite's preload helper, for a chunk's CSS
  /unable to preload css/i,
  /loading (css )?chunk [\w-]+ failed/i,
]

/** sessionStorage key prefix: one entry per running version and page. */
export const RELOAD_GUARD_PREFIX = 'mp.chunk-reload:'
/** A second failure on the same version and page within this window shows the error instead. */
export const RELOAD_GUARD_MS = 60_000

const messageOf = (error: unknown): string =>
  typeof error === 'string'
    ? error
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : ''

/** True when the error means a code-split chunk (or its CSS) couldn't be loaded, in any browser. */
export function isChunkLoadError(error: unknown, depth = 0): boolean {
  if (!error || depth > 3) return false
  if (typeof error === 'object' && 'name' in error && error.name === 'ChunkLoadError') return true
  if (CHUNK_ERROR_PATTERNS.some((p) => p.test(messageOf(error)))) return true
  return typeof error === 'object' && 'cause' in error ? isChunkLoadError(error.cause, depth + 1) : false
}

const sessionStore = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * Claims the one automatic reload for this version and page: true (and recorded) when none happened
 * in the last RELOAD_GUARD_MS. Without sessionStorage never, since a loop couldn't be stopped.
 */
export function claimChunkReload(
  url: string,
  version: string,
  storage: Storage | null = sessionStore(),
  now = Date.now(),
): boolean {
  if (!storage) return false
  try {
    const u = new URL(url, 'http://localhost')
    const key = `${RELOAD_GUARD_PREFIX}${version}:${u.pathname}${u.search}`
    const last = Number(storage.getItem(key))
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) return false
    storage.setItem(key, String(now))
    return true
  } catch {
    return false
  }
}
