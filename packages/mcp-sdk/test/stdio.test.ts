import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { memoryLogger } from '@mp/core'
import { resultText, type McpNotification } from '@mp/mcp'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpHub, type SdkMcpHub } from '../src/index.ts'

// Spawns test/fixtures/stdio-server.ts as a real child process (node + tsx loader).
const fixture = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url))
let tsxLoader: string | undefined
try {
  tsxLoader = import.meta.resolve('tsx')
} catch {}
const canSpawn = !!tsxLoader && existsSync(fixture) && process.env.MP_SKIP_SPAWN !== '1'

describe.skipIf(!canSpawn)('createMcpHub over stdio', () => {
  let hub: SdkMcpHub | undefined
  afterEach(async () => {
    await hub?.close()
  })

  it('spawns the server with env and secrets, lists and calls tools, receives notifications', { timeout: 20_000 }, async () => {
    const logger = memoryLogger([])
    hub = createMcpHub({
      logger: logger.child({}),
      servers: [
        {
          name: 'fixture',
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', tsxLoader!, fixture],
          env: { PLAIN_VAR: 'plain' },
          secrets: { DEMO_TOKEN: 'demo-token' },
        },
      ],
      resolveSecrets: async () => ({ 'demo-token': 'sk-test-stdio-secret' }),
    })
    const results = await hub.start()
    expect(results).toEqual([{ server: 'fixture', ok: true }])

    const tools = await hub.listTools('fixture')
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'env', 'ping_me'])
    expect(resultText(await hub.callTool('fixture', 'echo', { text: 'over stdio' }))).toBe('over stdio')
    expect(resultText(await hub.callTool('fixture', 'env', { name: 'PLAIN_VAR' }))).toBe('plain')
    expect(resultText(await hub.callTool('fixture', 'env', { name: 'DEMO_TOKEN' }))).toBe('sk-test-stdio-secret')
    // Only safe variables are inherited from the parent environment.
    expect(resultText(await hub.callTool('fixture', 'env', { name: 'MP_UNLIKELY_PARENT_VAR' }))).toBe('')

    const got: McpNotification[] = []
    hub.onNotification((n) => got.push(n))
    await hub.callTool('fixture', 'ping_me', {})
    const end = Date.now() + 5000
    while (!got.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([{ server: 'fixture', method: 'notifications/message', params: { level: 'info', data: 'pinged' } }])

    // The server's stderr is logged at debug level, with secret values redacted.
    const stderrLines = () => logger.lines.filter((l) => l.msg === 'MCP server stderr')
    while (!stderrLines().length && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    const stderr = stderrLines()
    expect(stderr.some((l) => String(l.fields.line).includes('[redacted]'))).toBe(true)
    expect(JSON.stringify(logger.lines)).not.toContain('sk-test-stdio-secret')
  })

  it('reports a command that cannot be spawned', async () => {
    hub = createMcpHub({ servers: [{ name: 'broken', transport: 'stdio', command: '/nonexistent/mcp-server-binary' }] })
    const [r] = await hub.start()
    expect(r!.ok).toBe(false)
  })
})
