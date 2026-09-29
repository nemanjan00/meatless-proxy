import type { Access, McpServerCreate, McpServerPatch } from '@mp/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/app.tsx'
import { McpServers } from '../src/components/mcp-servers.tsx'
import { Toaster } from '../src/components/ui/sonner.tsx'
import { DataProvider } from '../src/lib/api.tsx'
import { AuthProvider } from '../src/lib/auth.tsx'
import { createMockDataLayer } from '../src/mock/index.ts'

type Layer = ReturnType<typeof createMockDataLayer>

const layer = (access: Access = 'admin') => {
  const data = createMockDataLayer({ now: Date.now() })
  data.api.me = async () => ({ contactId: 'con_01JB0000000000000000000001', name: 'Ana Novak', access, via: 'session' })
  return data
}

/** The component alone, under a router and the auth provider. */
function renderSection(data: Layer, opts: { url?: string; employeeId?: string; openUrl?: (u: string) => void } = {}) {
  return render(
    <MemoryRouter initialEntries={[opts.url ?? '/settings/mcp']}>
      <DataProvider value={data}>
        <AuthProvider>
          <McpServers
            {...(opts.employeeId ? { employeeId: opts.employeeId } : {})}
            {...(opts.openUrl ? { openUrl: opts.openUrl } : {})}
          />
          <Toaster />
        </AuthProvider>
      </DataProvider>
    </MemoryRouter>,
  )
}

const row = async (name: string) => screen.findByTestId(`mcp-server-${name}`)

