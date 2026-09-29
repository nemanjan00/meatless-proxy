/**
 * The McpHub contract. Every implementation must pass it:
 *
 *   mcpHubContract('sdk', async () => ({ hub, notify, cleanup }))
 *
 * `make` returns a hub connected to exactly one server named `demo` with two tools:
 * - `echo` ({ text: string }): a text result with `text`
 * - `fail`: a result with `isError: true`
 * and a `notify(method, params)` that makes the `demo` server send a notification.
 */
import { NotFoundError } from '@mp/core'
import { afterEach, describe, expect, it } from 'vitest'
import { resultText, type McpHub, type McpNotification } from './types.ts'

export interface McpContractHub {
  hub: McpHub
  notify(method: string, params: Record<string, unknown>): Promise<void> | void
  cleanup?(): Promise<void>
}

export function mcpHubContract(name: string, make: () => Promise<McpContractHub>) {
  describe(`McpHub contract: ${name}`, () => {
    let current: McpContractHub | undefined
    const setup = async () => (current = await make())
    afterEach(async () => {
      await current?.hub.close()
      await current?.cleanup?.()
      current = undefined
    })

    it('lists servers and tools', async () => {
      const { hub } = await setup()
      expect(hub.servers()).toEqual(['demo'])
      const tools = await hub.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'fail'])
      for (const t of tools) {
        expect(t.server).toBe('demo')
        expect(typeof t.description).toBe('string')
        expect(t.inputSchema).toMatchObject({ type: 'object' })
      }
      expect(await hub.listTools('demo')).toHaveLength(2)
    })

    it('calls a tool', async () => {
      const { hub } = await setup()
      const r = await hub.callTool('demo', 'echo', { text: 'hello' })
      expect(r.isError).toBe(false)
      expect(resultText(r)).toBe('hello')
    })

    it('returns isError results', async () => {
      const { hub } = await setup()
      const r = await hub.callTool('demo', 'fail', {})
      expect(r.isError).toBe(true)
    })

    it('rejects an unknown server with NotFoundError', async () => {
      const { hub } = await setup()
      await expect(hub.callTool('nope', 'echo', {})).rejects.toBeInstanceOf(NotFoundError)
      await expect(hub.listTools('nope')).rejects.toBeInstanceOf(NotFoundError)
    })

    it('delivers notifications with the server name, and unsubscribes', async () => {
      const { hub, notify } = await setup()
      await hub.listTools() // make sure the server is connected
      const got: McpNotification[] = []
      const other: McpNotification[] = []
      hub.onNotification((n) => got.push(n))
      const off = hub.onNotification((n) => other.push(n))
      await notify('notifications/message', { level: 'info', data: 'one' })
      await waitFor(() => got.length === 1)
      expect(got[0]).toEqual({ server: 'demo', method: 'notifications/message', params: { level: 'info', data: 'one' } })
      off()
      await notify('notifications/message', { level: 'info', data: 'two' })
      await waitFor(() => got.length === 2)
      expect(other).toHaveLength(1)
    })

    it('handles concurrent calls', async () => {
      const { hub } = await setup()
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => hub.callTool('demo', 'echo', { text: `m${i}` })))
      expect(results.map(resultText)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`))
    })

    it('closes', async () => {
      const { hub } = await setup()
      await hub.listTools()
      await hub.close()
      await expect(hub.callTool('demo', 'echo', { text: 'x' })).rejects.toThrow()
    })
  })
}

async function waitFor(cond: () => boolean, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}
