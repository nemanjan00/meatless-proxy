import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { serve, type ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { errorMessage } from '@mp/core'
import { pendingMigrations } from '@mp/store-postgres'
import { Hono } from 'hono'
import { bootstrap, isEmpty } from './bootstrap.ts'
import type { Config } from './config.ts'
import { apiRoutes } from './http/api.ts'
import { defaultWebDist, serveWeb } from './http/static.ts'
import { sendError } from './http/util.ts'
import { LiveHub, NowTracker } from './live.ts'
import { HarnessMcpServer } from './mcp-server.ts'
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
}

export interface App {
  /** The hono app: HTTP API, `/ws`, `/mcp` and the web UI. */
  app: Hono
  services: Services
  live: LiveHub
  mcp: HarnessMcpServer
  /** Starts workers, rebuilds the queues from the database, and listens. Resolves with the bound port. */
  start(opts?: StartOptions): Promise<{ port: number | null }>
  /** Graceful shutdown: stop taking jobs, let running jobs reach a boundary, close queue, MCP and store. */
  stop(opts?: { timeoutMs?: number }): Promise<void>
}

/** The composition root: wires every adapter and service and builds the HTTP app. */
export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  const services = await buildServices(config, overrides)
  const log = services.logger
  if (config.MP_BOOTSTRAP && (await isEmpty(services))) {
    const r = await bootstrap(services)
    log.info('bootstrap done', { employeeId: r.employeeId, routerSessionId: r.routerSessionId })
  }
  // Employees created before keypairs existed (or while a key write failed) get one now.
  for (const e of (await services.directory.employees.list()).items) await ensureSshKey(services, e.id)

  const tracker = new NowTracker(services)
  const live = new LiveHub(services)
  const mcp = new HarnessMcpServer(services)

  const app = new Hono()
  app.onError((err, c) => sendError(c, err, log))
  app.notFound((c) => c.json({ error: { code: 'not_found', message: `no route ${c.req.method} ${c.req.path}` } }, 404))

  const ws = createNodeWebSocket({ app })
  app.get(
    '/ws',
    ws.upgradeWebSocket(() => {
      let conn: ReturnType<LiveHub['connect']> | null = null
      return {
        onOpen: (_evt, socket) => {
          conn = live.connect(socket)
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
  app.route('/', apiRoutes({ services, tracker, version: VERSION, migrationsReady }))
  const webDir = config.MP_WEB_DIST ?? defaultWebDist()
  if (serveWeb(app, webDir)) log.info('serving the web UI', { dir: webDir })

  let server: ServerType | null = null
  let workers: Workers | null = null
  let stopping: Promise<void> | null = null

  return {
    app,
    services,
    live,
    mcp,
    async start(opts = {}) {
      if (opts.workers !== false) {
        workers = startWorkers(services)
        const recovered = await recoverQueues(services)
        if (recovered.events || recovered.runs || recovered.timers) log.info('queues rebuilt from the database', recovered)
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
      log.info('listening', { host: config.HOST, port: bound })
      return { port: bound }
    },
    stop(opts = {}) {
      stopping ??= (async () => {
        log.info('shutting down')
        live.close()
        await mcp.close()
        tracker.close()
        const closing = server
          ? new Promise<void>((resolve) => {
              server!.close(() => resolve())
              ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
            })
          : Promise.resolve()
        ws.wss.close()
        await workers?.stop(opts.timeoutMs ?? 30_000)
        await closing.catch((err) => log.warn('http close failed', { err: errorMessage(err) }))
        await services.close()
        log.info('stopped')
      })()
      return stopping
    },
  }
}
