import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createChat, createChatAttachments, type Chat, type ChatAttachments, type ImageDescriber } from '@mp/chat'
import { createChecklists, type Checklists } from '@mp/checklists'
import type { ContainerRuntime } from '@mp/containers'
import { dockerRuntime } from '@mp/containers-docker'
import {
  createEventBus,
  createHooks,
  errorMessage,
  jsonLogger,
  systemClock,
  type Clock,
  type EventBus,
  type Hooks,
  type Logger,
} from '@mp/core'
import { createDirectory, type Directory, type Employee } from '@mp/directory'
import { createEvents, type Events } from '@mp/events'
import { createFiles, directoryStorage, migrateFileRecords, type FileStorage, type FilesService } from '@mp/files'
import type { GitCache } from '@mp/git'
import { isManagedHub, type McpHub } from '@mp/mcp'
import { createMcpHub } from '@mp/mcp-sdk'
import { createMemory, type MemoryService } from '@mp/memory'
import { emptyUsage, type ModelClient } from '@mp/model'
import { openAiModel } from '@mp/model-openai'
import { memoryQueue, type Queue } from '@mp/queue'
import { bullmqQueue } from '@mp/queue-bullmq'
import { createDocs, createRecords, type Docs, type Records } from '@mp/records'
import { beforeDeliver, createRouter, type RecipientResolver, type Router } from '@mp/router'
import { afterModelCall, createRunner, type Runner } from '@mp/runner'
import type { SecretStore } from '@mp/secrets'
import { storeSecretStore } from '@mp/secrets-store'
import { createSandbox, type Sandbox } from '@mp/sandbox'
import { directNetworkName, networkFor, type ProcedureContexts } from '@mp/stdlib'
import { createSessions, type Session, type Sessions } from '@mp/sessions'
import { createSkills, type SkillsService } from '@mp/skills'
import { memoryStore, type Store } from '@mp/store'
import { postgresStore, runMigrations } from '@mp/store-postgres'
import { createToolRegistry, registerMcpTools, type ToolLists, type ToolRegistry } from '@mp/tools'
import { createUsage, type UsageService } from '@mp/usage'
import pg from 'pg'
import type { Config } from './config.ts'
import { imageLoader, resolveVision, type VisionSettings } from './attachments.ts'
import { buildDescriber, describedEvent, enqueueDescriptions } from './image-descriptions.ts'
import { createControl, type Control } from './control.ts'
import { wireMcpNotifications } from './mcp-in.ts'
import { enqueueOnIngest, withJobDefaults, QUEUES } from './queues.ts'
import { DEFAULT_SETTINGS, SettingNames, createSettings, type Settings } from './settings.ts'
import { limitDefaults, PricingStore, runLimitsFor } from './limits.ts'
import { loadStdlib, type StdlibModule } from './stdlib.ts'
import { employeeGit, type EmployeeGit } from './git-store.ts'
import { createIntegrations, type Integrations, type IntegrationsOptions } from './integrations/index.ts'
import { defineSshFields, ensureSshKey, sshPrivateKey } from './ssh.ts'
import { defineAuthKinds } from './auth/access.ts'
import type { AuthOptions } from './auth/index.ts'
import { selfContainer } from './previews/self.ts'
import { McpServers } from './mcp-servers/index.ts'
import { privateEvents, privateSessions, watchDmLinks } from './private-work.ts'

/** Replacements for adapters and ambient services, mostly for tests. */
export interface AppOverrides {
  store?: Store
  queue?: Queue
  model?: ModelClient
  mcpHub?: McpHub
  git?: GitCache
  containers?: ContainerRuntime
  /** Where employee files live. Default: `directoryStorage` on FILES_DIR. */
  fileStorage?: FileStorage
  secrets?: SecretStore
  clock?: Clock
  logger?: Logger
  bus?: EventBus
  /** `false` skips the standard library (tests of the bare wiring). Default: load it when it is available. */
  stdlib?: boolean
  /** Integration options (fetch and base URL overrides for tests). */
  integrations?: IntegrationsOptions
  /** Sign-in options (an OIDC `fetch` for tests, rate limits). */
  auth?: AuthOptions
  /** Runs after the services are wired and before bootstrap: register extra tools or hooks. */
  setup?: (services: Services) => void | Promise<void>
}

