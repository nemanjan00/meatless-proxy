import {
  type ApiRecord,
  ApiRequestError,
  DESKTOP_PORTS,
  type DesktopToken,
  type EmployeeData,
  type EnvContainerProcesses,
  type EnvContainerStats,
  type Environment,
  type EnvironmentsApi,
  type EnvironmentStats,
  type LiveTopic,
  type LiveTopics,
  type RunData,
  type SessionData,
} from '@mp/api'
import { CON, type MockDb, SES } from './data.ts'

/** What the environments mock borrows from the mock API. */
export interface MockEnvironmentsHelpers {
  db: MockDb
  delay<T>(v: T): Promise<T>
  get<T>(kind: string, id: string): ApiRecord<T> | undefined
  all<T>(kind: string): ApiRecord<T>[]
  emit?: <T extends LiveTopic>(topic: T, payload: LiveTopics[T]) => void
}

/** A mock environment: what the server would know about it, without the session join. */
interface MockEnv {
  envId: string
  name: string
  sessionId: string
  createdAt: number
  profile?: string
  image?: string
  checkouts: Environment['checkouts']
  network: Environment['network']
  ports: number[]
  desktop: boolean
  services: string[]
  exec: Environment['exec']
  canStop: boolean
  canControl: boolean
  /** The base load of each container, so the numbers move around something plausible. */
  load: Record<string, { cpu: number; mem: number; limit: number | null; pids: number }>
  logs: string[]
  net: { rx: number; tx: number }
  stats: EnvironmentStats | null
}

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** The environments of one mock database (tests make a new one each time). */
const state = new WeakMap<MockDb, { envs: MockEnv[]; tick: number }>()

function seed(db: MockDb): { envs: MockEnv[]; tick: number } {
  const now = db.now()
  const min = 60_000
  const envs: MockEnv[] = [
    {
      envId: 'mp-billing-bot-pay-123-refund',
      name: 'billing-bot-pay-123-refund',
      sessionId: SES.pay123,
      createdAt: now - 42 * min,
      profile: 'default',
      image: 'nemanjan00/dev:default',
      checkouts: [
        { key: 'payments-api', path: '/workspace' },
        { key: 'payments-api', path: '/repos/payments-api' },
      ],
      network: { via: 'proxy', allow: ['registry.npmjs.org', 'gitlab.example.com', 'api.stripe.com'] },
      ports: [5173, 8000],
      desktop: false,
      services: ['db'],
      exec: {
        cmd: ['npm', 'test', '--', '--run', 'refunds'],
        startedAt: new Date(now - 47_000).toISOString(),
        runId: 'run_mock',
      },
      canStop: true,
      canControl: true,
      load: {
        main: { cpu: 86, mem: 1.3 * GIB, limit: 4 * GIB, pids: 38 },
        db: { cpu: 7, mem: 210 * MIB, limit: 4 * GIB, pids: 9 },
      },
      logs: [
        '> payments-api@2.4.0 dev',
        '> vite --host 0.0.0.0',
        '  VITE v8.3.1  ready in 412 ms',
        '  ➜  Network: http://0.0.0.0:5173/',
        '[api] listening on 0.0.0.0:8000',
        '[api] POST /refunds 201 18ms',
      ],
      net: { rx: 48 * MIB, tx: 3.2 * MIB },
      stats: null,
    },
    {
      envId: 'mp-billing-bot-pay-140-repro',
      name: 'billing-bot-pay-140-repro',
      sessionId: SES.pay140Repro,
      createdAt: now - 3 * 3600_000 - 12 * min,
      profile: 'scraper',
      image: 'nemanjan00/dev:scraper',
      checkouts: [{ key: 'payments-api', path: '/workspace' }],
      network: { via: 'proxy', allow: ['staging.payments.example.com'] },
      ports: [],
      desktop: true,
      services: [],
      exec: null,
      canStop: true,
      canControl: true,
      load: {
        main: { cpu: 34, mem: 820 * MIB, limit: 2 * GIB, pids: 61 },
        desktop: { cpu: 6, mem: 96 * MIB, limit: 512 * MIB, pids: 7 },
      },
      logs: ['launching chromium --headed on :99', 'opened https://staging.payments.example.com/webhooks', 'retry 3/5 in 8s'],
      net: { rx: 212 * MIB, tx: 9 * MIB },
      stats: null,
    },
    {
      envId: 'mp-infra-bot-inc-42-disk',
      name: 'infra-bot-inc-42-disk',
      sessionId: SES.inc42,
      createdAt: now - 26 * min,
      profile: 'analyst',
      image: 'nemanjan00/dev:analyst',
      checkouts: [],
      network: { via: 'direct' },
      ports: [],
      desktop: false,
      services: [],
      exec: { cmd: ['sh', '-c', 'du -xh /data | sort -h | tail -20'], startedAt: new Date(now - 6_000).toISOString() },
      canStop: false,
      canControl: false,
      load: { main: { cpu: 12, mem: 180 * MIB, limit: null, pids: 4 } },
      logs: ['ssh staging-eu-1: connected', '/var/lib/docker 71G'],
      net: { rx: 1.4 * MIB, tx: 0.2 * MIB },
      stats: null,
    },
  ]
  const s = { envs, tick: 0 }
  for (const e of envs) e.stats = sample(db, e, 0)
  return s
}

