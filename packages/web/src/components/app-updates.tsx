import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  APP_VERSION,
  createUpdateNotifier,
  createVersionWatcher,
  DEV_VERSION,
  fetchDeployedVersion,
  reloadApp,
} from '@/lib/app-version.ts'

/** One toast at a time: a newer version replaces the one shown. */
export const UPDATE_TOAST_ID = 'app-update'

/** The "new version" toast: stays until dismissed or refreshed, with one Refresh action. */
export function showUpdateToast() {
  toast('A new version of vegan is available', {
    id: UPDATE_TOAST_ID,
    description: 'Refresh to get the latest version.',
    duration: Number.POSITIVE_INFINITY,
    action: { label: 'Refresh', onClick: () => reloadApp() },
  })
}

const notifyNewVersion = createUpdateNotifier(showUpdateToast)

/**
 * Watches for a new deployment: checks /version.json every few minutes and when the tab comes back,
 * and shows the toast once per new version. A chunk that fails to preload (`vite:preloadError`) is a
 * sign of one, so it checks at once; the page itself is recovered by PageErrorBoundary.
 */
export function AppUpdates({ version = APP_VERSION }: { version?: string }) {
  useEffect(() => {
    if (version === DEV_VERSION) return undefined
    const watcher = createVersionWatcher({
      current: version,
      fetchVersion: () => fetchDeployedVersion(),
      onNewVersion: notifyNewVersion,
    })
    const onPreloadError = () => void watcher.check(true)
    watcher.start()
    window.addEventListener('vite:preloadError', onPreloadError)
    return () => {
      watcher.stop()
      window.removeEventListener('vite:preloadError', onPreloadError)
    }
  }, [version])
  return null
}
