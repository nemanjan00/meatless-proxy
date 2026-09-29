import { errorMessage } from '@mp/core'
import type { Alerts } from '../alerts.ts'
import type { Services } from '../services.ts'
import { MCP_SERVER_STATUS_TOPIC, type McpServerStatusEvent } from './manager.ts'

/** One alert per server per this window while it keeps needing a sign-in. */
const WINDOW_MS = 6 * 3600_000

/**
 * Posts an alert in #alerts when a runtime MCP server needs a new sign-in
 * (its OAuth refresh failed, or its token was refused): its tools are gone
 * until an admin connects it again.
 */
export function wireMcpAlerts(s: Services, alerts: Pick<Alerts, 'post'>): () => void {
  return s.bus.subscribe<McpServerStatusEvent>(MCP_SERVER_STATUS_TOPIC, async (m) => {
    const e = m.payload
    if (e.state !== 'needs_auth') return
    const where = e.employeeId ? `employee [[employee:${e.employeeId}]]'s` : 'the global'
    const settings = e.employeeId ? 'its MCP servers on the employee page' : 'Settings → MCP servers'
    try {
      await alerts.post(
        `mcp.needs_auth:${e.id}:${Math.floor(s.clock.now() / WINDOW_MS)}`,
        {
          condition: 'dependency.unavailable',
          dependency: `MCP server ${e.name}`,
          text: `The ${where} MCP server ${e.name} needs a new sign-in (${e.error ?? 'authorization was refused'}). Its tools are off until an admin connects it again in ${settings}.`,
        },
        null,
      )
    } catch (err) {
      s.logger.error('could not post an MCP sign-in alert', { serverId: e.id, err: errorMessage(err) })
    }
  })
}
