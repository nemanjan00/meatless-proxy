import { NotFoundError, UnavailableError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { managedMcpHubContract, mcpHubContract } from '../src/contract.ts'
import { fakeMcpHub, resultText, type McpNotification } from '../src/index.ts'

mcpHubContract('fake', async () => {
  const hub = fakeMcpHub({
    servers: {
      demo: {
        tools: [
          { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'fail' },
        ],
        call: (tool, args) =>
          tool === 'fail' ? { content: [{ type: 'text', text: 'failed' }], isError: true } : String(args.text),
      },
    },
  })
  return { hub, notify: (method, params) => hub.notify('demo', method, params) }
})

managedMcpHubContract('fake', async () => {
  const hub = fakeMcpHub({
    servers: {},
    definitions: {
      demo: {
        tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }, { name: 'fail' }],
        call: (tool, args) =>
          tool === 'fail' ? { content: [{ type: 'text', text: 'failed' }], isError: true } : String(args.text),
      },
    },
  })
  return { hub, demo: { name: 'demo', transport: 'http', url: 'http://demo.invalid/mcp' } }
})

describe('fakeMcpHub', () => {
  const make = () =>
    fakeMcpHub({
      servers: {
        slack: { tools: [{ name: 'post', description: 'Post a message' }, { name: 'read' }] },
        linear: {
          tools: [{ name: 'create_issue', inputSchema: { type: 'object', required: ['title'] } }],
          call: async (_tool, args) => ({ id: 'ISS-1', title: args.title }),
        },
      },
    })

  it('lists tools per server with defaults', async () => {
    const hub = make()
    expect(hub.servers()).toEqual(['slack', 'linear'])
    expect(await hub.listTools('slack')).toEqual([
      { server: 'slack', name: 'post', description: 'Post a message', inputSchema: { type: 'object', properties: {} } },
      { server: 'slack', name: 'read', description: '', inputSchema: { type: 'object', properties: {} } },
    ])
    expect((await hub.listTools()).map((t) => `${t.server}.${t.name}`)).toEqual([
      'slack.post',
      'slack.read',
      'linear.create_issue',
    ])
  })

  it('records calls and echoes by default', async () => {
    const hub = make()
    const r = await hub.callTool('slack', 'post', { text: 'hi' })
    expect(JSON.parse(resultText(r))).toEqual({ tool: 'post', args: { text: 'hi' } })
    expect(hub.calls).toEqual([{ server: 'slack', tool: 'post', args: { text: 'hi' } }])
  })

  it('turns JSON values into text results and keeps structured results', async () => {
    const hub = make()
    const r = await hub.callTool('linear', 'create_issue', { title: 'Bug' })
    expect(JSON.parse(resultText(r))).toEqual({ id: 'ISS-1', title: 'Bug' })
    hub.setServer('s', { tools: [{ name: 't' }], call: () => ({ content: [], structuredContent: { a: 1 }, isError: false }) })
    expect(await hub.callTool('s', 't', {})).toEqual({ content: [], structuredContent: { a: 1 }, isError: false })
    expect(hub.servers()).toContain('s')
  })

  it('rejects unknown tools and servers, recording the attempt', async () => {
    const hub = make()
    await expect(hub.callTool('slack', 'nope', {})).rejects.toBeInstanceOf(NotFoundError)
    await expect(hub.callTool('nope', 'post', {})).rejects.toBeInstanceOf(NotFoundError)
    expect(hub.calls).toHaveLength(2)
    expect(() => hub.notify('nope', 'x')).toThrow(NotFoundError)
  })

  it('propagates handler errors', async () => {
    const hub = fakeMcpHub({ servers: { s: { tools: [{ name: 't' }], call: () => Promise.reject(new Error('down')) } } })
    await expect(hub.callTool('s', 't', {})).rejects.toThrow('down')
  })

  it('honours abort signals', async () => {
    const ac = new AbortController()
    const hub = fakeMcpHub({
      servers: {
        s: {
          tools: [{ name: 't' }],
          call: (_t, _a, { signal }) => {
            expect(signal).toBe(ac.signal)
            ac.abort(new Error('cancelled'))
            return 'late'
          },
        },
      },
    })
    await expect(hub.callTool('s', 't', {}, { signal: ac.signal })).rejects.toThrow('cancelled')
  })

  it('notifies subscribers with default params', () => {
    const hub = make()
    const got: McpNotification[] = []
    hub.onNotification((n) => got.push(n))
    hub.notify('slack', 'notifications/message')
    expect(got).toEqual([{ server: 'slack', method: 'notifications/message', params: {} }])
  })

  it('stops after close', async () => {
    const hub = make()
    const got: McpNotification[] = []
    hub.onNotification((n) => got.push(n))
    await hub.close()
    expect(hub.closed).toBe(true)
    hub.notify('slack', 'x')
    expect(got).toEqual([])
    await expect(hub.listTools()).rejects.toBeInstanceOf(UnavailableError)
  })
})
