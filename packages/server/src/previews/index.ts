import type { AddressInfo } from 'node:net'
import type { IncomingMessage, Server } from 'node:http'
import type { PreviewToken, SessionPreview } from '@mp/api'
import { NotFoundError, UnavailableError, errorMessage, type Json } from '@mp/core'
import type { Session } from '@mp/sessions'
import { Hono } from 'hono'
import { principalOf } from '../auth/guard.ts'
import { BadRequestError, jsonBody, requireString } from '../http/util.ts'
import type { Services } from '../services.ts'
import { previewMode, previewOrigin, refusePreviewOrigins, splitHost, type PreviewMode } from './origins.ts'
import { PREVIEW_AUTH_PATH, createPreviewProxy } from './proxy.ts'
import { PreviewSigner } from './tokens.ts'

export { PREVIEW_AUTH_PATH, PREVIEW_COOKIE, allowedSetCookie, frameAncestors, previewRequestCookies } from './proxy.ts'
export * from './origins.ts'
export * from './tokens.ts'

interface EnvMeta {
  id: string
  name?: string
  expose?: number[]
}
interface WorktreeMeta {
  key?: string
  path?: string
}

const envOf = (s: Session): EnvMeta | null => {
  const e = s.data.meta?.env as unknown as EnvMeta | undefined
  return e && typeof e === 'object' && typeof e.id === 'string' ? e : null
}
const exposedOf = (e: EnvMeta | null) => (Array.isArray(e?.expose) ? e.expose.filter((p) => Number.isInteger(p)) : [])
const worktreesOf = (s: Session): WorktreeMeta[] =>
  Array.isArray(s.data.meta?.worktrees) ? (s.data.meta.worktrees as unknown as WorktreeMeta[]) : []

export interface PreviewsOptions {
  /** The port the harness itself listens on (for the harness origin in port mode without `PUBLIC_URL`). */
  harnessPort: () => number | null
}

export interface Previews {
  mode: PreviewMode
  signer: PreviewSigner
  /** Mount first on the harness app: refuses requests whose Host or Origin is a preview origin. */
  refuse: ReturnType<typeof refusePreviewOrigins>
  /** `POST /api/previews/token` and `GET /api/sessions/:id/preview`. */
  routes: Hono
  /** Whether previews can be served: a runtime with `previewTarget`, and a place to serve them. */
  enabled: boolean
  /** Starts the preview listener (when enabled). Resolves with its port, or null. */
  listen(host: string, port?: number): Promise<number | null>
  /** The listener's bound port, when listening. */
  port(): number | null
  close(): Promise<void>
}

/**
 * Live previews (docs/spec.md "Live previews"): tokens for signed-in viewers, the preview listener
 * that proxies an environment's exposed ports on an origin of its own, and a tracker that tells the
 * UI when the commit an environment runs changes (the `preview.commit` live event).
 */
