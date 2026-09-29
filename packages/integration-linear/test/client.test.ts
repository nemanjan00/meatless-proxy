import { isMpError, ManualClock, memoryLogger, MpError, UnavailableError } from '@mp/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLinearClient, waitFor } from '../src/index.ts'
import { FakeLinear, rateLimited } from './fake-linear.ts'

let fake: FakeLinear
const clock = new ManualClock(Date.UTC(2026, 8, 29, 12))
let delays: number[]
const logger = memoryLogger()

const client = (extra: Record<string, unknown> = {}) =>
  createLinearClient({
    apiKey: fake.apiKey,
    baseUrl: fake.url,
    clock,
    logger,
    retryBaseMs: 100,
    retryMaxMs: 10_000,
    sleep: async (ms) => void delays.push(ms),
    ...extra,
  })

const VIEWER = 'query Viewer { viewer { id name } }'
const CREATE = 'mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }'

beforeAll(async () => {
  fake = new FakeLinear()
  await fake.start()
})
afterAll(async () => {
  await fake.stop()
})
beforeEach(() => {
  delays = []
  fake.queue = []
  fake.requests = []
  logger.lines.length = 0
})

describe('linear GraphQL client', () => {
  it('returns data', async () => {
    const d = await client().request(VIEWER)
    expect(d.viewer.name).toBe('Kai Bot')
  })

  it('retries HTTP 429 after Retry-After seconds', async () => {
    fake.queue.push({ status: 429, headers: { 'retry-after': '3' }, body: { errors: [{ message: 'slow down' }] } })
    const d = await client().request(VIEWER)
    expect(d.viewer.id).toBeTruthy()
    expect(delays).toEqual([3000])
    expect(fake.requests).toHaveLength(2)
  })

  it('retries RATELIMITED (HTTP 400) until the rate-limit reset', async () => {
    fake.queue.push(rateLimited(clock.now() + 2500))
    await client().request(VIEWER)
    expect(delays).toEqual([2500])
  })

  it('retries rate limits even for mutations', async () => {
    fake.queue.push(rateLimited(clock.now() + 50))
    const d = await client().request(CREATE, { input: { teamId: fake.teams[0]!.id, title: 'Once' } }, { mutation: true })
    expect(d.issueCreate.success).toBe(true)
    expect(fake.requests.filter((r) => r.operation === 'IssueCreate')).toHaveLength(2)
    expect(fake.issues.filter((i) => i.title === 'Once')).toHaveLength(1)
  })

  it('retries 5xx for queries with exponential backoff', async () => {
    fake.queue.push({ status: 502, body: 'bad gateway' }, { status: 503, body: '' })
    await client().request(VIEWER)
    expect(delays).toEqual([100, 200])
    expect(logger.lines.filter((l) => l.msg === 'linear request failed, retrying')).toHaveLength(2)
  })

  it('does not retry a mutation on 5xx, since it may have been applied', async () => {
    fake.queue.push({ status: 500, body: { errors: [{ message: 'Internal' }] } })
    const e = await client()
      .request(CREATE, { input: { teamId: fake.teams[0]!.id, title: 'Maybe' } }, { mutation: true })
      .catch((x) => x)
    expect(isMpError(e, 'integration_request')).toBe(true)
    expect(e.message).toMatch(/may have been applied/)
    expect(e.details.status).toBe(500)
    expect(fake.requests).toHaveLength(1)
  })

  it('gives up with UnavailableError after maxRetries', async () => {
    for (let n = 0; n < 5; n++) fake.queue.push({ status: 503, body: '' })
    const e = await client({ maxRetries: 2 })
      .request(VIEWER)
      .catch((x) => x)
    expect(e).toBeInstanceOf(UnavailableError)
    expect(e.details).toMatchObject({ operation: 'Viewer', attempts: 3, status: 503 })
    expect(fake.requests).toHaveLength(3)
  })

  it('caps a long Retry-After at retryMaxMs', async () => {
    fake.queue.push({ status: 429, headers: { 'retry-after': '3600' }, body: '' })
    await client().request(VIEWER)
    expect(delays).toEqual([10_000])
  })

  it('maps GraphQL errors to MpError with status and code, without retrying', async () => {
    const e = await client()
      .request('query Issue($id: String!) { issue(id: $id) { id } }', { id: 'NOPE-1' })
      .catch((x) => x)
    expect(e).toBeInstanceOf(MpError)
    expect(e.code).toBe('integration_request')
    expect(e.message).toBe('Linear: Could not find referenced Issue.')
    expect(e.details).toMatchObject({ status: 200, code: 'INVALID_INPUT' })
    expect(fake.requests).toHaveLength(1)
  })

  it('maps a plain 4xx to MpError', async () => {
    fake.queue.push({ status: 403, body: 'Forbidden' })
    const e = await client()
      .request(VIEWER)
      .catch((x) => x)
    expect(e.code).toBe('integration_request')
    expect(e.details.status).toBe(403)
    expect(e.message).toContain('HTTP 403')
  })

  it('treats network errors as retryable and redacts the key', async () => {
    let calls = 0
    const failing: typeof fetch = async () => {
      calls++
      throw new Error(`connect ECONNREFUSED (key ${fake.apiKey})`)
    }
    const e = await client({ fetch: failing, maxRetries: 1 })
      .request(VIEWER)
      .catch((x) => x)
    expect(e).toBeInstanceOf(UnavailableError)
    expect(calls).toBe(2)
    expect(e.message).not.toContain(fake.apiKey)
    expect(JSON.stringify(logger.lines)).not.toContain(fake.apiKey)
  })

  it('does not retry a mutation on a network error', async () => {
    let calls = 0
    const failing: typeof fetch = async () => {
      calls++
      throw new Error('socket hang up')
    }
    const e = await client({ fetch: failing })
      .request(CREATE, { input: {} }, { mutation: true })
      .catch((x) => x)
    expect(e).toBeInstanceOf(UnavailableError)
    expect(e.message).toMatch(/may have been applied/)
    expect(calls).toBe(1)
  })

  it('times out slow requests', async () => {
    const slow: typeof fetch = (_u, init) =>
      new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    const e = await client({ fetch: slow, timeoutMs: 20, maxRetries: 0 })
      .request(VIEWER)
      .catch((x) => x)
    expect(e).toBeInstanceOf(UnavailableError)
    expect(e.message).toMatch(/timed out/)
  })

  it('paginates with first/after and stops at the limit or the last page', async () => {
    const c = client()
    const q =
      'query Teams($first: Int, $after: String) { teams(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }'
    const one = await c.paginate(q, {}, (d) => d.teams, 1)
    expect(one.nodes).toHaveLength(1)
    expect(one.nextCursor).toBe(fake.teams[0]!.id)
    const rest = await c.paginate(q, { after: one.nextCursor }, (d) => d.teams, 10)
    expect(rest.nodes.map((t: any) => t.id)).toEqual([fake.teams[1]!.id])
    expect(rest.nextCursor).toBeNull()
  })

  it('handles concurrent requests independently', async () => {
    fake.queue.push({ status: 503, body: '' })
    const c = client()
    const res = await Promise.all([c.request(VIEWER), c.request(VIEWER), c.request(VIEWER)])
    expect(res.every((d) => d.viewer.name === 'Kai Bot')).toBe(true)
    expect(fake.requests).toHaveLength(4)
  })

  it('waitFor reads Retry-After seconds and dates, and the reset header', () => {
    const now = Date.UTC(2026, 0, 1)
    expect(waitFor(new Headers({ 'retry-after': '2' }), now)).toBe(2000)
    expect(waitFor(new Headers({ 'retry-after': new Date(now + 5000).toUTCString() }), now)).toBe(5000)
    expect(waitFor(new Headers({ 'x-ratelimit-requests-reset': String(now + 700) }), now)).toBe(700)
    expect(waitFor(new Headers({ 'x-ratelimit-requests-reset': String(now - 700) }), now)).toBe(0)
    expect(waitFor(new Headers(), now)).toBeUndefined()
  })
})
