import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMcpToken } from '../src/tokens.ts'
import { adminOf, testApp, type TestApp } from './helpers.ts'

let t: TestApp & { port: number | null }
let adminToken: string
let memberToken: string
let adminId: string

const text = (r: any) => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n')
const json = (r: any) => JSON.parse(text(r))

beforeAll(async () => {
  t = await testApp({ http: true })
  const s = t.a.services
  adminId = await adminOf(t.a)
  adminToken = (await createMcpToken(s, adminId, 'admin agent')).token
  const bo = await s.directory.contacts.create({ name: 'Bo Example', kind: 'person', access: 'member' })
  memberToken = (await createMcpToken(s, bo.id, 'test')).token
})
afterAll(async () => {
  await t.close()
})

async function connect(tok: string) {
  const client = new Client({ name: 'admin-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${t.port}/mcp/admin`), {
    requestInit: { headers: { authorization: `Bearer ${tok}` } },
  })
  await client.connect(transport)
  return client
}

const post = (tok: string | null) =>
  fetch(`http://127.0.0.1:${t.port}/mcp/admin`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    }),
  })

describe('admin MCP server /mcp/admin', () => {
  it('is for admins only: no token is 401, a member is 403', async () => {
    expect((await post(null)).status).toBe(401)
    expect((await post('nope')).status).toBe(401)
    const member = await post(memberToken)
    expect(member.status).toBe(403)
    expect(JSON.stringify(await member.json())).toContain('admins only')
    expect((await post(adminToken)).status).toBe(200)
    await expect(connect(memberToken)).rejects.toThrow()
  })

  it('lists the API routes with the access each needs', async () => {
    const client = await connect(adminToken)
    expect((await client.listTools()).tools.map((x) => x.name).sort()).toEqual(['api_request', 'api_routes'])
    const all = json(await client.callTool({ name: 'api_routes', arguments: {} }))
    expect(all.total).toBeGreaterThan(50)
    expect(all.routes).toContainEqual({ method: 'PUT', path: '/api/secrets', need: 'admin' })
    expect(all.routes.every((r: any) => r.path.startsWith('/api/'))).toBe(true)
    const keys = all.routes.map((r: any) => `${r.method} ${r.path}`)
    expect(new Set(keys).size).toBe(keys.length)
    const some = json(await client.callTool({ name: 'api_routes', arguments: { filter: 'POST /api/employees' } }))
    expect(some.routes.length).toBeGreaterThan(0)
    expect(some.routes.every((r: any) => r.method === 'POST' && r.path.startsWith('/api/employees'))).toBe(true)
    await client.close()
  })

  it('calls the API as the admin: writes are theirs, secret values never come back', async () => {
    const client = await connect(adminToken)
    const me = json(await client.callTool({ name: 'api_request', arguments: { method: 'GET', path: '/api/me' } }))
    expect(me.status).toBe(200)
    expect(JSON.stringify(me.body)).toContain(adminId)

    const set = await client.callTool({
      name: 'api_request',
      arguments: { method: 'PUT', path: '/api/secrets', body: { name: 'WIKI_TOKEN', value: 'sk-test-wiki' } },
    })
    expect(set.isError).toBeFalsy()
    const list = json(await client.callTool({ name: 'api_request', arguments: { method: 'GET', path: '/api/secrets' } }))
    expect(list.body).toContainEqual(expect.objectContaining({ name: 'WIKI_TOKEN' }))
    expect(JSON.stringify(list)).not.toContain('sk-test-wiki')

    const del = await client.callTool({
      name: 'api_request',
      arguments: { method: 'DELETE', path: '/api/secrets', query: { name: 'WIKI_TOKEN' } },
    })
    expect(del.isError).toBeFalsy()
    expect(text(del)).toContain('HTTP 204')
    await client.close()
  })

  it('returns API errors as tool errors, and only reaches /api/', async () => {
    const client = await connect(adminToken)
    const bad = await client.callTool({ name: 'api_request', arguments: { method: 'PUT', path: '/api/secrets', body: {} } })
    expect(bad.isError).toBe(true)
    expect(json(bad).status).toBe(400)
    const missing = await client.callTool({ name: 'api_request', arguments: { method: 'GET', path: '/api/nope' } })
    expect(missing.isError).toBe(true)
    for (const path of ['/mcp', '/mcp/admin', '/healthz', '/api/../mcp', 'http://example.com/api/me', '//example.com/api/me']) {
      const r = await client.callTool({ name: 'api_request', arguments: { method: 'GET', path } })
      expect(r.isError, path).toBe(true)
      expect(text(r), path).toContain('only /api/ paths')
    }
    await client.close()
  })

  it("is refused once the admin's token is revoked or they are no longer an admin", async () => {
    const s = t.a.services
    const cleo = await s.directory.contacts.create({ name: 'Cleo Example', kind: 'person', access: 'admin' })
    const tok = (await createMcpToken(s, cleo.id, 'test')).token
    const client = await connect(tok)
    await s.directory.contacts.update(cleo.id, { access: 'member' })
    await expect(client.callTool({ name: 'api_routes', arguments: {} })).rejects.toThrow()
  })
})
