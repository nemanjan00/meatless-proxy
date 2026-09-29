import type * as Api from '@mp/api'
import {
  type Clock,
  ConflictError,
  DeniedError,
  type EventBus,
  errorMessage,
  isMpError,
  type Json,
  type Logger,
  NotFoundError,
  stableStringify,
  UnavailableError,
  ValidationError,
} from '@mp/core'
import type { Directory } from '@mp/directory'
import type { ManagedMcpHub, McpServerConfig, McpServerStatus, McpToolInfo } from '@mp/mcp'
import { beginAuthorization, completeAuthorization, StoredOAuthProvider, type StoredOAuthOptions } from '@mp/mcp-sdk'
import { resultText } from '@mp/mcp'
import type { Records } from '@mp/records'
import type { SecretStore } from '@mp/secrets'
import type { Sessions } from '@mp/sessions'
import type { StoredRecord } from '@mp/store'
import { mcpToolName, type ToolLists, type ToolRegistry } from '@mp/tools'
import type { McpServerEntry } from '../config.ts'
import { OAUTH_CALLBACK_PATH, OAUTH_STORAGE_KEYS, OAuthStates, oauthSecretName, scopeOf, secretOAuthStorage } from './oauth.ts'
import {
  checkName,
  MCP_SERVER_KIND,
  type McpServerAuth,
  type McpServerAuthInput,
  type McpServerData,
  mcpServerKind,
  parseCreate,
  parsePatch,
  secretNameFor,
} from './schema.ts'

/** How long after a failed connect a server is tried again. */
const RETRY_MS = 60_000

/** Bus topic published when a runtime server's state changes. */
export const MCP_SERVER_STATUS_TOPIC = 'mcp.server.status'

export interface McpServerStatusEvent {
  id: string
  name: string
  employeeId: string | null
  state: Api.McpServerState
  error?: string
}

export interface McpServersDeps {
  records: Records
  secrets: SecretStore
  tools: ToolRegistry
  /** Null when the injected hub can't manage servers at runtime: then only config servers exist. */
  hub: ManagedMcpHub | null
  directory: Directory
  sessions: Sessions
  bus: EventBus
  clock: Clock
  logger: Logger
  /** `MCP_SERVERS` from the config (read-only, and their names are taken). */
  configServers: McpServerEntry[]
  /** Status of config servers (the hub knows them by name). */
  configStatus?: (name: string) => McpServerStatus | null
  /** Tools registered for config servers. */
  configTools: () => string[]
  /** Names that are taken by something else, e.g. enabled integrations. */
  reservedNames?: () => string[]
  /** The employee's tool lists before MCP scoping (for router toolsets). */
  baseToolLists: (employeeId: string) => Promise<ToolLists>
  /** `PUBLIC_URL`, for the OAuth redirect URI. */
  publicUrl?: string
}

interface Owner {
  serverId: string
  /** Undefined for a global server. */
  employeeId: string | undefined
  tool: McpToolInfo
  effect: Api.McpEffect
  secrets: string[]
}

interface Live {
  record: StoredRecord<McpServerData>
  /** The config the hub has for it, to tell whether a change needs a new connection. */
  applied: string
  tools: string[]
}

const toolOutput = (res: { content: unknown[]; structuredContent?: unknown }): Json => {
  const text = resultText(res as never)
  return text || res.structuredContent === undefined ? text : (res.structuredContent as Json)
}

/** The hub knows a runtime server by its record id: say its name instead. */
const named = (text: string, rec: StoredRecord<McpServerData>) => text.split(rec.id).join(rec.data.name)

/** A path on the harness to go back to after an OAuth sign-in. Anything else becomes `fallback`. */
export function safeReturnTo(v: unknown, fallback: string): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\') || v.length > 500) return fallback
  try {
    const u = new URL(v, 'http://x')
    return u.origin === 'http://x' ? `${u.pathname}${u.search}${u.hash}` : fallback
  } catch {
    return fallback
  }
}

/**
 * MCP servers added at runtime (`mcp_server` records), next to the read-only
 * `MCP_SERVERS` ones (docs/spec.md#mcp):
 *
 * - **Hub:** each enabled record is a server in the shared hub, keyed by its
 *   record id. A change to the record (the `record.changed` bus event, or a
 *   call from the API) connects, reconnects or removes it, one change at a
 *   time per server.
 * - **Tools** are `mcp.<name>.<tool>`. A global server's tools are for every
 *   employee; an employee server's only for that employee: `hiddenFor`
 *   denies the others (the runner checks it when listing and calling), and
 *   the handler refuses them with `DeniedError`. Two employees may each have
 *   a server of the same name: a call goes to the caller's own.
 * - **New tools reach new sessions** through the router contexts of the
 *   employees that see them (sessions they start copy the router's tools);
 *   running sessions keep their tool set.
 * - **Secrets:** a token or OAuth credentials are in the secret store,
 *   scoped to the employee or global, and never in the record or the API.
 */
