import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  DIRECT_WARNING,
  describeNetwork,
  NetworkSetting,
  networkEffect,
  REGISTRY_HOSTS,
} from '../src/components/network-setting.tsx'
import { DataProvider } from '../src/lib/api.tsx'
import { createMockDataLayer } from '../src/mock/index.ts'

describe('employee network setting', () => {
  it('describes each setting in one line', () => {
    expect(describeNetwork(undefined)).toBe("the project's allowlist")
    expect(describeNetwork('project')).toBe("the project's allowlist")
    expect(describeNetwork('none')).toBe('none')
    expect(describeNetwork({ allow: ['*'] })).toBe('any public host')
    expect(describeNetwork({ allow: [...REGISTRY_HOSTS].reverse() })).toBe('package registries (PyPI, npm)')
    expect(describeNetwork({ allow: ['pypi.org', '*.github.com:443'] })).toBe('pypi.org, *.github.com:443')
    expect(describeNetwork({ allow: [] })).toBe('none (empty list)')
    expect(describeNetwork('direct')).toBe('direct network (no proxy)')
  })

  it('says what the code sandbox and environments get', () => {
    // The default gives the sandbox nothing: code runs belong to no project.
    expect(networkEffect(undefined).sandbox).toMatch(/^no network/)
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
})
