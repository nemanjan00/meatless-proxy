import type * as Api from '@mp/api'
import { DESKTOP_PORTS, type EnvInfo, type EnvStats } from '@mp/containers'
import { ConflictError, DeniedError, NotFoundError, UnavailableError, errorMessage, isMpError, type Json } from '@mp/core'
import { LABEL_SANDBOX } from '@mp/sandbox'
import type { Session } from '@mp/sessions'
import type { Actor } from '@mp/store'
import { Hono } from 'hono'
import { type Principal, principalOf, viewerOf } from '../auth/guard.ts'
import type { ChatVisibility } from '../auth/visibility.ts'
import type { Services } from '../services.ts'
import { mayControlEnv, requestersOf, sessionEnvOf } from './access.ts'

export { mayControlEnv, requestersOf, sessionEnvOf } from './access.ts'

/** How often metrics are sampled while someone watches. */
export const STATS_INTERVAL_MS = 5000

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
          this.execs.set(p.envId, {
            cmd: p.cmd.map(String),
            startedAt: p.startedAt ?? new Date(m.at).toISOString(),
            ...(p.runId ? { runId: p.runId } : {}),
            ...(p.callId ? { callId: p.callId } : {}),
          })
        },
      ),
      bus.subscribe<{ envId?: string; callId?: string }>('env.exec.finished', (m) => {
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

  forget(envId: string) {
    this.execs.delete(envId)
    this.latest.delete(envId)
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
  constructor(
    private s: Services,
    private visibility: ChatVisibility,
    private monitor: EnvironmentMonitor,
  ) {}

  /** Every environment the viewer may see, newest first, with the filters applied. */
  async list(p: Principal, q: Api.EnvironmentQuery = {}): Promise<Api.Environment[]> {
    const rt = this.s.containers
    if (!rt) return []
    const infos = (await rt.listEnvs()).filter((e) => !e.labels[LABEL_SANDBOX])
    const out: Api.Environment[] = []
    for (const info of infos) {
      const view = await this.view(p, info)
      if (!view) continue
      if (q.employeeId && view.employee?.id !== q.employeeId) continue
      if (q.sessionId && view.session?.id !== q.sessionId) continue
      if (q.desktop && !view.desktop) continue
      out.push(view)
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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
            runState: runs.at(-1)?.data.state ?? null,
          }
        : null,
      employee: employee ? { id: employee.id, name: employee.data.name } : null,
      ...(requester ? { requester: { id: requester.id, name: requester.data.name } } : {}),
      ...(meta?.profile ? { profile: meta.profile } : {}),
      ...(meta?.image ? { image: meta.image } : {}),
      checkouts: Array.isArray(meta?.checkouts) ? meta.checkouts.map((c) => ({ key: String(c.key), path: String(c.path) })) : [],
      network,
      ports: Array.isArray(meta?.expose) ? meta.expose.filter((x) => Number.isInteger(x)) : [],
      desktop: info.desktop === true,
      exec: this.monitor.execOf(info.id),
      stats: this.monitor.statsOf(info.id) as Api.EnvironmentStats | null,
      canStop: control,
      canControl: control && info.desktop === true,
    }
  }
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
 * `POST /api/environments/:id/stop`, `GET /api/environments/:id/logs` and `…/processes`.
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