export interface Services {
  config: Config
  clock: Clock
  logger: Logger
  bus: EventBus
  hooks: Hooks
  store: Store
  queue: Queue
  model: ModelClient
  mcpHub: McpHub | null
  git: GitCache
  /** The per-employee git stores behind `git` (null when a git cache was injected). */
  gitStores: EmployeeGit | null
  containers: ContainerRuntime | null
  /** code.run's sandboxes, when containers are enabled and SANDBOX_ENABLED. */
  sandbox: Sandbox | null
  secrets: SecretStore
  records: Records
  docs: Docs
  directory: Directory
  memory: MemoryService
  skills: SkillsService
  files: FilesService
  /** Ingesting enqueues the event for routing. */
  events: Events
  /** The same, without enqueueing (for direct deliveries). */
  rawEvents: Events
  sessions: Sessions
  checklists: Checklists
  chat: Chat
  /** Chat image attachments, on the files volume (src/attachments.ts). */
  attachments: ChatAttachments
  /** Whether the model can see images (MODEL_VISION), and the image limits. */
  vision: VisionSettings
  /** Saved image descriptions (IMAGE_DESCRIBE, src/image-descriptions.ts). */
  describer: ImageDescriber
  tools: ToolRegistry
  usage: UsageService
  /** The pricing the ledger uses: Settings → Pricing, `PRICING`, the built-in table (src/limits.ts). */
  pricing: PricingStore
  settings: Settings
  control: Control
  router: Router
  runner: Runner
  /** The stdlib module, when it is available and enabled. */
  stdlib: StdlibModule | null
  /** Procedure contexts: build, check, rebuild and start (from the stdlib; null without it). */
  procedureContexts: ProcedureContexts | null
  /** Tool names registered from `MCP_SERVERS` servers. */
  mcpTools: string[]
  /** MCP servers added at runtime (src/mcp-servers), null when the hub can't add servers. */
  mcpServers: McpServers | null
  /** The first-party integrations (Slack, Linear, GitLab), null when none is enabled. */
  integrations: Integrations | null
  /** Postgres pool, when the store is Postgres. */
  pool: pg.Pool | null
  /** The employee's router session, or the default router. */
  routerSessionFor(employeeId?: string): Promise<string | null>
  toolListsFor(employeeId: string): Promise<ToolLists>
  /** Closes adapters (queue, MCP, store), in that order. */
  close(): Promise<void>
}

/** A model client that refuses every call, for deployments without a configured provider. */
function missingModel(): ModelClient {
  return {
    defaultModel: 'none',
    async complete() {
      throw new Error('no model provider configured (set OPENAI_BASE_URL, OPENAI_API_KEY and MODEL)')
    },
  }
}

