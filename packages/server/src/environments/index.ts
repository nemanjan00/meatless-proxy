import type * as Api from '@mp/api'
import { DESKTOP_PORTS, type EnvInfo, type EnvStats, type ImageInfo } from '@mp/containers'
import {
  ConflictError,
  DeniedError,
  NotFoundError,
  UnavailableError,
  ValidationError,
  errorMessage,
  isMpError,
  type Json,
} from '@mp/core'
import { LABEL_SANDBOX } from '@mp/sandbox'
import type { Run, Session } from '@mp/sessions'
import { DEFAULT_ENV_PROFILES, type EnvProfile } from '@mp/stdlib'
import type { Actor } from '@mp/store'
import { Hono } from 'hono'
import { type Principal, principalOf, viewerOf } from '../auth/guard.ts'
import type { ChatVisibility } from '../auth/visibility.ts'
import type { Services } from '../services.ts'
import { mayControlEnv, requestersOf, sessionEnvOf } from './access.ts'

export { mayControlEnv, requestersOf, sessionEnvOf } from './access.ts'

/** How often metrics are sampled while someone watches. */
export const STATS_INTERVAL_MS = 5000
/** How long an image inspection is reused: images don't change often. */
export const IMAGE_CACHE_MS = 5 * 60_000
/** `POST /api/environments/stop-idle`: the default idle time, and the least one may ask for. */
export const STOP_IDLE_DEFAULT_MINUTES = 60
export const STOP_IDLE_MIN_MINUTES = 5
/** Run states in which a session may still use its environment. */
const BUSY_RUN_STATES = new Set(['queued', 'running', 'suspended', 'paused'])

/** What the monitor needs from the live hub: which channels someone is subscribed to. */
export interface ChannelWatch {
  channelsInUse(): Set<string>
}

/**
 * Follows what runs in each environment (`env.exec.started` / `env.exec.finished` from the stdlib)
 * and, while someone watches the `environments` channel or a session's, samples its metrics about
 * every 5 s and publishes them as `env.stats` (the live hub filters them by who may read the
 * session). It also notices environments appearing and going away (`env.changed`).
 */
export class EnvironmentMonitor {
  private execs = new Map<string, Api.EnvironmentExec & { callId?: string }>()
  private latest = new Map<string, EnvStats>()
  /** When each environment last started or finished an `env.exec` (this process only). */
  private lastExec = new Map<string, string>()
  /** Environment id → its session, as of the last round (null: not watching). */
  private known: Map<string, string | undefined> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private offs: (() => void)[] = []

  constructor(
    private s: Services,
    private watch: ChannelWatch,
    private opts: { intervalMs?: number } = {},
  ) {
    const bus = s.bus
    this.offs.push(
      bus.subscribe<{ envId?: string; cmd?: string[]; startedAt?: string; runId?: string; callId?: string }>(
        'env.exec.started',
        (m) => {
          const p = m.payload
          if (typeof p.envId !== 'string' || !Array.isArray(p.cmd)) return
          this.lastExec.set(p.envId, new Date(m.at).toISOString())
          this.execs.set(p.envId, {
            cmd: p.cmd.map(String),
            startedAt: p.startedAt ?? new Date(m.at).toISOString(),
            ...(p.runId ? { runId: p.runId } : {}),
            ...(p.callId ? { callId: p.callId } : {}),
          })
        },
      ),
      bus.subscribe<{ envId?: string; callId?: string }>('env.exec.finished', (m) => {
        if (typeof m.payload.envId === 'string') this.lastExec.set(m.payload.envId, new Date(m.at).toISOString())
        const cur = typeof m.payload.envId === 'string' ? this.execs.get(m.payload.envId) : undefined
        // A later command in the same environment may have started meanwhile.
        if (cur && (!m.payload.callId || cur.callId === m.payload.callId)) this.execs.delete(m.payload.envId!)
      }),
      bus.subscribe<{ envId?: string; op?: string }>('env.changed', (m) => {
        if (m.payload.op === 'down' && typeof m.payload.envId === 'string') this.forget(m.payload.envId)
      }),
    )
  }

