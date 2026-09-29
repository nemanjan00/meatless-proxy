import { memoryLogger, NotFoundError, UnavailableError, ValidationError } from '@mp/core'
import { resultText, type McpNotification } from '@mp/mcp'
import { mcpHubContract } from '@mp/mcp/contract'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpHub, type SdkMcpHub } from '../src/index.ts'
import { cfg, demoServer, inMemoryServers } from './helpers.ts'

mcpHubContract('sdk (in-memory transport)', async () => {
  const mem = inMemoryServers({ demo: demoServer })
  const hub = createMcpHub({ servers: [cfg('demo')], transportFactory: mem.factory })
  return {
    hub,
    notify: async (method, params) => {
      await mem.live.demo!.server.notification({ method, params } as any)
    },
  }
})

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('createMcpHub', () => {
  let hub: SdkMcpHub | undefined
  afterEach(async () => {
    await hub?.close()
    hub = undefined
  })

  it('connects lazily, once, even under concurrent use', async () => {
    const mem = inMemoryServers({ demo: demoServer })
    hub = createMcpHub({ servers: [cfg('demo')], transportFactory: mem.factory })
    expect(mem.resolved).toHaveLength(0)
    expect(hub.connected('demo')).toBe(false)
    await Promise.all([hub.listTools(), hub.callTool('demo', 'echo', { text: 'a' }), hub.listTools('demo')])
    expect(mem.resolved).toHaveLength(1)
    expect(hub.connected('demo')).toBe(true)
  })

  it('start() connects all servers and reports failures per server', async () => {
    const mem = inMemoryServers({ demo: demoServer })
    hub = createMcpHub({ servers: [cfg('demo'), cfg('missing')], transportFactory: mem.factory })
    const results = await hub.start()
    expect(results).toEqual([
      { server: 'demo', ok: true },
      { server: 'missing', ok: false, error: expect.stringContaining('cannot connect to MCP server missing') },
    ])
  })

  it('lists tools across servers, with schemas', async () => {
    const other = () => {
      const s = new McpServer({ name: 'other', version: '0' })
      s.registerTool('add', { description: 'Add', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
        content: [{ type: 'text', text: String(a + b) }],
        structuredContent: { sum: a + b },
      }))
      return s
    }
    const mem = inMemoryServers({ demo: demoServer, other })
    hub = createMcpHub({ servers: [cfg('demo'), cfg('other')], transportFactory: mem.factory })
    const tools = await hub.listTools()
    expect(tools.map((t) => `${t.server}.${t.name}`)).toEqual(['demo.echo', 'demo.fail', 'other.add'])
    const add = tools.find((t) => t.name === 'add')!
    expect(add.description).toBe('Add')
    expect(add.inputSchema).toMatchObject({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } })
    const r = await hub.callTool('other', 'add', { a: 2, b: 3 })
    expect(r).toEqual({ content: [{ type: 'text', text: '5' }], structuredContent: { sum: 5 }, isError: false })
  })

  it('follows listTools pagination and caches until tools/list_changed', async () => {
    let listCalls = 0
    let version = 1
    let low: Server | undefined
    const paged = () => {
      low = new Server({ name: 'paged', version: '0' }, { capabilities: { tools: { listChanged: true } } })
      low.setRequestHandler(ListToolsRequestSchema, async (req) => {
        listCalls++
        const page = Number(req.params?.cursor ?? 0)
        const tools = [0, 1].map((i) => ({ name: `v${version}_t${page * 2 + i}`, inputSchema: { type: 'object' as const } }))
        return page < 2 ? { tools, nextCursor: String(page + 1) } : { tools }
      })
      return low as unknown as McpServer
    }
    // inMemoryServers expects McpServer; a low-level Server connects the same way.
    const mem = inMemoryServers({ paged })
    hub = createMcpHub({ servers: [cfg('paged')], transportFactory: mem.factory })
    const tools = await hub.listTools('paged')
    expect(tools.map((t) => t.name)).toEqual(['v1_t0', 'v1_t1', 'v1_t2', 'v1_t3', 'v1_t4', 'v1_t5'])
    expect(tools[0]!.description).toBe('')
    expect(listCalls).toBe(3)
    await hub.listTools('paged')
    expect(listCalls).toBe(3)

    const got: McpNotification[] = []
    hub.onNotification((n) => got.push(n))
    version = 2
    await low!.sendToolListChanged()
    await waitFor(() => got.length === 1)
    expect(got[0]).toEqual({ server: 'paged', method: 'notifications/tools/list_changed', params: {} })
    expect((await hub.listTools('paged'))[0]!.name).toBe('v2_t0')
    expect(listCalls).toBe(6)
  })

  it('maps isError results and protocol errors to isError results', async () => {
    const low = () => {
      const s = new Server({ name: 'low', version: '0' }, { capabilities: { tools: {} } })
      s.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'x', inputSchema: { type: 'object' as const } }],
      }))
      s.setRequestHandler(CallToolRequestSchema, async (req) => {
        if (req.params.name === 'x') return { content: [{ type: 'text', text: 'bad input' }], isError: true }
        throw new Error('no such tool here')
      })
      return s as unknown as McpServer
    }
    const mem = inMemoryServers({ demo: demoServer, low })
    hub = createMcpHub({ servers: [cfg('demo'), cfg('low')], transportFactory: mem.factory })
    expect(await hub.callTool('low', 'x', {})).toEqual({ content: [{ type: 'text', text: 'bad input' }], isError: true })
    const unknown = await hub.callTool('low', 'y', {})
    expect(unknown.isError).toBe(true)
    expect(resultText(unknown)).toContain('no such tool here')
    const unknownDemo = await hub.callTool('demo', 'nope', {})
    expect(unknownDemo.isError).toBe(true)
    // Invalid arguments are also reported as tool errors.
    expect((await hub.callTool('demo', 'echo', { text: 42 })).isError).toBe(true)
  })

  it('forwards any server notification with the server name', async () => {
    const mem = inMemoryServers({ demo: demoServer })
    hub = createMcpHub({ servers: [cfg('demo')], transportFactory: mem.factory })
    await hub.start()
    const got: McpNotification[] = []
    hub.onNotification((n) => got.push(n))
    hub.onNotification(() => {
      throw new Error('a bad subscriber does not break others')
    })
    await mem.live.demo!.server.notification({
      method: 'notifications/slack/message',
      params: { channel: 'C1', text: 'hi' },
    } as any)
    await mem.live.demo!.sendLoggingMessage({ level: 'info', data: 'log line' })
    await waitFor(() => got.length === 2)
    expect(got).toEqual([
      { server: 'demo', method: 'notifications/slack/message', params: { channel: 'C1', text: 'hi' } },
      { server: 'demo', method: 'notifications/message', params: { level: 'info', data: 'log line' } },
    ])
  })

  it('resolves secrets into the transport env, never logging them', async () => {
    const logger = memoryLogger()
    const mem = inMemoryServers({ demo: demoServer })
    const asked: string[][] = []
    hub = createMcpHub({
      servers: [cfg('demo', { env: { PLAIN: 'value' }, secrets: { API_TOKEN: 'demo-token', OTHER: 'other-secret' } })],
      transportFactory: mem.factory,
      logger,
      resolveSecrets: async (names) => {
        asked.push(names)
        return { 'demo-token': 'sk-test-123456', 'other-secret': 'sk-test-abcdef' }
      },
    })
    await hub.listTools()
    expect(asked).toEqual([['demo-token', 'other-secret']])
    expect(mem.resolved[0]!.env).toEqual({ PLAIN: 'value', API_TOKEN: 'sk-test-123456', OTHER: 'sk-test-abcdef' })
    expect(mem.resolved[0]!.config.env).toEqual({ PLAIN: 'value' })
    expect(JSON.stringify(logger.lines)).not.toContain('sk-test-')
  })

  it('fails with ValidationError when a secret is missing, without retrying', async () => {
    const mem = inMemoryServers({ demo: demoServer })
    hub = createMcpHub({
      servers: [cfg('demo', { secrets: { API_TOKEN: 'demo-token' } })],
      transportFactory: mem.factory,
      resolveSecrets: async () => ({}),
    })
    const err = await hub.listTools().catch((e) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.message).toContain('demo-token')
    expect(mem.resolved).toHaveLength(0)
  })

  it('validates configs', () => {
    expect(() => createMcpHub({ servers: [cfg('a'), cfg('a')] })).toThrow(ValidationError)
    expect(() => createMcpHub({ servers: [cfg('a.b')] })).toThrow(ValidationError)
    expect(() => createMcpHub({ servers: [{ name: 'a', transport: 'stdio' }] })).toThrow(ValidationError)
    expect(() => createMcpHub({ servers: [{ name: 'a', transport: 'http' }] })).toThrow(ValidationError)
    expect(() => createMcpHub({ servers: [cfg('a', { secrets: { X: 'y' } })] })).toThrow(/resolveSecrets/)
  })

  it('retries a failed connect once', async () => {
    const mem = inMemoryServers({ demo: demoServer })
    hub = createMcpHub({ servers: [cfg('demo')], transportFactory: mem.factory })
    mem.failNext(1)
    expect(await hub.listTools()).toHaveLength(2)
    expect(mem.resolved).toHaveLength(2)
  })

  it('gives UnavailableError when connecting fails twice, and tries again on next use', async () => {
    const mem = inMemoryServers({ demo: demoServer })
    hub = createMcpHub({ servers: [cfg('demo')], transportFactory: mem.factory })
    mem.failNext(2)
    await expect(hub.callTool('demo', 'echo', { text: 'x' })).rejects.toBeInstanceOf(UnavailableError)
    expect(resultText(await hub.callTool('demo', 'echo', { text: 'x' }))).toBe('x')
  })

  it('reconnects after the server drops the connection', async () => {
    const mem = inMemoryServers({ demo: demoServer })
    hub = createMcpHub({ servers: [cfg('demo')], transportFactory: mem.factory })
    await hub.listTools()
    await mem.live.demo!.close()
    await waitFor(() => !hub!.connected('demo'))
    expect(resultText(await hub.callTool('demo', 'echo', { text: 'again' }))).toBe('again')
    expect(mem.resolved).toHaveLength(2)
  })

  it('rejects unknown servers', async () => {
    hub = createMcpHub({ servers: [] })
    expect(hub.servers()).toEqual([])
    expect(await hub.listTools()).toEqual([])
    await expect(hub.callTool('x', 'y', {})).rejects.toBeInstanceOf(NotFoundError)
  })

  it('aborts a pending tool call', async () => {
    const slow = () => {
      const s = new McpServer({ name: 'slow', version: '0' })
      s.registerTool('wait', { description: 'waits' }, () => new Promise(() => {}))
      return s
    }
    const mem = inMemoryServers({ slow })
    hub = createMcpHub({ servers: [cfg('slow')], transportFactory: mem.factory })
    await hub.start()
    const ac = new AbortController()
    const p = hub.callTool('slow', 'wait', {}, { signal: ac.signal })
    setTimeout(() => ac.abort(new Error('stop')), 20)
    await expect(p).rejects.toThrow('stop')
    // The connection survives an aborted call.
    expect(hub.connected('slow')).toBe(true)
  })

  it('times out a slow tool call with UnavailableError', async () => {
    const slow = () => {
      const s = new McpServer({ name: 'slow', version: '0' })
      s.registerTool('wait', { description: 'waits' }, () => new Promise(() => {}))
      return s
    }
    const mem = inMemoryServers({ slow })
    hub = createMcpHub({ servers: [cfg('slow')], transportFactory: mem.factory, requestTimeoutMs: 50 })
    await expect(hub.callTool('slow', 'wait', {})).rejects.toBeInstanceOf(UnavailableError)
  })

  it('closes connections, stops notifications and rejects further use', async () => {
    const mem = inMemoryServers({ demo: demoServer })
    hub = createMcpHub({ servers: [cfg('demo')], transportFactory: mem.factory })
    await hub.start()
    const got: McpNotification[] = []
    hub.onNotification((n) => got.push(n))
    const h = hub
    await h.close()
    await h.close()
    expect(h.connected('demo')).toBe(false)
    await expect(h.listTools()).rejects.toBeInstanceOf(UnavailableError)
    expect(got).toEqual([])
  })

  it('closing while connecting does not leak a connection', async () => {
    let serverSide: InMemoryTransport | undefined
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    hub = createMcpHub({
      servers: [cfg('demo')],
      transportFactory: async () => {
        await gate
        const [client, server] = InMemoryTransport.createLinkedPair()
        serverSide = server
        await demoServer().connect(server)
        return client
      },
    })
    const p = hub.listTools().catch((e) => e)
    const closing = hub.close()
    release()
    await closing
    expect(await p).toBeInstanceOf(UnavailableError)
    expect(serverSide).toBeDefined()
  })
})
