import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppUpdates } from '../src/components/app-updates.tsx'
import { PageErrorBoundary } from '../src/components/page-error.tsx'
import { Toaster } from '../src/components/ui/sonner.tsx'
import { createVersionWatcher, isNewVersion, parseVersionFile } from '../src/lib/app-version.ts'
import { claimChunkReload, isChunkLoadError, RELOAD_GUARD_MS } from '../src/lib/chunk-error.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('stale chunks', () => {
  it('are recognised in every browser’s words, and in a cause', () => {
    for (const m of [
      'Failed to fetch dynamically imported module: https://x/assets/a.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      "'text/html' is not a valid JavaScript MIME type.",
      'Unable to preload CSS for /assets/b.css',
    ])
      expect(isChunkLoadError(new TypeError(m)), m).toBe(true)
    expect(isChunkLoadError(new Error('wrapped', { cause: new TypeError('Importing a module script failed.') }))).toBe(true)
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
  })

  it('get one automatic reload per version and page a minute', () => {
    const now = 1_000_000
    expect(claimChunkReload('https://v/now', 'abc', sessionStorage, now)).toBe(true)
    expect(claimChunkReload('https://v/now', 'abc', sessionStorage, now + 1000)).toBe(false)
    expect(claimChunkReload('https://v/chat', 'abc', sessionStorage, now + 1000)).toBe(true)
    expect(claimChunkReload('https://v/now', 'def', sessionStorage, now + 1000)).toBe(true)
    expect(claimChunkReload('https://v/now', 'abc', sessionStorage, now + RELOAD_GUARD_MS + 1)).toBe(true)
    expect(claimChunkReload('https://v/now', 'abc', null)).toBe(false)
  })
})

describe('new versions', () => {
  it('read version.json and tell a new deployment from the running one (never in dev)', () => {
    expect(parseVersionFile({ version: ' abc ' })).toBe('abc')
    expect(parseVersionFile({})).toBeNull()
    expect(isNewVersion('abc', 'def')).toBe(true)
    expect(isNewVersion('abc', 'abc')).toBe(false)
    expect(isNewVersion('dev', 'def')).toBe(false)
    expect(isNewVersion('abc', null)).toBe(false)
  })

  it('are checked on a timer and on focus, at most once per gap', async () => {
    vi.useFakeTimers()
    let t = 0
    const fetchVersion = vi.fn(async () => 'new')
    const onNewVersion = vi.fn()
    const w = createVersionWatcher({ current: 'old', fetchVersion, onNewVersion, intervalMs: 1000, minGapMs: 500, now: () => t })
    w.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchVersion).toHaveBeenCalledTimes(1)
    expect(onNewVersion).toHaveBeenCalledWith('new')
    t = 100
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchVersion).toHaveBeenCalledTimes(1) // within the gap
    t = 2000
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchVersion).toHaveBeenCalledTimes(2)
    w.stop()
    vi.useRealTimers()
  })

  it('show one toast with Refresh when the deployed version differs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ version: 'v2' }), { status: 200 })),
    )
    render(
      <>
        <Toaster />
        <AppUpdates version="v1" />
      </>,
    )
    await act(async () => {
      window.dispatchEvent(new Event('vite:preloadError'))
    })
    expect(await screen.findByText('A new version of vegan is available')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })
})

describe('a page that fails to load', () => {
  const Broken = ({ error }: { error: Error }) => {
    throw error
  }

  it('reloads once onto the new build when its chunk is gone, then says so with a Reload button', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, href: 'https://v/chat', reload, assign: vi.fn() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stale = new TypeError('Failed to fetch dynamically imported module: https://v/assets/chat-1.js')
    const first = render(
      <PageErrorBoundary>
        <Broken error={stale} />
      </PageErrorBoundary>,
    )
    expect(screen.getByText('Loading the new version…')).toBeInTheDocument()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    first.unmount()
    // The reload didn't help (same version and page): no loop, a message instead of a blank page.
    const again = new TypeError(stale.message)
    render(
      <PageErrorBoundary>
        <Broken error={again} />
      </PageErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('This page has been updated')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('shows any other error with a Reload button, not a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <PageErrorBoundary>
        <Broken error={new Error('boom')} />
      </PageErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on this page')
  })
})
