import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/app.tsx'
import { clearPermalinkCache, RepoLinks, SubjectLink } from '../src/components/links.tsx'
import { DataProvider } from '../src/lib/api.tsx'
import { eventSubject, handleView, parseSubjectKey, repoView, repoWebUrl, subjectView, threadSubject } from '../src/lib/links.ts'
import { createMockDataLayer, PRO, SES } from '../src/mock/index.ts'

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0)
const view = (key: string, extra: Record<string, string> = {}, ctx = {}) =>
  subjectView({ ...parseSubjectKey(key), ...extra }, ctx)

afterEach(() => clearPermalinkCache())

describe('subjectView', () => {
  it('a harness thread links to the chat thread when its channel is known', () => {
    expect(view('mp:msg_01TEST', { channelId: 'chn_01TEST', title: 'lunch anyone?' })).toEqual({
      label: 'Thread: lunch anyone?',
      raw: 'mp:msg_01TEST',
      href: '/chat/chn_01TEST/msg_01TEST',
    })
    expect(view('mp:msg_01TEST')).toEqual({ label: 'Chat thread', raw: 'mp:msg_01TEST' })
  })

  it('a harness session, run or event links to its page', () => {
    expect(view('mp:ses_01J9Z3K8Q4ABCD')).toMatchObject({ label: 'Session ses_…ABCD', href: '/sessions/ses_01J9Z3K8Q4ABCD' })
    expect(view('mp:ses_01J9Z3K8Q4ABCD/children', { title: 'Loop children' })).toMatchObject({
      label: 'Loop children',
      href: '/sessions/ses_01J9Z3K8Q4ABCD',
    })
    expect(view('mp:run_01J9Z3K8Q4ABCD').href).toBe('/lineage/run_01J9Z3K8Q4ABCD')
  })

  it('a Slack thread opens its channel until the permalink is known', () => {
    expect(view('slack:C0TEST0001/1700000000.000100', { channelName: 'general' })).toEqual({
      label: 'Slack thread in #general',
      raw: 'slack:C0TEST0001/1700000000.000100',
      href: 'https://slack.com/app_redirect?channel=C0TEST0001',
      slack: { channel: 'C0TEST0001', ts: '1700000000.000100' },
    })
    expect(view('slack:C0TEST0001/1700000000.000100').label).toBe('Slack thread in C0TEST0001')
    expect(view('slack:D0TEST0001/1700000000.000100').label).toBe('Slack thread in a DM')
    expect(view('slack:C0TEST0001')).toMatchObject({ label: 'Slack channel C0TEST0001', href: expect.any(String) })
    expect(view('slack:not a channel')).toEqual({ label: 'slack:not a channel', raw: 'slack:not a channel' })
  })

  it('GitLab merge requests, issues, branches and pipelines link to the instance', () => {
    const gl = { gitlabBaseUrl: 'https://git.example.com/' }
    expect(view('gitlab:acme/app!4', {}, gl)).toEqual({
      label: 'MR !4 · acme/app',
      raw: 'gitlab:acme/app!4',
      href: 'https://git.example.com/acme/app/-/merge_requests/4',
    })
    expect(view('gitlab:acme/app#12', {}, gl)).toMatchObject({
      label: 'Issue #12 · acme/app',
      href: 'https://git.example.com/acme/app/-/issues/12',
    })
    expect(view('gitlab:acme/app@mp/x', {}, gl)).toMatchObject({
      label: 'branch mp/x · acme/app',
      href: 'https://git.example.com/acme/app/-/tree/mp/x',
    })
    expect(view('gitlab:group/sub/app@pipeline/77', {}, gl)).toMatchObject({
      label: 'Pipeline #77 · group/sub/app',
      href: 'https://git.example.com/group/sub/app/-/pipelines/77',
    })
    // The subject's own instance wins; gitlab.com without either.
    expect(view('gitlab:acme/app!4', { baseUrl: 'https://gitlab.test' }, gl).href).toBe(
      'https://gitlab.test/acme/app/-/merge_requests/4',
    )
    expect(view('gitlab:acme/app!4').href).toBe('https://gitlab.com/acme/app/-/merge_requests/4')
    expect(view('gitlab:acme/app')).toEqual({ label: 'gitlab:acme/app', raw: 'gitlab:acme/app' })
  })

  it("a local repository's branch links to its review on the project page", () => {
    expect(view('local-git:mdtoc/mp/x', { projectId: 'pro_01TEST' })).toEqual({
      label: 'branch mp/x · mdtoc',
      raw: 'local-git:mdtoc/mp/x',
      href: '/projects/pro_01TEST?branch=mp%2Fx#local-repo-title',
    })
    expect(view('local-git:mdtoc/mp/x')).toEqual({ label: 'branch mp/x · mdtoc', raw: 'local-git:mdtoc/mp/x' })
  })

  it('Linear issues and unknown systems stay plain text', () => {
    expect(view('linear:PAY-123', { title: 'Charged twice' })).toEqual({
      label: 'PAY-123 · Charged twice',
      raw: 'linear:PAY-123',
    })
    expect(view('zendesk:SUP-88')).toEqual({ label: 'zendesk:SUP-88', raw: 'zendesk:SUP-88' })
    expect(view('webhook:ci', { title: 'CI' })).toEqual({ label: 'CI', raw: 'webhook:ci' })
  })

  it('fills a thread from the threads a page knows, and a Slack channel name from the event', () => {
    const threads = [{ channelId: 'chn_1', threadId: 'msg_1', title: 'lunch anyone?' }]
    expect(threadSubject({ system: 'mp', ref: 'msg_1' }, threads)).toEqual({
      system: 'mp',
      ref: 'msg_1',
      title: 'lunch anyone?',
      channelId: 'chn_1',
    })
    expect(
      eventSubject({ data: { subject: { system: 'slack', ref: 'C1/1.2' }, payload: { channel_name: 'general' } } })?.channelName,
    ).toBe('general')
  })
})

