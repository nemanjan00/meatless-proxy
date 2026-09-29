import { ApiRequestError, type Me } from '@mp/api'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { UNAUTHORIZED_EVENT, atLeast, csrfToken } from '../src/lib/auth.tsx'
import { CHN, createMockDataLayer } from '../src/mock/index.ts'

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
const signedOut = (data: Layer) => {
  data.api.me = async () => {
    throw new ApiRequestError(401, 'unauthorized', 'sign in first')
  }
}

describe('sign-in', () => {
  it('sends people who are not signed in to the login page, and remembers where they were going', async () => {
    renderAt('/sessions?status=running', signedOut)
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText(/Check your email for a sign-in link, or ask an admin for one/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /single sign-on/ })).toBeNull()
  })

  it('explains what went wrong, and offers single sign-on when it is set up', async () => {
    renderAt('/login?error=invalid_link&next=/chat', (d) => {
      signedOut(d)
      d.api.authConfig = async () => ({ oidc: true })
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was already used/)
    const sso = await screen.findByRole('link', { name: /Continue with single sign-on/ })
    expect(sso).toHaveAttribute('href', `/auth/oidc/start?next=${encodeURIComponent('/chat')}`)
  })

  it('goes to the login page when the API answers 401 later', async () => {
    renderAt('/now')
    await screen.findAllByTestId('now-card')
    act(() => {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    })
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('a signed-in person on /login goes on to the app', async () => {
    renderAt('/login?next=/sessions')
    expect(await screen.findAllByTestId('session-row')).not.toHaveLength(0)
  })

  it('shows the current user in the sidebar, and signs out', async () => {
    const { data } = renderAt('/now')
    const account = await screen.findByRole('button', { name: 'Your account' })
    expect(account).toHaveTextContent('Ana Novak')
    expect(account).toHaveTextContent('admin')
    let out = 0
    data.api.logout = async () => {
      out++
    }
    fireEvent.pointerDown(account, { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(out).toBe(1)
  })
})

describe('what people see by access', () => {
  it('hides the kill switch and admin settings from members', async () => {
    renderAt('/now', as('member'))
    await screen.findAllByTestId('now-card')
    expect(screen.queryByRole('button', { name: /Pause all/ })).toBeNull()
  })

  it('shows admins the kill switch', async () => {
    renderAt('/now', as('admin'))
    await screen.findAllByTestId('now-card')
    expect(screen.getByRole('button', { name: /Pause all/ })).toBeInTheDocument()
  })

  it('settings: non-admins only get their tokens', async () => {
    renderAt('/settings', as('member'))
    expect(await screen.findByTestId('tokens')).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Settings' })
    expect(within(nav).queryByText('Secrets')).toBeNull()
    expect(within(nav).getByText('API tokens')).toBeInTheDocument()
  })

  it('settings: an admin section by URL says it is for admins', async () => {
    renderAt('/settings/secrets', as('viewer'))
    expect(await screen.findByText('Only admins can see this.')).toBeInTheDocument()
    expect(screen.queryByTestId('secrets')).toBeNull()
  })

  it('viewers read chat but get no message box', async () => {
    renderAt(`/chat/${CHN.billing}`, as('viewer'))
    expect((await screen.findAllByText('You have read-only access here.')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
  })
})

describe('API tokens page', () => {
  it('creates a token, shows it once, and revokes it', async () => {
    renderAt('/settings/tokens')
    const page = await screen.findByTestId('tokens')
    expect(within(page).getByText('No tokens yet.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'laptop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }))
    expect((await screen.findByTestId('new-token')).textContent).toMatch(/^mpt_/)
    expect(await screen.findByText('laptop')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByTestId('new-token')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }))
    await waitFor(() => expect(screen.getByText('revoked')).toBeInTheDocument())
  })
})

describe('helpers', () => {
  it('reads the CSRF cookie', () => {
    expect(csrfToken('a=1; mp_csrf=abc%3D; b=2')).toBe('abc=')
    expect(csrfToken('a=1')).toBeUndefined()
  })
  it('orders access levels', () => {
    expect(atLeast('admin', 'member')).toBe(true)
    expect(atLeast('member', 'admin')).toBe(false)
    expect(atLeast('viewer', 'viewer')).toBe(true)
    expect(atLeast(undefined, 'viewer')).toBe(false)
  })
})
