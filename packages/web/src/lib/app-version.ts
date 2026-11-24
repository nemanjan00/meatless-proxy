/**
 * New-version detection: every build bakes in its version (the git commit, `__APP_VERSION__`, see
 * vite.config.ts) and ships `/version.json` with the same value. The running app checks that file;
 * when the deployed version differs, it offers a refresh.
 */

declare const __APP_VERSION__: string | undefined

export const DEV_VERSION = 'dev'
/** The running build's version: the git commit, or `dev` (a local build, tests). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : DEV_VERSION
/** How often a visible tab checks for a new deployment. */
export const POLL_INTERVAL_MS = 5 * 60_000
/** Focus and visibility checks are skipped when the last check is more recent than this. */
export const MIN_CHECK_GAP_MS = 30_000

/** Reads `{ "version": "<sha>" }`; anything else is null. */
export function parseVersionFile(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('version' in body) || typeof body.version !== 'string') return null
  return body.version.trim() || null
}

/** A different, known deployed version means a new deployment; a dev build never asks. */
export const isNewVersion = (running: string, deployed: string | null): deployed is string =>
  running !== DEV_VERSION && deployed !== null && deployed !== DEV_VERSION && deployed !== running

/** The deployed version from `/version.json`, past every cache; null when it can't be read. */
export async function fetchDeployedVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  const res = await fetcher('/version.json', { cache: 'no-store', headers: { accept: 'application/json' } })
  if (!res.ok) return null
  return parseVersionFile(await res.json())
}

export interface VersionWatcherOptions {
  current: string
  fetchVersion(): Promise<string | null>
  onNewVersion(version: string): void
  intervalMs?: number
  minGapMs?: number
  now?(): number
}

export interface VersionWatcher {
  start(): void
  stop(): void
  /** Checks now (not while hidden or with a check in flight); `force` ignores the minimum gap. */
  check(force?: boolean): Promise<void>
}

/** Checks while the tab is visible: every `intervalMs`, and when it's shown or focused (at most once per `minGapMs`). */
export function createVersionWatcher(o: VersionWatcherOptions): VersionWatcher {
  const intervalMs = o.intervalMs ?? POLL_INTERVAL_MS
  const minGapMs = o.minGapMs ?? MIN_CHECK_GAP_MS
  const now = o.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | undefined
  let last = Number.NEGATIVE_INFINITY
  let inFlight = false
  let running = false
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

  const check = async (force = false) => {
    if (hidden() || inFlight || (!force && now() - last < minGapMs)) return
    inFlight = true
    last = now()
    try {
      const deployed = await o.fetchVersion()
      if (isNewVersion(o.current, deployed)) o.onNewVersion(deployed)
    } catch {
      // Offline or a failed request: the next tick tries again.
    } finally {
      inFlight = false
    }
  }
  const startTimer = () => {
    timer ??= setInterval(() => void check(true), intervalMs)
  }
  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const onVisibility = () => {
    if (hidden()) return stopTimer()
    startTimer()
    void check()
  }
  const onFocus = () => void check()

  return {
    start() {
      if (running) return
      running = true
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('focus', onFocus)
      if (!hidden()) startTimer()
    },
    stop() {
      running = false
      stopTimer()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    },
    check,
  }
}

/** Calls `notify` once per new version, however often it's reported. */
export function createUpdateNotifier(notify: (version: string) => void): (version: string) => void {
  const seen = new Set<string>()
  return (v) => {
    if (seen.has(v)) return
    seen.add(v)
    notify(v)
  }
}

/** A full reload onto the latest deployment (to `url` when given, else this page). */
export function reloadApp(url?: string) {
  if (url && url !== window.location.href) window.location.assign(url)
  else window.location.reload()
}
