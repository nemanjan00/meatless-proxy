import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGitlabClient,
  createGitlabHooks,
  type GitlabHooks,
  gitlabProjectPath,
  HOOK_EVENTS,
  sslVerificationFor,
} from '../src/index.ts'
import { type FakeGitlab, startFakeGitlab, TOKEN } from './fake-gitlab.ts'

let fake: FakeGitlab
let hooks: GitlabHooks
const URL_A = 'https://mp.example.com/webhooks/gitlab/emp_1'

beforeEach(async () => {
  fake = await startFakeGitlab({ prefix: '/gitlab' })
  hooks = createGitlabHooks(createGitlabClient({ baseUrl: fake.baseUrl, token: TOKEN, retryBaseMs: 1, retryMaxMs: 5 }))
})
afterEach(() => fake.close())

const writes = () => fake.requests.filter((r) => r.method !== 'GET' && r.path.includes('/hooks'))

describe('ensureProjectHook', () => {
  it('creates the hook with the handled events, SSL verification and the token', async () => {
    const r = await hooks.ensureProjectHook('acme/platform/billing', { url: URL_A, token: 'whsec-1' })
    expect(r.action).toBe('created')
    expect(fake.state.hooks).toHaveLength(1)
    const h = fake.state.hooks[0]!
    expect(h).toMatchObject({
      url: URL_A,
      token: 'whsec-1',
      push_events: true,
      push_events_branch_filter: '',
      note_events: true,
      issues_events: true,
      merge_requests_events: true,
      job_events: true,
      pipeline_events: true,
      tag_push_events: false,
      enable_ssl_verification: true,
    })
    expect(r.hook).not.toHaveProperty('token')
    const post = writes()[0]!
    expect(post.rawPath).toBe('/projects/acme%2Fplatform%2Fbilling/hooks')
    expect(post.body).not.toHaveProperty('push_events_branch_filter')
  })

  it('is idempotent: a second run changes nothing and never duplicates', async () => {
    const first = await hooks.ensureProjectHook(42, { url: URL_A, token: 'whsec-1' })
    const before = writes().length
    const again = await hooks.ensureProjectHook(42, { url: `${URL_A}/`, token: 'whsec-1', tokenKnownFor: first.hook.id })
    expect(again).toMatchObject({ action: 'unchanged', changed: [] })
    expect(writes().length).toBe(before)
    expect(fake.state.hooks).toHaveLength(1)
  })

  it('sets the token again when it cannot know it (no tokenKnownFor, or another hook id)', async () => {
    const first = await hooks.ensureProjectHook(42, { url: URL_A, token: 'whsec-1' })
    const r = await hooks.ensureProjectHook(42, { url: URL_A, token: 'whsec-2' })
    expect(r).toMatchObject({ action: 'updated', changed: ['token'] })
    expect(fake.state.hooks[0]!.token).toBe('whsec-2')
    const r2 = await hooks.ensureProjectHook(42, { url: URL_A, token: 'whsec-3', tokenKnownFor: first.hook.id + 1000 })
    expect(r2.changed).toEqual(['token'])
    expect(fake.state.hooks[0]!.token).toBe('whsec-3')
  })

  it('repairs drifted events, SSL verification and a branch filter, keeping the token', async () => {
    const first = await hooks.ensureProjectHook(42, { url: URL_A, token: 'whsec-1' })
    Object.assign(fake.state.hooks[0]!, {
      job_events: false,
      tag_push_events: true,
      enable_ssl_verification: false,
      push_events_branch_filter: 'main',
    })
    const r = await hooks.ensureProjectHook(42, { url: URL_A, token: 'whsec-1', tokenKnownFor: first.hook.id })
    expect(r.action).toBe('updated')
    expect(r.changed.sort()).toEqual(['enable_ssl_verification', 'job_events', 'push_events_branch_filter', 'tag_push_events'])
    const put = writes().at(-1)!
    expect(put.method).toBe('PUT')
    expect(put.body).not.toHaveProperty('token')
    expect(fake.state.hooks[0]).toMatchObject({
      job_events: true,
      tag_push_events: false,
      enable_ssl_verification: true,
      push_events_branch_filter: '',
      token: 'whsec-1',
    })
  })

  it('removes duplicates with our URL and keeps the one whose token is known', async () => {
    const first = await hooks.ensureProjectHook(42, { url: URL_A, token: 'whsec-1' })
    fake.state.hooks.push({ ...fake.state.hooks[0]!, id: 1, token: 'other' }, { ...fake.state.hooks[0]!, id: 99_999 })
    fake.state.hooks.push({ ...fake.state.hooks[0]!, id: 5, url: 'https://elsewhere.example.com/hook' })
    const r = await hooks.ensureProjectHook(42, { url: URL_A, token: 'whsec-1', tokenKnownFor: first.hook.id })
    expect(r.action).toBe('unchanged')
    expect(r.removedDuplicates.sort()).toEqual([1, 99_999])
    expect(fake.state.hooks.map((h) => h.id).sort()).toEqual([5, first.hook.id].sort())
  })

  it('turns SSL verification off only for http URLs', async () => {
    expect(sslVerificationFor('http://10.0.0.5:3000/webhooks/gitlab/x')).toBe(false)
    expect(sslVerificationFor(URL_A)).toBe(true)
    await hooks.ensureProjectHook(42, { url: 'http://10.0.0.5:3000/webhooks/gitlab/x', token: 't-1234' })
    expect(fake.state.hooks[0]!.enable_ssl_verification).toBe(false)
  })

  it('takes custom events', async () => {
    await hooks.ensureProjectHook(42, { url: URL_A, token: 't-1234', events: { ...HOOK_EVENTS, job_events: false } })
    expect(fake.state.hooks[0]!.job_events).toBe(false)
  })

  it('fails with the status when the token may not manage hooks (403) or the project is missing (404)', async () => {
    fake.state.tokens[TOKEN] = 'developer'
    await expect(hooks.ensureProjectHook(42, { url: URL_A, token: 't-1234' })).rejects.toMatchObject({
      code: 'integration_request',
      details: { status: 403 },
    })
    fake.state.tokens[TOKEN] = 'maintainer'
    await expect(hooks.ensureProjectHook('acme/nope', { url: URL_A, token: 't-1234' })).rejects.toMatchObject({
      details: { status: 404 },
    })
    expect(fake.state.hooks).toHaveLength(0)
  })

  it('works on several projects independently', async () => {
    fake.state.otherProjects.push({ ...fake.state.project, id: 43, path_with_namespace: 'acme/web' })
    await hooks.ensureProjectHook(42, { url: URL_A, token: 't-1234' })
    await hooks.ensureProjectHook('acme/web', { url: URL_A, token: 't-1234' })
    expect(fake.state.hooks.map((h) => h.project_id).sort()).toEqual([42, 43])
    expect(await hooks.listProjectHooks(43)).toHaveLength(1)
  })
})