export function createPreviews(s: Services, opts: PreviewsOptions): Previews {
  const config = s.config
  const mode = previewMode(config)
  const signer = new PreviewSigner({
    ...(config.SECRETS_KEY ? { secretsKey: config.SECRETS_KEY } : {}),
    now: () => s.clock.now(),
  })
  const log = s.logger.child({ component: 'previews' })
  const runtime = s.containers
  let server: Server | null = null
  let proxyClose: (() => void) | null = null
  let boundPort: number | null = null

  const reasonOff = !runtime?.previewTarget
    ? 'the container runtime has no previews'
    : mode.kind === 'port' && !mode.port
      ? 'PREVIEW_PORT is 0'
      : mode.kind === 'domain' && !config.PUBLIC_URL
        ? 'PREVIEW_DOMAIN needs PUBLIC_URL (the harness origin allowed to frame previews)'
        : null
  const enabled = reasonOff === null

  /** The harness origin allowed to frame previews. */
  const harnessOrigin = (previewHost: string): string | null => {
    if (config.PUBLIC_URL) return new URL(config.PUBLIC_URL).origin
    if (mode.kind === 'domain') return null
    const port = opts.harnessPort() ?? config.PORT
    return `http://${splitHost(previewHost).name}:${port}`
  }

  const secure = (req: IncomingMessage) => {
    if (config.COOKIE_SECURE === 'true') return true
    if (config.COOKIE_SECURE === 'false') return false
    if (mode.kind === 'domain') return mode.scheme === 'https'
    if (config.PUBLIC_URL) return config.PUBLIC_URL.startsWith('https:')
    return config.TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https'
  }

  // ── Routes on the harness ────────────────────────────────────────────────
  const routes = new Hono()

  routes.get('/api/sessions/:id/preview', async (c) => {
    const session = await s.sessions.require(c.req.param('id'))
    const env = envOf(session)
    if (!env)
      return c.json({ sessionId: session.id, envId: null, status: 'none', ports: [], commit: null } satisfies SessionPreview)
    const info = runtime ? await runtime.getEnv(env.id).catch(() => null) : null
    const status: SessionPreview['status'] = info ? info.status : 'missing'
    return c.json({
      sessionId: session.id,
      envId: env.id,
      status,
      ports: info ? exposedOf(env) : [],
      commit: info ? await commitOf(session) : null,
    } satisfies SessionPreview)
  })

  routes.post('/api/previews/token', async (c) => {
    const me = principalOf(c)
    const body = await jsonBody<{ envId?: unknown; port?: unknown }>(c)
    const envId = requireString(body.envId, 'envId')
    const port = Number(body.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BadRequestError('port must be a port number')
    if (!enabled) throw new UnavailableError(`live previews are off: ${reasonOff}`)
    // The environment must exist, belong to a session, and that session must still run it with this port.
    const info = await runtime!.getEnv(envId)
    if (!info) throw new NotFoundError('environment', envId)
    const sessionId = info.labels['mp.session']
    const session = sessionId ? await s.sessions.get(sessionId) : null
    const env = session ? envOf(session) : null
    if (!session || env?.id !== envId) throw new NotFoundError('environment', envId)
    if (!exposedOf(env).includes(port)) throw new NotFoundError('exposed port', `${envId}:${port}`)
    const { token, expiresAt } = signer.token({ envId, port, contactId: me.contactId })
    const host = c.req.header('host') ?? new URL(c.req.url).host
    const origin = previewOrigin(config, { envId, port }, host, boundPort ?? config.PREVIEW_PORT)
    log.info('preview token issued', { envId, port, contactId: me.contactId })
    return c.json({
      envId,
      port,
      token,
      origin,
      url: `${origin}${PREVIEW_AUTH_PATH}?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    } satisfies PreviewToken)
  })

  // ── The commit an environment runs ───────────────────────────────────────
  /** The newest commit of the session's first checkout. */
  async function commitOf(session: Session): Promise<SessionPreview['commit']> {
    const w = worktreesOf(session).find((x) => typeof x.path === 'string')
    if (!w?.path) return null
    try {
      const [head] = await s.git.log(w.path, 1)
      return head ? { sha: head.sha, subject: head.subject, ...(w.key ? { repo: w.key } : {}) } : null
    } catch {
      return null
    }
  }

  const lastCommit = new Map<string, string>()
  const checkCommit = async (sessionId: string) => {
    const session = await s.sessions.get(sessionId)
    const env = session ? envOf(session) : null
    if (!session || !env || !exposedOf(env).length) return
    const commit = await commitOf(session)
    if (!commit || lastCommit.get(sessionId) === commit.sha) return
    lastCommit.set(sessionId, commit.sha)
    s.bus.publish('preview.commit', { sessionId, envId: env.id, ...commit } as unknown as Json)
  }
  const watch = (sessionId: unknown) => {
    if (typeof sessionId !== 'string') return
    checkCommit(sessionId).catch((e) => log.debug('preview commit check failed', { sessionId, err: errorMessage(e) }))
  }
  // Commits come from git tools, and from the commit-on-stop policy when a run ends.
  const offs = [
    s.bus.subscribe<{ sessionId?: string; name?: string; isError?: boolean }>('tool.result', (m) => {
      if (!m.payload.isError && /^git\.(commit|checkout)$/.test(m.payload.name ?? '')) watch(m.payload.sessionId)
    }),
    s.bus.subscribe<{ sessionId?: string; to?: string }>('run.state', (m) => {
      if (['completed', 'failed', 'cancelled', 'suspended'].includes(m.payload.to ?? '')) watch(m.payload.sessionId)
    }),
  ]

  return {
    mode,
    signer,
    refuse: refusePreviewOrigins(config),
    routes,
    enabled,
    port: () => boundPort,
    async listen(host, port) {
      if (!enabled) {
        if (runtime) log.warn('live previews are off', { reason: reasonOff })
        return null
      }
      const p = createPreviewProxy({
        mode,
        signer,
        containers: runtime!,
        directory: s.directory,
        logger: log,
        now: () => s.clock.now(),
        harnessOrigin,
        secure,
        trustProxy: config.TRUST_PROXY,
      })
      server = p.server
      proxyClose = p.close
      await new Promise<void>((resolve, reject) => {
        p.server.once('error', reject)
        p.server.listen(port ?? config.PREVIEW_PORT, host, () => resolve())
      })
      boundPort = (p.server.address() as AddressInfo).port
      log.info('preview listener', { host, port: boundPort, mode: mode.kind })
      return boundPort
    },
    async close() {
      for (const off of offs) off()
      proxyClose?.()
      if (server) {
        const srv = server
        await new Promise<void>((resolve) => {
          srv.close(() => resolve())
          srv.closeAllConnections()
        })
      }
      server = null
    },
  }
}