const stateOf = (db: MockDb) => {
  let s = state.get(db)
  if (!s) {
    s = seed(db)
    state.set(db, s)
  }
  return s
}

/** A metrics sample that wobbles around each container's base load. */
function sample(db: MockDb, e: MockEnv, tick: number): EnvironmentStats {
  const at = new Date(db.now()).toISOString()
  const wobble = (base: number, i: number, amp: number) => Math.max(0, base * (1 + amp * Math.sin(tick * 0.9 + i * 1.7)))
  e.net.rx += 180_000 + (tick % 5) * 40_000
  e.net.tx += 12_000
  const containers: EnvContainerStats[] = Object.entries(e.load).map(([name, l], i) => ({
    name,
    role: name === 'main' ? 'main' : name === 'desktop' ? 'desktop' : 'service',
    state: 'running',
    cpuPercent: Math.round(wobble(l.cpu, i, 0.35) * 10) / 10,
    memoryBytes: Math.round(wobble(l.mem, i, 0.04)),
    memoryLimitBytes: l.limit,
    // The desktop shares the main container's network namespace, so it reports the same traffic.
    netRxBytes: name === 'main' || name === 'desktop' ? e.net.rx : Math.round(e.net.rx / 20),
    netTxBytes: name === 'main' || name === 'desktop' ? e.net.tx : Math.round(e.net.tx / 20),
    pids: l.pids + (tick % 3),
    startedAt: new Date(e.createdAt).toISOString(),
  }))
  return { envId: e.envId, at, containers }
}

