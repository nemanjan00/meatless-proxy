import type { McpServerConfig } from '@mp/mcp'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ResolvedMcpServer, TransportFactory } from '../src/index.ts'

/** Builds a fresh in-process MCP server per connection and hands the client side to the hub. */
export function inMemoryServers(build: Record<string, () => McpServer>) {
  const live: Record<string, McpServer> = {}
  const resolved: ResolvedMcpServer[] = []
  let failNext = 0
  const factory: TransportFactory = async (r) => {
    resolved.push(r)
    if (failNext > 0) {
      failNext--
      throw new Error('cannot start server')
    }
    const make = build[r.config.name]
    if (!make) throw new Error(`no in-memory server ${r.config.name}`)
    const [client, server] = InMemoryTransport.createLinkedPair()
    const s = make()
    await s.connect(server)
    live[r.config.name] = s
    return client
  }
  return {
    factory,
    live,
    resolved,
    failNext: (n: number) => (failNext = n),
  }
}

export function demoServer(): McpServer {
  const s = new McpServer({ name: 'demo', version: '0.0.0' }, { capabilities: { logging: {} } })
  s.registerTool('echo', { description: 'Echo text', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }))
  s.registerTool('fail', { description: 'Always fails' }, async () => ({
    content: [{ type: 'text', text: 'failed' }],
    isError: true,
  }))
  return s
}

export const cfg = (name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name,
  transport: 'stdio',
  command: 'unused',
  ...extra,
})