  /** The `env.exec` running in an environment now, if any. */
  execOf(envId: string): Api.EnvironmentExec | null {
    const e = this.execs.get(envId)
    if (!e) return null
    const { callId: _callId, ...rest } = e
    return rest
  }

  /** The latest metrics sample of an environment, if one was taken. */
  statsOf(envId: string): EnvStats | null {
    return this.latest.get(envId) ?? null
  }

  /** When the environment last started or finished an `env.exec`, as far as this process saw. */
  lastExecOf(envId: string): string | null {
    return this.lastExec.get(envId) ?? null
  }

  forget(envId: string) {
    this.execs.delete(envId)
    this.latest.delete(envId)
    this.lastExec.delete(envId)
  }

  start() {
    if (this.timer || !this.s.containers) return
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? STATS_INTERVAL_MS)
    this.timer.unref?.()
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const off of this.offs) off()
    this.offs = []
  }

  /** One round: samples the watched environments and publishes their metrics. Rounds never overlap. */
  tick(): Promise<void> {
    this.running ??= this.round().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async round() {
    const rt = this.s.containers
    if (!rt) return
    const watched = this.watch.channelsInUse()
    const all = watched.has('environments')
    const sessions = new Set([...watched].filter((c) => c.startsWith('session:')).map((c) => c.slice('session:'.length)))
    if (!all && !sessions.size) {
      this.known = null
      return
    }
    let envs: EnvInfo[]
    try {
      envs = (await rt.listEnvs()).filter((e) => !e.labels[LABEL_SANDBOX])
    } catch (e) {
      this.s.logger.debug('environments could not be listed', { err: errorMessage(e) })
      return
    }
    const ids = new Map(envs.map((e) => [e.id, e.labels['mp.session']]))
    // Changes made elsewhere (another instance, by hand). With a session, the live hub shows them only
    // to who may read it.
    const changed = (envId: string, sessionId: string | undefined, op: 'up' | 'down') =>
      this.s.bus.publish('env.changed', { envId, ...(sessionId ? { sessionId } : {}), op })
    if (this.known) {
      for (const [id, sid] of ids) if (!this.known.has(id)) changed(id, sid, 'up')
      for (const [id, sid] of this.known)
        if (!ids.has(id)) {
          this.forget(id)
          changed(id, sid, 'down')
        }
    }
    this.known = ids
    if (!rt.stats) return
    await Promise.all(
      envs.map(async (e) => {
        const sessionId = e.labels['mp.session']
        // Only environments their session runs now: the live hub filters them by who may read it.
        if (!sessionId || !(all || sessions.has(sessionId)) || e.status !== 'running') return
        if (sessionEnvOf(await this.s.sessions.get(sessionId))?.id !== e.id) return
        try {
          const stats = await rt.stats!(e.id)
          this.latest.set(e.id, stats)
          this.s.bus.publish('env.stats', { sessionId, envId: e.id, stats, exec: this.execOf(e.id) } as unknown as Json)
        } catch (err) {
          if (!isMpError(err, 'not_found'))
            this.s.logger.debug('environment stats failed', { envId: e.id, err: errorMessage(err) })
        }
      }),
    )
  }
}

/** Environments as the Environments page shows them. */
export class EnvironmentViews {
  /** Image inspections by image ID (or reference), reused for `IMAGE_CACHE_MS`. */
  private images = new Map<string, { at: number; info: Promise<ImageInfo | null> }>()

  constructor(
    private s: Services,
    private visibility: ChatVisibility,
    private monitor: EnvironmentMonitor,
  ) {}

