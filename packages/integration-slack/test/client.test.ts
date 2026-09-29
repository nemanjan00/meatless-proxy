import { isMpError, ManualClock, type MpError, UnavailableError } from '@mp/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSlackClient, parseRetryAfter, slackErrorCode } from '../src/index.ts'
import { type FakeSlack, startFakeSlack, TOKEN } from './fake-slack.ts'

let slack: FakeSlack
let sleeps: number[]
const clock = new ManualClock(Date.UTC(2026, 8, 29, 12))
const make = (extra: Partial<Parameters<typeof createSlackClient>[0]> = {}) =>
  createSlackClient({
    token: TOKEN,
    baseUrl: slack.url,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...extra,
  })

beforeEach(async () => {
  slack = await startFakeSlack()
  sleeps = []
})
afterEach(async () => {
  await slack.close()
})

const catchErr = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as MpError
  }
  throw new Error('expected a failure')
}

describe('createSlackClient', () => {
  it('posts form bodies with the bearer token and returns the response', async () => {
    const r = await make().call('users.info', { user: 'U1', skip: undefined })
    expect(r.ok).toBe(true)
    const [c] = slack.callsTo('users.info')
    expect(c?.auth).toBe(`Bearer ${TOKEN}`)
    expect(c?.contentType).toBe('application/x-www-form-urlencoded')
    expect(c?.params).toEqual({ user: 'U1' })
  })

  it('posts JSON bodies when asked', async () => {
    await make().call('chat.postMessage', { channel: 'C1', text: 'hi', mrkdwn: true }, { json: true, write: true })
    const [c] = slack.callsTo('chat.postMessage')
    expect(c?.contentType).toMatch(/^application\/json/)
    expect(c?.params).toEqual({ channel: 'C1', text: 'hi', mrkdwn: true })
  })

  it('turns ok:false into MpError(integration_request) with the Slack error code', async () => {
    const e = await catchErr(make().call('users.info', { user: 'U404' }))
    expect(isMpError(e, 'integration_request')).toBe(true)
    expect(e.details).toMatchObject({ status: 200, error: 'user_not_found', method: 'users.info' })
    expect(slackErrorCode(e)).toBe('user_not_found')
  })

  it('reports invalid_auth without leaking the token', async () => {
    const e = await catchErr(createSlackClient({ token: 'xoxb-wrong', baseUrl: slack.url }).call('auth.test'))
    expect(slackErrorCode(e)).toBe('invalid_auth')
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain('xoxb-wrong')
  })

  it('waits out a 429 using Retry-After seconds, then succeeds', async () => {
    slack.script('users.info', { status: 429, headers: { 'retry-after': '2' } })
    const r = await make().call('users.info', { user: 'U1' })
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([2000])
    expect(slack.callsTo('users.info')).toHaveLength(2)
  })

  it('accepts Retry-After as an HTTP date', () => {
    const now = Date.UTC(2026, 0, 1)
    expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000)
    expect(parseRetryAfter('1.5', now)).toBe(1500)
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter(undefined, now)).toBeUndefined()
  })

  it('retries writes after a 429: Slack did not execute them', async () => {
    slack.script('chat.postMessage', { status: 429, headers: { 'retry-after': '1' } })
    const r = await make().call('chat.postMessage', { channel: 'C1', text: 'hi' }, { write: true, json: true })
    expect(r.ok).toBe(true)
    expect(slack.callsTo('chat.postMessage')).toHaveLength(2)
    expect(slack.channels.get('C1')?.messages.filter((m) => m.text === 'hi')).toHaveLength(1)
  })

  it('retries the ratelimited error code', async () => {
    slack.script('conversations.history', {
      status: 200,
      headers: { 'retry-after': '3' },
      body: JSON.stringify({ ok: false, error: 'ratelimited' }),
    })
    const r = await make().call('conversations.history', { channel: 'C1' })
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([3000])
  })

  it('fails with UnavailableError when rate limits outlast the attempts', async () => {
    const limited = { status: 429, headers: { 'retry-after': '1' } }
    slack.script('users.info', limited, limited, limited)
    const e = await catchErr(make().call('users.info', { user: 'U1' }))
    expect(e).toBeInstanceOf(UnavailableError)
    expect(e.details).toMatchObject({ status: 429, attempts: 3 })
    expect(sleeps).toEqual([1000, 1000])
  })

  it('does not wait longer than maxDelayMs', async () => {
    slack.script('users.info', { status: 429, headers: { 'retry-after': '120' } })
    const e = await catchErr(make({ retry: { maxDelayMs: 10_000 } }).call('users.info', { user: 'U1' }))
    expect(e).toBeInstanceOf(UnavailableError)
    expect(e.details).toMatchObject({ retryAfterMs: 120_000 })
    expect(sleeps).toEqual([])
  })

  it('retries reads after 5xx with exponential backoff', async () => {
    slack.script('conversations.history', { status: 500, body: 'oops' }, { status: 503, body: 'down' })
    const r = await make({ retry: { baseDelayMs: 100 } }).call('conversations.history', { channel: 'C1' })
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([100, 200])
  })

  it('never retries a write after a 5xx: it may have been executed', async () => {
    slack.script('chat.postMessage', { status: 502, body: 'bad gateway' })
    const e = await catchErr(make().call('chat.postMessage', { channel: 'C1', text: 'x' }, { write: true, json: true }))
    expect(e).toBeInstanceOf(UnavailableError)
    expect(e.details).toMatchObject({ status: 502 })
    expect(slack.callsTo('chat.postMessage')).toHaveLength(1)
  })

  it('maps other 4xx to integration_request with the status, without retrying', async () => {
    slack.script('users.info', { status: 404, body: 'not found' })
    const e = await catchErr(make().call('users.info', { user: 'U1' }))
    expect(isMpError(e, 'integration_request')).toBe(true)
    expect(e.details).toMatchObject({ status: 404 })
    expect(sleeps).toEqual([])
  })

  it('treats a non-JSON 200 as a request error', async () => {
    slack.script('users.info', { status: 200, body: '<html>' })
    const e = await catchErr(make().call('users.info', { user: 'U1' }))
    expect(isMpError(e, 'integration_request')).toBe(true)
  })

  it('retries network errors on reads, not on writes, and redacts the token', async () => {
    let n = 0
    const flaky: typeof fetch = async (input, init) => {
      if (n++ === 0) throw new Error(`connect ECONNREFUSED (token ${TOKEN})`)
      return fetch(input, init)
    }
    const r = await make({ fetch: flaky }).call('users.info', { user: 'U1' })
    expect(r.ok).toBe(true)
    const broken: typeof fetch = async () => {
      throw new Error(`socket hang up ${TOKEN}`)
    }
    const e = await catchErr(make({ fetch: broken }).call('chat.postMessage', { channel: 'C1', text: 'x' }, { write: true }))
    expect(e).toBeInstanceOf(UnavailableError)
    expect(e.message).not.toContain(TOKEN)
    expect(e.message).toContain('[redacted]')
  })

  it('handles concurrent calls independently', async () => {
    slack.script('users.info', { status: 429, headers: { 'retry-after': '1' } })
    const client = make()
    const results = await Promise.all(['U1', 'U2', 'U1', 'U2'].map((user) => client.call('users.info', { user })))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(slack.callsTo('users.info')).toHaveLength(5)
  })
})
