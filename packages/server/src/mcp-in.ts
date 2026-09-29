import { createHash } from 'node:crypto'
import { errorMessage, globMatch, stableStringify, type Json, type Logger } from '@mp/core'
import type { Directory } from '@mp/directory'
import type { Events, IngestInput, Subject } from '@mp/events'
import type { McpHub, McpNotification } from '@mp/mcp'
import type { McpEventMapping, McpServerEntry } from './config.ts'

/** A stable short hash of any JSON value (keys sorted). */
export function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value ?? null))
    .digest('hex')
    .slice(0, 32)
}

/** Reads a dot path (`issue.identifier`) from an object. */
export function pathValue(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

const asId = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined

/**
 * Maps an MCP notification to an event, using the server's mapping config
 * when a mapping matches the method. Without one: the type is the method,
 * the subject is `params.uri` for resource notifications, and the dedupe key
 * is the server, the method and a hash of the params.
 */
export function notificationToEvent(n: McpNotification, entry?: Pick<McpServerEntry, 'events'>): IngestInput {
  const mapping: McpEventMapping | undefined = entry?.events?.find((m) => m.method === n.method || globMatch(m.method, n.method))
  const params = n.params ?? {}
  const subjectId = asId(mapping?.subjectFrom ? pathValue(params, mapping.subjectFrom) : params.uri)
  const subject: Subject | undefined = subjectId ? { system: mapping?.subjectSystem ?? n.server, id: subjectId } : undefined
  const externalId = mapping?.idFrom ? asId(pathValue(params, mapping.idFrom)) : undefined
  const text = mapping?.textFrom ? pathValue(params, mapping.textFrom) : undefined
  return {
    source: `mcp:${n.server}`,
    type: mapping?.type ?? n.method,
    dedupeKey: `mcp:${n.server}:${n.method}:${externalId ?? stableHash(params)}`,
    ...(subject ? { subject } : {}),
    payload: params as Json,
    ...(typeof text === 'string' && text ? { text } : {}),
  }
}

export interface McpInboundDeps {
  hub: McpHub
  events: Events
  directory: Directory
  servers: McpServerEntry[]
  logger: Logger
  /**
   * Servers added at runtime (src/mcp-servers): the hub knows them by record id. Returns the
   * server's name (for the event source), its event mapping and its employee, or undefined.
   */
  runtime?: (hubName: string) => { name: string; events?: McpEventMapping[]; employeeId?: string } | undefined
}

/**
 * Turns every MCP server notification into a durable event (docs/spec.md#notifications-in).
 * Returns the unsubscribe function.
 */
export function wireMcpNotifications(deps: McpInboundDeps): () => void {
  const byName = new Map(deps.servers.map((s) => [s.name, s]))
  const employees = new Map<string, string | null>()
  const employeeId = async (name: string | undefined) => {
    if (!name) return undefined
    if (!employees.has(name)) employees.set(name, (await deps.directory.employees.byHandle(name))?.id ?? null)
    return employees.get(name) ?? undefined
  }
  return deps.hub.onNotification((raw) => {
    void (async () => {
      const rt = deps.runtime?.(raw.server)
      const n = rt ? { ...raw, server: rt.name } : raw
      const entry: Pick<McpServerEntry, 'events' | 'employee'> | undefined = rt
        ? { ...(rt.events ? { events: rt.events } : {}) }
        : byName.get(n.server)
      const input = notificationToEvent(n, entry)
      const mapping = entry?.events?.find((m) => m.method === n.method || globMatch(m.method, n.method))
      if (mapping?.actorFrom) {
        const handle = asId(pathValue(n.params, mapping.actorFrom))
        if (handle) {
          const c = await deps.directory.contacts.byHandle(mapping.subjectSystem ?? n.server, handle)
          if (c) input.actorContactId = c.id
        }
      }
      const emp = rt ? rt.employeeId : await employeeId(entry?.employee)
      if (emp) input.employeeId = emp
      const { event, created } = await deps.events.ingest(input)
      deps.logger.debug('mcp notification ingested', { server: n.server, method: n.method, eventId: event.id, created })
    })().catch((err) =>
      deps.logger.error('mcp notification could not be ingested', {
        server: raw.server,
        method: raw.method,
        err: errorMessage(err),
      }),
    )
  })
}