describe('MCP servers', () => {
  it('lists the global servers with their status, auth and tool count, and config servers read-only', async () => {
    const data = layer()
    render(
      <MemoryRouter initialEntries={['/settings/mcp']}>
        <App data={data} />
      </MemoryRouter>,
    )
    const docs = await row('docs')
    expect(within(docs).getByTestId('mcp-status')).toHaveTextContent('Connected')
    expect(within(docs).getByText('Token')).toBeInTheDocument()
    expect(within(docs).getByText('3 tools')).toBeInTheDocument()
    expect(within(docs).getByText('https://docs.example.com/mcp')).toBeInTheDocument()
    const tasks = await row('tasks')
    expect(within(tasks).getByText('config')).toBeInTheDocument()
    expect(within(tasks).queryByRole('button', { name: /Edit|Delete/ })).toBeNull()
    // The employee's OAuth server isn't a global one.
    expect(screen.queryByTestId('mcp-server-crm')).toBeNull()
  })

  it("shows an employee's own servers, with Needs sign-in and Connect", async () => {
    const data = layer()
    const crm = (await data.api.mcpServers()).find((s) => s.name === 'crm')!
    renderSection(data, { employeeId: crm.employeeId! })
    const r = await row('crm')
    expect(within(r).getByTestId('mcp-status')).toHaveTextContent('Needs sign-in')
    expect(within(r).getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.queryByTestId('mcp-server-docs')).toBeNull()
  })

  it.each(['member', 'viewer'] as const)('is hidden from a %s', async (access) => {
    const data = layer(access)
    const spy = vi.spyOn(data.api, 'mcpServers')
    renderSection(data)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('mcp-servers')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('creates a token server with the token, and never pre-fills it on edit', async () => {
    const user = userEvent.setup()
    const data = layer()
    const create = vi.spyOn(data.api, 'createMcpServer')
    const update = vi.spyOn(data.api, 'updateMcpServer')
    renderSection(data)
    await row('docs')
    await user.click(screen.getByRole('button', { name: /Add server/ }))
    await user.type(screen.getByLabelText(/^Name/), 'wiki')
    await user.type(screen.getByLabelText(/^URL/), 'https://wiki.example.com/mcp')
    await user.click(screen.getByRole('radio', { name: 'Token' }))
    await user.type(screen.getByLabelText(/^Token/), 'sk-test-wiki')
    await user.click(screen.getByRole('button', { name: 'Add server' }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    const body = create.mock.calls[0]![0] as McpServerCreate
    expect(body).toMatchObject({
      name: 'wiki',
      url: 'https://wiki.example.com/mcp',
      employeeId: null,
      auth: { type: 'token', token: 'sk-test-wiki', header: 'Authorization', prefix: 'Bearer ' },
    })
    const wiki = await row('wiki')
    expect(within(wiki).getByTestId('mcp-status')).toHaveTextContent('Connected')

    await user.click(within(wiki).getByRole('button', { name: 'Edit wiki' }))
    const tokenInput = screen.getByLabelText(/^Token/) as HTMLInputElement
    expect(tokenInput.value).toBe('')
    expect(screen.getByText('Leave empty to keep the current token')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('sk-test-wiki')
    expect(screen.getByLabelText(/^Name/)).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalled())
    const patch = update.mock.calls[0]![1] as McpServerPatch
    expect(patch.auth).toMatchObject({ type: 'token' })
    expect(patch.auth && 'token' in patch.auth).toBe(false)
  })

  it('shows validation errors inline', async () => {
    const user = userEvent.setup()
    const data = layer()
    renderSection(data)
    await row('docs')
    await user.click(screen.getByRole('button', { name: /Add server/ }))
    await user.type(screen.getByLabelText(/^Name/), 'bad')
    await user.type(screen.getByLabelText(/^URL/), 'ftp://nope')
    await user.click(screen.getByRole('button', { name: 'Add server' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('url: must be an http(s) URL')
  })

  it('Connect starts the OAuth sign-in and opens the authorization URL', async () => {
    const user = userEvent.setup()
    const data = layer()
    const crm = (await data.api.mcpServers()).find((s) => s.name === 'crm')!
    const start = vi
      .spyOn(data.api, 'startMcpOAuth')
      .mockResolvedValue({ authorizationUrl: 'https://auth.example.com/authorize?state=s', expiresAt: '' })
    const openUrl = vi.fn()
    renderSection(data, { employeeId: crm.employeeId!, url: `/employees/${crm.employeeId}`, openUrl })
    await user.click(within(await row('crm')).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://auth.example.com/authorize?state=s'))
    expect(start).toHaveBeenCalledWith(crm.id, { returnTo: `/employees/${crm.employeeId}` })
  })

  it('shows a toast when the sign-in comes back, and refreshes the list', async () => {
    const data = layer()
    renderSection(data, { url: '/settings/mcp?mcp_oauth=connected&mcp_server=docs' })
    expect(await screen.findByText('docs connected')).toBeInTheDocument()
  })

  it('shows the error when the sign-in failed', async () => {
    const data = layer()
    renderSection(data, { url: '/settings/mcp?mcp_oauth=error&mcp_server=docs&mcp_error=the%20sign-in%20expired' })
    expect(await screen.findByText("Couldn't connect docs")).toBeInTheDocument()
    expect(await screen.findByText('the sign-in expired')).toBeInTheDocument()
  })

  it('in the mock, Connect signs in and lands back connected', async () => {
    const user = userEvent.setup()
    const data = layer()
    const crm = (await data.api.mcpServers()).find((s) => s.name === 'crm')!
    renderSection(data, { employeeId: crm.employeeId!, url: `/employees/${crm.employeeId}` })
    await user.click(within(await row('crm')).getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('crm connected')).toBeInTheDocument()
    await waitFor(async () => expect(within(await row('crm')).getByTestId('mcp-status')).toHaveTextContent('Connected'))
    expect(within(await row('crm')).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
  })

  it('deletes after a confirmation', async () => {
    const user = userEvent.setup()
    const data = layer()
    const del = vi.spyOn(data.api, 'deleteMcpServer')
    renderSection(data)
    await user.click(within(await row('docs')).getByRole('button', { name: 'Delete docs' }))
    expect(await screen.findByText('Delete docs?')).toBeInTheDocument()
    expect(del).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith(expect.stringMatching(/^mcs_/)))
    await waitFor(() => expect(screen.queryByTestId('mcp-server-docs')).toBeNull())
  })

  it('lists a server’s tools when expanded', async () => {
    const user = userEvent.setup()
    const data = layer()
    renderSection(data)
    await user.click(within(await row('docs')).getByRole('button', { name: 'Show tools of docs' }))
    expect(await screen.findByText('mcp.docs.search')).toBeInTheDocument()
  })
})
