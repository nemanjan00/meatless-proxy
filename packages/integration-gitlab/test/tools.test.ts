import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitlabIntegration, type GitlabIntegration, TOOL_NAMES } from '../src/index.ts'
import { type FakeGitlab, startFakeGitlab, TOKEN } from './fake-gitlab.ts'

let fake: FakeGitlab
let integration: GitlabIntegration
let client: Client

const connect = async (i: GitlabIntegration) => {
  const [c, s] = InMemoryTransport.createLinkedPair()
  await i.createMcpServer().connect(s)
  const cl = new Client({ name: 'test', version: '0.0.0' })
  await cl.connect(c)
  return cl
}

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args })
  const text = r.content?.[0]?.text ?? ''
  return { isError: !!r.isError, data: JSON.parse(text) }
}
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args)
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.data)}`)
  return r.data
}
const lastRequest = (method: string, pathPart: string) =>
  [...fake.requests].reverse().find((r) => r.method === method && r.path.includes(pathPart))!

beforeEach(async () => {
  fake = await startFakeGitlab()
  integration = createGitlabIntegration({
    secrets: { token: TOKEN, webhookSecret: 'whsec-test' },
    baseUrl: fake.baseUrl,
    retry: { retryBaseMs: 1, retryMaxMs: 20 },
  })
  client = await connect(integration)
})
afterEach(async () => {
  await client.close()
  await fake.close()
})

describe('tools list', () => {
  it('exposes exactly the documented tools, with descriptions', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(20)
  })

  it('has no merge, approve or auto-merge tool, and no tool argument that could merge (the hard rule)', async () => {
    const { tools } = await client.listTools()
    for (const t of tools) {
      const name = t.name.replace(/merge_requests?/g, 'MR')
      expect(name).not.toMatch(/merge|approv|accept|auto/i)
      const props = Object.keys((t.inputSchema as any).properties ?? {})
      for (const p of props) expect(p).not.toMatch(/merge|approv|auto|state_event|squash/i)
    }
    for (const forbidden of ['merge_merge_request', 'accept_merge_request', 'approve_merge_request', 'set_auto_merge', 'merge']) {
      const r: any = await client
        .callTool({ name: forbidden, arguments: { project: 42, iid: 12 } })
        .catch((e: Error) => ({ error: e.message }))
      expect(r.isError || r.error).toBeTruthy()
    }
    expect(fake.requests.some((r) => /\/(merge|approve)$/.test(r.path))).toBe(false)
  })
})

describe('projects, branches and files', () => {
  it('get_project by numeric id and by URL-encoded path', async () => {
    const byId = await ok('get_project', { project: 42 })
    expect(byId).toMatchObject({
      id: 42,
      path: 'acme/platform/billing',
      default_branch: 'main',
      ssh_url: expect.stringContaining('git@'),
    })
    expect(byId).not.toHaveProperty('namespace')
    const byPath = await ok('get_project', { project: 'acme/platform/billing' })
    expect(byPath.id).toBe(42)
    expect(lastRequest('GET', '/projects/').rawPath).toBe('/projects/acme%2Fplatform%2Fbilling')
    expect(lastRequest('GET', '/projects/').headers['private-token']).toBe(TOKEN)
  })

  it('get_project on an unknown project is an error result with the status', async () => {
    const r = await call('get_project', { project: 'acme/nope' })
    expect(r.isError).toBe(true)
    expect(r.data).toMatchObject({ code: 'integration_request', status: 404 })
    expect(r.data.error).toContain('404 Project Not Found')
  })

  it('list_branches follows pagination up to the limit', async () => {
    const all = await ok('list_branches', { project: 42, limit: 100 })
    expect(all).toHaveLength(100)
    expect(all[0]).toMatchObject({ name: 'main', default: true, protected: true, commit: { id: '0001abcd', title: 'Commit 1' } })
    const few = await ok('list_branches', { project: 42, limit: 5 })
    expect(few).toHaveLength(5)
    const search = await ok('list_branches', { project: 42, search: 'fix-' })
    expect(search.map((b: any) => b.name)).toEqual(['mp/billing-bot/fix-rounding'])
    expect(lastRequest('GET', 'branches').query.get('search')).toBe('fix-')
  })

  it('paginate walks X-Next-Page across pages', async () => {
    const items = await integration.client.paginate('/projects/42/repository/branches', {}, 250)
    expect(items).toHaveLength(130)
    const pages = fake.requests.filter((r) => r.path.endsWith('branches')).map((r) => r.query.get('page'))
    expect(pages).toEqual(['1', '2'])
  })

  it('get_file reads raw content at the default branch or a ref, and truncates', async () => {
    const readme = await ok('get_file', { project: 42, path: 'README.md' })
    expect(readme).toEqual({ path: 'README.md', ref: 'main', size: 32, content: '# Billing\n\nThe billing service.\n' })
    const onBranch = await ok('get_file', {
      project: 'acme/platform/billing',
      path: 'README.md',
      ref: 'mp/billing-bot/fix-rounding',
    })
    expect(onBranch.content).toContain('(branch)')
    const big = await ok('get_file', { project: 42, path: '/src/app.ts', max_bytes: 100 })
    expect(big.truncated).toBe(true)
    expect(big.content).toHaveLength(100)
    expect(lastRequest('GET', 'files').rawPath).toBe('/projects/42/repository/files/src%2Fapp.ts/raw')
    const bin = await ok('get_file', { project: 42, path: 'assets/logo.png' })
    expect(bin).toMatchObject({ binary: true })
    expect(bin).not.toHaveProperty('content')
    const missing = await call('get_file', { project: 42, path: 'nope.txt' })
    expect(missing.isError).toBe(true)
  })

  it('list_tree lists a directory or recursively', async () => {
    const root = await ok('list_tree', { project: 42 })
    expect(root).toEqual([
      { path: 'src', type: 'dir' },
      { path: 'README.md', type: 'file' },
      { path: 'assets', type: 'dir' },
    ])
    const src = await ok('list_tree', { project: 42, path: 'src', ref: 'main' })
    expect(src).toEqual([{ path: 'src/app.ts', type: 'file' }])
    const all = await ok('list_tree', { project: 42, recursive: true })
    expect(all).toHaveLength(5)
    expect(lastRequest('GET', 'tree').query.get('recursive')).toBe('true')
  })
})

describe('merge requests', () => {
  it('create_merge_request defaults the target, resolves usernames, marks drafts and joins labels', async () => {
    fake.state.mrs = fake.state.mrs.filter((m) => m.iid !== 12)
    const mr = await ok('create_merge_request', {
      project: 'acme/platform/billing',
      source_branch: 'mp/billing-bot/fix-rounding',
      title: 'Fix rounding',
      description: 'Rounds to cents.',
      draft: true,
      labels: ['bug', 'billing'],
      reviewers: ['@ana'],
      assignees: ['billing-bot'],
    })
    expect(mr).toMatchObject({
      iid: 12,
      title: 'Draft: Fix rounding',
      draft: true,
      target_branch: 'main',
      reviewers: ['ana'],
      assignees: ['billing-bot'],
      labels: ['bug', 'billing'],
    })
    const req = lastRequest('POST', 'merge_requests')
    expect(req.body).toEqual({
      source_branch: 'mp/billing-bot/fix-rounding',
      target_branch: 'main',
      title: 'Draft: Fix rounding',
      description: 'Rounds to cents.',
      labels: 'bug,billing',
      reviewer_ids: [11],
      assignee_ids: [7],
    })
  })

  it('create_merge_request never forwards merge or auto-merge arguments', async () => {
    fake.state.mrs = fake.state.mrs.filter((m) => m.iid !== 12)
    await ok('create_merge_request', {
      project: 42,
      source_branch: 'mp/billing-bot/fix-rounding',
      target_branch: 'main',
      title: 'Fix',
      merge_when_pipeline_succeeds: true,
      auto_merge: true,
      remove_source_branch: true,
    })
    const body = lastRequest('POST', 'merge_requests').body
    expect(body).not.toHaveProperty('merge_when_pipeline_succeeds')
    expect(body).not.toHaveProperty('auto_merge')
    expect(fake.state.mrs[0]!.state).toBe('opened')
  })

  it('create_merge_request reports unknown users and API conflicts', async () => {
    const unknown = await call('create_merge_request', { project: 42, source_branch: 'x', title: 't', reviewers: ['ghost'] })
    expect(unknown).toMatchObject({ isError: true, data: { code: 'validation' } })
    expect(unknown.data.error).toContain('@ghost')
    const dup = await call('create_merge_request', { project: 42, source_branch: 'mp/billing-bot/fix-rounding', title: 'Again' })
    expect(dup.isError).toBe(true)
    expect(dup.data).toMatchObject({ status: 409 })
    expect(dup.data.error).toContain('Another open merge request')
  })

  it('update_merge_request changes fields and toggles draft', async () => {
    const drafted = await ok('update_merge_request', { project: 42, iid: 12, draft: true })
    expect(drafted.title).toBe('Draft: Fix rounding in invoices')
    const ready = await ok('update_merge_request', {
      project: 42,
      iid: 12,
      draft: false,
      description: 'New',
      add_labels: ['ready'],
    })
    expect(ready).toMatchObject({ title: 'Fix rounding in invoices', labels: ['bug', 'ready'] })
    expect(lastRequest('PUT', 'merge_requests').body).toEqual({
      title: 'Fix rounding in invoices',
      description: 'New',
      add_labels: 'ready',
    })
    const retitled = await ok('update_merge_request', {
      project: 42,
      iid: 12,
      title: 'Better title',
      labels: ['x'],
      remove_labels: ['bug'],
    })
    expect(retitled.title).toBe('Better title')
    const nothing = await call('update_merge_request', { project: 42, iid: 12 })
    expect(nothing).toMatchObject({ isError: true, data: { code: 'validation' } })
  })

  it('update_merge_request drops state_event and merge flags', async () => {
    await ok('update_merge_request', {
      project: 42,
      iid: 12,
      title: 'T',
      state_event: 'merge',
      merge_when_pipeline_succeeds: true,
    })
    expect(lastRequest('PUT', 'merge_requests').body).toEqual({ title: 'T' })
    expect(fake.state.mrs.find((m) => m.iid === 12)!.state).toBe('opened')
  })

  it('get_merge_request includes diff stats, pipeline and unresolved discussions', async () => {
    const mr = await ok('get_merge_request', { project: 42, iid: 12 })
    expect(mr).toMatchObject({
      iid: 12,
      title: 'Fix rounding in invoices',
      state: 'opened',
      author: 'billing-bot',
      reviewers: ['ana'],
      merge_status: 'ci_must_pass',
      diff: { files: 3, additions: 3002, deletions: 1 },
      pipeline: { id: 900, status: 'failed' },
      unresolved_discussions: 1,
    })
    expect(mr.discussions).toEqual([
      {
        id: 'd1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0',
        author: 'ana',
        body: 'Please handle negative amounts.',
        path: 'src/app.ts',
        line: 2,
        replies: 0,
      },
    ])
  })

  it('list_merge_requests filters by state, author and source branch', async () => {
    const open = await ok('list_merge_requests', { project: 42 })
    expect(open.map((m: any) => m.iid)).toEqual([12])
    expect(lastRequest('GET', 'merge_requests').query.get('state')).toBe('opened')
    const all = await ok('list_merge_requests', { project: 42, state: 'all' })
    expect(all).toHaveLength(2)
    const byAuthor = await ok('list_merge_requests', { project: 42, state: 'all', author: '@ana' })
    expect(byAuthor.map((m: any) => m.iid)).toEqual([11])
    expect(lastRequest('GET', 'merge_requests').query.get('author_username')).toBe('ana')
    const bySource = await ok('list_merge_requests', { project: 42, state: 'all', source_branch: 'mp/billing-bot/fix-rounding' })
    expect(bySource.map((m: any) => m.iid)).toEqual([12])
  })

  it('merge_request_changes returns diffs within a budget, or one file', async () => {
    const all = await ok('merge_request_changes', { project: 42, iid: 12, max_bytes: 5000 })
    expect(all.files).toBe(3)
    expect(all.truncated).toBe(true)
    expect(all.changes[0]).toMatchObject({ path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1 })
    expect(all.changes[0].diff).toContain('Math.round')
    expect(all.changes[1]).toMatchObject({ path: 'docs/rounding.md', status: 'added', additions: 3000 })
    expect(all.changes[1].diff).toContain('[diff truncated]')
    expect(all.changes[1].diff.length).toBeLessThan(5100)
    expect(all.changes[2]).toMatchObject({ path: 'new.txt', old_path: 'old.txt', status: 'renamed' })
    const one = await ok('merge_request_changes', { project: 42, iid: 12, path: 'src/app.ts' })
    expect(one.files).toBe(1)
    expect(one.truncated).toBeUndefined()
  })

  it('comment_merge_request posts a note; reply_discussion answers a thread', async () => {
    const n = await ok('comment_merge_request', { project: 42, iid: 12, body: 'Pipeline fixed.' })
    expect(n).toMatchObject({ author: 'billing-bot', body: 'Pipeline fixed.' })
    expect(lastRequest('POST', '/notes').path).toBe('/projects/42/merge_requests/12/notes')
    const r = await ok('reply_discussion', {
      project: 42,
      iid: 12,
      discussion_id: 'd1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0',
      body: 'Handled.',
    })
    expect(r).toMatchObject({ discussion_id: 'd1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0', body: 'Handled.' })
    expect(fake.state.discussions['mr:12']![0].notes).toHaveLength(2)
    const onIssue = await ok('reply_discussion', { project: 42, iid: 3, discussion_id: 'abc', body: 'Yes.', on: 'issue' })
    expect(onIssue.body).toBe('Yes.')
    expect(lastRequest('POST', 'discussions').path).toBe('/projects/42/issues/3/discussions/abc/notes')
    const missing = await call('reply_discussion', { project: 42, iid: 12, discussion_id: 'nope', body: 'x' })
    expect(missing).toMatchObject({ isError: true, data: { status: 404 } })
  })
})

describe('pipelines and jobs', () => {
  it('pipeline_status for a merge request: the latest pipeline with its jobs', async () => {
    const r = await ok('pipeline_status', { project: 42, iid: 12 })
    expect(r.pipeline).toMatchObject({ id: 900, status: 'failed', ref: 'refs/merge-requests/12/head', sha: 'feedface' })
    expect(r.failed_jobs).toEqual(['test'])
    expect(r.jobs).toHaveLength(3)
    expect(r.jobs[1]).toMatchObject({ id: 5001, name: 'test', stage: 'test', status: 'failed', failure_reason: 'script_failure' })
    expect(r.jobs[2]).toMatchObject({ name: 'lint', allow_failure: true })
  })

  it('pipeline_status for a ref, defaulting to the default branch; none is null', async () => {
    const main = await ok('pipeline_status', { project: 'acme/platform/billing' })
    expect(main.pipeline).toMatchObject({ id: 901, status: 'success', ref: 'main' })
    expect(main.failed_jobs).toBeUndefined()
    const none = await ok('pipeline_status', { project: 42, ref: 'feature/f-000' })
    expect(none).toEqual({ pipeline: null })
  })

  it('job_log returns the cleaned tail of the trace', async () => {
    const r = await ok('job_log', { project: 42, job_id: 5001, tail_kb: 1 })
    expect(r.truncated).toBe(true)
    expect(r.log.length).toBe(1024)
    expect(r.log).toContain('FAIL src/app.test.ts')
    expect(r.log).toContain('ERROR: Job failed: exit code 1')
    expect(r.log).not.toContain('\u001b')
    expect(r.log).not.toContain('section_end')
    const full = await ok('job_log', { project: 42, job_id: 5001, tail_kb: 512 })
    expect(full.truncated).toBeUndefined()
    expect(full.log.startsWith('Running with gitlab-runner')).toBe(true)
    const missing = await call('job_log', { project: 42, job_id: 1 })
    expect(missing).toMatchObject({ isError: true, data: { status: 404 } })
  })
})

describe('issues and users', () => {
  it('get_issue with human comments, oldest first', async () => {
    const i = await ok('get_issue', { project: 42, iid: 3 })
    expect(i).toMatchObject({
      iid: 3,
      title: 'Invoices round wrong',
      author: 'ana',
      assignees: ['billing-bot'],
      milestone: 'Q4',
      labels: ['bug'],
    })
    expect(i.comments.map((c: any) => c.body)).toEqual(['Seen on invoice 1234.', 'Working on it in !12.'])
  })

  it('create_issue and comment_issue', async () => {
    const i = await ok('create_issue', {
      project: 42,
      title: 'Follow-up',
      description: 'More',
      labels: ['a', 'b'],
      assignees: ['ana'],
      confidential: true,
    })
    expect(i).toMatchObject({ iid: 4, title: 'Follow-up', labels: ['a', 'b'], assignees: ['ana'], confidential: true })
    expect(lastRequest('POST', 'issues').body).toEqual({
      title: 'Follow-up',
      description: 'More',
      labels: 'a,b',
      assignee_ids: [11],
      confidential: true,
    })
    const n = await ok('comment_issue', { project: 42, iid: 4, body: 'Started.' })
    expect(n.body).toBe('Started.')
    expect(lastRequest('POST', 'notes').path).toBe('/projects/42/issues/4/notes')
  })

  it('current_user', async () => {
    expect(await ok('current_user')).toEqual({ id: 7, username: 'billing-bot', name: 'Billing Bot (AI)', bot: true })
  })

  it('invalid arguments are rejected by the schema', async () => {
    const r: any = await client
      .callTool({ name: 'get_issue', arguments: { project: 42, iid: -1 } })
      .catch((e: Error) => ({ isError: true, e }))
    expect(r.isError).toBe(true)
  })
})

describe('resolveUser', () => {
  it('returns handle, public email and name', async () => {
    expect(await integration.resolveUser!('ana')).toEqual({
      handle: { system: 'gitlab', id: 'ana' },
      email: 'ana@example.com',
      name: 'Ana Example',
    })
    expect(await integration.resolveUser!('@marko')).toEqual({ handle: { system: 'gitlab', id: 'marko' }, name: 'Marko Example' })
  })
  it('returns null for unknown users', async () => {
    expect(await integration.resolveUser!('ghost')).toBeNull()
    expect(await integration.resolveUser!('  ')).toBeNull()
  })
})

describe('self-hosted', () => {
  it('works under a sub-path base URL', async () => {
    const hosted = await startFakeGitlab({ prefix: '/gitlab' })
    try {
      const i = createGitlabIntegration({ secrets: { token: TOKEN, webhookSecret: 's' }, baseUrl: `${hosted.baseUrl}/` })
      expect(i.client.apiUrl).toBe(`${hosted.baseUrl}/api/v4`)
      const c = await connect(i)
      const r: any = await c.callTool({ name: 'get_project', arguments: { project: 42 } })
      expect(JSON.parse(r.content[0].text).path).toBe('acme/platform/billing')
      await c.close()
    } finally {
      await hosted.close()
    }
  })
})
