import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { createMockDataLayer } from '../src/mock/index.ts'

describe('Settings → Integrations', () => {
  it('shows per employee which integrations are set up and each GitLab webhook with its error', async () => {
    const data = createMockDataLayer({ now: Date.now() })
    const [employee] = (await data.api.listRecords<{ name: string }>('employee')).items
    await data.api.putSecret('GITLAB_TOKEN', 'glpat-test', { type: 'employee', id: employee!.id })
    await data.api.createRecord('gitlab_hook', {
      employeeId: employee!.id,
      gitlabProject: 'acme/billing',
      status: 'error',
      error: 'the token needs Maintainer on acme/billing to register webhooks',
      lastAttemptAt: new Date().toISOString(),
    })
    render(
      <MemoryRouter initialEntries={['/settings/integrations']}>
        <App data={data} />
      </MemoryRouter>,
    )
    const root = await screen.findByTestId('integrations')
    const section = await within(root).findByRole('region', { name: employee!.data.name })
    expect(within(section).getByText('GitLab')).toBeInTheDocument()
    expect(within(section).getByText('acme/billing')).toBeInTheDocument()
    expect(within(section).getByText(/needs Maintainer on acme\/billing/)).toBeInTheDocument()
    expect(within(section).getAllByText(/token set/).length).toBeGreaterThanOrEqual(1)
    expect(root.textContent).not.toContain('glpat-test')
  })
})