/** Wires every adapter and service. This is the only place that knows the concrete adapters. */
export async function buildServices(config: Config, o: AppOverrides = {}): Promise<Services> {
  const clock = o.clock ?? systemClock
  const logger = o.logger ?? jsonLogger(config.LOG_LEVEL, { service: 'meatless-proxy' })
  const bus = o.bus ?? createEventBus({ logger, now: () => clock.now() })
  const hooks = createHooks()

  // ── Store ────────────────────────────────────────────────────────────────
  let pool: pg.Pool | null = null
  let store: Store
  if (o.store) store = o.store
  else if (config.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 })
    pool.on('error', (err) => logger.error('postgres pool error', { err: errorMessage(err) }))
    const schema = config.DATABASE_SCHEMA ?? 'public'
    const { applied } = await runMigrations({ pool, schema, logger })
    if (applied.length) logger.info('migrations applied', { applied })
    store = await postgresStore({ pool, schema, bus, clock, logger })
  } else store = memoryStore({ bus, clock })

  // ── Queue ────────────────────────────────────────────────────────────────
  const baseQueue =
    o.queue ??
    (config.REDIS_URL
      ? bullmqQueue({ connection: config.REDIS_URL, prefix: config.REDIS_PREFIX ?? 'mp', bus, logger })
      : memoryQueue({ bus, logger }))
  const queue = withJobDefaults(baseQueue, {
    [QUEUES.runs]: { attempts: config.RUN_ATTEMPTS, backoffMs: config.RUN_BACKOFF_MS },
    [QUEUES.events]: { attempts: 5, backoffMs: 1000 },
  })

  // ── Model ────────────────────────────────────────────────────────────────
  const model =
    o.model ??
    (config.OPENAI_BASE_URL && config.MODEL
      ? openAiModel({ baseUrl: config.OPENAI_BASE_URL, apiKey: config.OPENAI_API_KEY ?? '', model: config.MODEL, logger, clock })
      : missingModel())

  // ── Secrets ──────────────────────────────────────────────────────────────
  let secretsKey = config.SECRETS_KEY
  if (!secretsKey) {
    secretsKey = randomBytes(24).toString('hex')
    logger.warn('SECRETS_KEY is not set: using an ephemeral key, stored secrets will not survive a restart')
  }
  const secrets = o.secrets ?? storeSecretStore({ store, key: secretsKey, clock })

  // ── Git (one store per employee) and containers ──────────────────────────
  let git: GitCache
  let gitStores: EmployeeGit | null = null
  if (o.git) git = o.git
  else {
    mkdirSync(config.GIT_CACHE_DIR, { recursive: true })
    gitStores = employeeGit({
      root: config.GIT_CACHE_DIR,
      logger: logger.child({ component: 'git' }),
      clock,
    })
    git = gitStores
  }
  const containers =
    o.containers ??
    (config.DOCKER_ENABLED
      ? dockerRuntime({
          ...(config.DOCKER_SOCKET ? { socketPath: config.DOCKER_SOCKET } : {}),
          namePrefix: config.DOCKER_NAME_PREFIX,
          ...selfContainer(config),
          logger,
          clock,
        })
      : null)

  // ── Domain ───────────────────────────────────────────────────────────────
  const records = createRecords({ store, bus })
  const docs = createDocs(records)
  const directory = createDirectory({ records })
  defineSshFields(records)
  defineAuthKinds(records)
  const memory = createMemory({ records, clock })
  const skills = createSkills({ records })
  // Employee files live on disk (the files volume); only sharing grants are records.
  const fileStorage = o.fileStorage ?? directoryStorage({ root: config.FILES_DIR })
  const files = createFiles({ records, storage: fileStorage, bus })
  await migrateFileRecords({ records: store.records, storage: fileStorage, logger: logger.child({ component: 'files' }) })
  // Work from direct messages is private: marked when it happens (src/private-work.ts).
  const privacy = { records, logger: logger.child({ component: 'privacy' }) }
  const rawEvents = privateEvents(createEvents({ records, clock, bus }), privacy)
  const events = enqueueOnIngest(rawEvents, queue, logger)
  const sessions = privateSessions(createSessions({ records, clock, bus }), privacy)
  watchDmLinks(bus, sessions, privacy)
  const checklists = createChecklists({ records, sessions, clock, bus })
  // Chat attachments live on the files volume too, under `attachments/`, apart from employees' files.
  const attachments = createChatAttachments({
    records,
    storage: fileStorage,
    clock,
    logger: logger.child({ component: 'attachments' }),
    limits: { maxBytes: config.CHAT_ATTACHMENT_MAX_BYTES, maxPerMessage: config.CHAT_ATTACHMENTS_PER_MESSAGE },
  })
  // Set once vision is known (below); `upload` mode queues a describe job per posted image.
  let describer: ImageDescriber | null = null
  const chat = createChat({
    records,
    events,
    clock,
    bus,
    attachments,
    onAttachments: enqueueDescriptions(queue, () => describer, logger),
    async resolveName(name) {
      const emp = await directory.employees.byHandle(name)
      if (emp) return { type: 'employee', employeeId: emp.id, contactId: emp.data.contactId }
      const c = await directory.contacts.byHandle('mp', name)
      if (c) return c.data.kind === 'ai' ? null : { type: 'person', contactId: c.id }
      return null
    },
    resolveSessionSlug: async (employeeId, slug) => (await sessions.bySlug(employeeId, slug))?.id ?? null,
  })
  const tools = createToolRegistry()
  const sandbox =
    containers && config.SANDBOX_ENABLED
      ? createSandbox({
          runtime: containers,
          files,
          image: config.SANDBOX_IMAGE,
          clock,
          logger: logger.child({ component: 'sandbox' }),
          ...(config.FILES_VOLUME ? { filesVolume: config.FILES_VOLUME } : {}),
          user: config.SANDBOX_USER,
          limits: { cpus: config.SANDBOX_CPUS, memoryMb: config.SANDBOX_MEMORY_MB, pids: config.SANDBOX_PIDS },
          // No project: the employee's own list, its direct network, or DEFAULT_EGRESS.
          egress: async (id) => {
            const emp = await directory.employees.get(id)
            const net = networkFor({
              network: emp?.data.network,
              fallback: config.DEFAULT_EGRESS,
              direct: config.DOCKER_DIRECT_NETWORK,
            })
            return net.direct ? { direct: directNetworkName(emp?.key ?? id) } : net.allow
          },
          idleMs: config.SANDBOX_IDLE_MINUTES * 60_000,
          nameFor: async (id) => (await directory.employees.get(id))?.key ?? id,
          namePrefix: config.DOCKER_NAME_PREFIX,
        })
      : null
  const settings = createSettings(records)
  // Pricing and deployment limit defaults that work without configuration (src/limits.ts).
  const pricing = new PricingStore({ settings, env: config.PRICING, logger, now: () => clock.now() })
  await pricing.load()
  const usage = createUsage({ records, clock, bus, pricing: () => pricing.current(), defaults: limitDefaults(config) })

  const employeeCache = new Map<string, { at: number; employee: Employee | null }>()
  const employee = async (id: string) => {
    const hit = employeeCache.get(id)
    if (hit && clock.now() - hit.at < 1000) return hit.employee
    const e = await directory.employees.get(id)
    employeeCache.set(id, { at: clock.now(), employee: e })
    return e
  }

  // An edited employee (a new router context, say) is read fresh, not from the cache.
  bus.subscribe<{ kind: string; id: string }>('record.changed', (m) => {
    if (m.payload.kind === 'employee') employeeCache.delete(m.payload.id)
  })

  const routerSessionFor = async (employeeId?: string): Promise<string | null> => {
    if (employeeId) {
      const e = await employee(employeeId)
      if (e?.data.routerSessionId) return e.data.routerSessionId
      // A known employee without a router context yet: its work never goes to another employee's router.
      if (e) return null
    }
    const def = await settings.get<string>(SettingNames.defaultRouter)
    return typeof def === 'string' ? def : null
  }

  const baseToolLists = async (employeeId: string): Promise<ToolLists> => {
    const e = await employee(employeeId)
    return { allow: e?.data.toolAllow ?? [], deny: e?.data.toolDeny ?? [] }
  }
  // Another employee's MCP servers' tools are denied (src/mcp-servers).
  let mcpServers: McpServers | null = null
  // Set once the integrations exist (below); until then no integration tools are hidden.
  let integrationsForTools: Integrations | null = null
  const toolListsFor = async (employeeId: string): Promise<ToolLists> => {
    const lists = await baseToolLists(employeeId)
    const hidden = mcpServers?.hiddenFor(employeeId) ?? []
    return hidden.length ? { ...lists, deny: [...lists.deny, ...hidden] } : lists
  }
  /**
   * What the runner offers the model, at each call: the lists above, minus the tools of integrations
   * the employee has no token for (they can only fail). Not used for toolsets fixed at creation, so a
   * token set later brings the tools back without a new session.
   * An integration's hiding pattern is `mcp.<name>.*`; a config MCP server with that name owns the
   * namespace instead (its tools replaced the integration's at registration), so it isn't hidden.
   */
  const integrationPattern = /^mcp\.([^.]+)\.\*$/
  const configServerNames = new Set(config.MCP_SERVERS.map((s) => s.name))
  const offeredToolListsFor = async (employeeId: string): Promise<ToolLists> => {
    const lists = await toolListsFor(employeeId)
    const hidden = ((await integrationsForTools?.hiddenToolsFor(employeeId).catch(() => [])) ?? []).filter((p) => {
      const m = integrationPattern.exec(p)
      return !m || !configServerNames.has(m[1]!)
    })
    return hidden.length ? { ...lists, deny: [...lists.deny, ...hidden] } : lists
  }

  const projectOf = async (session: Session): Promise<string | undefined> => {
    const linked = await records.linked({ kind: 'session', id: session.id }, { kind: 'project' })
    return linked[0]?.record.id
  }

  // Chat channel members receive the channel's messages like a subscription (docs/spec.md#creating-channels).
  const channelMembers: RecipientResolver = async (event) => {
    if (event.data.source !== 'chat') return []
    const channelId = (event.data.payload as { channelId?: unknown } | undefined)?.channelId
    if (typeof channelId !== 'string') return []
    const members = await chat.members(channelId)
    return members
      .filter((m) => m.kind === 'session')
      .map((m) => ({ sessionId: m.id, reason: 'member' as const, expectedToAct: false, trusted: true, fork: false }))
  }

  const router = createRouter({
    events: rawEvents,
    sessions,
    queue,
    hooks,
    bus,
    logger: logger.child({ component: 'router' }),
    routerSessionFor,
    procedureContext: async (procedureId) => (await directory.procedures.get(procedureId))?.data.contextSessionId ?? null,
    resolvers: [channelMembers],
    // Chat events show the saved descriptions of their images (made after the event was stored).
    prepareEvent: describedEvent(attachments),
    // Employees in a chat thread (their sessions posted in it, or it tagged them, e.g. an alert) hear a person's
    // untagged follow-up there.
    participantsOf: async (event) => {
      const p = event.data.payload as { threadId?: unknown; messageId?: unknown } | undefined
      if (event.data.source !== 'chat' || event.data.type !== 'message.replied' || typeof p?.threadId !== 'string') return []
      const employees = new Set<string>()
      for (const m of await chat.thread(p.threadId)) {
        if (m.id === p.messageId) continue
        for (const tag of m.data.tags) if (tag.type === 'employee' || tag.type === 'session') employees.add(tag.employeeId)
        if (m.data.author.kind !== 'session') continue
        const employeeId = (await sessions.get(m.data.author.id))?.data.employeeId
        if (employeeId) employees.add(employeeId)
      }
      return [...employees]
    },
    isHuman: async (event) => {
      const id = event.data.actorContactId
      if (!id) return false
      return (await directory.contacts.get(id))?.data.kind === 'person'
    },
  })

  // A session's own untagged chat messages are nobody else's business: they don't fall back to the router.
  hooks.on(beforeDeliver, ({ event, delivery }) => {
    if (delivery.reason !== 'fallback' || event.data.source !== 'chat') return undefined
    const author = (event.data.payload as { author?: { kind?: string } } | undefined)?.author
    return author?.kind === 'session' ? { skip: 'a session message nobody subscribed to' } : undefined
  })

  const vision = await resolveVision(config, model, logger)
  describer = buildDescriber({
    records,
    attachments,
    model,
    sessions,
    usage,
    clock,
    bus,
    logger: logger.child({ component: 'describe' }),
    mode: config.IMAGE_DESCRIBE,
    modelName: config.IMAGE_DESCRIBE_MODEL,
    vision,
  })
  const runner = createRunner({
    sessions,
    tools,
    model,
    vision: vision.enabled,
    loadImage: imageLoader({ attachments, storage: fileStorage, maxSide: vision.maxSide, maxBytes: vision.maxBytes }),
    queue,
    hooks,
    secrets,
    bus,
    clock,
    logger: logger.child({ component: 'runner' }),
    toolListsFor: offeredToolListsFor,
    projectOf,
    maxSteps: config.MAX_STEPS,
    limitsFor: runLimitsFor(usage),
    ...(config.MAX_TOKENS ? { maxTokens: config.MAX_TOKENS } : {}),
  })

  const control = createControl({
    settings,
    sessions,
    hooks,
    bus,
    clock,
    logger,
    enqueueRun: (runId, priority) => runner.enqueue(runId, priority !== undefined ? { priority } : {}),
  })

  // ── MCP hub: MCP_SERVERS, and servers added at runtime (src/mcp-servers) ──
  let mcpHub: McpHub | null = o.mcpHub ?? null
  if (!mcpHub) {
    mcpHub = createMcpHub({
      servers: config.MCP_SERVERS.map((s) => ({
        name: s.name,
        transport: s.transport,
        ...(s.command ? { command: s.command } : {}),
        ...(s.args ? { args: s.args } : {}),
        ...(s.url ? { url: s.url } : {}),
        ...(s.env ? { env: s.env } : {}),
        ...(s.secrets ? { secrets: s.secrets } : {}),
      })),
      resolveSecrets: (names, server) =>
        mcpServers?.isRuntime(server.name) ? mcpServers.resolveSecrets(names, server) : secrets.resolve(names, {}),
      authProviderFor: (server) => mcpServers?.authProviderFor(server),
      logger: logger.child({ component: 'mcp' }),
      clock,
      clientInfo: { name: 'meatless-proxy', version: '0.0.0' },
    })
  }

  const services: Services = {
    config,
    clock,
    logger,
    bus,
    hooks,
    store,
    queue,
    model,
    mcpHub,
    git,
    gitStores,
    containers,
    sandbox,
    secrets,
    records,
    docs,
    directory,
    memory,
    skills,
    files,
    events,
    rawEvents,
    sessions,
    checklists,
    chat,
    attachments,
    vision,
    describer,
    tools,
    usage,
    pricing,
    settings,
    control,
    router,
    runner,
    stdlib: null,
    procedureContexts: null,
    mcpTools: [],
    mcpServers: null,
    integrations: null,
    pool,
    routerSessionFor,
    toolListsFor,
    async close() {
      await queue.close().catch((e) => logger.warn('queue close failed', { err: errorMessage(e) }))
      await sandbox?.close().catch((e) => logger.warn('sandbox close failed', { err: errorMessage(e) }))
      await services.integrations?.close().catch((e) => logger.warn('integrations close failed', { err: errorMessage(e) }))
      await mcpServers?.close().catch((e) => logger.warn('mcp servers close failed', { err: errorMessage(e) }))
      await mcpHub?.close().catch((e) => logger.warn('mcp close failed', { err: errorMessage(e) }))
      await bus.idle().catch(() => {})
      gitStores?.close()
      if (!o.store) await store.close().catch((e) => logger.warn('store close failed', { err: errorMessage(e) }))
      if (pool) await pool.end().catch(() => {})
    },
  }

  // ── Standard library and policies ────────────────────────────────────────
  const stdlib = o.stdlib === false ? null : await loadStdlib()
  if (stdlib) {
    mkdirSync(config.WORKTREES_DIR, { recursive: true })
    const deps = {
      records,
      docs,
      sessions,
      events,
      chat,
      directory,
      memory,
      skills,
      files,
      checklists,
      usage,
      attachments,
      vision: { enabled: vision.enabled, maxSide: vision.maxSide, maxBytes: vision.maxBytes },
      describer,
      git,
      ...(containers ? { containers } : {}),
      // Work a router context starts gets the employee's full toolset, not the router's routing-only one.
      toolsetFor: async (employeeId: string) => tools.allowed(await toolListsFor(employeeId)).map((t) => t.name),
      ...(sandbox ? { sandbox } : {}),
      sshKeyFor: async (employeeId: string) => (await sshPrivateKey({ secrets }, employeeId)) ?? undefined,
      defaultTimezone: async () => (await settings.get<string>(SettingNames.timezone)) || DEFAULT_SETTINGS.timezone,
      enqueueRun: (runId: string, opts?: { priority?: number }) => runner.enqueue(runId, opts ?? {}),
      wakeRun: (runId: string) => runner.wake(runId),
      clock,
      logger: logger.child({ component: 'stdlib' }),
      bus,
      config: {
        worktreesRoot: config.WORKTREES_DIR,
        pushPolicy: { protected: ['main', 'master', 'production', 'release/**'], allow: ['mp/**'] },
        defaultEgress: config.DEFAULT_EGRESS,
        directNetwork: config.DOCKER_DIRECT_NETWORK,
      },
    }
    const names = stdlib.registerStdlib(tools, deps)
    stdlib.registerPolicies(hooks, deps)
    stdlib.registerUsagePolicies(hooks, deps)
    stdlib.registerRouterPolicies(hooks, deps)
    services.stdlib = stdlib
    services.procedureContexts = stdlib.createProcedureContexts(tools, deps)
    logger.debug('stdlib registered', { tools: names.length })
  } else {
    // Without the stdlib's usage policy, still keep the ledger.
    hooks.on(afterModelCall, async ({ run, session, response, model: modelName }) => {
      const u = response.usage ?? emptyUsage()
      await usage.record({
        runId: run.id,
        sessionId: session.id,
        rootSessionId: session.data.rootId,
        employeeId: session.data.employeeId,
        ...(run.data.requesterId ? { requesterId: run.data.requesterId } : {}),
        model: modelName,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        cachedTokens: u.cachedTokens,
        reasoningTokens: u.reasoningTokens,
        totalTokens: u.totalTokens,
      })
      return undefined
    })
  }

  // ── First-party integrations (src/integrations) ──────────────────────────
  if (config.INTEGRATIONS.length) {
    const baseUrls = { ...(config.GITLAB_BASE_URL ? { gitlab: config.GITLAB_BASE_URL } : {}), ...o.integrations?.baseUrls }
    services.integrations = await createIntegrations(
      { tools, hooks, bus, secrets, events, sessions, directory, records, clock, logger },
      { enabled: config.INTEGRATIONS, ...o.integrations, baseUrls },
    )
    integrationsForTools = services.integrations
  }

  // ── MCP tools and notifications ──────────────────────────────────────────
  if (mcpHub) {
    const byName = new Map(config.MCP_SERVERS.map((s) => [s.name, s]))
    wireMcpNotifications({
      hub: mcpHub,
      events,
      directory,
      servers: config.MCP_SERVERS,
      logger: logger.child({ component: 'mcp' }),
      runtime: (hubName) => {
        const r = mcpServers?.recordOf(hubName)
        return r
          ? {
              name: r.data.name,
              ...(r.data.events ? { events: r.data.events } : {}),
              ...(r.data.employeeId ? { employeeId: r.data.employeeId } : {}),
            }
          : undefined
      },
    })
    if ('start' in mcpHub && typeof (mcpHub as { start?: unknown }).start === 'function') {
      const results = await (mcpHub as { start(): Promise<{ server: string; ok: boolean; error?: string }[]> }).start()
      for (const r of results) if (!r.ok) logger.warn('mcp server did not connect', { server: r.server, error: r.error })
    }
    for (const server of mcpHub.servers()) {
      try {
        const names = await registerMcpTools(tools, mcpHub, {
          server,
          effectOf: (s, tool) => byName.get(s)?.effects?.[tool] ?? byName.get(s)?.effect ?? 'non_idempotent',
        })
        services.mcpTools.push(...names)
      } catch (err) {
        logger.warn('mcp tools could not be listed', { server, err: errorMessage(err) })
      }
    }
  }
  if (isManagedHub(mcpHub)) {
    const hub = mcpHub
    mcpServers = new McpServers({
      records,
      secrets,
      tools,
      hub,
      directory,
      sessions,
      bus,
      clock,
      logger,
      configServers: config.MCP_SERVERS,
      configStatus: (name) => (hub.servers().includes(name) ? hub.status(name) : null),
      configTools: () => services.mcpTools,
      reservedNames: () => Object.keys(services.integrations?.specs ?? {}),
      baseToolLists,
      ...(config.PUBLIC_URL ? { publicUrl: config.PUBLIC_URL } : {}),
    })
    services.mcpServers = mcpServers
    // Connects in the background: a slow server doesn't hold up the start (await `mcpServers.start()` to wait).
    mcpServers.start().catch((err) => logger.error('mcp servers could not be loaded', { err: errorMessage(err) }))
  }

  // Every employee gets its own SSH keypair when it is created, however it is created.
  bus.subscribe<{ kind: string; id: string; op: string }>('record.changed', async (m) => {
    if (m.payload.kind !== 'employee' || m.payload.op !== 'create') return
    await ensureSshKey(services, m.payload.id).catch((err) =>
      logger.error('could not create the ssh keypair', { employeeId: m.payload.id, err: errorMessage(err) }),
    )
  })

  await o.setup?.(services)
  return services
}
