import { memoryLogger } from '@mp/core'
import type { WebhookRequest } from '@mp/mcp'
import { describe, expect, it } from 'vitest'
import { createGitlabIntegration, dedupeKey, mrIidFromRef, verifyGitlabToken } from '../src/index.ts'
import * as p from './payloads.ts'

const SECRET = 'whsec-test-secret'
const logger = memoryLogger()
const integration = createGitlabIntegration({ secrets: { token: 'glpat-test', webhookSecret: SECRET }, logger })

const HEADERS: Record<string, string> = {
  'Merge Request Hook': 'merge_request',
  'Note Hook': 'note',
  'Pipeline Hook': 'pipeline',
  'Job Hook': 'build',
  'Push Hook': 'push',
  'Issue Hook': 'issue',
}
const eventHeader = (body: any) => Object.entries(HEADERS).find(([, k]) => k === body.object_kind)?.[0] ?? 'System Hook'

let n = 0
const req = (body: unknown, headers: Record<string, string> = {}): WebhookRequest => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-gitlab-event': eventHeader(body),
    'x-gitlab-token': SECRET,
    'x-gitlab-event-uuid': `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    'x-gitlab-webhook-uuid': '11111111-1111-4111-8111-111111111111',
    ...headers,
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  query: {},
})
const one = async (body: unknown) => {
  const r = await integration.handleWebhook(req(body))
  expect(r.status).toBe(200)
  expect(r.events).toHaveLength(1)
  return r.events[0]!
}

describe('verification', () => {
  it('verifyGitlabToken is exact', () => {
    expect(verifyGitlabToken(SECRET, SECRET)).toBe(true)
    expect(verifyGitlabToken(`${SECRET}x`, SECRET)).toBe(false)
    expect(verifyGitlabToken(SECRET.slice(0, -1), SECRET)).toBe(false)
    expect(verifyGitlabToken('', SECRET)).toBe(false)
    expect(verifyGitlabToken(undefined, SECRET)).toBe(false)
    expect(verifyGitlabToken(SECRET, '')).toBe(false)
  })

  it('accepts a valid token', async () => {
    const r = await integration.handleWebhook(req(p.push()))
    expect(r.status).toBe(200)
    expect(r.events).toHaveLength(1)
  })

  it('rejects a wrong or missing token with 401 and no events', async () => {
    const bad = await integration.handleWebhook(req(p.push(), { 'x-gitlab-token': 'guess' }))
    expect(bad).toMatchObject({ status: 401, events: [] })
    const { 'x-gitlab-token': _, ...rest } = req(p.push()).headers
    const missing = await integration.handleWebhook({ ...req(p.push()), headers: rest })
    expect(missing).toMatchObject({ status: 401, events: [] })
    expect(logger.lines.some((l) => l.msg.includes('bad token'))).toBe(true)
    expect(JSON.stringify(logger.lines)).not.toContain(SECRET)
  })

  it('rejects other methods and bad JSON', async () => {
    expect((await integration.handleWebhook({ ...req(p.push()), method: 'GET' })).status).toBe(405)
    expect(await integration.handleWebhook(req('{not json'))).toMatchObject({ status: 400, events: [] })
    expect(await integration.handleWebhook(req('null'))).toMatchObject({ status: 400, events: [] })
  })

  it('acknowledges unknown kinds with no events', async () => {
    expect(await integration.handleWebhook(req({ object_kind: 'wiki_page', object_attributes: {} }))).toMatchObject({
      status: 200,
      events: [],
    })
    expect(await integration.handleWebhook(req({ object_kind: 'tag_push', ref: 'refs/tags/v1' }))).toMatchObject({
      status: 200,
      events: [],
    })
  })

  it('the factory requires both secrets', () => {
    expect(() => createGitlabIntegration({ secrets: { token: '', webhookSecret: 's' } })).toThrow(/token/)
    expect(() => createGitlabIntegration({ secrets: { token: 't', webhookSecret: '' } })).toThrow(/webhook secret/)
  })
})

describe('dedupe', () => {
  it('uses the event UUID, stable across redeliveries of the same event', async () => {
    const body = p.push()
    const headers = { 'x-gitlab-event-uuid': 'aaaaaaaa-0000-4000-8000-000000000001' }
    const a = await integration.handleWebhook(req(body, headers))
    const b = await integration.handleWebhook(req(body, headers))
    expect(a.events[0]!.dedupeKey).toBe('gitlab:push:aaaaaaaa-0000-4000-8000-000000000001')
    expect(b.events[0]!.dedupeKey).toBe(a.events[0]!.dedupeKey)
  })

  it('falls back to the webhook UUID plus the body hash', () => {
    const k1 = dedupeKey({ 'x-gitlab-webhook-uuid': 'hook-1' }, '{"a":1}', 'push')
    expect(k1).toMatch(/^gitlab:push:hook-1:[0-9a-f]{32}$/)
    expect(dedupeKey({ 'x-gitlab-webhook-uuid': 'hook-1' }, '{"a":1}', 'push')).toBe(k1)
    expect(dedupeKey({ 'x-gitlab-webhook-uuid': 'hook-1' }, '{"a":2}', 'push')).not.toBe(k1)
    expect(dedupeKey({}, '{"a":1}', 'push')).toMatch(/^gitlab:push:[0-9a-f]{32}$/)
  })

  it('different events get different keys', async () => {
    const a = await one(p.pipeline('running'))
    const b = await one(p.pipeline('failed'))
    expect(a.dedupeKey).not.toBe(b.dedupeKey)
  })

  it('one event per pipeline and status, though GitLab sends a hook on every job change', async () => {
    // Two deliveries (each with its own event UUID) for the same running pipeline: one key.
    const first = await one(p.pipeline('running'))
    const again = await one(p.pipeline('running'))
    expect(again.dedupeKey).toBe(first.dedupeKey)
    expect(first.dedupeKey).toMatch(/^gitlab:pipeline:.+:pipeline\.running$/)
  })
})

describe('merge request events', () => {
  it.each([
    ['open', 'merge_request.opened', 'opened'],
    ['reopen', 'merge_request.opened', 'opened'],
    ['update', 'merge_request.updated', 'updated'],
    ['approved', 'merge_request.approved', 'approved'],
    ['approval', 'merge_request.approved', 'approved'],
    ['unapproved', 'merge_request.unapproved', 'unapproved'],
    ['merge', 'merge_request.merged', 'merged'],
    ['close', 'merge_request.closed', 'closed'],
  ])('%s → %s', async (action, type, verb) => {
    const e = await one(p.mergeRequest(action))
    expect(e).toMatchObject({
      source: 'integration:gitlab',
      type,
      subject: { system: 'gitlab', id: 'acme/platform/billing!12' },
      actor: { system: 'gitlab', id: 'ana' },
      text: `GitLab acme/platform/billing!12 "Fix rounding in invoices": merge request ${verb} by @ana`,
    })
    expect(e.payload).toMatchObject({
      project: 'acme/platform/billing',
      iid: 12,
      action,
      source_branch: 'mp/billing-bot/fix-rounding',
      target_branch: 'main',
      labels: ['bug'],
      reviewers: ['ana'],
      assignees: ['billing-bot'],
      actor: 'ana',
    })
  })

  it('an update with new commits or changed fields says so', async () => {
    const pushed = await one(p.mergeRequest('update', { oldrev: 'abc' }))
    expect(pushed.text).toContain('(new commits pushed)')
    expect(pushed.payload).toMatchObject({ new_commits: true })
    const changed = await one({ ...p.mergeRequest('update'), changes: { title: { previous: 'a', current: 'b' }, labels: {} } })
    expect(changed.text).toContain('(title, labels changed)')
    expect(changed.payload).toMatchObject({ changed: ['title', 'labels'] })
  })

  it('the payload never carries the raw body or user emails', async () => {
    const e = await one(p.mergeRequest('open'))
    expect(JSON.stringify(e.payload)).not.toContain('REDACTED')
    expect(e.payload).not.toHaveProperty('user')
  })
})

describe('comment events', () => {
  it('a note on an MR', async () => {
    const e = await one(p.mrNote())
    expect(e).toMatchObject({
      type: 'comment.created',
      subject: { system: 'gitlab', id: 'acme/platform/billing!12' },
      actor: { system: 'gitlab', id: 'ana' },
      text: 'GitLab acme/platform/billing!12 "Fix rounding in invoices": comment by @ana: Please handle negative amounts.',
      payload: {
        on: 'merge_request',
        iid: 12,
        note_id: 1244,
        discussion_id: 'd1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0',
        body: 'Please handle\nnegative amounts.',
        path: 'src/app.ts',
        line: 2,
      },
    })
  })

  it('a note on an issue', async () => {
    const e = await one(p.issueNote())
    expect(e).toMatchObject({
      type: 'comment.created',
      subject: { system: 'gitlab', id: 'acme/platform/billing#3' },
      text: 'GitLab acme/platform/billing#3 "Invoices round wrong": comment by @ana: Seen again today.',
      payload: { on: 'issue', iid: 3, path: null, line: null },
    })
  })

  it('long notes are truncated in the text', async () => {
    const e = await one(p.mrNote({ note: 'x'.repeat(5000) }))
    expect(e.text.length).toBeLessThan(400)
    expect(String((e.payload as any).body).length).toBeLessThan(4100)
  })

  it('notes on commits and snippets are ignored', async () => {
    expect((await integration.handleWebhook(req(p.commitNote()))).events).toEqual([])
  })
})

describe('pipeline and job events', () => {
  it('a failed MR pipeline attaches to the MR and names the failed job', async () => {
    const e = await one(p.pipeline('failed'))
    expect(e).toMatchObject({
      type: 'pipeline.failed',
      subject: { system: 'gitlab', id: 'acme/platform/billing!12' },
      actor: { system: 'gitlab', id: 'ana' },
      text: 'GitLab acme/platform/billing!12 "Fix rounding in invoices": pipeline 900 failed on job test',
      payload: { pipeline_id: 900, merge_request_iid: 12, failed_jobs: ['test'], actor: 'ana' },
    })
  })

  it.each([
    ['success', 'pipeline.succeeded'],
    ['running', 'pipeline.running'],
    ['canceled', 'pipeline.canceled'],
  ])('%s → %s', async (status, type) => {
    const e = await one(p.pipeline(status))
    expect(e.type).toBe(type)
    expect(e.text).not.toContain('on job')
  })

  it('a branch pipeline attaches to the ref', async () => {
    const e = await one(p.pipeline('success', false))
    expect(e).toMatchObject({
      subject: { system: 'gitlab', id: 'acme/platform/billing@main' },
      text: 'GitLab acme/platform/billing@main: pipeline 900 succeeded',
      payload: { merge_request_iid: null },
    })
  })

  it('an MR pipeline ref alone is enough to attach to the MR', async () => {
    const body = { ...p.pipeline('failed'), merge_request: null }
    const e = await one(body)
    expect(e.subject).toEqual({ system: 'gitlab', id: 'acme/platform/billing!12' })
  })

  it('many failed jobs are shortened in the text', async () => {
    const builds = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      name: `j${i}`,
      stage: 't',
      status: 'failed',
      allow_failure: false,
    }))
    const e = await one(p.pipeline('failed', true, builds))
    expect(e.text).toContain('on job j0, j1, j2, j3, j4, …')
  })

  it('pending, created and skipped pipelines are ignored', async () => {
    for (const s of ['pending', 'created', 'skipped', 'manual'])
      expect((await integration.handleWebhook(req(p.pipeline(s)))).events).toEqual([])
  })

  it('a failed job → job.failed, on the MR for merge request refs', async () => {
    const e = await one(p.job('failed'))
    expect(e).toMatchObject({
      type: 'job.failed',
      subject: { system: 'gitlab', id: 'acme/platform/billing!12' },
      actor: { system: 'gitlab', id: 'ana' },
      text: 'GitLab acme/platform/billing!12: job test (test) failed: script_failure',
      payload: { job_id: 5001, name: 'test', pipeline_id: 900, merge_request_iid: 12, actor: 'ana' },
    })
    const onBranch = await one(p.job('failed', 'mp/billing-bot/fix-rounding'))
    expect(onBranch.subject).toEqual({ system: 'gitlab', id: 'acme/platform/billing@mp/billing-bot/fix-rounding' })
  })

  it('the project path falls back to the repository homepage', async () => {
    const { project: _, ...body } = p.job('failed')
    const e = await one(body)
    expect(e.subject!.id).toBe('acme/platform/billing!12')
  })

  it('other job statuses are ignored', async () => {
    for (const s of ['success', 'running', 'created']) expect((await integration.handleWebhook(req(p.job(s)))).events).toEqual([])
  })

  it('mrIidFromRef', () => {
    expect(mrIidFromRef('refs/merge-requests/12/head')).toBe(12)
    expect(mrIidFromRef('refs/merge-requests/7/merge')).toBe(7)
    expect(mrIidFromRef('main')).toBeUndefined()
    expect(mrIidFromRef(undefined)).toBeUndefined()
  })
})

describe('push events', () => {
  it('a push to a branch', async () => {
    const e = await one(p.push())
    expect(e).toMatchObject({
      type: 'push',
      subject: { system: 'gitlab', id: 'acme/platform/billing@mp/billing-bot/fix-rounding' },
      actor: { system: 'gitlab', id: 'billing-bot' },
      text: 'GitLab acme/platform/billing@mp/billing-bot/fix-rounding: @billing-bot pushed 2 commits',
      payload: {
        branch: 'mp/billing-bot/fix-rounding',
        created: false,
        deleted: false,
        total_commits: 2,
        actor: 'billing-bot',
        commits: [
          { id: 'b6568db1', title: 'Round to cents', author: 'Billing Bot (AI)' },
          { id: 'da156088', title: 'Add tests', author: 'Billing Bot (AI)' },
        ],
      },
    })
  })

  it('new and deleted branches', async () => {
    const created = await one(p.push({ before: '0000000000000000000000000000000000000000', total_commits_count: 1 }))
    expect(created.text).toContain('pushed 1 commit (new branch)')
    const deleted = await one(p.push({ after: '0000000000000000000000000000000000000000', commits: [], total_commits_count: 0 }))
    expect(deleted.text).toContain('deleted the branch')
  })
})

describe('issue events', () => {
  it.each([
    ['open', 'issue.opened'],
    ['reopen', 'issue.opened'],
    ['update', 'issue.updated'],
    ['close', 'issue.closed'],
  ])('%s → %s', async (action, type) => {
    const e = await one(p.issue(action))
    expect(e).toMatchObject({
      type,
      subject: { system: 'gitlab', id: 'acme/platform/billing#3' },
      actor: { system: 'gitlab', id: 'ana' },
      payload: { iid: 3, title: 'Invoices round wrong', labels: ['bug'], assignees: ['billing-bot'] },
    })
    expect(e.text).toMatch(/^GitLab acme\/platform\/billing#3 "Invoices round wrong": issue /)
  })

  it('an update lists what changed', async () => {
    expect((await one(p.issue('update'))).text).toBe(
      'GitLab acme/platform/billing#3 "Invoices round wrong": issue updated (labels changed) by @ana',
    )
  })
})
