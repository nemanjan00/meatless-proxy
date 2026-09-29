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
import { ConflictError, NotFoundError } from '@mp/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resultText,
  type ManagedMcpHub,
  type McpHub,
  type McpNotification,
  type McpServerConfig,
  type McpServerStatus,
} from './types.ts'

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

export interface ManagedMcpContractHub {
  /** A hub with no servers. */
  hub: ManagedMcpHub
  /** A config the hub can connect to: a server named `demo` with the tools `echo` and `fail` (as above). */
  demo: McpServerConfig
  cleanup?(): Promise<void>
}

/**
 * The runtime-management part of the contract, for hubs that implement `ManagedMcpHub`:
 *
 *   managedMcpHubContract('sdk', async () => ({ hub, demo }))
 */
export function managedMcpHubContract(name: string, make: () => Promise<ManagedMcpContractHub>) {
  describe(`ManagedMcpHub contract: ${name}`, () => {
    let current: ManagedMcpContractHub | undefined
    const setup = async () => (current = await make())
    afterEach(async () => {
      await current?.hub.close()
      await current?.cleanup?.()
      current = undefined
    })

    it('adds a server at runtime and uses it', async () => {
      const { hub, demo } = await setup()
      expect(hub.servers()).toEqual([])
      hub.addServer(demo)
      expect(hub.servers()).toEqual(['demo'])
      expect((await hub.listTools('demo')).map((t) => t.name).sort()).toEqual(['echo', 'fail'])
      expect(resultText(await hub.callTool('demo', 'echo', { text: 'hi' }))).toBe('hi')
      expect(hub.status('demo')).toMatchObject({ state: 'connected' })
    })

    it('refuses a duplicate name with ConflictError', async () => {
      const { hub, demo } = await setup()
      hub.addServer(demo)
      expect(() => hub.addServer(demo)).toThrow(ConflictError)
    })

    it('removes a server: its tools and calls are gone, and it can be added again', async () => {
      const { hub, demo } = await setup()
      hub.addServer(demo)
      await hub.listTools('demo')
      expect(await hub.removeServer('demo')).toBe(true)
      expect(await hub.removeServer('demo')).toBe(false)
      expect(hub.servers()).toEqual([])
      await expect(hub.callTool('demo', 'echo', { text: 'x' })).rejects.toBeInstanceOf(NotFoundError)
      expect(() => hub.status('demo')).toThrow(NotFoundError)
      hub.addServer(demo)
      expect(resultText(await hub.callTool('demo', 'echo', { text: 'again' }))).toBe('again')
    })

    it('reconnects, and reports status changes', async () => {
      const { hub, demo } = await setup()
      const seen: [string, McpServerStatus][] = []
      const off = hub.onStatus((server, status) => seen.push([server, status]))
      hub.addServer(demo)
      const status = await hub.reconnect('demo')
      expect(status.state).toBe('connected')
      expect(seen.some(([server, st]) => server === 'demo' && st.state === 'connected')).toBe(true)
      expect(resultText(await hub.callTool('demo', 'echo', { text: 'after' }))).toBe('after')
      off()
      const before = seen.length
      await hub.reconnect('demo')
      expect(seen.length).toBe(before)
    })

    it('rejects unknown servers with NotFoundError', async () => {
      const { hub } = await setup()
      expect(() => hub.status('nope')).toThrow(NotFoundError)
      await expect(hub.reconnect('nope')).rejects.toBeInstanceOf(NotFoundError)
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
