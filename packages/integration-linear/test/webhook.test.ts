import { createHmac } from 'node:crypto'
import { ManualClock, memoryLogger } from '@mp/core'
import type { Integration } from '@mp/mcp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLinearIntegration, mapWebhook, verifySignature } from '../src/index.ts'
import { FakeLinear, uid } from './fake-linear.ts'

const SECRET = 'whsec-test-linear'
const NOW = Date.UTC(2026, 8, 29, 12)
const clock = new ManualClock(NOW)
let fake: FakeLinear
let integration: Integration

const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex')

function request(payload: unknown, opts: { delivery?: string | null; signature?: string; method?: string } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'linear-event': (payload as any)?.type ?? 'Issue',
    'linear-signature': opts.signature ?? sign(body),
  }
  if (opts.delivery !== null) headers['linear-delivery'] = opts.delivery ?? '5f8b3a2e-1111-4a4a-9b9b-000000000001'
  return { method: opts.method ?? 'POST', headers, body, query: {} }
}

// Shapes follow Linear's webhook documentation: action, type, data, actor, updatedFrom, url, webhookTimestamp.
const ana = { id: uid(102), name: 'Ana Example', email: 'ana@example.com', type: 'user' }
const issueData = (extra: Record<string, unknown> = {}) => ({
  id: 'b3d6c7e8-0000-4000-8000-000000000123',
  createdAt: '2026-09-29T11:59:00.000Z',
  updatedAt: '2026-09-29T11:59:59.000Z',
  number: 123,
  title: 'Refunds fail for EUR cards',
  description: 'Stripe returns 402.',
  priority: 2,
  priorityLabel: 'High',
  teamId: uid(1),
  team: { id: uid(1), key: 'PAY', name: 'Payments' },
  stateId: uid(203),
  state: { id: uid(203), name: 'In Progress', type: 'started', color: '#f2c94c' },
  assigneeId: uid(101),
  assignee: { id: uid(101), name: 'Kai Bot' },
  creatorId: uid(102),
  labelIds: [uid(303)],
  labels: [{ id: uid(303), name: 'bug', color: '#f0f' }],
  ...extra,
})
const envelope = (type: string, action: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  action,
  type,
  actor: ana,
  createdAt: '2026-09-29T11:59:59.000Z',
  data,
  url: 'https://linear.app/acme/issue/PAY-123/refunds-fail-for-eur-cards',
  organizationId: uid(900),
  webhookTimestamp: NOW - 1000,
  webhookId: uid(950),
  ...extra,
})

beforeAll(async () => {
  fake = new FakeLinear()
  await fake.start()
  integration = createLinearIntegration({
    secrets: { apiKey: fake.apiKey, webhookSecret: SECRET },
    baseUrl: fake.url,
    clock,
    logger: memoryLogger(),
    retry: { sleep: async () => {} },
  })
})
afterAll(async () => {
  await fake.stop()
})
beforeEach(() => {
  clock.set(NOW)
  fake.requests = []
})