export class McpServers {
  private readonly live = new Map<string, Live>()
  private readonly owners = new Map<string, Map<string, Owner>>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly providers = new Map<string, { key: string; provider: StoredOAuthProvider }>()
  private readonly states: OAuthStates
  private readonly log: Logger
  private readonly offs: (() => void)[] = []
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  private started: Promise<void> | null = null
  private closed = false

  constructor(private readonly d: McpServersDeps) {
    if (!d.records.kinds.has(MCP_SERVER_KIND)) d.records.kinds.define(mcpServerKind)
    this.log = d.logger.child({ component: 'mcp-servers' })
    this.states = new OAuthStates(d.records, d.clock, this.log)
  }

  // ── Wiring for the hub ────────────────────────────────────────────────────

  /** Whether a hub server name is a runtime server (a record id). */
  isRuntime(hubName: string): boolean {
    return this.live.has(hubName)
  }

  /** The record of a runtime server by its hub name. */
  recordOf(hubName: string): StoredRecord<McpServerData> | undefined {
    return this.live.get(hubName)?.record
  }

  /** Resolves a server's secrets in its scope: an employee server's are the employee's (global as fallback). */
  resolveSecrets = async (names: string[], server: McpServerConfig): Promise<Record<string, string>> => {
    const employeeId = this.live.get(server.name)?.record.data.employeeId
    return this.d.secrets.resolve(names, employeeId ? { employeeId } : {})
  }

  /** The OAuth provider the hub connects an OAuth server with (non-interactive: it never starts a sign-in). */
  authProviderFor = (config: McpServerConfig): StoredOAuthProvider | undefined => {
    const rec = this.live.get(config.name)?.record
    if (rec?.data.auth.type !== 'oauth') return undefined
    const key = stableStringify(this.oauthOptionsKey(rec))
    const hit = this.providers.get(rec.id)
    if (hit && hit.key === key) return hit.provider
    const provider = new StoredOAuthProvider(this.oauthOptions(rec, this.redirectUrl()))
    this.providers.set(rec.id, { key, provider })
    return provider
  }

