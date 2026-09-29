// A tiny MCP server over stdio, spawned by stdio.test.ts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fixture', version: '0.0.0' }, { capabilities: { logging: {} } })

server.registerTool('echo', { description: 'Echo text', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}))

server.registerTool('env', { description: 'Read an env var', inputSchema: { name: z.string() } }, async ({ name }) => ({
  content: [{ type: 'text', text: process.env[name] ?? '' }],
}))

server.registerTool('ping_me', { description: 'Send a notification' }, async () => {
  await server.server.notification({ method: 'notifications/message', params: { level: 'info', data: 'pinged' } })
  return { content: [{ type: 'text', text: 'sent' }] }
})

process.stderr.write(`fixture started with token ${process.env.DEMO_TOKEN ?? ''}\n`)
await server.connect(new StdioServerTransport())
