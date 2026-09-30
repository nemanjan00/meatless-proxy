import type { Me } from '@mp/api'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/app.tsx'
import { PREVIEW_SANDBOX } from '../src/components/preview-panel.tsx'
import { formatBytes, formatCpu, networkLabel, shortDuration, shortImage, totals } from '../src/lib/environments.ts'
import { EMP, SES, createMockDataLayer } from '../src/mock/index.ts'
import { tickMockEnvironments } from '../src/mock/environments.ts'

type Layer = ReturnType<typeof createMockDataLayer>

function Probe() {
  const l = useLocation()
  return <div data-testid="location">{l.search}</div>
}

function renderAt(path: string, tweak?: (data: Layer) => void) {
  const data = createMockDataLayer({ now: Date.now() })
  tweak?.(data)
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
      <Probe />
    </MemoryRouter>,
  )
  return { ...utils, data }
}

const as = (access: Me['access']) => (data: Layer) => {
  data.api.me = async () => ({ contactId: 'con_01JB0000000000000000000001', name: 'Ana Novak', access, via: 'session' })
}
const search = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '')
const rows = () => screen.queryAllByTestId('env-row')
const rowOf = (title: string) => rows().find((r) => within(r).queryByText(title))!

describe('environment metrics formatting', () => {
  it('formats bytes, CPU and the network', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(4 * 1024 ** 3)).toBe('4.0 GB')
    expect(formatCpu(null)).toBe('—')
    expect(formatCpu(3.14)).toBe('3.1%')
    expect(formatCpu(186.4)).toBe('186%')
    expect(networkLabel(null)).toBe('No network')
    expect(networkLabel({ via: 'direct' })).toBe('Direct network')
    expect(networkLabel({ via: 'proxy', allow: ['a.example.com'] })).toBe('Proxy · 1 host')
  })

  it('shortens images and lengths of time', () => {
    expect(shortImage('ghcr.io/acme/app:1')).toBe('acme/app:1')
    expect(shortImage('localhost:5000/app')).toBe('app')
    expect(shortImage('docker.io/library/node:22')).toBe('node:22')
    expect(shortImage('nemanjan00/dev:scraper')).toBe('nemanjan00/dev:scraper')
    expect(shortImage(undefined)).toBe('unknown image')
    expect(shortDuration(42_000)).toBe('42s')
    expect(shortDuration(12 * 60_000)).toBe('12m')
    expect(shortDuration(3 * 3600_000 + 20 * 60_000)).toBe('3h 20m')
    expect(shortDuration(52 * 3600_000)).toBe('2d 4h')
  })

  it('sums containers and counts the desktop, which shares the network, once', () => {
    const t = totals({
      envId: 'e',
      at: '2026-09-29T12:00:00Z',
      containers: [
        {
          name: 'main',
          role: 'main',
          state: 'running',
          cpuPercent: 50,
          memoryBytes: 100,
          memoryLimitBytes: 1000,
          netRxBytes: 10,
          netTxBytes: 5,
          pids: 3,
          startedAt: null,
        },
        {
          name: 'desktop',
          role: 'desktop',
          state: 'running',
          cpuPercent: 5,
          memoryBytes: 20,
          memoryLimitBytes: 500,
          netRxBytes: 10,
          netTxBytes: 5,
          pids: 4,
          startedAt: null,
        },
        {
          name: 'db',
          role: 'service',
          state: 'running',
          cpuPercent: null,
          memoryBytes: 30,
          memoryLimitBytes: 1000,
          netRxBytes: 1,
          netTxBytes: 1,
          pids: 2,
          startedAt: null,
        },
      ],
    })
    expect(t).toEqual({ cpu: 55, memory: 150, memoryLimit: 1000, rx: 11, tx: 6, pids: 9 })
    expect(totals(null).cpu).toBeNull()
  })
})

