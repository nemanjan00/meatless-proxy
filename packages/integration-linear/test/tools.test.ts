import { memoryLogger } from '@mp/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLinearIntegration, LINEAR_TOOLS } from '../src/index.ts'
import { FakeLinear, uid } from './fake-linear.ts'

let fake: FakeLinear
let client: Client
let close: () => Promise<void>

async function connect(fakeApi: FakeLinear) {
  const integration = createLinearIntegration({
    secrets: { apiKey: fakeApi.apiKey, webhookSecret: 'whsec-test' },
    baseUrl: fakeApi.url,
    logger: memoryLogger(),
    retry: { retryBaseMs: 1, sleep: async () => {} },
  })
  const server = integration.createMcpServer() as any
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(ct)
  return {
    client: c,
    close: async () => {
      await c.close()
      await server.close()
    },
  }
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  const text = res.content[0]!.text
  // Argument validation errors come from the SDK as plain text; tool failures are JSON.
  return { isError: !!res.isError, data: text.startsWith('{') ? JSON.parse(text) : { error: text } }
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args)
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.data)}`)
  return r.data
}

beforeAll(async () => {
  fake = new FakeLinear()
  await fake.start()
})
afterAll(async () => {
  await fake.stop()
})
beforeEach(async () => {
  ;({ client, close } = await connect(fake))
  fake.requests = []
})
afterEach(async () => {
  await close()
})

describe('linear MCP tools', () => {
  it('lists every tool, with descriptions and read-only hints', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...LINEAR_TOOLS].sort())
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(20)
    expect(tools.find((t) => t.name === 'get_issue')!.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((t) => t.name === 'create_issue')!.annotations?.readOnlyHint).toBe(false)
  })

  it('sends the API key as the Authorization header', async () => {
    await ok('viewer')
    expect(fake.requests[0]!.headers.authorization).toBe(fake.apiKey)
  })

  it('viewer returns the connected user and workspace', async () => {
    expect(await ok('viewer')).toEqual({
      id: uid(101),
      name: 'Kai Bot',
      displayName: 'kai',
      email: 'kai@example.com',
      organization: { name: 'Acme', urlKey: 'acme' },
    })
  })

  describe('search_issues', () => {
    it('filters by team, state, assignee and labels', async () => {
      const res = await ok('search_issues', { team: 'pay', state: ['In Progress'], assignee: 'me', labels: ['bug', 'backend'] })
      expect(res.issues.map((i: any) => i.identifier)).toEqual(['PAY-1'])
      expect(res.issues[0]).toMatchObject({
        title: 'Refunds fail for EUR cards',
        state: 'In Progress',
        stateType: 'started',
        priority: 'High',
        assignee: { id: uid(101), name: 'Kai Bot', email: 'kai@example.com' },
        team: 'PAY',
        project: 'Checkout v2',
      })
      expect([...res.issues[0].labels].sort()).toEqual(['backend', 'bug'])
      expect(fake.requests.at(-1)!.operation).toBe('Issues')
    })

    it('takes state types, an email and "none" for assignee', async () => {
      expect((await ok('search_issues', { state: 'completed' })).issues.map((i: any) => i.identifier)).toEqual(['PAY-3'])
      expect((await ok('search_issues', { assignee: 'ana@example.com' })).issues.map((i: any) => i.identifier)).toEqual(['PAY-2'])
      expect((await ok('search_issues', { assignee: 'none' })).issues.map((i: any) => i.identifier)).toEqual(['OPS-1'])
    })

    it('uses full-text search when text is given', async () => {
      const res = await ok('search_issues', { text: 'refund' })
      expect(res.issues.map((i: any) => i.identifier).sort()).toEqual(['PAY-1', 'PAY-3'])
      expect(fake.requests.at(-1)!.operation).toBe('SearchIssues')
      expect(fake.requests.at(-1)!.variables.term).toBe('refund')
    })

    it('pages with limit and cursor', async () => {
      const a = await ok('search_issues', { limit: 2 })
      expect(a.issues).toHaveLength(2)
      expect(a.nextCursor).toBeTruthy()
      const b = await ok('search_issues', { limit: 10, cursor: a.nextCursor })
      expect(b.issues).toHaveLength(2)
      expect(b.nextCursor).toBeNull()
      const ids = [...a.issues, ...b.issues].map((i: any) => i.identifier)
      expect(new Set(ids).size).toBe(4)
    })

    it('follows several pages to reach the limit', async () => {
      const many = new FakeLinear()
      for (let n = 0; n < 120; n++) many.addIssue({ title: `Chore ${n}`, teamId: uid(2) })
      await many.start()
      const c = await connect(many)
      try {
        const res = (await c.client.callTool({ name: 'search_issues', arguments: { team: 'OPS', limit: 100 } })) as any
        const data = JSON.parse(res.content[0].text)
        expect(data.issues).toHaveLength(100)
        expect(data.nextCursor).toBeTruthy()
        expect(many.requests.filter((r) => r.operation === 'Issues').map((r) => r.variables.first)).toEqual([50, 50])
      } finally {
        await c.close()
        await many.stop()
      }
    })
  })

  it('get_issue returns details, children and the latest comments oldest first', async () => {
    const i = await ok('get_issue', { issue: 'PAY-1' })
    expect(i).toMatchObject({
      identifier: 'PAY-1',
      description: 'Stripe returns 402 on refunds.',
      state: 'In Progress',
      parent: null,
      children: [{ identifier: 'PAY-3', title: 'Reproduce refund failure', state: 'Done', assignee: 'Kai Bot' }],
    })
    expect(i.comments.map((c: any) => c.body)).toEqual(['Seen again today.', 'Looking into it.'])
    expect(i.comments[0].author).toEqual({ id: uid(102), name: 'Ana Example', email: 'ana@example.com' })
    const latest = await ok('get_issue', { issue: 'PAY-1', comments: 1 })
    expect(latest.comments.map((c: any) => c.body)).toEqual(['Looking into it.'])
    const child = await ok('get_issue', { issue: fake.issues[3]!.id })
    expect(child.parent).toEqual({ identifier: 'PAY-1', title: 'Refunds fail for EUR cards' })
  })

  it('get_issue on a missing issue is an error result', async () => {
    const r = await call('get_issue', { issue: 'PAY-999' })
    expect(r.isError).toBe(true)
    expect(r.data.error).toMatch(/Could not find referenced Issue/)
    expect(r.data.code).toBe('integration_request')
  })

  describe('create_issue', () => {
    it('resolves the team key, assignee email, label names, parent identifier, project name and state', async () => {
      const i = await ok('create_issue', {
        teamId: 'PAY',
        title: 'Retry webhook deliveries',
        description: '## Why\nThey get lost.',
        priority: 'urgent',
        assigneeId: 'ana@example.com',
        labelIds: ['bug', 'backend'],
        parentId: 'PAY-1',
        projectId: 'checkout v2',
        state: 'todo',
      })
      expect(i).toMatchObject({ identifier: 'PAY-4', priority: 'Urgent', state: 'Todo', parent: 'PAY-1', project: 'Checkout v2' })
      expect(i.url).toContain('/issue/PAY-4/')
      const input = fake.requests.find((r) => r.operation === 'IssueCreate')!.variables.input
      expect(input).toEqual({
        teamId: uid(1),
        title: 'Retry webhook deliveries',
        description: '## Why\nThey get lost.',
        priority: 1,
        assigneeId: uid(102),
        // The team's own "bug" wins over the workspace "bug".
        labelIds: [uid(303), uid(302)],
        parentId: fake.issues[0]!.id,
        projectId: uid(401),
        stateId: uid(202),
      })
    })

    it("uses the parent's team when no team is given, and 'me'", async () => {
      const i = await ok('create_issue', { title: 'Child of OPS', parentId: 'OPS-1', assigneeId: 'me' })
      expect(i.identifier).toMatch(/^OPS-\d+$/)
      expect(i.assignee.id).toBe(uid(101))
    })

    it('fails clearly without a team, or with an unknown team, label or state', async () => {
      expect((await call('create_issue', { title: 'x' })).data.error).toMatch(/team is required/)
      expect((await call('create_issue', { title: 'x', teamId: 'NOPE' })).data).toMatchObject({
        error: expect.stringMatching(/team NOPE not found/),
        hint: expect.any(String),
      })
      expect((await call('create_issue', { title: 'x', teamId: 'PAY', labelIds: ['nope'] })).data.error).toMatch(
        /unknown labels.*nope/,
      )
      expect((await call('create_issue', { title: 'x', teamId: 'PAY', state: 'Limbo' })).data.error).toMatch(
        /Limbo.*Backlog, Todo/,
      )
      expect((await call('create_issue', { title: 'x', teamId: 'PAY', priority: 'meh' })).data.error).toMatch(/priority/)
      expect(fake.requests.some((r) => r.operation === 'IssueCreate')).toBe(false)
    })
  })

  describe('update_issue', () => {
    it('sets the state by name, the assignee, priority, title and description', async () => {
      const i = await ok('update_issue', {
        issue: 'PAY-2',
        state: 'In Progress',
        assignee: 'Kai Bot',
        priority: 4,
        title: 'Add invoice PDF export (v2)',
        description: 'Updated.',
      })
      expect(i).toMatchObject({
        identifier: 'PAY-2',
        state: 'In Progress',
        assignee: { id: uid(101) },
        priority: 'Low',
        title: 'Add invoice PDF export (v2)',
      })
      expect(fake.requests.find((r) => r.operation === 'IssueUpdate')!.variables).toMatchObject({
        id: fake.issues[1]!.id,
        input: {
          stateId: uid(203),
          assigneeId: uid(101),
          priority: 4,
          title: 'Add invoice PDF export (v2)',
          description: 'Updated.',
        },
      })
    })

    it('unassigns with null or "none"', async () => {
      expect((await ok('update_issue', { issue: 'PAY-2', assignee: null })).assignee).toBeNull()
      expect((await ok('update_issue', { issue: 'PAY-2', assignee: 'none' })).assignee).toBeNull()
    })

    it('replaces, adds and removes labels', async () => {
      expect((await ok('update_issue', { issue: 'PAY-2', labels: ['bug'] })).labels).toEqual(['bug'])
      expect((await ok('update_issue', { issue: 'PAY-2', addLabels: ['backend'] })).labels.sort()).toEqual(['backend', 'bug'])
      expect((await ok('update_issue', { issue: 'PAY-2', removeLabels: ['bug'] })).labels).toEqual(['backend'])
    })

    it('rejects an empty update and a state from another team', async () => {
      expect((await call('update_issue', { issue: 'PAY-2' })).data.error).toMatch(/nothing to update/)
      expect((await call('update_issue', { issue: 'OPS-1', state: 'Done' })).isError).toBe(true)
    })
  })

  it('create_sub_issue creates a child in the parent team and returns identifier and url', async () => {
    const r = await ok('create_sub_issue', { parent: 'PAY-1', title: 'Check EUR refunds in staging', description: 'Item 1 of 2' })
    expect(r).toEqual({
      id: expect.any(String),
      identifier: expect.stringMatching(/^PAY-\d+$/),
      url: expect.stringContaining('https://linear.app/acme/issue/PAY-'),
      title: 'Check EUR refunds in staging',
      parent: 'PAY-1',
    })
    const created = fake.issues.find((i) => i.id === r.id)!
    expect(created.parentId).toBe(fake.issues[0]!.id)
    expect((await call('create_sub_issue', { parent: 'PAY-404', title: 'x' })).isError).toBe(true)
  })

  it('comment posts markdown on an issue by identifier', async () => {
    const c = await ok('comment', { issue: 'PAY-2', body: '**Done**, see the MR.' })
    expect(c).toMatchObject({ id: expect.any(String), identifier: 'PAY-2', url: expect.stringContaining('PAY-2') })
    expect(fake.comments.at(-1)).toMatchObject({ issueId: fake.issues[1]!.id, body: '**Done**, see the MR.' })
    expect((await call('comment', { issue: 'PAY-2', body: '' })).isError).toBe(true)
  })

  it('list_teams, list_workflow_states, list_users, list_projects, list_labels and list_cycles', async () => {
    expect((await ok('list_teams')).teams).toEqual([
      { id: uid(1), key: 'PAY', name: 'Payments' },
      { id: uid(2), key: 'OPS', name: 'Operations' },
    ])
    expect((await ok('list_workflow_states', { team: 'PAY' })).states.map((s: any) => s.name)).toEqual([
      'Backlog',
      'Todo',
      'In Progress',
      'Done',
    ])
    expect((await ok('list_users')).users.map((u: any) => u.email)).toEqual(['kai@example.com', 'ana@example.com'])
    expect((await ok('list_users', { includeInactive: true })).users).toHaveLength(3)
    expect((await ok('list_users', { query: 'ana' })).users).toEqual([
      { id: uid(102), name: 'Ana Example', displayName: 'ana', email: 'ana@example.com' },
    ])
    expect((await ok('list_projects', { team: 'OPS' })).projects).toEqual([
      { id: uid(402), name: 'Datacenter move', state: 'planned', lead: null, targetDate: null, url: expect.any(String) },
    ])
    expect((await ok('list_labels', { team: 'PAY' })).labels.map((l: any) => `${l.name}:${l.team}`)).toEqual([
      'bug:null',
      'backend:PAY',
      'bug:PAY',
    ])
    expect((await ok('list_labels')).labels).toHaveLength(4)
    expect((await ok('list_cycles', { team: 'PAY' })).cycles).toEqual([
      expect.objectContaining({ number: 7, active: true, completed: false }),
      expect.objectContaining({ number: 6, name: 'Sprint 6', active: false, completed: true }),
    ])
  })

  it('reports authentication failures without leaking the key', async () => {
    const saved = fake.apiKey
    fake.apiKey = 'another-key'
    try {
      const r = await call('viewer')
      expect(r.isError).toBe(true)
      expect(r.data).toMatchObject({ code: 'integration_request', status: 400 })
      expect(r.data.error).toMatch(/authenticate/)
      expect(JSON.stringify(r.data)).not.toContain(saved)
    } finally {
      fake.apiKey = saved
    }
  })
})