  /** Tool names an employee may not see or call: other employees' MCP tools. */
  hiddenFor(employeeId: string): string[] {
    const out: string[] = []
    for (const [name, owners] of this.owners) {
      if (![...owners.values()].some((o) => o.employeeId === undefined || o.employeeId === employeeId)) out.push(name)
    }
    return out
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Loads every server, connects the enabled ones, and follows record changes. Resolves when all have been tried. */
  start(): Promise<void> {
    this.started ??= (async () => {
      this.offs.push(
        this.d.bus.subscribe<{ kind: string; id: string }>('record.changed', (m) => {
          if (m.payload.kind === MCP_SERVER_KIND) void this.sync(m.payload.id)
        }),
      )
      if (this.d.hub) {
        this.offs.push(this.d.hub.onStatus((server, status) => this.onStatus(server, status)))
        this.offs.push(
          this.d.hub.onNotification((n) => {
            if (n.method === 'notifications/tools/list_changed' && this.live.has(n.server)) void this.refresh(n.server)
          }),
        )
      }
      const all = await this.d.records.query<McpServerData>(MCP_SERVER_KIND, { limit: 1000 })
      await Promise.all(all.items.map((r) => this.sync(r.id)))
    })()
    return this.started
  }

  async close(): Promise<void> {
    this.closed = true
    for (const off of this.offs.splice(0)) off()
    for (const t of this.retries.values()) clearTimeout(t)
    this.retries.clear()
    await Promise.all([...this.chains.values()].map((p) => p.catch(() => {})))
  }

  /** Runs `fn` after every earlier change of the same server. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    const tail = next.catch(() => {})
    this.chains.set(id, tail)
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id)
    })
    return next
  }

  /** Brings the hub and the tools in line with the record: add, reconnect, remove. Never throws. */
  sync(id: string, opts: { reconnect?: boolean } = {}): Promise<void> {
    return this.serial(id, async () => {
      if (this.closed) return
      try {
        await this.apply(id, opts.reconnect ?? false)
      } catch (err) {
        this.log.warn('MCP server could not be applied', { serverId: id, err: errorMessage(err) })
      }
    })
  }

  private hubConfig(rec: StoredRecord<McpServerData>): McpServerConfig {
    const a = rec.data.auth
    return {
      name: rec.id,
      transport: 'http',
      url: rec.data.url,
      ...(rec.data.headers && Object.keys(rec.data.headers).length ? { env: { ...rec.data.headers } } : {}),
      ...(a.type === 'token'
        ? {
            secrets: { [a.header ?? 'Authorization']: a.secret },
            secretPrefix: { [a.header ?? 'Authorization']: a.prefix ?? 'Bearer ' },
          }
        : {}),
    }
  }

  private async apply(id: string, reconnect: boolean) {
    const rec = await this.d.records.get<McpServerData>(MCP_SERVER_KIND, id)
    const hub = this.d.hub
    const current = this.live.get(id)
    if (!rec?.data.enabled || !hub) {
      if (current || hub?.servers().includes(id)) await this.teardown(id)
      if (rec && !hub) this.log.warn('the MCP hub cannot add servers at runtime', { serverId: id })
      return
    }
    const config = this.hubConfig(rec)
    const applied = stableStringify({ config, auth: rec.data.auth })
    if (current && current.applied === applied && !reconnect) {
      current.record = rec
      // Effects or the event mapping changed: re-register with the new effects.
      this.registerTools(id, await this.listed(id))
      return
    }
    if (hub.servers().includes(id)) await hub.removeServer(id)
    this.providers.delete(id)
    this.live.set(id, { record: rec, applied, tools: current?.tools ?? [] })
    hub.addServer(config)
    const status = await hub.reconnect(id)
    if (status.state === 'connected') await this.refresh(id, false)
    else {
      this.unregisterTools(id)
      this.publish(id, status)
    }
  }

  private async listed(id: string): Promise<McpToolInfo[]> {
    try {
      return await this.d.hub!.listTools(id)
    } catch {
      return []
    }
  }

  /** Lists the server's tools again and registers them. */
  private async refresh(id: string, serialize = true): Promise<void> {
    const run = async () => {
      if (!this.live.has(id) || !this.d.hub) return
      try {
        const tools = await this.d.hub.listTools(id)
        const added = this.registerTools(id, tools)
        await this.addToRouters(id, added)
      } catch (err) {
        this.log.warn('MCP tools could not be listed', { serverId: id, err: errorMessage(err) })
        this.unregisterTools(id)
      }
    }
    return serialize ? this.serial(id, run) : run()
  }

  private async teardown(id: string) {
    this.cancelRetry(id)
    this.unregisterTools(id)
    this.live.delete(id)
    this.providers.delete(id)
    await this.d.hub?.removeServer(id)
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  /** Registers the server's tools (replacing its earlier ones). Returns the tool names that are new. */
  private registerTools(id: string, tools: McpToolInfo[]): string[] {
    const live = this.live.get(id)
    if (!live) return []
    const rec = live.record
    const names = new Set<string>()
    const added: string[] = []
    const a = rec.data.auth
    for (const tool of tools) {
      const name = mcpToolName(rec.data.name, tool.name)
      names.add(name)
      let owners = this.owners.get(name)
      if (!owners) this.owners.set(name, (owners = new Map()))
      if (!owners.has(id)) added.push(name)
      owners.set(id, {
        serverId: id,
        employeeId: rec.data.employeeId,
        tool,
        effect: rec.data.effects?.[tool.name] ?? rec.data.effect ?? 'non_idempotent',
        secrets: a.type === 'token' ? [a.secret] : [],
      })
      this.register(name)
    }
    for (const old of live.tools) {
      if (names.has(old)) continue
      this.owners.get(old)?.delete(id)
      this.register(old)
    }
    live.tools = [...names].sort()
    return added
  }

  private unregisterTools(id: string) {
    const live = this.live.get(id)
    for (const name of live?.tools ?? []) {
      this.owners.get(name)?.delete(id)
      this.register(name)
    }
    if (live) live.tools = []
  }

  /** (Re)registers one tool name from its owners, or unregisters it when there are none. */
  private register(name: string) {
    const owners = this.owners.get(name)
    if (!owners?.size) {
      this.owners.delete(name)
      this.d.tools.unregister(name)
      return
    }
    // The definition the model sees: a global server's when there is one.
    const all = [...owners.values()]
    const def = all.find((o) => o.employeeId === undefined) ?? all[0]!
    const secrets = [...new Set(all.flatMap((o) => o.secrets))]
    this.d.tools.register(
      {
        name,
        description: def.tool.description ?? '',
        parameters:
          def.tool.inputSchema && typeof def.tool.inputSchema === 'object'
            ? def.tool.inputSchema
            : { type: 'object', properties: {} },
        effect: def.effect,
        source: 'mcp',
        server: this.live.get(def.serverId)?.record.data.name ?? def.serverId,
        ...(secrets.length ? { secrets } : {}),
      },
      async (args, ctx) => {
        const owner = this.ownerFor(name, ctx.employeeId)
        if (!owner) throw new DeniedError(`${name} is another employee's MCP tool`)
        const serverName = this.live.get(owner.serverId)?.record.data.name ?? owner.serverId
        try {
          const res = await this.d.hub!.callTool(owner.serverId, owner.tool.name, (args ?? {}) as Record<string, unknown>, {
            signal: ctx.signal,
          })
          const output = toolOutput(res)
          return res.isError ? { output, isError: true } : { output }
        } catch (err) {
          // Name the server by its name, not its record id (alerts and the model read this).
          if (err instanceof UnavailableError)
            throw new UnavailableError(err.message.split(owner.serverId).join(serverName), { ...err.details, server: serverName })
          throw err
        }
      },
      { replace: true },
    )
  }

  /** The server a call of `name` goes to for this employee: its own, else the global one. */
  private ownerFor(name: string, employeeId: string): Owner | undefined {
    const all = [...(this.owners.get(name)?.values() ?? [])]
    return all.find((o) => o.employeeId === employeeId) ?? all.find((o) => o.employeeId === undefined)
  }

  /** Adds newly registered tools to the router contexts of the employees that see them, so new sessions get them. */
  private async addToRouters(id: string, names: string[]) {
    if (!names.length) return
    const rec = this.live.get(id)?.record
    if (!rec) return
    const employees = rec.data.employeeId
      ? [await this.d.directory.employees.get(rec.data.employeeId)].filter((e) => !!e)
      : (await this.d.directory.employees.list({ limit: 1000 })).items
    for (const e of employees) {
      const routerId = e.data.routerSessionId
      if (!routerId) continue
      try {
        const session = await this.d.sessions.get(routerId)
        if (!session) continue
        const lists = await this.d.baseToolLists(e.id)
        const hidden = new Set(this.hiddenFor(e.id))
        const add = names.filter((n) => !session.data.toolset.includes(n) && !hidden.has(n) && this.d.tools.isAllowed(n, lists))
        if (!add.length) continue
        await this.d.records.update('session', routerId, { toolset: [...session.data.toolset, ...add] })
        this.log.info('router context got new MCP tools', { employeeId: e.id, tools: add })
      } catch (err) {
        this.log.warn('could not add MCP tools to a router context', { employeeId: e.id, err: errorMessage(err) })
      }
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  private cancelRetry(id: string) {
    const t = this.retries.get(id)
    if (t) clearTimeout(t)
    this.retries.delete(id)
  }

  private onStatus(server: string, status: McpServerStatus) {
    if (!this.live.has(server)) return
    this.publish(server, status)
    if (status.state === 'needs_auth' || status.state === 'error') this.unregisterTools(server)
    // A server that can't be reached is tried again every minute (one that needs a sign-in waits for it).
    if (status.state === 'error' && !this.retries.has(server) && !this.closed) {
      const t = setTimeout(() => {
        this.retries.delete(server)
        if (this.live.has(server)) void this.sync(server, { reconnect: true })
      }, RETRY_MS)
      t.unref?.()
      this.retries.set(server, t)
    }
    if (status.state === 'connected') this.cancelRetry(server)
    if (status.state === 'connected' && !this.live.get(server)!.tools.length && status.toolCount === undefined)
      void this.refresh(server)
  }

  private lastPublished = new Map<string, string>()

  private publish(id: string, status: McpServerStatus) {
    const rec = this.live.get(id)?.record
    if (!rec) return
    const state = this.stateOf(rec, status)
    const payload: McpServerStatusEvent = {
      id,
      name: rec.data.name,
      employeeId: rec.data.employeeId ?? null,
      state,
      ...(status.error ? { error: named(status.error, rec) } : {}),
    }
    const key = `${state}:${status.error ?? ''}`
    if (this.lastPublished.get(id) === key) return
    this.lastPublished.set(id, key)
    this.d.bus.publish(MCP_SERVER_STATUS_TOPIC, payload)
    if (state === 'needs_auth') this.log.warn('MCP server needs authorization', { serverId: id, name: rec.data.name })
  }

  private stateOf(rec: StoredRecord<McpServerData>, status: McpServerStatus | null): Api.McpServerState {
    if (!rec.data.enabled) return 'disabled'
    if (!status) return 'connecting'
    if (status.state === 'idle') return 'connecting'
    return status.state
  }

  private statusInfo(rec: StoredRecord<McpServerData>): Api.McpServerStatusInfo {
    let status: McpServerStatus | null = null
    try {
      status = this.live.has(rec.id) && this.d.hub ? this.d.hub.status(rec.id) : null
    } catch {}
    const state = this.stateOf(rec, status)
    return {
      state,
      toolCount: this.live.get(rec.id)?.tools.length ?? 0,
      ...(status?.error && (state === 'error' || state === 'needs_auth') ? { error: named(status.error, rec) } : {}),
      ...(!status && rec.data.enabled && !this.d.hub ? { state: 'error' as const, error: 'the MCP hub cannot add servers' } : {}),
      ...(status?.lastError ? { lastError: named(status.lastError, rec) } : {}),
      ...(status?.lastErrorAt ? { lastErrorAt: status.lastErrorAt } : {}),
      ...(status?.connectedAt ? { connectedAt: status.connectedAt } : {}),
    }
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  private async hasSecret(name: string, employeeId: string | undefined): Promise<boolean> {
    const v = await this.d.secrets.resolve([name], employeeId ? { employeeId } : {})
    return !!v[name]
  }

  async view(rec: StoredRecord<McpServerData>): Promise<Api.McpServerInfo> {
    const a = rec.data.auth
    let auth: Api.McpServerAuthInfo
    if (a.type === 'token')
      auth = {
        type: 'token',
        header: a.header ?? 'Authorization',
        prefix: a.prefix ?? 'Bearer ',
        secret: a.secret,
        hasToken: await this.hasSecret(a.secret, rec.data.employeeId),
      }
    else if (a.type === 'oauth')
      auth = {
        type: 'oauth',
        ...(a.scopes?.length ? { scopes: a.scopes } : {}),
        ...(a.clientId ? { clientId: a.clientId } : {}),
        ...(a.clientSecretSecret ? { clientSecretSecret: a.clientSecretSecret } : {}),
        ...(a.authorizationServer ? { authorizationServer: a.authorizationServer } : {}),
        hasTokens: await this.hasSecret(oauthSecretName(rec.data.name, 'tokens'), rec.data.employeeId),
      }
    else auth = { type: 'none' }
    return {
      id: rec.id,
      name: rec.data.name,
      source: 'record',
      transport: 'http',
      url: rec.data.url,
      ...(rec.data.headers && Object.keys(rec.data.headers).length ? { headers: rec.data.headers } : {}),
      employeeId: rec.data.employeeId ?? null,
      enabled: rec.data.enabled,
      ...(rec.data.effect ? { effect: rec.data.effect } : {}),
      ...(rec.data.effects ? { effects: rec.data.effects } : {}),
      ...(rec.data.events ? { events: rec.data.events as Api.McpEventMapping[] } : {}),
      auth,
      status: this.statusInfo(rec),
      version: rec.version,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    }
  }

  private configView(s: McpServerEntry): Api.McpServerInfo {
    const st = this.d.configStatus?.(s.name) ?? null
    const tools = this.d.configTools().filter((t) => t.startsWith(`mcp.${s.name}.`)).length
    return {
      id: `config:${s.name}`,
      name: s.name,
      source: 'config',
      transport: s.transport,
      ...(s.url ? { url: s.url } : {}),
      employeeId: null,
      enabled: true,
      ...(s.effect ? { effect: s.effect } : {}),
      ...(s.effects ? { effects: s.effects } : {}),
      ...(s.events ? { events: s.events as Api.McpEventMapping[] } : {}),
      auth: { type: 'none' },
      status: {
        state: !st ? (tools ? 'connected' : 'connecting') : st.state === 'idle' ? 'connecting' : st.state,
        toolCount: tools,
        ...(st?.error ? { error: st.error } : {}),
        ...(st?.lastError ? { lastError: st.lastError } : {}),
        ...(st?.lastErrorAt ? { lastErrorAt: st.lastErrorAt } : {}),
        ...(st?.connectedAt ? { connectedAt: st.connectedAt } : {}),
      },
    }
  }

  /**
   * Servers, newest last. `employeeId`: undefined for all, null for the global
   * ones (config servers included), an id for that employee's.
   */
  async list(employeeId?: string | null): Promise<Api.McpServerInfo[]> {
    const page = await this.d.records.query<McpServerData>(MCP_SERVER_KIND, {
      limit: 1000,
      orderBy: { field: 'createdAt', dir: 'asc' },
    })
    const recs = page.items.filter((r) =>
      employeeId === undefined ? true : employeeId === null ? !r.data.employeeId : r.data.employeeId === employeeId,
    )
    const out = employeeId ? [] : this.d.configServers.map((s) => this.configView(s))
    for (const r of recs) out.push(await this.view(r))
    return out
  }

  async get(id: string): Promise<StoredRecord<McpServerData>> {
    if (id.startsWith('config:')) throw new DeniedError('servers from MCP_SERVERS are read-only: change the config')
    return this.d.records.require<McpServerData>(MCP_SERVER_KIND, id)
  }

  async tools(id: string): Promise<Api.McpServerTool[]> {
    if (id.startsWith('config:')) {
      const name = id.slice('config:'.length)
      if (!this.d.configServers.some((s) => s.name === name)) throw new NotFoundError('MCP server', id)
      return this.d
        .configTools()
        .filter((t) => t.startsWith(`mcp.${name}.`))
        .map((t) => {
          const def = this.d.tools.get(t)!.def
          return {
            name: t.slice(`mcp.${name}.`.length),
            toolName: t,
            description: def.description,
            inputSchema: def.parameters,
            effect: def.effect,
          }
        })
    }
    await this.get(id)
    const out: Api.McpServerTool[] = []
    for (const name of this.live.get(id)?.tools ?? []) {
      const o = this.owners.get(name)?.get(id)
      if (o)
        out.push({
          name: o.tool.name,
          toolName: name,
          description: o.tool.description,
          inputSchema: o.tool.inputSchema,
          effect: o.effect,
        })
    }
    return out
  }

  // ── Changes (from the API) ────────────────────────────────────────────────

  private async checkNameFree(name: string, employeeId: string | undefined, exceptId?: string) {
    checkName(name)
    if (this.d.configServers.some((s) => s.name === name) || this.d.reservedNames?.().includes(name))
      throw new ConflictError(`the MCP server name ${name} is taken by the configuration`)
    const same = await this.d.records.query<McpServerData>(MCP_SERVER_KIND, { where: { name }, limit: 1000 })
    for (const r of same.items) {
      if (r.id === exceptId) continue
      if (!r.data.employeeId) throw new ConflictError(`there is already a global MCP server named ${name}`)
      if (!employeeId) throw new ConflictError(`an employee already has an MCP server named ${name}: global names must be unique`)
      if (r.data.employeeId === employeeId) throw new ConflictError(`this employee already has an MCP server named ${name}`)
    }
  }

  /** Turns the auth input into what the record keeps, writing secret values to the secret store. */
  private async applyAuth(
    name: string,
    employeeId: string | undefined,
    input: McpServerAuthInput,
    prev: McpServerAuth | undefined,
    generated: Set<string>,
    actor: string,
  ): Promise<McpServerAuth> {
    const scope = scopeOf(employeeId)
    if (input.type === 'none') return { type: 'none' }
    if (input.type === 'token') {
      const prevSecret = prev?.type === 'token' ? prev.secret : undefined
      const secret = input.secret ?? prevSecret ?? secretNameFor(name, 'TOKEN')
      if (input.token !== undefined) {
        await this.d.secrets.set(secret, input.token, scope, actor)
        if (!input.secret || input.secret === secretNameFor(name, 'TOKEN')) generated.add(secret)
      } else if (!(await this.hasSecret(secret, employeeId)))
        throw new ValidationError(`give the token, or the name of a secret that is set (${secret} is not)`)
      return {
        type: 'token',
        secret,
        ...(input.header && input.header !== 'Authorization' ? { header: input.header } : {}),
        ...(input.prefix !== undefined && input.prefix !== 'Bearer ' ? { prefix: input.prefix } : {}),
      }
    }
    let clientSecretSecret = input.clientSecretSecret ?? (prev?.type === 'oauth' ? prev.clientSecretSecret : undefined)
    if (input.clientSecret !== undefined) {
      clientSecretSecret = secretNameFor(name, 'OAUTH_CLIENT_SECRET')
      await this.d.secrets.set(clientSecretSecret, input.clientSecret, scope, actor)
      generated.add(clientSecretSecret)
    }
    if (input.clientSecret === undefined && input.clientSecretSecret === undefined && !input.clientId)
      clientSecretSecret = undefined
    return {
      type: 'oauth',
      ...(input.scopes?.length ? { scopes: input.scopes } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(clientSecretSecret ? { clientSecretSecret } : {}),
      ...(input.authorizationServer ? { authorizationServer: input.authorizationServer } : {}),
    }
  }

  async create(body: unknown, actor: string): Promise<Api.McpServerInfo> {
    const input = parseCreate(body)
    const employeeId = input.employeeId ?? undefined
    if (employeeId) await this.d.directory.employees.require(employeeId)
    await this.checkNameFree(input.name, employeeId)
    const generated = new Set<string>()
    const auth = await this.applyAuth(input.name, employeeId, input.auth ?? { type: 'none' }, undefined, generated, actor)
    const data: McpServerData = {
      name: input.name,
      transport: 'http',
      url: input.url,
      ...(input.headers ? { headers: input.headers } : {}),
      ...(employeeId ? { employeeId } : {}),
      enabled: input.enabled ?? true,
      ...(input.effect ? { effect: input.effect } : {}),
      ...(input.effects ? { effects: input.effects } : {}),
      ...(input.events ? { events: input.events } : {}),
      auth,
      ...(generated.size ? { generatedSecrets: [...generated] } : {}),
    }
    // One server per scope and name, also when two requests race.
    const key = `${employeeId ?? 'global'}:${input.name}`
    let rec: StoredRecord<McpServerData>
    try {
      rec = await this.d.records.create<McpServerData>(MCP_SERVER_KIND, data, { key, actor: { type: 'contact', id: actor } })
    } catch (err) {
      if (err instanceof ConflictError) throw new ConflictError(`an MCP server named ${input.name} already exists`)
      throw err
    }
    this.log.info('MCP server added', { serverId: rec.id, name: rec.data.name, employeeId, auth: auth.type })
    await this.sync(rec.id)
    return this.view((await this.d.records.get<McpServerData>(MCP_SERVER_KIND, rec.id)) ?? rec)
  }

  async update(id: string, body: unknown, actor: string): Promise<Api.McpServerInfo> {
    const input = parsePatch(body)
    const rec = await this.get(id)
    if (input.name !== undefined && input.name !== rec.data.name)
      throw new ValidationError("an MCP server's name can't change: add a new server")
    if (input.employeeId !== undefined && (input.employeeId ?? undefined) !== rec.data.employeeId)
      throw new ValidationError("an MCP server's employee can't change: add a new server")
    const generated = new Set(rec.data.generatedSecrets ?? [])
    const auth = input.auth
      ? await this.applyAuth(rec.data.name, rec.data.employeeId, input.auth, rec.data.auth, generated, actor)
      : rec.data.auth
    const next: McpServerData = { ...rec.data, auth }
    if (input.url !== undefined) next.url = input.url
    if (input.headers !== undefined) next.headers = input.headers
    if (input.enabled !== undefined) next.enabled = input.enabled
    for (const k of ['effect', 'effects', 'events'] as const) {
      const v = input[k]
      if (v === null) delete next[k]
      else if (v !== undefined) (next as Record<string, unknown>)[k] = v
    }
    // A token or OAuth set-up that was replaced leaves its generated secrets behind: remove them.
    if (rec.data.auth.type === 'oauth' && auth.type !== 'oauth') await this.deleteOAuthSecrets(rec)
    if (rec.data.auth.type === 'token' && (auth.type !== 'token' || auth.secret !== rec.data.auth.secret)) {
      const old = rec.data.auth.secret
      if (generated.has(old)) {
        await this.d.secrets.delete(old, scopeOf(rec.data.employeeId))
        generated.delete(old)
      }
    }
    next.generatedSecrets = [...generated]
    if (!generated.size) delete next.generatedSecrets
    const updated = await this.d.records.update<McpServerData>(MCP_SERVER_KIND, id, next, {
      replace: true,
      actor: { type: 'contact', id: actor },
      ...(input.version !== undefined ? { expectedVersion: input.version } : {}),
    })
    // A new secret value under the same name isn't a config change: connect again to use it.
    const newValue =
      (input.auth?.type === 'token' && input.auth.token !== undefined) ||
      (input.auth?.type === 'oauth' && !!input.auth.clientSecret)
    await this.sync(id, { reconnect: newValue })
    return this.view((await this.d.records.get<McpServerData>(MCP_SERVER_KIND, id)) ?? updated)
  }

  async remove(id: string): Promise<void> {
    const rec = await this.get(id)
    await this.d.records.delete(MCP_SERVER_KIND, id)
    await this.serial(id, () => this.teardown(id))
    const scope = scopeOf(rec.data.employeeId)
    for (const name of rec.data.generatedSecrets ?? []) await this.d.secrets.delete(name, scope)
    await this.deleteOAuthSecrets(rec)
    await this.states.forget(id)
    this.log.info('MCP server deleted', { serverId: id, name: rec.data.name })
  }

  async reconnect(id: string): Promise<Api.McpServerInfo> {
    await this.get(id)
    this.providers.get(id)?.provider.forget()
    await this.sync(id, { reconnect: true })
    return this.view(await this.get(id))
  }

  private async deleteOAuthSecrets(rec: StoredRecord<McpServerData>) {
    const scope = scopeOf(rec.data.employeeId)
    for (const key of OAUTH_STORAGE_KEYS) await this.d.secrets.delete(oauthSecretName(rec.data.name, key), scope)
    this.providers.get(rec.id)?.provider.forget()
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  /** The redirect URI: `PUBLIC_URL` (or the request's origin) + `/oauth/mcp/callback`. */
  redirectUrl(requestOrigin?: string): string {
    const base = (this.d.publicUrl ?? requestOrigin ?? 'http://localhost').replace(/\/+$/, '')
    return `${base}${OAUTH_CALLBACK_PATH}`
  }

  private oauthOptionsKey(rec: StoredRecord<McpServerData>) {
    return { auth: rec.data.auth, name: rec.data.name, employeeId: rec.data.employeeId, url: rec.data.url }
  }

  private oauthOptions(rec: StoredRecord<McpServerData>, redirectUrl: string): StoredOAuthOptions {
    const a = rec.data.auth
    if (a.type !== 'oauth') throw new ValidationError(`MCP server ${rec.data.name} doesn't use OAuth`)
    const employeeId = rec.data.employeeId
    return {
      storage: secretOAuthStorage(this.d.secrets, rec.data.name, employeeId),
      redirectUrl,
      clientName: 'meatless-proxy',
      ...(a.scopes?.length ? { scopes: a.scopes } : {}),
      ...(a.clientId ? { clientId: a.clientId } : {}),
      ...(a.clientSecretSecret
        ? {
            clientSecret: async () =>
              (await this.d.secrets.resolve([a.clientSecretSecret!], employeeId ? { employeeId } : {}))[a.clientSecretSecret!],
          }
        : {}),
      ...(a.authorizationServer ? { authorizationServer: a.authorizationServer } : {}),
    }
  }

  /** Starts a sign-in: the authorization URL to send the person to. */
  async oauthStart(
    id: string,
    who: { contactId: string },
    opts: { returnTo?: unknown; requestOrigin?: string },
  ): Promise<Api.McpOAuthStart> {
    const rec = await this.get(id)
    if (rec.data.auth.type !== 'oauth') throw new ValidationError(`MCP server ${rec.data.name} doesn't use OAuth`)
    const fallback = rec.data.employeeId ? `/employees/${rec.data.employeeId}` : '/settings/mcp'
    const redirectUrl = this.redirectUrl(opts.requestOrigin)
    const { state, expiresAt } = await this.states.create({
      serverId: id,
      contactId: who.contactId,
      returnTo: safeReturnTo(opts.returnTo, fallback),
      redirectUrl,
    })
    let url: URL
    try {
      url = await beginAuthorization({ ...this.oauthOptions(rec, redirectUrl), serverUrl: rec.data.url, state })
    } catch (err) {
      throw new UnavailableError(`could not start the OAuth sign-in for ${rec.data.name}: ${errorMessage(err)}`, {
        server: rec.data.name,
      })
    }
    this.log.info('MCP OAuth sign-in started', { serverId: id, contactId: who.contactId })
    return { authorizationUrl: url.toString(), expiresAt }
  }

  /**
   * Finishes a sign-in from the callback. Returns where to send the person, with the outcome in the query
   * (`mcp_oauth=connected|error`). Refused states throw `DeniedError` (the caller shows the error).
   */
  async oauthCallback(query: Record<string, string | undefined>, who: { contactId: string }): Promise<string> {
    const st = await this.states.consume(query.state ?? '', who.contactId)
    const rec = await this.d.records.get<McpServerData>(MCP_SERVER_KIND, st.serverId)
    const back = (outcome: 'connected' | 'error', name: string, message?: string) => {
      const u = new URL(st.returnTo, 'http://x')
      u.searchParams.set('mcp_oauth', outcome)
      u.searchParams.set('mcp_server', name)
      if (message) u.searchParams.set('mcp_error', message.slice(0, 300))
      return `${u.pathname}${u.search}${u.hash}`
    }
    if (rec?.data.auth.type !== 'oauth')
      return back('error', rec?.data.name ?? '', 'the server was deleted or no longer uses OAuth')
    if (query.error) return back('error', rec.data.name, query.error_description || query.error)
    if (!query.code) return back('error', rec.data.name, 'no authorization code came back')
    try {
      await completeAuthorization({ ...this.oauthOptions(rec, st.redirectUrl), serverUrl: rec.data.url, code: query.code })
    } catch (err) {
      this.log.warn('MCP OAuth code exchange failed', { serverId: rec.id, err: errorMessage(err) })
      return back('error', rec.data.name, `the code exchange failed: ${errorMessage(err)}`)
    }
    this.log.info('MCP OAuth connected', { serverId: rec.id, name: rec.data.name })
    this.providers.get(rec.id)?.provider.forget()
    await this.sync(rec.id, { reconnect: true })
    let status: McpServerStatus | null = null
    try {
      status = this.d.hub?.status(rec.id) ?? null
    } catch {}
    if (status && status.state !== 'connected')
      return back('error', rec.data.name, `signed in, but the server did not connect: ${status.error ?? status.state}`)
    return back('connected', rec.data.name)
  }

  /** Deletes the stored OAuth tokens and registration: the server needs a new sign-in. */
  async oauthDisconnect(id: string): Promise<Api.McpServerInfo> {
    const rec = await this.get(id)
    if (rec.data.auth.type !== 'oauth') throw new ValidationError(`MCP server ${rec.data.name} doesn't use OAuth`)
    await this.deleteOAuthSecrets(rec)
    await this.sync(id, { reconnect: true })
    this.log.info('MCP OAuth disconnected', { serverId: id })
    return this.view(await this.get(id))
  }
}

/** Whether an error is the hub reporting a server that needs a new sign-in. */
export const needsAuth = (err: unknown) =>
  isMpError(err, 'unavailable') && (err.details as { needsAuth?: unknown } | undefined)?.needsAuth === true