describe('Environments page', () => {
  it('lists environments with their session, what they run, network, exec and metrics', async () => {
    renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(screen.getByTestId('env-count')).toHaveTextContent('4 environments')
    const pay = rowOf('PAY-123: refund a double charge')
    expect(within(pay).getByRole('link', { name: 'PAY-123: refund a double charge' })).toHaveAttribute(
      'href',
      `/sessions/${SES.pay123}`,
    )
    expect(within(pay).getByText('default')).toBeInTheDocument()
    expect(within(pay).getByTestId('env-exec')).toHaveTextContent('npm test -- --run refunds')
    expect(within(pay).getByTestId('env-metrics')).toHaveTextContent(/%/)
    expect(within(pay).getByTestId('env-metrics')).toHaveTextContent(/GB/)
    expect(within(pay).getByRole('link', { name: 'Open preview' })).toHaveAttribute(
      'href',
      `/sessions/${SES.pay123}?tab=preview&port=5173`,
    )
    // The desktop environment has a thumbnail card and an Open desktop action; the others don't.
    expect(screen.getAllByTestId('desktop-card')).toHaveLength(1)
    expect(within(rowOf('PAY-140: reproduce in staging')).getByRole('button', { name: 'Open desktop' })).toBeInTheDocument()
    expect(within(pay).queryByRole('button', { name: 'Open desktop' })).toBeNull()
  })

  it('shows the image of every row: profile badge, image and size, or that it was built', async () => {
    renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    const pay = within(rowOf('PAY-123: refund a double charge')).getByTestId('env-image')
    expect(within(pay).getByTestId('env-profile')).toHaveTextContent('default')
    expect(pay).toHaveTextContent('nemanjan00/dev:default')
    expect(pay).toHaveTextContent('1.9 GB')
    const built = within(rowOf('PAY-131: currency rounding in invoices')).getByTestId('env-image')
    expect(built).toHaveTextContent('build')
    expect(built).toHaveTextContent('mp-build/billing-bot-pay-131-rounding:latest')
    expect(built).toHaveTextContent('612 MB')
    expect(within(built).queryByTestId('env-profile')).toBeNull()
  })

  it("shows each environment's session state and idle time", async () => {
    renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(within(rowOf('PAY-131: currency rounding in invoices')).getByTestId('env-state')).toHaveTextContent(
      'done · idle 23h 12m',
    )
    expect(within(rowOf('PAY-123: refund a double charge')).getByTestId('env-state')).toHaveTextContent('working')
  })

  it("details the image, limits and activity in the drawer's tabs", async () => {
    renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    await userEvent.click(
      within(rowOf('PAY-131: currency rounding in invoices')).getByRole('button', { name: 'Logs and details' }),
    )
    const sheet = await screen.findByTestId('env-sheet')
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Image' }))
    const img = within(sheet).getByTestId('env-image-facts')
    expect(img).toHaveTextContent("built from payments-api's Dockerfile on node:22-bookworm-slim")
    expect(img).toHaveTextContent('sha256:4f9c2a7d31e0')
    expect(img).toHaveTextContent('none (built here)')
    expect(img).toHaveTextContent('linux/amd64')
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Details' }))
    expect(within(sheet).getByTestId('env-session-state')).toHaveTextContent('done')
    expect(within(sheet).getByTestId('env-activity')).toHaveTextContent('Idle 23h 12m')
    expect(within(sheet).getByTestId('env-limits')).toHaveTextContent('any CPU · no memory limit · 4096 processes')
  })

  it('shows a profile image with its description, source and digest', async () => {
    renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    await userEvent.click(within(rowOf('PAY-140: reproduce in staging')).getByRole('button', { name: 'Logs and details' }))
    const sheet = await screen.findByTestId('env-sheet')
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Image' }))
    const img = within(sheet).getByTestId('env-image-facts')
    expect(img).toHaveTextContent('cloakbrowser')
    expect(img).toHaveTextContent('nemanjan00/dev@sha256:')
    expect(within(img).getByRole('link', { name: 'https://github.com/nemanjan00/dev-environment' })).toHaveAttribute(
      'target',
      '_blank',
    )
  })

  it('lets admins stop idle environments after listing them', async () => {
    const { data } = renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    const call = vi.spyOn(data.api, 'stopIdleEnvironments')
    await userEvent.click(screen.getByRole('button', { name: /Stop idle \(1\)/ }))
    const dialog = await screen.findByTestId('stop-idle-dialog')
    expect(await within(dialog).findByText('mp-billing-bot-pay-131-rounding')).toBeInTheDocument()
    expect(call).toHaveBeenLastCalledWith({ idleMinutes: 60, dryRun: true })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop 1 idle' }))
    await waitFor(() => expect(call).toHaveBeenLastCalledWith({ idleMinutes: 60 }))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(rows().some((r) => within(r).queryByText('PAY-131: currency rounding in invoices'))).toBe(false)
  })

  it('offers Stop idle to admins only', async () => {
    renderAt('/environments', as('member'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(screen.queryByRole('button', { name: /Stop idle/ })).toBeNull()
  })

  it('filters by employee and by desktop, in the URL', async () => {
    renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    await userEvent.click(screen.getByRole('combobox', { name: 'Employee' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Infra Bot' }))
    await waitFor(() => expect(search().get('employee')).toBe(EMP.infra))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rowOf('INC-42: staging disk full')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(rows()).toHaveLength(4))
    await userEvent.click(screen.getByRole('checkbox', { name: 'With desktop' }))
    await waitFor(() => expect(search().get('desktop')).toBe('1'))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rowOf('PAY-140: reproduce in staging')).toBeTruthy()
  })

  it('updates a row live from env.stats, including the running exec', async () => {
    const { data } = renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    const inc = () => rowOf('INC-42: staging disk full')
    expect(within(inc()).getByTestId('env-exec')).toHaveTextContent('du -xh')
    act(() => {
      data.live.emit('env.stats', {
        sessionId: SES.inc42,
        envId: 'mp-infra-bot-inc-42-disk',
        exec: { cmd: ['df', '-h'], startedAt: new Date().toISOString() },
        stats: {
          envId: 'mp-infra-bot-inc-42-disk',
          at: new Date().toISOString(),
          containers: [
            {
              name: 'main',
              role: 'main',
              state: 'running',
              cpuPercent: 142,
              memoryBytes: 3 * 1024 ** 3,
              memoryLimitBytes: null,
              netRxBytes: 0,
              netTxBytes: 0,
              pids: 77,
              startedAt: null,
            },
          ],
        },
      })
    })
    await waitFor(() => expect(within(inc()).getByTestId('env-metrics')).toHaveTextContent('142%'))
    expect(within(inc()).getByTestId('env-metrics')).toHaveTextContent('3.0 GB')
    expect(within(inc()).getByTestId('env-exec')).toHaveTextContent('df -h')
    // The mock's own poller sends a sample for every environment.
    act(() => tickMockEnvironments(data.api.db, data.live.emit))
    await waitFor(() => expect(within(inc()).getByTestId('env-metrics')).not.toHaveTextContent('142%'))
  })

  it('opens the logs drawer, refreshes the logs, and loads processes on demand', async () => {
    const { data } = renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    const logs = vi.spyOn(data.api, 'environmentLogs')
    const procs = vi.spyOn(data.api, 'environmentProcesses')
    await userEvent.click(within(rowOf('PAY-123: refund a double charge')).getByRole('button', { name: 'Logs and details' }))
    const sheet = await screen.findByTestId('env-sheet')
    expect(await within(sheet).findByTestId('env-logs')).toHaveTextContent('listening on 0.0.0.0:8000')
    expect(logs).toHaveBeenCalledWith('mp-billing-bot-pay-123-refund', 300)
    expect(procs).not.toHaveBeenCalled()
    await waitFor(() => expect(logs.mock.calls.length).toBeGreaterThan(1), { timeout: 4500 })
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Processes' }))
    const p = await within(sheet).findByTestId('env-processes')
    expect(await within(p).findByText('npm test -- --run refunds')).toBeInTheDocument()
    expect(within(p).getByText('db')).toBeInTheDocument()
    await userEvent.click(within(p).getByRole('button', { name: 'Refresh processes' }))
    await waitFor(() => expect(procs).toHaveBeenCalledTimes(2))
    await userEvent.click(within(sheet).getByRole('tab', { name: 'Metrics' }))
    expect(within(sheet).getByTestId('container-metrics')).toHaveTextContent('main')
  }, 10_000)

  it('shows Stop only where allowed, and stops after a confirmation', async () => {
    const { data } = renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(within(rowOf('INC-42: staging disk full')).queryByRole('button', { name: 'Stop environment' })).toBeNull()
    const stop = vi.spyOn(data.api, 'stopEnvironment')
    await userEvent.click(within(rowOf('PAY-123: refund a double charge')).getByRole('button', { name: 'Stop environment' }))
    const dialog = await screen.findByRole('dialog')
    expect(stop).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: /Stop environment/ }))
    await waitFor(() => expect(stop).toHaveBeenCalledWith('mp-billing-bot-pay-123-refund'))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(rows().some((r) => within(r).queryByText('PAY-123: refund a double charge'))).toBe(false)
  })

  it('opens the desktop view-only in the sandboxed frame, and lets an allowed viewer take control', async () => {
    const { data } = renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    const mint = vi.spyOn(data.api, 'desktopToken')
    // The thumbnail is a view-only frame that takes no input.
    const thumb = await screen.findByTitle(/\(thumbnail\)/)
    expect(thumb).toHaveAttribute('sandbox', PREVIEW_SANDBOX)
    expect(thumb.className).toContain('pointer-events-none')
    await userEvent.click(screen.getByRole('button', { name: /Open the desktop of/ }))
    const dialog = await screen.findByTestId('desktop-dialog')
    const frame = (await within(dialog).findByTestId('desktop-frame')) as HTMLIFrameElement
    expect(frame).toHaveAttribute('sandbox', PREVIEW_SANDBOX)
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(mint).toHaveBeenLastCalledWith('mp-billing-bot-pay-140-repro', { control: false })
    expect(within(dialog).getByTestId('desktop-mode')).toHaveTextContent('View only')
    expect(decodeURIComponent(frame.src)).toContain('View only')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Take control' }))
    await waitFor(() => expect(mint).toHaveBeenLastCalledWith('mp-billing-bot-pay-140-repro', { control: true }))
    await waitFor(() => expect(within(dialog).getByTestId('desktop-mode')).toHaveTextContent('Controlling'))
    const again = within(dialog).getByTestId('desktop-frame') as HTMLIFrameElement
    expect(again).not.toBe(frame)
    expect(decodeURIComponent(again.src)).toContain('Controlling')
    // A fresh token for a new tab, never the one the frame used.
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open desktop in a new tab' }))
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(expect.stringContaining('data:text/html'), '_blank', 'noopener,noreferrer'),
    )
    open.mockRestore()
  })

  it('offers no control toggle without canControl', async () => {
    const { data } = renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    const orig = data.api.environments
    data.api.environments = async (q) => {
      const r = await orig(q)
      return { items: r.items.map((e) => ({ ...e, canControl: false })) }
    }
    act(() => data.live.emit('env.changed', { envId: 'x', op: 'up' }))
    await userEvent.click(within(rowOf('PAY-140: reproduce in staging')).getByRole('button', { name: 'Open desktop' }))
    const dialog = await screen.findByTestId('desktop-dialog')
    await within(dialog).findByTestId('desktop-frame')
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Take control' })).toBeNull())
  })

  it('tells viewers that only members open desktops', async () => {
    renderAt('/environments', as('viewer'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    await userEvent.click(within(rowOf('PAY-140: reproduce in staging')).getByRole('button', { name: 'Open desktop' }))
    const dialog = await screen.findByTestId('desktop-dialog')
    expect(within(dialog).getByText(/members can open them/)).toBeInTheDocument()
    expect(within(dialog).queryByTestId('desktop-frame')).toBeNull()
  })

  it('reloads when an environment starts or stops', async () => {
    const { data } = renderAt('/environments')
    await waitFor(() => expect(rows()).toHaveLength(4))
    const list = vi.spyOn(data.api, 'environments')
    act(() => data.live.emit('env.changed', { sessionId: SES.pay123, envId: 'mp-x', op: 'up' }))
    await waitFor(() => expect(list).toHaveBeenCalled())
  })

  it('is in the sidebar', async () => {
    renderAt('/now')
    expect(await screen.findByRole('link', { name: 'Environments' })).toHaveAttribute('href', '/environments')
  })
})

describe('the session page', () => {
  it('shows the Environment card with metrics, logs and stop', async () => {
    const { data } = renderAt(`/sessions/${SES.pay123}`)
    const card = await screen.findByTestId('env-card')
    expect(within(card).getByText('default')).toBeInTheDocument()
    expect(within(card).getByTestId('env-exec')).toHaveTextContent('npm test')
    expect(within(card).getByTestId('env-card-metrics')).toHaveTextContent(/%/)
    await userEvent.click(within(card).getByRole('button', { name: /Logs/ }))
    expect(await within(await screen.findByTestId('env-sheet')).findByTestId('env-logs')).toHaveTextContent('vite')
    await userEvent.keyboard('{Escape}')
    const stop = vi.spyOn(data.api, 'stopEnvironment')
    await userEvent.click(within(card).getByRole('button', { name: /Stop/ }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Stop environment/ }))
    await waitFor(() => expect(stop).toHaveBeenCalledWith('mp-billing-bot-pay-123-refund'))
    await waitFor(() => expect(screen.queryByTestId('env-card')).toBeNull())
  })

  it('has no card without an environment', async () => {
    renderAt(`/sessions/${SES.sup91}`)
    await screen.findByTestId('properties')
    await screen.findByTestId('timeline')
    expect(screen.queryByTestId('env-card')).toBeNull()
  })

  it('opens the desktop from a deep link, in the Preview tab', async () => {
    renderAt(`/sessions/${SES.pay140Repro}?tab=preview&desktop=1`)
    expect(await screen.findByRole('tab', { name: 'preview' })).toHaveAttribute('data-state', 'active')
    const frame = await screen.findByTestId('desktop-frame')
    expect(frame).toHaveAttribute('sandbox', PREVIEW_SANDBOX)
    expect(within(screen.getByTestId('desktop-viewer')).getByTestId('desktop-mode')).toHaveTextContent('View only')
  })

  it('switches between the desktop and the app when there are both', async () => {
    renderAt(`/sessions/${SES.pay123}?tab=preview`, (d) => {
      const orig = d.api.environments
      d.api.environments = async (q) => {
        const r = await orig(q)
        return { items: r.items.map((e) => (e.envId === 'mp-billing-bot-pay-123-refund' ? { ...e, desktop: true } : e)) }
      }
      const tok = d.api.desktopToken
      d.api.desktopToken = async (id, o) =>
        id === 'mp-billing-bot-pay-123-refund' ? { ...(await tok('mp-billing-bot-pay-140-repro', o)), envId: id } : tok(id, o)
    })
    expect(await screen.findByTestId('preview-frame')).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'Desktop' }))
    await waitFor(() => expect(search().get('desktop')).toBe('1'))
    expect(await screen.findByTestId('desktop-frame')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-frame')).toBeNull()
    await userEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'App' }))
    expect(await screen.findByTestId('preview-frame')).toBeInTheDocument()
  })
})