describe('removeProjectHook', () => {
  it('removes by id or by URL, and a missing hook is fine', async () => {
    const a = await hooks.ensureProjectHook(42, { url: URL_A, token: 't-1234' })
    await hooks.ensureProjectHook(42, { url: 'https://mp.example.com/webhooks/gitlab/emp_2', token: 't-1234' })
    expect(await hooks.removeProjectHook(42, a.hook.id)).toBe(1)
    expect(await hooks.removeProjectHook(42, a.hook.id)).toBe(0)
    expect(await hooks.removeProjectHook(42, { url: 'https://mp.example.com/webhooks/gitlab/emp_2/' })).toBe(1)
    expect(fake.state.hooks).toHaveLength(0)
  })
})

describe('gitlabProjectPath', () => {
  const base = 'https://git.example.com/gitlab'
  it.each([
    ['https://git.example.com/gitlab/acme/platform/billing.git', 'acme/platform/billing'],
    ['https://git.example.com/gitlab/acme/billing', 'acme/billing'],
    ['https://git.example.com/gitlab/acme/billing/-/tree/main', 'acme/billing'],
    ['git@git.example.com:acme/platform/billing.git', 'acme/platform/billing'],
    ['ssh://git@git.example.com:2222/acme/billing.git', 'acme/billing'],
    ['https://gitlab.com/acme/billing.git', 'acme/billing'],
    ['git@gitlab.com:acme/billing.git', 'acme/billing'],
    ['https://github.com/acme/billing.git', null],
    ['git@github.com:acme/billing.git', null],
    ['https://git.example.com/gitlab/lonely', null],
    ['not a url', null],
    ['/srv/git/acme.git', null],
  ])('%s → %s', (url, want) => {
    expect(gitlabProjectPath(url, base)).toBe(want)
  })

  it('defaults to gitlab.com', () => {
    expect(gitlabProjectPath('https://gitlab.com/a/b')).toBe('a/b')
    expect(gitlabProjectPath('https://git.example.com/a/b')).toBeNull()
  })
})
