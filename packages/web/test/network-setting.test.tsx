import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  DIRECT_OFF_NOTE,
  DIRECT_WARNING,
  describeNetwork,
  NetworkSetting,
  networkEffect,
  REGISTRY_HOSTS,
} from '../src/components/network-setting.tsx'
import { DataProvider } from '../src/lib/api.tsx'
import { AuthProvider } from '../src/lib/auth.tsx'
import { createMockDataLayer } from '../src/mock/index.ts'

describe('employee network setting', () => {
  it('describes each setting in one line', () => {
    expect(describeNetwork(undefined)).toBe('deployment default (direct network, no proxy)')
    expect(describeNetwork('project')).toBe("the project's allowlist")
    expect(describeNetwork('none')).toBe('none')
    expect(describeNetwork({ allow: ['*'] })).toBe('any public host')
    expect(describeNetwork({ allow: [...REGISTRY_HOSTS].reverse() })).toBe('package registries (PyPI, npm)')
    expect(describeNetwork({ allow: ['pypi.org', '*.github.com:443'] })).toBe('pypi.org, *.github.com:443')
    expect(describeNetwork({ allow: [] })).toBe('none (empty list)')
    expect(describeNetwork('direct')).toBe('direct network (no proxy)')
  })

  it('describes an unset setting as the deployment default, whatever that is', () => {
    expect(describeNetwork(undefined, { defaultNetwork: 'direct', directNetwork: true })).toBe(
      'deployment default (direct network, no proxy)',
    )
    expect(describeNetwork(undefined, { defaultNetwork: 'none', directNetwork: true })).toBe('deployment default (no network)')
    expect(describeNetwork(undefined, { defaultNetwork: 'project', directNetwork: true })).toBe(
      "deployment default (the project's allowlist)",
    )
    expect(describeNetwork(undefined, { defaultNetwork: 'direct', directNetwork: false })).toBe(
      'deployment default (no network: direct networks are off)',
    )
    expect(describeNetwork('direct', { defaultNetwork: 'direct', directNetwork: false })).toBe(
      'direct network (off here: no network)',
    )
  })

  it('says what the code sandbox and environments get', () => {
    // Unset follows the deployment default: a direct network unless the deployment says otherwise.
    expect(networkEffect(undefined)).toEqual(networkEffect('direct'))
    expect(networkEffect(undefined, { defaultNetwork: 'none', directNetwork: true })).toEqual(networkEffect('none'))
    // The project setting gives the sandbox nothing: code runs belong to no project.
    const project = networkEffect(undefined, { defaultNetwork: 'project', directNetwork: true })
    expect(project).toEqual(networkEffect('project'))
    expect(project.sandbox).toMatch(/^no network/)
    // Where direct networks are off, direct (own or by default) means no network.
    const off = { defaultNetwork: 'direct', directNetwork: false } as const
    expect(networkEffect('direct', off).environments).toBe('no network')
    expect(networkEffect(undefined, off).sandbox).toMatch(/^no network/)
    // An explicit setting ignores the deployment default.
    expect(networkEffect('none', { defaultNetwork: 'direct', directNetwork: true })).toEqual({
      sandbox: 'no network',
      environments: 'no network',
    })
    expect(networkEffect('none')).toEqual({ sandbox: 'no network', environments: 'no network' })
    expect(networkEffect({ allow: ['*'] }).sandbox).toBe('any public host')
    expect(networkEffect({ allow: ['*'] }).environments).toContain("narrowed to the project's allowlist")
    // A direct network isn't narrowed by anything, and says it isn't logged.
    const direct = networkEffect('direct')
    expect(`Code sandbox: ${direct.sandbox}. Environments: ${direct.environments}.`).toBe(
      'Code sandbox: direct network, unrestricted and not logged. Environments: the same.',
    )
  })

  it('warns plainly about a direct network', () => {
    expect(DIRECT_WARNING).toBe(
      'Unrestricted and not logged: it can reach your LAN, cloud metadata and any host. Only for employees you trust.',
    )
  })

  it('shows the warning for a direct network, and offers it to admins with the warning when picked', async () => {
    const data = createMockDataLayer({ now: Date.now() })
    const update = vi.fn(async () => ({}) as never)
    data.api.updateRecord = update as never
    const employee = { id: 'emp_1', version: 3, data: { contactId: 'con_1', name: 'Ana', network: 'direct' as const } }
    const { unmount } = render(
      <DataProvider value={data}>
        <NetworkSetting employee={employee as never} admin={false} onSaved={() => {}} />
      </DataProvider>,
    )
    expect(screen.getByText('direct network (no proxy)')).toBeInTheDocument()
    expect(screen.getByTestId('network-direct-warning')).toHaveTextContent(DIRECT_WARNING)
    unmount()

    render(
      <DataProvider value={data}>
        <NetworkSetting
          employee={{ ...employee, data: { ...employee.data, network: 'project' } } as never}
          admin
          onSaved={() => {}}
        />
      </DataProvider>,
    )
    expect(screen.queryByTestId('network-direct-warning')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Change' }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Network' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Direct network (no proxy)' }))
    expect(screen.getByTestId('network-direct-warning')).toHaveTextContent(DIRECT_WARNING)
    expect(screen.getByTestId('network-preview')).toHaveTextContent(
      'Code sandbox: direct network, unrestricted and not logged. Environments: the same.',
    )
    expect(screen.queryByText(/Everything goes through the logging egress proxy/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(update).toHaveBeenCalledWith('employee', 'emp_1', { network: 'direct' }, 3)
  })

  it("shows the deployment default for an unset setting, and an admin can pick it to clear the employee's own", async () => {
    const data = createMockDataLayer({ now: Date.now() })
    const update = vi.fn(async () => ({}) as never)
    data.api.updateRecord = update as never
    const employee = { id: 'emp_1', version: 5, data: { contactId: 'con_1', name: 'Ana' } }
    const { unmount } = render(
      <DataProvider value={data}>
        <NetworkSetting employee={employee as never} admin={false} onSaved={() => {}} />
      </DataProvider>,
    )
    // Unset is the deployment default: direct unless the deployment says otherwise, with its warning.
    expect(screen.getByText('deployment default (direct network, no proxy)')).toBeInTheDocument()
    expect(screen.getByTestId('network-effect')).toHaveTextContent(
      'Code sandbox: direct network, unrestricted and not logged. Environments: the same.',
    )
    expect(screen.getByTestId('network-direct-warning')).toHaveTextContent(DIRECT_WARNING)
    unmount()

    render(
      <DataProvider value={data}>
        <NetworkSetting
          employee={{ ...employee, data: { ...employee.data, network: { allow: ['pypi.org'] } } } as never}
          admin
          onSaved={() => {}}
          deployment={{ defaultNetwork: 'none', directNetwork: true }}
        />
      </DataProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Change' }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Network' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Deployment default (no network)' }))
    expect(screen.getByTestId('network-preview')).toHaveTextContent('Code sandbox: no network. Environments: no network.')
    expect(screen.queryByTestId('network-direct-warning')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(update).toHaveBeenCalledWith('employee', 'emp_1', { network: null }, 5)
  })

  it('reads the deployment default from /api/me, and the mock clears the field on null', async () => {
    const data = createMockDataLayer({ now: Date.now() })
    data.api.me = async () => ({
      contactId: 'con_1',
      name: 'Ana Novak',
      access: 'admin',
      via: 'session',
      deployment: { defaultNetwork: 'project', directNetwork: true },
    })
    render(
      <DataProvider value={data}>
        <AuthProvider>
          <NetworkSetting
            employee={{ id: 'emp_1', version: 1, data: { contactId: 'con_1', name: 'Ana' } } as never}
            admin={false}
            onSaved={() => {}}
          />
        </AuthProvider>
      </DataProvider>,
    )
    expect(await screen.findByText("deployment default (the project's allowlist)")).toBeInTheDocument()
    expect(screen.queryByTestId('network-direct-warning')).toBeNull()

    const emp = (await data.api.listRecords<{ network?: unknown }>('employee')).items[0]!
    const set = await data.api.updateRecord('employee', emp.id, { network: 'none' }, emp.version)
    expect(set.data.network).toBe('none')
    const cleared = await data.api.updateRecord('employee', emp.id, { network: null }, set.version)
    expect('network' in cleared.data).toBe(false)
  })

  it('says a direct network means no network where the deployment turns direct networks off', async () => {
    const data = createMockDataLayer({ now: Date.now() })
    const off = { defaultNetwork: 'direct', directNetwork: false } as const
    const employee = { id: 'emp_1', version: 2, data: { contactId: 'con_1', name: 'Ana', network: 'direct' as const } }
    const { unmount } = render(
      <DataProvider value={data}>
        <NetworkSetting employee={employee as never} admin onSaved={() => {}} deployment={off} />
      </DataProvider>,
    )
    expect(screen.getByText('direct network (off here: no network)')).toBeInTheDocument()
    expect(screen.getByTestId('network-direct-off')).toHaveTextContent(DIRECT_OFF_NOTE)
    expect(screen.queryByTestId('network-direct-warning')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Change' }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Network' }))
    expect(
      await screen.findByRole('option', { name: 'Deployment default (no network: direct networks are off)' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Direct network (off here: no network)' })).toBeInTheDocument()
    unmount()

    render(
      <DataProvider value={data}>
        <NetworkSetting
          employee={{ ...employee, data: { contactId: 'con_1', name: 'Ana' } } as never}
          admin={false}
          onSaved={() => {}}
          deployment={off}
        />
      </DataProvider>,
    )
    expect(screen.getByText('deployment default (no network: direct networks are off)')).toBeInTheDocument()
    expect(screen.getByTestId('network-effect')).toHaveTextContent('Environments: no network.')
    expect(screen.getByTestId('network-direct-off')).toBeInTheDocument()
  })
})
