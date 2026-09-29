import type { Me } from '@mp/api'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/app.tsx'
import { PREVIEW_SANDBOX } from '../src/components/preview-panel.tsx'
import { SES, createMockDataLayer } from '../src/mock/index.ts'
import { advancePreviewCommit } from '../src/mock/data.ts'

type Layer = ReturnType<typeof createMockDataLayer>

function renderAt(path: string, tweak?: (data: Layer) => void) {
  const data = createMockDataLayer({ now: Date.now() })
  tweak?.(data)
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return { ...utils, data }
}

const as = (access: Me['access']) => (data: Layer) => {
  data.api.me = async () => ({ contactId: 'con_01JB0000000000000000000001', name: 'Ana Novak', access, via: 'session' })
}

const frame = () => screen.findByTestId('preview-frame') as Promise<HTMLIFrameElement>
/** The demo page's text, decoded from the frame's data URL. */
const page = (f: HTMLIFrameElement) => decodeURIComponent(f.getAttribute('src')!)

describe('live preview', () => {
  it('shows a Preview tab only for sessions whose environment exposes ports', async () => {
    renderAt(`/sessions/${SES.pay123}`)
    expect(await screen.findByRole('tab', { name: 'preview' })).toBeInTheDocument()
  })

  it('has no Preview tab without an environment, even when the link asks for it', async () => {
    renderAt(`/sessions/${SES.inc42}?tab=preview`)
    await screen.findByTestId('timeline')
    expect(screen.queryByRole('tab', { name: 'preview' })).toBeNull()
    expect(screen.queryByTestId('preview-panel')).toBeNull()
  })

  it('frames the preview sandboxed, from a fresh token, with the running commit', async () => {
    const tokens: string[] = []
    const { data } = renderAt(`/sessions/${SES.pay123}?tab=preview`)
    const mint = data.api.previewToken
    data.api.previewToken = async (envId, port) => {
      const t = await mint(envId, port)
      tokens.push(t.token)
      return t
    }
    const f = await frame()
    expect(f.getAttribute('sandbox')).toBe(PREVIEW_SANDBOX)
    expect(PREVIEW_SANDBOX).toBe('allow-scripts allow-forms allow-same-origin')
    expect(page(f)).toContain('Demo app on port 5173')
    expect(screen.getByTestId('preview-commit')).toHaveTextContent('3f9c2a7')

    // Reload mints a new token and loads the frame again.
    const before = f.getAttribute('src')
    fireEvent.click(screen.getByRole('button', { name: 'Reload preview' }))
    await waitFor(() => expect(screen.getByTestId('preview-frame').getAttribute('src')).not.toBe(before))
    expect(tokens.length).toBeGreaterThanOrEqual(1)
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('switches ports with the picker, and opens a port from the link', async () => {
    renderAt(`/sessions/${SES.pay123}?tab=preview&port=8000`)
    expect(page(await frame())).toContain('Demo app on port 8000')
    expect(screen.getByRole('button', { name: ':8000' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: ':5173' }))
    await waitFor(() => expect(page(screen.getByTestId('preview-frame'))).toContain('Demo app on port 5173'))
  })

  it('opens full screen in a new tab with its own token', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      renderAt(`/sessions/${SES.pay123}?tab=preview`)
      const f = await frame()
      fireEvent.click(screen.getByRole('button', { name: 'Open full screen' }))
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
      const [url, target, features] = open.mock.calls[0]!
      expect(target).toBe('_blank')
      expect(features).toBe('noopener,noreferrer')
      expect(String(url)).not.toBe(f.getAttribute('src'))
    } finally {
      open.mockRestore()
    }
  })

  it('reloads on a new commit from the live stream', async () => {
    const { data } = renderAt(`/sessions/${SES.pay123}?tab=preview`)
    const before = (await frame()).getAttribute('src')
    act(() => {
      const c = advancePreviewCommit(data.api.db, SES.pay123)!
      data.live.emit('preview.commit', c)
    })
    await waitFor(() => expect(screen.getByTestId('preview-commit')).not.toHaveTextContent('3f9c2a7'))
    await waitFor(() => expect(screen.getByTestId('preview-frame').getAttribute('src')).not.toBe(before))
  })

  it('tells viewers that previews are for members, without a frame', async () => {
    renderAt(`/sessions/${SES.pay123}?tab=preview`, as('viewer'))
    expect(await screen.findByText(/members can open them/)).toBeInTheDocument()
    expect(screen.queryByTestId('preview-frame')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open full screen' })).toBeNull()
  })
})