describe('signature verification', () => {
  it('accepts a valid signature', async () => {
    const r = await integration.handleWebhook(request(envelope('Issue', 'create', issueData())))
    expect(r.status).toBe(200)
    expect(r.events.length).toBeGreaterThan(0)
  })

  it('rejects a bad, missing, truncated or non-hex signature', async () => {
    const p = envelope('Issue', 'create', issueData())
    const body = JSON.stringify(p)
    for (const signature of [sign(body, 'other-secret'), '', sign(body).slice(0, 20), 'zz'.repeat(32), sign(`${body} `)]) {
      const r = await integration.handleWebhook(request(p, { signature }))
      expect(r.status).toBe(401)
      expect(r.events).toEqual([])
    }
  })

  it('verifySignature is exact and case-insensitive on hex', () => {
    expect(verifySignature('abc', sign('abc'), SECRET)).toBe(true)
    expect(verifySignature('abc', sign('abc').toUpperCase(), SECRET)).toBe(true)
    expect(verifySignature('abd', sign('abc'), SECRET)).toBe(false)
    expect(verifySignature('abc', undefined, SECRET)).toBe(false)
    expect(verifySignature('abc', sign('abc'), '')).toBe(false)
  })

  it('rejects a stale or future webhookTimestamp, and a missing one', async () => {
    for (const ts of [NOW - 61_000, NOW + 61_000, undefined]) {
      const r = await integration.handleWebhook(request(envelope('Issue', 'create', issueData(), { webhookTimestamp: ts })))
      expect(r.status).toBe(401)
      expect(r.body).toMatch(/webhookTimestamp/)
    }
    const ok = await integration.handleWebhook(
      request(envelope('Issue', 'create', issueData(), { webhookTimestamp: NOW - 59_000 })),
    )
    expect(ok.status).toBe(200)
  })

  it('rejects everything when no webhook secret is configured', async () => {
    const i = createLinearIntegration({ secrets: { apiKey: 'k' }, baseUrl: fake.url, clock })
    expect((await i.handleWebhook(request(envelope('Issue', 'create', issueData())))).status).toBe(401)
  })

  it('rejects non-POST requests and invalid JSON bodies', async () => {
    expect((await integration.handleWebhook(request(envelope('Issue', 'create', issueData()), { method: 'GET' }))).status).toBe(
      405,
    )
    expect((await integration.handleWebhook(request('not json'))).status).toBe(400)
    expect((await integration.handleWebhook(request('[]'))).status).toBe(400)
  })

  it('a replayed delivery has the same dedupe keys; without Linear-Delivery the body hash is used', async () => {
    const p = envelope('Issue', 'create', issueData())
    const a = await integration.handleWebhook(request(p))
    const b = await integration.handleWebhook(request(p))
    expect(a.events.map((e) => e.dedupeKey)).toEqual(b.events.map((e) => e.dedupeKey))
    expect(a.events[0]!.dedupeKey).toBe('linear:5f8b3a2e-1111-4a4a-9b9b-000000000001')
    const c = await integration.handleWebhook(request(p, { delivery: null }))
    const d = await integration.handleWebhook(request(p, { delivery: null }))
    expect(c.events[0]!.dedupeKey).toMatch(/^linear:body:[0-9a-f]{40}$/)
    expect(c.events[0]!.dedupeKey).toBe(d.events[0]!.dedupeKey)
    const other = await integration.handleWebhook(request({ ...p, webhookTimestamp: NOW - 2000 }, { delivery: null }))
    expect(other.events[0]!.dedupeKey).not.toBe(c.events[0]!.dedupeKey)
  })
})

