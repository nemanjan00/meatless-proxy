import { describe, expect, it } from 'vitest'
import { ApiRequestError, ROUTES, buildPath, buildQuery, codeForStatus, createApiClient } from '../src/index.ts'

interface Call {
  url: string
  method: string
  body?: unknown
  headers: Record<string, string>
}

function fakeFetch(respond: (call: Call) => { status?: number; body?: unknown } = () => ({ body: {} })) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string>,
    }
    calls.push(call)
    const r = respond(call)
    const status = r.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? null), { status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

describe('buildPath / buildQuery', () => {
  it('fills and encodes parameters', () => {
    expect(buildPath('/api/records/:kind/:id', { kind: 'contact', id: 'con_1 2' })).toBe('/api/records/contact/con_1%202')
  })
  it('throws on a missing parameter', () => {
    expect(() => buildPath('/api/runs/:id')).toThrow(/missing path parameter id/)
  })
  it('drops empty values and encodes the rest', () => {
    expect(buildQuery({ a: 'x y', b: undefined, c: null, d: '', e: 3, f: false })).toBe('?a=x%20y&e=3&f=false')
    expect(buildQuery({})).toBe('')
  })
})

describe('createApiClient', () => {
  it('uses the base url without a trailing slash and sends json accept headers', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: [] }))
    const api = createApiClient({ baseUrl: 'http://example.com/', fetch, headers: { authorization: 'Bearer test' } })
    await api.kinds()
    expect(calls[0]!.url).toBe('http://example.com/api/kinds')
    expect(calls[0]!.headers.accept).toBe('application/json')
    expect(calls[0]!.headers.authorization).toBe('Bearer test')
  })

  it('encodes where as json for record lists', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { items: [], total: 0 } }))
    const api = createApiClient({ baseUrl: '', fetch })
    const page = await api.listRecords('project', { where: { status: 'active' }, text: 'pay', limit: 10, dir: 'desc' })
    expect(page.total).toBe(0)
    const u = new URL(calls[0]!.url, 'http://x')
    expect(u.pathname).toBe('/api/records/project')
    expect(JSON.parse(u.searchParams.get('where')!)).toEqual({ status: 'active' })
    expect(u.searchParams.get('text')).toBe('pay')
    expect(u.searchParams.get('limit')).toBe('10')
  })

  it('sends PATCH with data and version', async () => {
    const { fetch, calls } = fakeFetch(({ body }) => ({
      body: { id: 'con_1', version: 3, data: (body as { data: unknown }).data },
    }))
    const api = createApiClient({ baseUrl: '', fetch })
    const r = await api.updateRecord('contact', 'con_1', { role: 'Engineer' }, 2)
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.body).toEqual({ data: { role: 'Engineer' }, version: 2 })
    expect(calls[0]!.headers['content-type']).toBe('application/json')
    expect(r.version).toBe(3)
  })

  it('returns undefined for 204', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 204 }))
    const api = createApiClient({ baseUrl: '', fetch })
    await expect(api.deleteRecord('contact', 'con_1', { cascade: true })).resolves.toBeUndefined()
    expect(calls[0]!.url).toBe('/api/records/contact/con_1?cascade=true')
    expect(calls[0]!.method).toBe('DELETE')
  })

  it('throws ApiRequestError with the server error body', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { error: { code: 'conflict', message: 'moved on', details: { version: 5 } } },
    }))
    const api = createApiClient({ baseUrl: '', fetch })
    const err = await api.updateRecord('contact', 'con_1', {}, 1).catch((e) => e)
    expect(err).toBeInstanceOf(ApiRequestError)
    expect(err.status).toBe(409)
    expect(err.code).toBe('conflict')
    expect(err.details).toEqual({ version: 5 })
  })

  it('derives the code from the status without an error body', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: 'nope' }))
    const api = createApiClient({ baseUrl: '', fetch })
    const err = await api.getRun('run_1').catch((e) => e)
    expect(err.code).toBe('not_found')
    expect(codeForStatus(418)).toBe('bad_request')
    expect(codeForStatus(502)).toBe('internal')
  })

  it('maps network failures to status 0', async () => {
    const fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const api = createApiClient({ baseUrl: '', fetch })
    const err = await api.health().catch((e) => e)
    expect(err.status).toBe(0)
    expect(err.code).toBe('unavailable')
    expect(err.message).toContain('ECONNREFUSED')
  })

  it('builds the routes for sessions, chat, usage, files and secrets', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }))
    const api = createApiClient({ baseUrl: '', fetch })
    await api.listSessions({ employeeId: 'emp_1', status: 'active,waiting' })
    await api.sendMessage('ses_1', 'hello')
    await api.postMessage('chn_1', { text: 'hi', threadId: 'msg_1' })
    await api.usageBreakdown('model', { since: '2026-09-01T00:00:00.000Z' })
    await api.usageSeries('day', { splitBy: 'employee' })
    await api.writeFile('emp_1', '/notes/a.md', '# A', 2)
    await api.deleteSecret('LINEAR_TOKEN', { type: 'employee', id: 'emp_1' })
    await api.pauseRun('run_1', 'looks stuck')
    await api.lineage('evt_1')
    const got = calls.map((c) => `${c.method} ${decodeURIComponent(c.url)}`)
    expect(got).toEqual([
      'GET /api/sessions?employeeId=emp_1&status=active,waiting',
      'POST /api/sessions/ses_1/message',
      'POST /api/chat/channels/chn_1/messages',
      'GET /api/usage/breakdown?groupBy=model&since=2026-09-01T00:00:00.000Z',
      'GET /api/usage/series?interval=day&splitBy=employee',
      'PUT /api/files/emp_1/content?path=/notes/a.md',
      'DELETE /api/secrets?name=LINEAR_TOKEN&scopeType=employee&scopeId=emp_1',
      'POST /api/runs/run_1/pause',
      'GET /api/lineage/evt_1',
    ])
    expect(calls[1]!.body).toEqual({ text: 'hello' })
    expect(calls[5]!.body).toEqual({ content: '# A', version: 2 })
    expect(calls[7]!.body).toEqual({ reason: 'looks stuck' })
  })

  it('has one client method per route', () => {
    const { fetch } = fakeFetch()
    const api = createApiClient({ baseUrl: '', fetch }) as unknown as Record<string, unknown>
    // Route names and method names differ in a few places; every route must be reachable.
    const methods = Object.keys(api)
    expect(methods.length).toBe(Object.keys(ROUTES).length)
    for (const [, [method, path]] of Object.entries(ROUTES)) {
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(method)
      expect(path.startsWith('/')).toBe(true)
    }
  })
})
