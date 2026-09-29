import { createHash } from 'node:crypto'
import { type Clock, errorMessage, type Json, type Logger, stableStringify } from '@mp/core'
import type { Integration } from '@mp/mcp'
import type { SecretStore } from '@mp/secrets'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type IntegrationSpec, secretNamesOf } from './specs.ts'

/** How long resolved secrets are reused before they're read again (another instance may have changed them). */
export const DEFAULT_SECRETS_TTL_MS = 60_000
/** Timeout of one in-process MCP request. */
const REQUEST_TIMEOUT_MS = 120_000
/** How long a replaced instance stays open for calls in flight. */
const RETIRE_AFTER_MS = REQUEST_TIMEOUT_MS

/** One employee's (or the deployment's) instance of an integration, with its in-process MCP client. */
export interface IntegrationInstance {
  spec: IntegrationSpec
  /** The employee whose secrets it uses; undefined for the deployment-wide instance. */
  employeeId: string | undefined
  integration: Integration
  /** Whether the token is set, so tools work. */
  hasToken: boolean
  /** Whether the webhook secret is set, so webhooks can be verified. */
  hasWebhookSecret: boolean
  /** The API base URL in use, when the spec has one configured (not a secret). */
  baseUrl?: string
  /** Calls a tool through the instance's MCP client. Output is parsed JSON when the text is JSON. */
  callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ output: Json; isError: boolean }>
  /** Tool definitions from the MCP server. */
  listTools(): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]>
  close(): Promise<void>
}

export interface InstanceCacheOptions {
  secrets: SecretStore
  clock: Clock
  logger: Logger
  /** Builds the factory deps for a spec (fetch and base URL overrides). */
  factoryDeps(spec: IntegrationSpec): { fetch?: typeof fetch; baseUrl?: string }
  secretsTtlMs?: number
}

/**
 * Integration instances, created lazily and cached per integration, employee
 * and secret version (a hash of the resolved values). Secrets are resolved
 * through the secret store with the employee's context, so an employee's own
 * secret wins and a deployment-wide one is the fallback. Resolved values are
 * reused for `secretsTtlMs`, and dropped at once by `invalidate()` (called
 * when a `secret` record changes). A changed secret gives a new instance; the
 * old one is closed.
 */
export class InstanceCache {
  private readonly instances = new Map<string, { version: string; instance: IntegrationInstance }>()
  private readonly resolved = new Map<string, { at: number; values: Promise<Record<string, string>> }>()
  private readonly ttl: number

  constructor(private readonly opts: InstanceCacheOptions) {
    this.ttl = opts.secretsTtlMs ?? DEFAULT_SECRETS_TTL_MS
  }

  /** Forgets every resolved secret, so the next use reads them again. */
  invalidate(): void {
    this.resolved.clear()
  }

  /** The instance for an employee (their secrets, falling back to deployment-wide ones), or the deployment-wide one. */
  async get(spec: IntegrationSpec, employeeId: string | undefined): Promise<IntegrationInstance> {
    const key = `${spec.name}:${employeeId ?? '*'}`
    const values = await this.values(key, spec, employeeId)
    const version = createHash('sha256').update(stableStringify(values)).digest('hex')
    const hit = this.instances.get(key)
    if (hit && hit.version === version) return hit.instance
    const instance = createInstance(spec, employeeId, values, {
      clock: this.opts.clock,
      logger: this.opts.logger,
      ...this.opts.factoryDeps(spec),
    })
    this.instances.set(key, { version, instance })
    if (hit) {
      this.opts.logger.info('integration secrets changed: new instance', { integration: spec.name, employeeId })
      // Let calls in flight on the old instance finish first.
      setTimeout(() => void hit.instance.close(), RETIRE_AFTER_MS).unref?.()
    }
    return instance
  }

  async close(): Promise<void> {
    const all = [...this.instances.values()]
    this.instances.clear()
    this.resolved.clear()
    await Promise.all(all.map((x) => x.instance.close()))
  }

  private values(key: string, spec: IntegrationSpec, employeeId: string | undefined): Promise<Record<string, string>> {
    const hit = this.resolved.get(key)
    if (hit && this.opts.clock.now() - hit.at < this.ttl) return hit.values
    const values = this.opts.secrets.resolve(secretNamesOf(spec), employeeId ? { employeeId } : {})
    this.resolved.set(key, { at: this.opts.clock.now(), values })
    values.catch(() => this.resolved.delete(key))
    return values
  }
}

/** The text of an MCP tool result, parsed as JSON when it is JSON. */
export function outputOf(result: { content?: unknown; structuredContent?: unknown }): Json {
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks
    .map((c) =>
      c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text) : '',
    )
    .filter(Boolean)
    .join('\n')
  if (!text && result.structuredContent !== undefined) return result.structuredContent as Json
  try {
    return JSON.parse(text) as Json
  } catch {
    return text
  }
}

/** Builds an instance and connects its MCP server lazily, in-process, over `InMemoryTransport`. */
export function createInstance(
  spec: IntegrationSpec,
  employeeId: string | undefined,
  values: Record<string, string>,
  deps: { clock: Clock; logger: Logger; fetch?: typeof fetch; baseUrl?: string },
): IntegrationInstance {
  const logger = deps.logger.child({ integration: spec.name, ...(employeeId ? { employeeId } : {}) })
  const integration = spec.create(values, { ...deps, logger })
  const baseUrl = (spec.baseUrlSecret && values[spec.baseUrlSecret]) || deps.baseUrl
  let client: Promise<Client> | null = null
  let closed = false

  const connect = () => {
    client ??= (async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      const server = integration.createMcpServer()
      await server.connect(serverSide)
      const c = new Client({ name: 'meatless-proxy', version: '0.0.0' }, { capabilities: {} })
      await c.connect(clientSide)
      return c
    })()
    client.catch(() => {
      client = null
    })
    return client
  }

  return {
    spec,
    employeeId,
    integration,
    hasToken: !!values[spec.tokenSecret],
    hasWebhookSecret: !!values[spec.webhookSecret],
    ...(baseUrl ? { baseUrl } : {}),
    async callTool(tool, args, signal) {
      const c = await connect()
      try {
        const res = await c.callTool({ name: tool, arguments: args }, undefined, {
          timeout: REQUEST_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        })
        const r = res as { content?: unknown; structuredContent?: unknown; isError?: unknown }
        return { output: outputOf(r), isError: r.isError === true }
      } catch (err) {
        if (signal?.aborted) throw err
        return { output: { error: errorMessage(err) }, isError: true }
      }
    },
    async listTools() {
      const c = await connect()
      const out: { name: string; description: string; inputSchema: Record<string, unknown> }[] = []
      let cursor: string | undefined
      do {
        const page = await c.listTools(cursor ? { cursor } : {})
        for (const t of page.tools)
          out.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> })
        cursor = page.nextCursor
      } while (cursor)
      return out
    },
    async close() {
      if (closed) return
      closed = true
      const c = client
      client = null
      if (c) await c.then((x) => x.close()).catch(() => {})
    },
  }
}