describe('handles and repositories', () => {
  it('a Slack user opens a DM, a GitLab user their profile', () => {
    expect(handleView({ system: 'slack', id: 'U0TEST0001' }).href).toBe('https://slack.com/app_redirect?channel=U0TEST0001')
    expect(handleView({ system: 'gitlab', id: 'ana.novak' }, { gitlabBaseUrl: 'https://git.example.com' })).toMatchObject({
      label: '@ana.novak',
      href: 'https://git.example.com/ana.novak',
    })
    expect(handleView({ system: 'linear', id: 'ana' }).href).toBeUndefined()
  })

  it('derives web pages from ssh and https URLs, httpUrl first', () => {
    expect(repoWebUrl({ url: 'git@git.example.com:acme/refunds.git' })).toBe('https://git.example.com/acme/refunds')
    expect(repoWebUrl({ url: 'ssh://git@git.example.com/acme/refunds.git' })).toBe('https://git.example.com/acme/refunds')
    expect(repoWebUrl({ url: 'https://git.example.com/acme/refunds-ui.git' })).toBe('https://git.example.com/acme/refunds-ui')
    expect(repoWebUrl({ url: 'git@git.example.com:acme/x.git', httpUrl: 'https://git.example.com:8443/acme/x.git' })).toBe(
      'https://git.example.com:8443/acme/x',
    )
    expect(repoWebUrl({ url: 'git@github.com:acme/tool.git' })).toBe('https://github.com/acme/tool')
    expect(repoWebUrl({ url: 'local:mdtoc' })).toBeNull()
    expect(repoWebUrl({ url: 'not a url' })).toBeNull()
  })

  it('GitLab repositories get merge requests and pipelines; other hosts only the page; local ones the section', () => {
    const ctx = { gitlabBaseUrl: 'https://git.example.com' }
    expect(repoView({ url: 'git@git.example.com:acme/refunds.git' }, ctx)).toEqual({
      raw: 'git@git.example.com:acme/refunds.git',
      label: 'acme/refunds',
      href: 'https://git.example.com/acme/refunds',
      mergeRequests: 'https://git.example.com/acme/refunds/-/merge_requests',
      pipelines: 'https://git.example.com/acme/refunds/-/pipelines',
    })
    expect(repoView({ url: 'https://github.com/acme/tool' }, ctx)).toEqual({
      raw: 'https://github.com/acme/tool',
      label: 'acme/tool',
      href: 'https://github.com/acme/tool',
    })
    expect(repoView({ url: 'local:mdtoc' }, ctx)).toEqual({
      raw: 'local:mdtoc',
      label: 'mdtoc',
      local: true,
      href: '#local-repo-title',
    })
  })
})