  /** Every environment the viewer may see, newest first, with the filters applied. */
  async list(p: Principal, q: Api.EnvironmentQuery = {}): Promise<Api.Environment[]> {
    const rt = this.s.containers
    if (!rt) return []
    // Main containers only: service containers belong to their environment, and code.run's sandbox isn't one.
    const infos = (await rt.listEnvs()).filter((e) => !e.labels[LABEL_SANDBOX])
    const views = await Promise.all(
      infos.map(async (info) => {
        // The list is a summary; one inspect gives the image ID, start time and limits.
        const full = await rt.getEnv(info.id).catch(() => null)
        return this.view(p, full ? { ...info, ...full } : info)
      }),
    )
    return views
      .filter((view): view is Api.Environment => !!view)
      .filter((view) => !q.employeeId || view.employee?.id === q.employeeId)
      .filter((view) => !q.sessionId || view.session?.id === q.sessionId)
      .filter((view) => !q.desktop || view.desktop)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** The environment and its session, when the viewer may see it; else null. */
  async find(p: Principal, envId: string): Promise<{ info: EnvInfo; session: Session | null } | null> {
    const rt = this.s.containers
    if (!rt) return null
    const info = await rt.getEnv(envId)
    if (!info || info.labels[LABEL_SANDBOX]) return null
    const session = await this.sessionOf(info)
    if (!session) return p.access === 'admin' ? { info, session: null } : null
    return (await this.visibility.canReadSession(viewerOf(p), session)) ? { info, session } : null
  }

  /** Like `find`, but 404 for what the viewer may not see. */
  async require(p: Principal, envId: string) {
    const hit = await this.find(p, envId)
    if (!hit) throw new NotFoundError('environment', envId)
    return hit
  }

  /** The configured profile catalog. */
  private profiles(): readonly EnvProfile[] {
    const configured = this.s.config.ENV_PROFILES
    return configured?.length ? configured : DEFAULT_ENV_PROFILES
  }

  /** What the runtime says about an image, cached briefly. Null when it can't tell. */
  private inspectImage(key: string): Promise<ImageInfo | null> {
    const rt = this.s.containers
    if (!rt?.inspectImage) return Promise.resolve(null)
    const now = this.s.clock.now()
    const hit = this.images.get(key)
    if (hit && now - hit.at < IMAGE_CACHE_MS) return hit.info
    if (this.images.size > 500) this.images.clear()
    const info = rt.inspectImage(key).catch((err) => {
      // Not cached: the next look tries again.
      this.images.delete(key)
      this.s.logger.debug('image inspect failed', { image: key, err: errorMessage(err) })
      return null
    })
    this.images.set(key, { at: now, info })
    return info
  }

  /** The session that runs this environment now (its meta points at it), or null when none does. */
  private async sessionOf(info: EnvInfo): Promise<Session | null> {
    const sid = info.labels['mp.session']
    const session = sid ? await this.s.sessions.get(sid) : null
    return session && sessionEnvOf(session)?.id === info.id ? session : null
  }

  private async view(p: Principal, info: EnvInfo): Promise<Api.Environment | null> {
    const session = await this.sessionOf(info)
    // Left behind by a session that has moved on (or was removed): admins only.
    if (!session && p.access !== 'admin') return null
    if (session && !(await this.visibility.canReadSession(viewerOf(p), session))) return null
    const meta = sessionEnvOf(session)
    const employeeId = session?.data.employeeId ?? info.labels['mp.employee']
    const [employee, requesterIds, runs] = await Promise.all([
      employeeId ? this.s.directory.employees.get(employeeId) : null,
      session ? requestersOf(this.s, session) : [],
      session ? this.s.sessions.runs({ sessionId: session.id }) : [],
    ])
    const requester = requesterIds[0] ? await this.s.directory.contacts.get(requesterIds[0]) : null
    const control = await mayControlEnv(this.s, p, session)
    const net = meta?.network
    const network: Api.EnvironmentNetwork | null =
      net && (net.via === 'none' || net.via === 'proxy' || net.via === 'direct')
        ? {
            via: net.via,
            ...(Array.isArray(net.allow) ? { allow: net.allow.map(String) } : {}),
            ...(typeof net.reason === 'string' ? { reason: net.reason } : {}),
          }
        : null
    const image = imageOf(info, meta?.image)
    const imageInfo = await this.imageView(info, image)
    const profile = profileOf(this.profiles(), meta?.profile, image)
    const exec = this.monitor.execOf(info.id)
    const lastRun = runs.at(-1)
    return {
      envId: info.id,
      name: info.name,
      status: info.status === 'running' ? 'running' : 'stopped',
      createdAt: info.createdAt,
      session: session
        ? {
            id: session.id,
            title: session.data.title,
            slug: session.data.slug,
            status: session.data.status,
            runState: lastRun?.data.state ?? null,
          }
        : null,
      employee: employee ? { id: employee.id, name: employee.data.name } : null,
      ...(requester ? { requester: { id: requester.id, name: requester.data.name } } : {}),
      ...(profile ? { profile: profile.name, ...(profile.description ? { profileDescription: profile.description } : {}) } : {}),
      ...(image ? { image } : {}),
      imageInfo,
      ...(info.built || meta?.image === 'build' ? { build: buildLabel(meta?.checkouts) } : {}),
      limits: info.limits
        ? { cpus: info.limits.cpus ?? null, memoryBytes: info.limits.memoryBytes ?? null, pids: info.limits.pids ?? null }
        : null,
      startedAt: info.startedAt ?? null,
      lastActiveAt: latest([this.monitor.lastExecOf(info.id), runActivity(lastRun), info.startedAt ?? info.createdAt]),
      busy: !!exec || (!!lastRun && BUSY_RUN_STATES.has(lastRun.data.state)),
      checkouts: Array.isArray(meta?.checkouts) ? meta.checkouts.map((c) => ({ key: String(c.key), path: String(c.path) })) : [],
      network,
      ports: Array.isArray(meta?.expose) ? meta.expose.filter((x) => Number.isInteger(x)) : [],
      desktop: info.desktop === true,
      exec,
      stats: this.monitor.statsOf(info.id) as Api.EnvironmentStats | null,
      canStop: control,
      canControl: control && info.desktop === true,
    }
  }

  /** The image as the page shows it, from a (cached) inspection. */
  private async imageView(info: EnvInfo, ref: string | undefined): Promise<Api.EnvironmentImage | null> {
    const key = info.imageId ?? ref
    if (!key || !ref) return null
    const img = await this.inspectImage(key)
    const labels = img?.labels ?? {}
    const oci = (k: string) => labels[`org.opencontainers.image.${k}`] || undefined
    const base = info.built?.base ?? oci('base.name')
    const source = oci('source') ?? oci('url')
    const description = oci('description')
    const version = oci('version')
    const revision = oci('revision')
    const platform = img?.os ? [img.os, img.architecture].filter(Boolean).join('/') : null
    return {
      ref,
      id: shortId(img?.id ?? info.imageId ?? null),
      digest: img?.repoDigests[0] ?? null,
      sizeBytes: img?.sizeBytes ?? null,
      createdAt: img?.createdAt ?? null,
      platform,
      ...(source ? { source } : {}),
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
      ...(revision ? { revision } : {}),
      ...(base ? { base } : {}),
    }
  }
}

/** The image an environment runs: what the runtime reports, else what its session recorded. */
function imageOf(info: EnvInfo, recorded: string | undefined): string | undefined {
  if (info.image) return info.image
  return recorded && recorded !== 'build' ? recorded : undefined
}

/** `sha256:` and the first 12 hex digits of an image ID. */
export function shortId(id: string | null): string | null {
  if (!id) return null
  const m = /^(sha256:)?([0-9a-f]{12})/.exec(id)
  return m ? `sha256:${m[2]}` : id
}

/** Reference forms Docker treats as the same image: `docker.io/library/node:latest` is `node`. */
function normalRef(ref: string): string {
  let r = ref
    .replace(/^docker\.io\//, '')
    .replace(/^index\.docker\.io\//, '')
    .replace(/^library\//, '')
  if (!/:[^/]+$/.test(r) && !r.includes('@')) r = `${r}:latest`
  return r
}

/** The profile an environment came from: the recorded one, else the profile whose image it runs. */
export function profileOf(
  profiles: readonly EnvProfile[],
  recorded: string | undefined,
  image: string | undefined,
): { name: string; description?: string } | null {
  if (recorded) {
    const p = profiles.find((x) => x.name === recorded)
    return p ? { name: p.name, description: p.description } : { name: recorded }
  }
  if (!image) return null
  const p = profiles.find((x) => normalRef(x.image) === normalRef(image))
  return p ? { name: p.name, description: p.description } : null
}

/** "built from payments-api's Dockerfile", from the checkout at /workspace when the session recorded it. */
export function buildLabel(checkouts: { key: string; path: string }[] | undefined): string {
  const repo = Array.isArray(checkouts) ? (checkouts.find((c) => c.path === '/workspace') ?? checkouts[0])?.key : undefined
  return repo ? `built from ${repo}'s Dockerfile` : "built from a checkout's Dockerfile"
}

/** When a run last did something. */
function runActivity(run: Run | undefined): string | null {
  if (!run) return null
  return run.data.endedAt ?? run.updatedAt ?? run.data.startedAt ?? run.createdAt
}

/** The latest of some ISO times. */
function latest(times: (string | null | undefined)[]): string {
  return times
    .filter((t): t is string => typeof t === 'string' && !Number.isNaN(Date.parse(t)))
    .reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
}

/** Whether an environment counts as idle for Stop idle: running, not busy, and quiet for `idleMs`. */
export function isIdle(e: Api.Environment, now: number, idleMs: number): boolean {
  return e.status === 'running' && !e.busy && now - Date.parse(e.lastActiveAt) >= idleMs
}

/** The note a session gets when someone stops its environment. */
export const stoppedNote = (name: string, envName: string) =>
  `${name} stopped this session's environment (${envName}) from the harness UI. Its containers, network and volumes are gone; env.up starts a new one if you still need it.`

/**
 * Stops an environment like env.down: destroys it and removes it from its session's meta. The
 * session is told who stopped it: in the history of an idle session, or as an inbox item a working
 * run reads at its next step (never in the middle of a tool call).
 */
export async function stopEnvironment(s: Services, p: Principal, hit: { info: EnvInfo; session: Session | null }): Promise<void> {
  const rt = s.containers
  if (!rt) throw new UnavailableError('containers are off')
  await rt.destroyEnv(hit.info.id)
  const session = hit.session
  const actor: Actor = { type: 'contact', id: p.contactId }
  if (session) {
    for (let attempt = 1; ; attempt++) {
      const cur = await s.sessions.require(session.id)
      if (sessionEnvOf(cur)?.id !== hit.info.id) break
      const { env: _env, ...meta } = (cur.data.meta ?? {}) as Record<string, Json>
      try {
        await s.records.update('session', cur.id, { meta }, { expectedVersion: cur.version, actor })
        break
      } catch (e) {
        if (!isMpError(e, 'conflict') || attempt >= 10) throw e
      }
    }
    await noteInSession(s, session.id, stoppedNote(p.name, hit.info.name), `envstop:${hit.info.id}:${s.clock.now()}`, actor)
  }
  s.bus.publish('env.changed', { ...(session ? { sessionId: session.id } : {}), envId: hit.info.id, op: 'down' })
  s.logger.info('environment stopped from the UI', { envId: hit.info.id, by: p.contactId, sessionId: session?.id })
}

/** A note from the harness in a session's history: now when it's idle, else at its active run's next step. */
async function noteInSession(s: Services, sessionId: string, text: string, key: string, actor: Actor) {
  const content = { source: 'harness', type: 'env.stopped', text, trusted: true, expectedToAct: false }
  if (!(await s.sessions.activeContinuingRun(sessionId))) {
    try {
      const run = await s.sessions.createRun({
        sessionId,
        mode: 'continuing',
        cause: { type: 'manual', note: 'environment stopped' },
        actor,
      })
      await s.sessions.transition(run.id, 'queued', 'running')
      await s.sessions.append(run.id, { kind: 'event', content: { eventId: key, ...content } })
      await s.sessions.commit(run.id)
      await s.sessions.transition(run.id, 'running', 'completed', { result: { status: 'completed', output: 'note added' } })
      return
    } catch (e) {
      // A run started meanwhile: it gets the note at its next step instead.
      if (!(e instanceof ConflictError) && !isMpError(e, 'conflict')) throw e
    }
  }
  await s.sessions.addToInbox({ sessionId, eventId: key, ...content })
}

/**
 * The Environments page's API (docs/spec.md "Environments"): `GET /api/environments`,
 * `POST /api/environments/:id/stop`, `POST /api/environments/stop-idle` (admins),
 * `GET /api/environments/:id/logs` and `…/processes`.
 * The desktop token is in src/previews (it belongs to the preview origin).
 */
export function environmentRoutes(s: Services, views: EnvironmentViews): Hono {
  const app = new Hono()

  app.get('/api/environments', async (c) => {
    const q = c.req.query()
    const items = await views.list(principalOf(c), {
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
      ...(q.desktop === 'true' || q.desktop === '1' ? { desktop: true } : {}),
    })
    return c.json({ items })
  })

  app.post('/api/environments/:id/stop', async (c) => {
    const p = principalOf(c)
    const hit = await views.require(p, c.req.param('id'))
    if (!(await mayControlEnv(s, p, hit.session)))
      throw new DeniedError("only admins and the person the session's work is for can stop its environment")
    await stopEnvironment(s, p, hit)
    return c.json({ stopped: true, envId: hit.info.id, sessionId: hit.session?.id ?? null })
  })

  app.post('/api/environments/stop-idle', async (c) => {
    const p = principalOf(c)
    if (p.access !== 'admin') throw new DeniedError('only admins can stop idle environments')
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Api.StopIdleRequest
    const minutes = body.idleMinutes ?? STOP_IDLE_DEFAULT_MINUTES
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < STOP_IDLE_MIN_MINUTES)
      throw new ValidationError(`idleMinutes must be a number, at least ${STOP_IDLE_MIN_MINUTES}`)
    const dryRun = body.dryRun === true
    const now = s.clock.now()
    const idle = (await views.list(p)).filter((e) => isIdle(e, now, minutes * 60_000))
    const out: Api.StopIdleResult = { stopped: [], failed: [], dryRun }
    for (const e of idle) {
      if (dryRun) {
        out.stopped.push(e.envId)
        continue
      }
      try {
        const hit = await views.find(p, e.envId)
        if (hit) await stopEnvironment(s, p, hit)
        out.stopped.push(e.envId)
      } catch (err) {
        out.failed.push({ envId: e.envId, error: errorMessage(err) })
      }
    }
    if (!dryRun && idle.length)
      s.logger.info('idle environments stopped from the UI', {
        by: p.contactId,
        stopped: out.stopped.length,
        idleMinutes: minutes,
      })
    return c.json(out)
  })

  app.get('/api/environments/:id/logs', async (c) => {
    const hit = await views.require(principalOf(c), c.req.param('id'))
    const tail = Math.min(Math.max(1, Number(c.req.query('tail') ?? 300) || 300), 5000)
    const logs = await s.containers!.logs(hit.info.id, { tail })
    // Keep the end: that's where the news is.
    return c.json({ envId: hit.info.id, logs: logs.length > 200_000 ? logs.slice(-200_000) : logs })
  })

  app.get('/api/environments/:id/processes', async (c) => {
    const hit = await views.require(principalOf(c), c.req.param('id'))
    const rt = s.containers!
    if (!rt.processes) throw new UnavailableError('the container runtime cannot list processes')
    return c.json({ envId: hit.info.id, containers: await rt.processes(hit.info.id) })
  })

  return app
}

/** The desktop ports of an environment: control for those who may act on it, else view-only. */
export const desktopPortFor = (control: boolean) => (control ? DESKTOP_PORTS.control : DESKTOP_PORTS.view)
