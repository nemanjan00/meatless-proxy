import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { APP_VERSION, reloadApp } from '@/lib/app-version.ts'
import { claimChunkReload, isChunkLoadError } from '@/lib/chunk-error.ts'

// Decided once per error: React may call getDerivedStateFromError more than once for the same one.
const decisions = new WeakMap<object, boolean>()
const reloadsStarted = new WeakSet<object>()
const shouldReload = (error: unknown) => {
  if (!error || typeof error !== 'object' || !isChunkLoadError(error)) return false
  let d = decisions.get(error)
  if (d === undefined) {
    d = claimChunkReload(window.location.href, APP_VERSION)
    decisions.set(error, d)
  }
  return d
}

interface State {
  error: unknown
  reloading: boolean
}

/**
 * Catches a page that failed to load or render, instead of leaving a blank page. A page whose chunk is
 * gone (a new deployment replaced it) reloads once onto the new build; if that already happened for this
 * version and page, or the error is something else, it says so with a Reload button. Give it a `key`
 * per location so moving to another page clears it.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, reloading: false }

  static getDerivedStateFromError(error: unknown): State {
    return { error, reloading: shouldReload(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    if (this.state.reloading) {
      if (error && typeof error === 'object' && !reloadsStarted.has(error)) {
        reloadsStarted.add(error)
        reloadApp(window.location.href)
      }
    } else console.error('page failed', error, info.componentStack)
  }

  override render() {
    const { error, reloading } = this.state
    if (!error) return this.props.children
    if (reloading) return <div className="p-6 text-fg-tertiary">Loading the new version…</div>
    const stale = isChunkLoadError(error)
    return (
      <div className="flex flex-col items-start gap-3 p-6" role="alert">
        <div className="text-title3 font-medium">
          {stale ? 'This page has been updated' : 'Something went wrong on this page'}
        </div>
        <p className="max-w-md text-fg-tertiary">
          {stale
            ? 'A new version of vegan was deployed while this tab was open. Reload to get it.'
            : 'Reloading usually fixes it. If it keeps happening, tell an admin what you were doing.'}
        </p>
        <Button size="sm" onClick={() => reloadApp()}>
          Reload
        </Button>
      </div>
    )
  }
}