describe('SubjectLink', () => {
  const renderLink = (node: React.ReactNode) => {
    const data = createMockDataLayer({ now: NOW })
    return {
      data,
      ...render(
        <MemoryRouter>
          <DataProvider value={data}>{node}</DataProvider>
        </MemoryRouter>,
      ),
    }
  }

  it('opens external links in a new tab without the opener, and keeps the raw subject in the tooltip', () => {
    renderLink(<SubjectLink subject={{ system: 'gitlab', ref: 'acme/app!4', baseUrl: 'https://git.example.com' }} />)
    const a = screen.getByRole('link', { name: 'MR !4 · acme/app' })
    expect(a).toHaveAttribute('href', 'https://git.example.com/acme/app/-/merge_requests/4')
    expect(a).toHaveAttribute('target', '_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
    expect(a).toHaveAttribute('title', 'gitlab:acme/app!4')
    expect(a).toHaveClass('doc-link')
  })

  it('in-app links stay in the tab; unknown subjects are text', () => {
    renderLink(
      <>
        <SubjectLink subject={{ system: 'mp', ref: 'msg_1', channelId: 'chn_1', title: 'lunch anyone?' }} />
        <SubjectLink subject={{ system: 'zendesk', ref: 'SUP-88' }} />
      </>,
    )
    const a = screen.getByRole('link', { name: 'Thread: lunch anyone?' })
    expect(a).toHaveAttribute('href', '/chat/chn_1/msg_1')
    expect(a).not.toHaveAttribute('target')
    expect(screen.getByTestId('subject-text')).toHaveTextContent('zendesk:SUP-88')
    expect(screen.queryAllByRole('link')).toHaveLength(1)
  })

  it("fetches a Slack thread's permalink when the link is about to be used, once", async () => {
    const { data } = renderLink(
      <SubjectLink
        subject={{ system: 'slack', ref: 'C0TEST0001/1700000000.000100', channelName: 'general' }}
        sessionId={SES.inc42}
      />,
    )
    const spy = vi.spyOn(data.api, 'subjectPermalink')
    const a = screen.getByRole('link', { name: 'Slack thread in #general' })
    expect(a).toHaveAttribute('href', 'https://slack.com/app_redirect?channel=C0TEST0001')
    expect(spy).not.toHaveBeenCalled()
    await userEvent.hover(a)
    await waitFor(() => expect(a).toHaveAttribute('href', 'https://example.slack.com/archives/C0TEST0001/p1700000000000100'))
    expect(spy).toHaveBeenCalledWith({ subject: 'slack:C0TEST0001/1700000000.000100', sessionId: SES.inc42 })
    await userEvent.unhover(a)
    await userEvent.hover(a)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('keeps the channel link when Slack has no permalink for it', async () => {
    renderLink(<SubjectLink subject={{ system: 'slack', ref: 'C0TEST0099/1700000000.000100' }} sessionId={SES.inc42} />)
    const a = screen.getByRole('link', { name: 'Slack thread in C0TEST0099' })
    await userEvent.hover(a)
    await new Promise((r) => setTimeout(r, 50))
    expect(a).toHaveAttribute('href', 'https://slack.com/app_redirect?channel=C0TEST0099')
  })

  it('RepoLinks: a local repository elsewhere points at its project page', () => {
    renderLink(<RepoLinks repo={{ url: 'local:mdtoc' }} projectId="pro_01TEST" compact />)
    expect(screen.getByRole('link', { name: 'mdtoc' })).toHaveAttribute('href', '/projects/pro_01TEST#local-repo-title')
  })
})

describe('pages', () => {
  const renderAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <App data={createMockDataLayer({ now: NOW })} />
      </MemoryRouter>,
    )

  it("the session page links each subscription to what it's about", async () => {
    renderAt(`/sessions/${SES.pay123}`)
    const thread = await screen.findByRole('link', { name: 'Thread: Thread in #billing' })
    expect(thread.getAttribute('href')).toMatch(/^\/chat\/chn_\w+\/msg_\w+$/)
    expect(screen.getByRole('link', { name: 'branch mp/refund-fix · acme/payments-api' })).toHaveAttribute(
      'href',
      'https://git.example.com/acme/payments-api/-/tree/mp/refund-fix',
    )
    expect(screen.getByRole('link', { name: 'Loop children' })).toHaveAttribute('href', `/sessions/${SES.pay123}`)
    expect(screen.getAllByText('PAY-123 · Customer charged twice for INV-1002')[0]).toHaveAttribute('title', 'linear:PAY-123')
  })

  it('the project page links its repositories', async () => {
    renderAt(`/projects/${PRO.payments}`)
    const section = await screen.findByTestId('project-repositories')
    expect(within(section).getByRole('link', { name: 'acme/payments-api' })).toHaveAttribute(
      'href',
      'https://git.example.com/acme/payments-api',
    )
    expect(within(section).getByRole('link', { name: 'Merge requests' })).toHaveAttribute(
      'href',
      'https://git.example.com/acme/payments-api/-/merge_requests',
    )
    expect(within(section).getByRole('link', { name: 'Pipelines' })).toHaveAttribute('target', '_blank')
  })
})