/** A small fake desktop, for the viewer frame: a browser window on a dark background. */
export function demoDesktopPage(e: { name: string }, opts: { control: boolean; thumbnail: boolean; token: string }): string {
  const bar = opts.thumbnail
    ? ''
    : `<div style="position:fixed;top:8px;right:8px;font:11px system-ui;padding:2px 6px;border-radius:4px;background:#0008;color:#d0d6e0">${opts.control ? 'Controlling' : 'View only'} · ${opts.token}</div>`
  const html = `<!doctype html><meta charset="utf-8"><title>Desktop ${e.name}</title>
<body style="margin:0;height:100vh;background:#1c1c1f;font:13px/1.5 system-ui,sans-serif;overflow:hidden">
<div style="position:absolute;inset:6% 8% 10% 8%;background:#f4f4f4;border-radius:6px;box-shadow:0 7px 32px #0006;overflow:hidden">
<div style="height:28px;background:#dcdbdd;display:flex;align-items:center;gap:6px;padding:0 10px">
<span style="width:10px;height:10px;border-radius:50%;background:#eb5757"></span><span style="width:10px;height:10px;border-radius:50%;background:#f0bf00"></span><span style="width:10px;height:10px;border-radius:50%;background:#27a644"></span>
<span style="margin-left:12px;flex:1;background:#fff;border-radius:4px;padding:1px 8px;color:#6f6e77;font-size:11px">https://staging.payments.example.com/webhooks</span></div>
<div style="padding:18px 22px;color:#282a30"><h1 style="margin:0 0 8px;font-size:18px;font-weight:590">Webhook deliveries</h1>
<p style="margin:0 0 4px;color:#6f6e77">evt_1042 · retry 3 of 5 · next in 8 s</p><p style="margin:0;color:#eb5757">evt_1043 · gave up after 2 retries</p></div></div>
${bar}</body>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** The processes a container would list. */
function processesOf(e: MockEnv): EnvContainerProcesses[] {
  const titles = ['PID', 'USER', '%CPU', '%MEM', 'ELAPSED', 'COMMAND']
  return Object.keys(e.load).map((name) => ({
    name,
    role: name === 'main' ? 'main' : name === 'desktop' ? 'desktop' : 'service',
    titles,
    processes:
      name === 'desktop'
        ? [
            ['12', '1000', '3.1', '1.2', '03:12:40', 'Xvfb :99 -screen 0 1440x900x24 -nolisten tcp'],
            ['18', '1000', '1.4', '0.8', '03:12:39', 'x11vnc -display :99 -rfbport 5900 -localhost -shared'],
            ['24', '1000', '0.2', '0.6', '03:12:39', 'websockify 0.0.0.0:6080 127.0.0.1:5900'],
          ]
        : name === 'db'
          ? [
              ['1', '70', '4.0', '5.1', '42:10', 'postgres'],
              ['31', '70', '0.3', '0.9', '42:08', 'postgres: checkpointer'],
            ]
          : [
              ['1', '1000', '0.0', '0.0', '42:11', 'sleep infinity'],
              ...(e.exec ? [['214', '1000', '71.2', '9.4', '00:47', e.exec.cmd.join(' ')]] : []),
              ...(e.ports.length ? [['88', '1000', '8.3', '3.2', '41:50', 'node vite --host 0.0.0.0']] : []),
              ...(e.desktop
                ? [['97', '1000', '28.4', '11.0', '03:10:02', 'chromium --no-sandbox https://staging.payments…']]
                : []),
            ],
  }))
}

/**
 * The next metrics sample of every environment, sent as `env.stats` (what the server's poller does
 * about every 5 s while someone watches). The simulator calls it; tests may too.
 */
export function tickMockEnvironments(db: MockDb, emit: <T extends LiveTopic>(topic: T, payload: LiveTopics[T]) => void) {
  const s = stateOf(db)
  s.tick++
  for (const e of s.envs) {
    e.stats = sample(db, e, s.tick)
    emit('env.stats', { sessionId: e.sessionId, envId: e.envId, stats: e.stats, exec: e.exec })
  }
}

/** Environments in the mock: a dev server with a database behind a proxy, a desktop, and a direct network. */
export function createMockEnvironmentsApi(h: MockEnvironmentsHelpers): EnvironmentsApi {
  const { db, delay, get, all } = h
  const notFound = () => new ApiRequestError(404, 'not_found', 'environment not found')
  const find = (id: string) => stateOf(db).envs.find((e) => e.envId === id)

  const view = (e: MockEnv): Environment => {
    const s = get<SessionData>('session', e.sessionId)
    const runs = all<RunData>('run')
      .filter((r) => r.data.sessionId === e.sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const emp = s ? get<EmployeeData>('employee', s.data.employeeId) : undefined
    const requesterId = runs.find((r) => r.data.requesterId)?.data.requesterId ?? CON.ana
    const requester = get<{ name: string }>('contact', requesterId)
    return {
      envId: e.envId,
      name: e.name,
      status: 'running',
      createdAt: new Date(e.createdAt).toISOString(),
      session: s
        ? { id: s.id, title: s.data.title, slug: s.data.slug, status: s.data.status, runState: runs.at(-1)?.data.state ?? null }
        : null,
      employee: emp ? { id: emp.id, name: emp.data.name } : s ? { id: s.data.employeeId, name: s.data.employeeId } : null,
      ...(requester ? { requester: { id: requesterId, name: requester.data.name } } : {}),
      ...(e.profile ? { profile: e.profile } : {}),
      ...(e.image ? { image: e.image } : {}),
      checkouts: e.checkouts,
      network: e.network,
      ports: e.ports,
      desktop: e.desktop,
      exec: e.exec,
      stats: e.stats,
      canStop: e.canStop,
      canControl: e.canControl,
    }
  }

  return {
    environments: (q = {}) => {
      const items = stateOf(db)
        .envs.filter((e) => !q.sessionId || e.sessionId === q.sessionId)
        .filter((e) => !q.desktop || e.desktop)
        .map(view)
        .filter((e) => !q.employeeId || e.employee?.id === q.employeeId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return delay({ items })
    },
    stopEnvironment: (id) => {
      const s = stateOf(db)
      const e = s.envs.find((x) => x.envId === id)
      if (!e) return Promise.reject(notFound())
      if (!e.canStop)
        return Promise.reject(
          new ApiRequestError(403, 'denied', "only admins and the session's requester can stop this environment"),
        )
      s.envs = s.envs.filter((x) => x !== e)
      h.emit?.('env.changed', { sessionId: e.sessionId, envId: e.envId, op: 'down' })
      return delay({ stopped: true as const, envId: e.envId, sessionId: e.sessionId })
    },
    environmentLogs: (id, tail = 200) => {
      const e = find(id)
      if (!e) return Promise.reject(notFound())
      const stamp = new Date(db.now()).toISOString().slice(11, 19)
      const lines = [...e.logs, `${stamp} ${e.exec ? `running: ${e.exec.cmd.join(' ')}` : 'idle'}`]
      return delay({ envId: e.envId, logs: `${lines.slice(-tail).join('\n')}\n` })
    },
    environmentProcesses: (id) => {
      const e = find(id)
      if (!e) return Promise.reject(notFound())
      return delay({ envId: e.envId, containers: processesOf(e) })
    },
    desktopToken: (id, o = {}) => {
      const e = find(id)
      if (!e) return Promise.reject(notFound())
      if (!e.desktop) return Promise.reject(new ApiRequestError(404, 'not_found', 'this environment has no desktop'))
      const control = o.control === true
      if (control && !e.canControl)
        return Promise.reject(new ApiRequestError(403, 'denied', "only admins and the session's requester can take control"))
      const port = control ? DESKTOP_PORTS.control : DESKTOP_PORTS.view
      const token = `mpp_mock_${++db.seq}`
      const out: DesktopToken = {
        envId: e.envId,
        port,
        token,
        control,
        url: demoDesktopPage(e, { control, thumbnail: o.thumbnail === true, token }),
        origin: `http://${e.envId}-${port}.preview.example.com`,
        expiresAt: new Date(db.now() + 5 * 60_000).toISOString(),
      }
      return delay(out)
    },
  }
}