describe('event mapping', () => {
  const handle = async (p: unknown, delivery = 'd-1') => {
    const r = await integration.handleWebhook(request(p, { delivery }))
    expect(r.status).toBe(200)
    return r.events
  }

  it('Issue create → issue.created, plus issue.assigned when it has an assignee', async () => {
    const events = await handle(envelope('Issue', 'create', issueData()))
    expect(events.map((e) => e.type)).toEqual(['issue.created', 'issue.assigned'])
    const [created, assigned] = events
    expect(created).toMatchObject({
      source: 'integration:linear',
      dedupeKey: 'linear:d-1',
      subject: { system: 'linear', id: 'PAY-123' },
      actor: { system: 'linear', id: uid(102) },
      text: 'Linear PAY-123 "Refunds fail for EUR cards": created by Ana Example',
    })
    // The assignee's email is looked up (the webhook body carries only id and name).
    expect(created!.payload).toEqual({
      action: 'create',
      id: 'b3d6c7e8-0000-4000-8000-000000000123',
      identifier: 'PAY-123',
      title: 'Refunds fail for EUR cards',
      state: 'In Progress',
      stateType: 'started',
      assignee: { id: uid(101), name: 'Kai Bot', email: 'kai@example.com' },
      priority: 2,
      priorityLabel: 'High',
      labels: ['bug'],
      team: 'PAY',
      url: 'https://linear.app/acme/issue/PAY-123/refunds-fail-for-eur-cards',
      actor: { id: uid(102), name: 'Ana Example' },
    })
    expect(assigned).toMatchObject({
      dedupeKey: 'linear:d-1:assigned',
      text: expect.stringContaining('assigned to Kai Bot by Ana Example'),
    })
    // Lookups are cached per user.
    fake.requests = []
    await handle(envelope('Issue', 'create', issueData()), 'd-2')
    expect(fake.requests.filter((r) => r.operation === 'User')).toHaveLength(0)
  })

  it('Issue create without an assignee is only issue.created', async () => {
    const events = await handle(envelope('Issue', 'create', issueData({ assigneeId: null, assignee: null })))
    expect(events.map((e) => e.type)).toEqual(['issue.created'])
    expect((events[0]!.payload as any).assignee).toBeNull()
  })

  it('Issue update → issue.updated plus issue.assigned, issue.state_changed and issue.labeled', async () => {
    const events = await handle(
      envelope(
        'Issue',
        'update',
        issueData({
          labelIds: [uid(303), uid(302)],
          labels: [
            { id: uid(303), name: 'bug' },
            { id: uid(302), name: 'backend' },
          ],
        }),
        {
          updatedFrom: {
            updatedAt: '2026-09-29T11:00:00.000Z',
            assigneeId: uid(102),
            stateId: uid(202),
            labelIds: [uid(303)],
            title: 'Refunds fail',
          },
        },
      ),
    )
    expect(events.map((e) => e.type)).toEqual(['issue.updated', 'issue.assigned', 'issue.state_changed', 'issue.labeled'])
    expect(events.map((e) => e.dedupeKey)).toEqual(['linear:d-1', 'linear:d-1:assigned', 'linear:d-1:state', 'linear:d-1:labels'])
    expect(events.every((e) => e.subject?.id === 'PAY-123' && e.actor?.id === uid(102))).toBe(true)
    expect(events[0]!.text).toBe(
      'Linear PAY-123 "Refunds fail for EUR cards": assigned to Kai Bot, moved to In Progress, labels changed, title changed by Ana Example',
    )
    expect(events[0]!.payload).toMatchObject({
      changed: ['assigneeId', 'stateId', 'labelIds', 'title'],
      changes: { title: { from: 'Refunds fail', to: 'Refunds fail for EUR cards' }, stateId: { from: uid(202), to: uid(203) } },
    })
    expect(events[1]!.payload).toMatchObject({ previousAssigneeId: uid(102), assignee: { id: uid(101) } })
    expect(events[2]!).toMatchObject({
      text: expect.stringContaining('moved to In Progress'),
      payload: { previousStateId: uid(202), state: 'In Progress' },
    })
    expect(events[3]!).toMatchObject({
      text: expect.stringContaining('labeled backend'),
      payload: { addedLabels: ['backend'], removedLabelIds: [] },
    })
  })

  it('an update that only unassigns is issue.unassigned; one that changes nothing specific is just issue.updated', async () => {
    const un = await handle(
      envelope('Issue', 'update', issueData({ assigneeId: null, assignee: null }), { updatedFrom: { assigneeId: uid(101) } }),
    )
    expect(un.map((e) => e.type)).toEqual(['issue.updated', 'issue.unassigned'])
    expect(un[1]!.text).toContain('unassigned by Ana Example')
    const prio = await handle(envelope('Issue', 'update', issueData(), { updatedFrom: { priority: 3, updatedAt: 'x' } }))
    expect(prio.map((e) => e.type)).toEqual(['issue.updated'])
    expect(prio[0]!.text).toContain('priority changed')
    const removedLabel = await handle(
      envelope('Issue', 'update', issueData({ labelIds: [], labels: [] }), { updatedFrom: { labelIds: [uid(303)] } }),
    )
    expect(removedLabel[1]).toMatchObject({ type: 'issue.labeled', payload: { addedLabels: [], removedLabelIds: [uid(303)] } })
  })

  it('Issue remove → issue.removed', async () => {
    const events = await handle(envelope('Issue', 'remove', issueData()))
    expect(events.map((e) => e.type)).toEqual(['issue.removed'])
    expect(events[0]!.text).toContain('removed by Ana Example')
  })

  it('builds the identifier from team key and number, or looks it up', async () => {
    const { team: _t, ...noTeam } = issueData()
    const known = fake.issues[0]!
    const events = await handle(envelope('Issue', 'create', { ...noTeam, id: known.id, assignee: null, assigneeId: null }))
    expect(events[0]!.subject).toEqual({ system: 'linear', id: 'PAY-1' })
    const direct = await handle(envelope('Issue', 'create', issueData({ identifier: 'PAY-777', assignee: null })))
    expect(direct[0]!.subject!.id).toBe('PAY-777')
  })

  it('Comment create/update/remove → comment.* with body and issue identifier', async () => {
    const data = {
      id: uid(700),
      body: 'Can you **also** check GBP?',
      issueId: 'b3d6c7e8-0000-4000-8000-000000000123',
      issue: { id: 'b3d6c7e8-0000-4000-8000-000000000123', identifier: 'PAY-123', title: 'Refunds fail for EUR cards' },
      userId: uid(102),
      user: { id: uid(102), name: 'Ana Example' },
      createdAt: '2026-09-29T11:59:59.000Z',
    }
    const [c] = await handle(envelope('Comment', 'create', data, { url: 'https://linear.app/acme/issue/PAY-123#comment-1' }))
    expect(c).toEqual({
      source: 'integration:linear',
      type: 'comment.created',
      dedupeKey: 'linear:d-1',
      subject: { system: 'linear', id: 'PAY-123' },
      actor: { system: 'linear', id: uid(102) },
      text: 'Linear PAY-123 "Refunds fail for EUR cards": comment created by Ana Example: Can you **also** check GBP?',
      payload: {
        action: 'create',
        commentId: uid(700),
        body: 'Can you **also** check GBP?',
        identifier: 'PAY-123',
        issueId: 'b3d6c7e8-0000-4000-8000-000000000123',
        issueTitle: 'Refunds fail for EUR cards',
        author: { id: uid(102), name: 'Ana Example', email: null },
        parentCommentId: null,
        url: 'https://linear.app/acme/issue/PAY-123#comment-1',
      },
    })
    expect((await handle(envelope('Comment', 'update', data)))[0]!.type).toBe('comment.updated')
    const removed = (await handle(envelope('Comment', 'remove', data)))[0]!
    expect(removed.type).toBe('comment.removed')
    expect(removed.text).not.toContain('GBP')
  })

  it('a comment whose body lacks the identifier gets it from the API; the actor falls back to data.userId', async () => {
    const known = fake.issues[1]!
    const [c] = await handle({
      ...envelope('Comment', 'create', { id: uid(701), body: 'hi', issueId: known.id, userId: uid(101) }),
      actor: undefined,
    })
    expect(c!.subject).toEqual({ system: 'linear', id: 'PAY-2' })
    expect(c!.actor).toEqual({ system: 'linear', id: uid(101) })
    expect((c!.payload as any).issueTitle).toBe('Add invoice PDF export')
  })

  it('a failed identifier lookup falls back to the issue id instead of failing the webhook', async () => {
    const [c] = await handle(
      envelope('Comment', 'create', { id: uid(702), body: 'hi', issueId: 'unknown-issue', userId: uid(101) }),
    )
    expect(c!.subject).toEqual({ system: 'linear', id: 'unknown-issue' })
  })

  it('IssueLabel → label.*; Reaction → reaction.* on the issue; other types pass through', async () => {
    const [l] = await handle(
      envelope('IssueLabel', 'create', { id: uid(310), name: 'needs-review', color: '#123456', teamId: uid(1) }),
    )
    expect(l).toMatchObject({
      type: 'label.created',
      text: 'Linear label "needs-review" created by Ana Example',
      payload: { name: 'needs-review' },
    })
    expect(l!.subject).toBeUndefined()
    const [r] = await handle(
      envelope('Reaction', 'create', {
        id: uid(720),
        emoji: '👍',
        userId: uid(102),
        commentId: uid(700),
        comment: { id: uid(700), issueId: fake.issues[0]!.id },
      }),
    )
    expect(r).toMatchObject({
      type: 'reaction.added',
      subject: { system: 'linear', id: 'PAY-1' },
      payload: { emoji: '👍', commentId: uid(700) },
    })
    expect(r!.text).toBe('Linear PAY-1: reaction 👍 added on a comment by Ana Example')
    const [p] = await handle(envelope('Project', 'update', { id: uid(401), name: 'Checkout v2' }))
    expect(p).toMatchObject({ type: 'project.update', text: 'Linear Project "Checkout v2" update by Ana Example' })
    const [ic] = await handle(envelope('IssueComment', 'create', { id: 'x' }))
    expect(ic!.type).toBe('issue_comment.create')
  })

  it('mapWebhook works without lookups', async () => {
    const events = await mapWebhook(envelope('Comment', 'create', { id: 'c', body: 'b', issueId: 'i-1' }) as any, 'k')
    expect(events[0]!.subject).toEqual({ system: 'linear', id: 'i-1' })
  })

  it('long descriptions in changes are clipped', async () => {
    const long = 'x'.repeat(2000)
    const [u] = await handle(
      envelope('Issue', 'update', issueData({ description: long }), { updatedFrom: { description: 'short' } }),
    )
    expect(((u!.payload as any).changes.description.to as string).length).toBe(500)
  })
})

describe('resolveUser', () => {
  it('returns the handle, email, name and display name', async () => {
    expect(await integration.resolveUser!(uid(102))).toEqual({
      handle: { system: 'linear', id: uid(102) },
      email: 'ana@example.com',
      name: 'Ana Example',
      displayName: 'ana',
    })
  })
  it('returns null for an unknown user', async () => {
    expect(await integration.resolveUser!(uid(199))).toBeNull()
  })
})
