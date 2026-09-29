import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { createMockDataLayer } from '../src/mock/index.ts'

describe('Settings → Integrations', () => {
  it('shows per employee which integrations are set up and failed GitLab webhooks, linking to the guided setup', async () => {
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
    const root = await screen.findByTestId('integrations-overview')
    const row = (await within(root).findAllByTestId('integrations-row')).find((r) => within(r).queryByText(employee!.data.name))!
    expect(
      within(row).getByText(/1 GitLab webhook failed: acme\/billing: the token needs Maintainer on acme\/billing/),
    ).toBeInTheDocument()
    const gitlab = within(row)
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === `/employees/${employee!.id}?setup=gitlab`)!
    expect(gitlab.getAttribute('title')).toMatch(/token set/)
    // The overview links to the employee's guided setup instead of setting anything up itself.
    expect(within(row).getByRole('link', { name: 'Set up' }).getAttribute('href')).toBe(`/employees/${employee!.id}`)
    expect(root.textContent).not.toContain('glpat-test')
  })
})
