import { callTools, reply, type ModelRequest } from '@mp/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testApp, until, type TestApp } from './helpers.ts'

const METRICS_TOKEN = 'metrics-test-token-0123456789'

let t: TestApp

beforeAll(async () => {
  t = await testApp({
    env: { METRICS_TOKEN },
    script: (req: ModelRequest) => {
      const last = req.messages.at(-1)!
      if (last.role === 'tool') return reply('done')
      if ((last.content ?? '').includes('USE A TOOL')) return callTools([{ name: 'checklist.show', args: {} }])
      return reply('ok')
    },
  })
})
afterAll(() => t.close())

interface Sample {
  name: string
  labels: Record<string, string>
  value: number
}

/** A strict parser of the Prometheus text format (0.0.4): fails on anything malformed. */
function parse(text: string) {
  expect(text.endsWith('\n')).toBe(true)
  const help = new Map<string, string>()
  const type = new Map<string, string>()
  const samples: Sample[] = []
  const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
  for (const line of text.slice(0, -1).split('\n')) {
    if (line.startsWith('# HELP ')) {
      const [name, ...rest] = line.slice(7).split(' ')
      expect(name).toMatch(NAME)
      expect(help.has(name!), `duplicate HELP ${name}`).toBe(false)
      help.set(name!, rest.join(' '))
      continue
    }
    if (line.startsWith('# TYPE ')) {
      const [name, kind] = line.slice(7).split(' ')
      expect(['counter', 'gauge', 'histogram', 'summary', 'untyped']).toContain(kind)
      type.set(name!, kind!)
      continue
    }
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (-?[0-9.e+]+|\+Inf|-Inf|NaN)$/.exec(line)
    expect(m, `malformed line: ${line}`).not.toBeNull()
    const labels: Record<string, string> = {}
    if (m![3]) {
      const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"(,|$)/g
      let consumed = 0
      for (let x = re.exec(m![3]); x; x = re.exec(m![3])) {
        labels[x[1]!] = x[2]!
        consumed += x[0].length
      }
      expect(consumed, `malformed labels: ${line}`).toBe(m![3].length)
    }
    const base = m![1]!.replace(/_(bucket|sum|count)$/, '')
    const family = type.has(m![1]!) ? m![1]! : base
    expect(type.has(family), `no TYPE for ${m![1]}`).toBe(true)
    expect(help.has(family), `no HELP for ${m![1]}`).toBe(true)
    samples.push({ name: m![1]!, labels, value: Number(m![4]!.replace('+Inf', 'Infinity')) })
  }
  return { samples, type }
}

const value = (samples: Sample[], name: string, labels: Record<string, string> = {}) =>
  samples
    .filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    .reduce((a, s) => a + s.value, 0)

describe('/metrics', () => {
  it('is for admins and the metrics token only', async () => {
    expect((await t.req('GET', '/metrics', undefined, { authorization: '' })).status).toBe(401)
    expect((await t.req('GET', '/metrics', undefined, { authorization: 'Bearer wrong-token-000000000' })).status).toBe(401)
    const member = await t.as((await t.a.services.directory.contacts.create({ name: 'Mo', kind: 'person' })).id)
    expect((await t.req('GET', '/metrics', undefined, member)).status).toBe(403)
    expect((await t.req('GET', '/metrics')).status).toBe(200)
    const byToken = await t.a.app.request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })
    expect(byToken.status).toBe(200)
    expect(byToken.headers.get('content-type')).toContain('text/plain; version=0.0.4')
  })

  it('exposes runs, queues, model calls, tokens, latency, tools, events, environments and http requests', async () => {
    const requests = (await t.a.services.chat.channelByName('requests'))!.id
    const session = await t.a.services.sessions.create({
      employeeId: (await t.a.services.directory.employees.byHandle('meatless'))!.id,
      title: 'Metrics',
      toolset: ['checklist.show'],
    })
    const r = await t.req('POST', `/api/sessions/${session.id}/message`, { text: 'please USE A TOOL' })
    expect(r.status).toBe(200)
    await until(async () => {
      await t.settle()
      return (await t.a.services.sessions.runs({ sessionId: session.id, state: 'completed' })).length > 0
    }, 'the run')
    await t.req('GET', `/api/chat/channels/${requests}/messages`)
    await t.req('GET', '/api/nope')

    const res = await t.a.app.request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })
    const { samples, type } = parse(await res.text())

    expect(type.get('mp_runs')).toBe('gauge')
    expect(value(samples, 'mp_runs', { state: 'completed' })).toBeGreaterThanOrEqual(1)
    expect(samples.filter((s) => s.name === 'mp_runs').map((s) => s.labels.state)).toEqual([
      'queued',
      'running',
      'suspended',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ])
    expect(samples.some((s) => s.name === 'mp_queue_jobs' && s.labels.queue && s.labels.state === 'waiting')).toBe(true)

    const model = samples.find((s) => s.name === 'mp_model_calls_total')!.labels.model!
    expect(value(samples, 'mp_model_calls_total', { model })).toBeGreaterThanOrEqual(2)
    expect(type.get('mp_model_tokens_total')).toBe('counter')
    for (const kind of ['prompt', 'completion', 'cached'])
      expect(samples.some((s) => s.name === 'mp_model_tokens_total' && s.labels.type === kind)).toBe(true)

    // The latency histogram: cumulative buckets, +Inf equals the count.
    expect(type.get('mp_model_call_duration_seconds')).toBe('histogram')
    const buckets = samples.filter((s) => s.name === 'mp_model_call_duration_seconds_bucket' && s.labels.model === model)
    expect(buckets.at(-1)!.labels.le).toBe('+Inf')
    for (let i = 1; i < buckets.length; i++) expect(buckets[i]!.value).toBeGreaterThanOrEqual(buckets[i - 1]!.value)
    expect(buckets.at(-1)!.value).toBe(value(samples, 'mp_model_call_duration_seconds_count', { model }))

    expect(value(samples, 'mp_tool_calls_total', { tool: 'checklist.show' })).toBeGreaterThanOrEqual(1)
    expect(type.get('mp_tool_errors_total')).toBe('counter')
    expect(value(samples, 'mp_events_total', { source: 'ui' })).toBeGreaterThanOrEqual(1)
    expect(value(samples, 'mp_environments_running')).toBe(0)

    expect(
      value(samples, 'mp_http_requests_total', { route: '/api/chat/channels/:id/messages', status: '200', method: 'GET' }),
    ).toBe(1)
    expect(value(samples, 'mp_http_requests_total', { route: '/api/*', status: '404' })).toBeGreaterThanOrEqual(1)
    expect(value(samples, 'mp_http_requests_total', { route: '/metrics', status: '401' })).toBeGreaterThanOrEqual(1)
  })
})
