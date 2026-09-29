import { DeniedError, isMpError, ManualClock, memoryLogger, UnavailableError } from '@mp/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertNotMerging, createGitlabClient, type GitlabClient, parseRetryAfter, projectRef } from '../src/index.ts'
import { type FakeGitlab, startFakeGitlab, TOKEN } from './fake-gitlab.ts'

let fake: FakeGitlab
let api: GitlabClient
const logger = memoryLogger()

beforeEach(async () => {
  fake = await startFakeGitlab()
  logger.lines.length = 0
  api = createGitlabClient({ baseUrl: fake.baseUrl, token: TOKEN, retryBaseMs: 1, retryMaxMs: 50, maxRetries: 2, logger })
})
afterEach(() => fake.close())

describe('projectRef', () => {
  it('keeps numeric ids and URL-encodes paths', () => {
    expect(projectRef(42)).toBe('42')
    expect(projectRef('42')).toBe('42')
    expect(projectRef('group/sub/repo')).toBe('group%2Fsub%2Frepo')
    expect(projectRef('/group/repo/')).toBe('group%2Frepo')
  })
})

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('2', 0)).toBe(2000)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000)
    expect(parseRetryAfter(null, 0)).toBeUndefined()
    expect(parseRetryAfter('soon', 0)).toBeUndefined()
  })
})

describe('retries and errors', () => {
  it('retries a 429, honouring Retry-After', async () => {
    fake.inject({ status: 429, headers: { 'retry-after': '0' }, body: '{"message":"429 Too Many Requests"}' })
    const u = await api.get('/user')
    expect(u.username).toBe('billing-bot')
    expect(fake.requests).toHaveLength(2)
    expect(logger.lines.some((l) => l.msg === 'gitlab request retrying' && l.fields.status === 429)).toBe(true)
  })

  it('waits for Retry-After (capped by retryMaxMs)', async () => {
    fake.inject({ status: 429, headers: { 'retry-after': '1' } })
    const t = Date.now()
    await api.get('/user')
    const took = Date.now() - t
    expect(took).toBeGreaterThanOrEqual(40)
    expect(took).toBeLessThan(900)
  })

  it('reads a Retry-After date against the injected clock', async () => {
    const clock = new ManualClock(Date.UTC(2026, 8, 29, 10, 0, 0))
    const c = createGitlabClient({ baseUrl: fake.baseUrl, token: TOKEN, clock, retryMaxMs: 10_000, maxRetries: 1 })
    fake.inject({ status: 429, headers: { 'retry-after': new Date(clock.now()).toUTCString() } })
    const t = Date.now()
    await c.get('/user')
    expect(Date.now() - t).toBeLessThan(500)
  })

  it('retries 5xx and then succeeds', async () => {
    fake.inject({ status: 502 }, { status: 503 })
    expect((await api.get('/user')).id).toBe(7)
    expect(fake.requests).toHaveLength(3)
  })

  it('gives up with UnavailableError after maxRetries', async () => {
    fake.inject({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 })
    const e = await api.get('/user').catch((x) => x)
    expect(e).toBeInstanceOf(UnavailableError)
    expect(e.details).toMatchObject({ status: 500, method: 'GET', path: '/user' })
    expect(fake.requests).toHaveLength(3)
  })

  it('network failures are retried and then unavailable', async () => {
    const c = createGitlabClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, retryBaseMs: 1, maxRetries: 1 })
    const e = await c.get('/user').catch((x) => x)
    expect(e).toBeInstanceOf(UnavailableError)
    expect(e.message).toContain('network')
  })

  it('4xx is MpError(integration_request) with the status and GitLab message, not retried', async () => {
    fake.inject({ status: 403, body: '{"message":"403 Forbidden"}' })
    const e = await api.get('/projects/42').catch((x) => x)
    expect(isMpError(e, 'integration_request')).toBe(true)
    expect(e.details.status).toBe(403)
    expect(e.message).toContain('403 Forbidden')
    expect(fake.requests).toHaveLength(1)
  })

  it('field errors in message objects are rendered', async () => {
    fake.inject({ status: 400, body: '{"message":{"title":["is too long"]}}' })
    const e = await api.post('/projects/42/issues', { title: 'x' }).catch((x) => x)
    expect(e.message).toContain('is too long')
  })

  it('a bad token is a 401 error, and the token never appears in errors or logs', async () => {
    const c = createGitlabClient({ baseUrl: fake.baseUrl, token: 'glpat-wrong-secret', logger, maxRetries: 0 })
    fake.inject({ status: 500, body: '{"message":"echo glpat-wrong-secret"}' })
    const e1 = await c.get('/user').catch((x) => x)
    expect(e1.message).not.toContain('glpat-wrong-secret')
    expect(e1.message).toContain('[redacted]')
    const e2 = await c.get('/user').catch((x) => x)
    expect(e2.details.status).toBe(401)
    expect(JSON.stringify(logger.lines)).not.toContain('glpat-wrong-secret')
  })

  it('handles concurrent requests independently', async () => {
    fake.inject({ status: 503 })
    const results = await Promise.all(Array.from({ length: 10 }, () => api.get('/projects/42')))
    expect(results.every((p) => p.id === 42)).toBe(true)
    expect(fake.requests).toHaveLength(11)
  })

  it('encodes array query params GitLab-style', async () => {
    await api.get('/projects/42/merge_requests', { labels: ['a', 'b'], state: 'opened' })
    const q = fake.requests[0]!.query
    expect(q.getAll('labels[]')).toEqual(['a', 'b'])
  })
})

describe('never merging (the hard rule)', () => {
  const refused = [
    ['PUT', '/projects/42/merge_requests/12/merge', undefined],
    ['POST', '/projects/42/merge_requests/12/approve', undefined],
    ['POST', '/projects/42/merge_requests/12/unapprove', undefined],
    ['POST', '/projects/42/merge_requests/12/merge_when_pipeline_succeeds', undefined],
    ['POST', '/projects/42/merge_trains/merge_requests/12', undefined],
    ['PUT', '/projects/42/merge_requests/12', { state_event: 'merge' }],
    ['PUT', '/projects/42/merge_requests/12', { merge_when_pipeline_succeeds: true }],
    ['PUT', '/projects/42/merge_requests/12', { auto_merge: true }],
    ['POST', '/projects/42/merge_requests', { source_branch: 'x', target_branch: 'main', title: 't', auto_merge_strategy: 'x' }],
  ] as const

  it.each(refused)('%s %s is refused before any request', async (method, path, body) => {
    const e = await api.request(method, path, body ? { body: { ...body } } : {}).catch((x) => x)
    expect(e).toBeInstanceOf(DeniedError)
    expect(fake.requests).toHaveLength(0)
    expect(fake.state.mrs.find((m) => m.iid === 12)!.state).toBe('opened')
  })

  it('reads and ordinary updates are allowed', () => {
    expect(() => assertNotMerging('GET', '/projects/42/merge_requests/12/merge_ref')).not.toThrow()
    expect(() => assertNotMerging('PUT', '/projects/42/merge_requests/12', { title: 'x' })).not.toThrow()
    expect(() => assertNotMerging('POST', '/projects/42/merge_requests/12/notes', { body: 'please merge' })).not.toThrow()
  })
})
