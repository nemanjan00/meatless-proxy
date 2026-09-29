import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { serve, type ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { errorMessage } from '@mp/core'
import { pendingMigrations } from '@mp/store-postgres'
import { Hono } from 'hono'
import { bootstrap, isEmpty, migrateEmployees } from './bootstrap.ts'
import { addStdlibToolsToRouters } from './router-tools.ts'
import type { Config } from './config.ts'
import { createAuth, ensureAdmin, principalOf } from './auth/index.ts'
import { apiRoutes } from './http/api.ts'
import { chatAttachmentRoutes } from './http/chat-attachments.ts'
import { Metrics, metricsRoutes } from './http/metrics.ts'
import { defaultWebDist, serveWeb } from './http/static.ts'
import { webhookRoutes } from './http/webhooks.ts'
import { mcpServerRoutes } from './http/mcp-servers.ts'
import { limitRoutes } from './http/limits.ts'
import { sendError } from './http/util.ts'
import { LiveHub, NowTracker } from './live.ts'
import { ChatActivity, chatActivityRoutes } from './chat-activity.ts'
import { notificationPrefsRoutes } from './notification-prefs.ts'
import { HarnessMcpServer } from './mcp-server.ts'
import { gitlabHookProvisioning, type HookProvisioning, integrationStatusRoutes } from './integrations/index.ts'
import { createPreviews, type Previews } from './previews/index.ts'
import { procedureRoutes } from './procedures/index.ts'
import { projectRoutes } from './projects/index.ts'
import { registerSessionMemory } from './session-memory.ts'
import { registerThreadContext } from './thread-context.ts'
import { backfillPrivateWork, upgradeEmployees, watchEmployeePrompts } from './upgrade.ts'
import { registerSessionProjects } from './session-projects.ts'
import { createSetup, type Setup, setupRoutes } from './setup/index.ts'
import { ensureSshKey } from './ssh.ts'
import { buildServices, type AppOverrides, type Services } from './services.ts'
import { recoverQueues, startWorkers, type Workers } from './workers.ts'

export const VERSION = '0.0.0'

export interface StartOptions {
  /** Listen for HTTP (default true). Without it only the workers run, e.g. for `app.request()` tests. */
  http?: boolean
  /** Override the configured port (0 picks a free one). */
  port?: number
  /** Start queue workers (default true). */
  workers?: boolean
  /** Override the preview listener's port (0 picks a free one). It listens only when previews are enabled. */
  previewPort?: number
}

export interface App {
  /** The hono app: HTTP API, `/ws`, `/mcp` and the web UI. */
  app: Hono
  services: Services
  live: LiveHub
  /** Who is working on each chat thread (src/chat-activity.ts). */
  activity: ChatActivity
  mcp: HarnessMcpServer
  /** Live previews: tokens, the preview listener, and the harness's refusal of preview origins. */
  previews: Previews
  /** GitLab webhook self-provisioning (src/integrations/provisioning.ts), null when GitLab is disabled. It starts with the workers. */
  hookProvisioning: HookProvisioning | null
  /** Guided integration setup (src/setup): cached checks and webhook activity. */
  setup: Setup
  /** Starts workers, rebuilds the queues from the database, and listens. Resolves with the bound ports. */
  start(opts?: StartOptions): Promise<{ port: number | null; previewPort?: number | null }>
  /** Graceful shutdown: stop taking jobs, let running jobs reach a boundary, close queue, MCP and store. */
  stop(opts?: { timeoutMs?: number }): Promise<void>
}

/** The composition root: wires every adapter and service and builds the HTTP app. */
export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  const services = await buildServices(config, overrides)
  const log = services.logger
  registerSessionMemory(services)
  registerThreadContext(services)
  registerSessionProjects(services)
  if (config.MP_BOOTSTRAP && (await isEmpty(services))) {
    const r = await bootstrap(services)
    log.info('bootstrap done', { employeeId: r.employeeId, routerSessionId: r.routerSessionId })
  }
  // An admin to sign in as, and a one-time link to do it while no admin has signed in yet.
  if (config.MP_BOOTSTRAP) await ensureAdmin(services)
  // Employees created before keypairs existed (or while a key write failed) get one now.
  for (const e of (await services.directory.employees.list()).items) await ensureSshKey(services, e.id)
  // Employees from older versions: the old default personality, projects in `scope` instead of links.
  await migrateEmployees(services)
  // Then provisioning they may have missed (router instructions, routing toolset, trigger shape), and a router
  // context rebuilt with the current employee prompt when it changed.
  await upgradeEmployees(services)
  // Work from DMs handled before sessions were marked private gets its mark once.
  await backfillPrivateWork(services)
  // An edited employee (personality, instructions, name, role) gets a router context with its current prompt.
  watchEmployeePrompts(services)
  // Router contexts created before a stdlib tool existed (time.now, code.run) get it now.
  await addStdlibToolsToRouters(services)
  const hookProvisioning = gitlabHookProvisioning(services, overrides.integrations)
  // Guided integration setup and new employees (src/setup): the employee page.
  const setup = createSetup(services, { integrations: overrides.integrations, provisioning: () => hookProvisioning })

  const tracker = new NowTracker(services)
  // Who is working on each chat thread (src/chat-activity.ts), before the live hub that forwards it.
  const activity = new ChatActivity(services)
  const live = new LiveHub(services)
  const mcp = new HarnessMcpServer(services)
  let boundPort: number | null = null
  const previews = createPreviews(services, { harnessPort: () => boundPort })

  const app = new Hono()
  app.onError((err, c) => sendError(c, err, log))
  app.notFound((c) => c.json({ error: { code: 'not_found', message: `no route ${c.req.method} ${c.req.path}` } }, 404))
  // Metrics count every request; then security headers and the sign-in guard (src/auth/guard.ts).
  const metrics = new Metrics(services)
  const auth = createAuth(services, overrides.auth)
  // Nothing of the harness answers on, or to, a preview origin (src/previews).
  app.use('*', metrics.middleware(), previews.refuse, ...auth.middleware)

  const ws = createNodeWebSocket({ app })
  app.get(
    '/ws',
    ws.upgradeWebSocket((c) => {
      const p = principalOf(c)
      const viewer = { contactId: p.contactId, admin: p.access === 'admin' }
      let conn: ReturnType<LiveHub['connect']> | null = null
      return {
        onOpen: (_evt, socket) => {
          conn = live.connect(socket, viewer)
        },
        onMessage: (evt) => conn?.message(typeof evt.data === 'string' ? evt.data : String(evt.data)),
        onClose: () => conn?.close(),
        onError: () => conn?.close(),
      }
    }),
  )
  app.all('/mcp', (c) => mcp.handle(c.req.raw))

  const migrationsReady = async () => {
    if (!services.pool) return true
    return (await pendingMigrations({ pool: services.pool, schema: config.DATABASE_SCHEMA ?? 'public' })).length === 0
  }
  app.route('/', setupRoutes(services, setup)) // before the webhooks: it records their activity
  app.route('/', webhookRoutes(services))
  app.route('/', auth.routes)
  app.route('/', metricsRoutes(services, metrics))
  app.route('/', previews.routes)
  app.route(
    '/',
    integrationStatusRoutes(services, () => hookProvisioning),
  )
  app.route('/', mcpServerRoutes(services))
  app.route('/', projectRoutes(services))
  app.route('/', procedureRoutes(services))
  app.route('/', notificationPrefsRoutes(services))
  app.route('/', limitRoutes(services)) // Settings → Limits and Pricing (src/http/limits.ts)
  app.route('/', chatAttachmentRoutes(services, auth.visibility))
  app.route('/', chatActivityRoutes(activity, auth.visibility))
  app.route('/', apiRoutes({ services, tracker, version: VERSION, migrationsReady, visibility: auth.visibility }))
  const webDir = config.MP_WEB_DIST ?? defaultWebDist()
  if (serveWeb(app, webDir)) log.info('serving the web UI', { dir: webDir })

  let server: ServerType | null = null
  let workers: Workers | null = null
  let stopping: Promise<void> | null = null

  return {
    app,
    services,
    live,
    activity,
    mcp,
    previews,
    hookProvisioning,
    setup,
    async start(opts = {}) {
      if (opts.workers !== false) {
        workers = startWorkers(services)
        const recovered = await recoverQueues(services)
        if (recovered.events || recovered.runs || recovered.timers) log.info('queues rebuilt from the database', recovered)
        hookProvisioning?.start()
      }
      if (opts.http === false) return { port: null }
      const port = opts.port ?? config.PORT
      const started = await new Promise<ServerType>((resolve, reject) => {
        const srv = serve({ fetch: app.fetch, port, hostname: config.HOST }, () => resolve(srv))
        srv.once('error', reject)
      })
      server = started
      ws.injectWebSocket(started as Server)
      const addr = started.address() as AddressInfo | null
      const bound = addr?.port ?? port
      boundPort = bound
      log.info('listening', { host: config.HOST, port: bound })
      const previewPort = await previews.listen(config.HOST, opts.previewPort)
      return { port: bound, previewPort }
    },
    stop(opts = {}) {
      stopping ??= (async () => {
        log.info('shutting down')
        live.close()
        metrics.close()
        await mcp.close()
        tracker.close()
        activity.close()
        const closing = server
          ? new Promise<void>((resolve) => {
              server!.close(() => resolve())
              ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
            })
          : Promise.resolve()
        ws.wss.close()
        await previews.close().catch((err) => log.warn('preview listener close failed', { err: errorMessage(err) }))
        await workers?.stop(opts.timeoutMs ?? 30_000)
        await hookProvisioning?.close()
        setup.close()
        await setup.activity.idle()
        await closing.catch((err) => log.warn('http close failed', { err: errorMessage(err) }))
        await services.close()
        log.info('stopped')
      })()
      return stopping
    },
  }
}
