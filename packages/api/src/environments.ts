// ─── Environments: every running environment, its live metrics, and its desktop ─────
//
// Served by packages/server/src/environments. Visibility follows the sessions' rule: an environment of a
// private (DM) session is shown only to the people who may read that session. Environments that belong
// to no session any more (left behind) are shown to admins only.

import type { EmployeeSummary, PreviewToken, RunState, SessionStatus } from './resources.ts'

/** The desktop's VNC-over-WebSocket ports inside an environment: full control, and view-only. */
export const DESKTOP_PORTS = { control: 6080, view: 6081 } as const

/** Live metrics of one container of an environment, from the container runtime. */
export interface EnvContainerStats {
  /** `main`, a service's name, or `desktop` (the desktop sidecar). */
  name: string
  role: 'main' | 'service' | 'desktop'
  /** `running`, `exited`, … */
  state: string
  /** Percent of one CPU (200 = two CPUs busy). Null until two samples were taken. */
  cpuPercent: number | null
  memoryBytes: number | null
  memoryLimitBytes: number | null
  /** Bytes received and sent since the container started. The desktop shares the main container's network. */
  netRxBytes: number | null
  netTxBytes: number | null
  pids: number | null
  startedAt: string | null
}

/** One sample of an environment's metrics. */
export interface EnvironmentStats {
  envId: string
  at: string
  containers: EnvContainerStats[]
}

/** The `env.exec` running in an environment right now. */
export interface EnvironmentExec {
  cmd: string[]
  startedAt: string
  runId?: string
}

/** How an environment reaches the network (what env.up said). */
export interface EnvironmentNetwork {
  via: 'none' | 'proxy' | 'direct'
  /** Proxy: the allowed hosts. */
  allow?: string[]
  /** None: why. */
  reason?: string
}

/** The image an environment runs, as the container runtime reports it (image inspect, cached briefly). */
export interface EnvironmentImage {
  /** The reference the container was created from, e.g. `nemanjan00/dev:scraper` or `mp-build/<name>:latest`. */
  ref: string
  /** The image ID, short: `sha256:` and 12 hex digits. Null when the runtime didn't tell. */
  id: string | null
  /** A registry digest (`name@sha256:…`), for pulled images. */
  digest: string | null
  sizeBytes: number | null
  /** When the image was built. */
  createdAt: string | null
  /** `linux/amd64`, `linux/arm64/v8`. */
  platform: string | null
  /** `org.opencontainers.image.*` labels, when the image has them. */
  source?: string
  description?: string
  version?: string
  revision?: string
  /** What it's built on: a built image's Dockerfile FROM, or the image's base-name label. */
  base?: string
}

/** Resource limits of the main container. Null values: no limit. */
export interface EnvironmentLimits {
  cpus: number | null
  memoryBytes: number | null
  pids: number | null
}

/** A running (or stopped, not yet removed) environment, joined with its session. */
export interface Environment {
  envId: string
  name: string
  status: 'running' | 'stopped'
  createdAt: string
  /** Null for an environment no session points at any more (admins only). */
  session: { id: string; title: string; slug: string; status: SessionStatus; runState: RunState | null } | null
  employee: EmployeeSummary | null
  /** Who the session's work is for. */
  requester?: { id: string; name: string }
  /** The profile it runs: what env.up picked, or the profile whose image it runs. */
  profile?: string
  /** The profile's one line: what it's for and its main tools. */
  profileDescription?: string
  /** The image reference it runs, from the container runtime (a built one is `mp-build/<name>:latest`). */
  image?: string
  /** More about the image, when the runtime can inspect it. */
  imageInfo: EnvironmentImage | null
  /** Set when the image was built from a Dockerfile: "built from payments-api's Dockerfile". */
  build?: string
  /** The main container's limits, when the runtime tells. */
  limits: EnvironmentLimits | null
  /** When the main container started (for its uptime), when the runtime tells. */
  startedAt: string | null
  /**
   * When it last did something: the end of its last `env.exec` this server saw, else its session's
   * last run, else when it started. Idle time counts from here.
   */
  lastActiveAt: string
  /** Busy now: an `env.exec` in progress, or its session has a run queued, running or suspended. */
  busy: boolean
  /** Checkouts: `/workspace` and `/repos/<name>`, with their repository keys. */
  checkouts: { key: string; path: string }[]
  network: EnvironmentNetwork | null
  /** Ports the app serves as live previews (the desktop's ports are not listed). */
  ports: number[]
  /** Whether it has a desktop (Xvfb and VNC), viewable with `desktopToken`. */
  desktop: boolean
  /** The `env.exec` in progress, if any. */
  exec: EnvironmentExec | null
  /** The latest metrics sample, if one was taken. Live updates come as `env.stats`. */
  stats: EnvironmentStats | null
  /** Whether the viewer may stop it: admins, and the session's requester. */
  canStop: boolean
  /** Whether the viewer may take control of its desktop: admins, and the session's requester. */
  canControl: boolean
}

export interface EnvironmentQuery {
  employeeId?: string
  sessionId?: string
  /** Only environments with a desktop. */
  desktop?: boolean
}

/** `POST /api/environments/stop-idle`: which environments count as idle. */
export interface StopIdleRequest {
  /** Idle at least this long (default 60, at least 5). */
  idleMinutes?: number
  /** Only list what would be stopped. */
  dryRun?: boolean
}

export interface StopIdleResult {
  /** Stopped (or, with `dryRun`, would be). */
  stopped: string[]
  /** Idle ones that could not be stopped, with why. */
  failed: { envId: string; error: string }[]
  dryRun: boolean
}

/** One container's processes, from `docker top` (the host's `ps`). */
export interface EnvContainerProcesses {
  name: string
  role: EnvContainerStats['role']
  titles: string[]
  /** Rows, busiest first, at most 25. */
  processes: string[][]
}

/** `POST /api/environments/:id/desktop`: a preview token for the desktop viewer. */
export interface DesktopToken extends PreviewToken {
  /** Whether it gives control (keyboard and mouse), or only a view. */
  control: boolean
}

/** The routes of this section (merged into `ROUTES`). */
export const ENVIRONMENT_ROUTES = {
  environments: ['GET', '/api/environments'],
  stopEnvironment: ['POST', '/api/environments/:id/stop'],
  stopIdleEnvironments: ['POST', '/api/environments/stop-idle'],
  environmentLogs: ['GET', '/api/environments/:id/logs'],
  environmentProcesses: ['GET', '/api/environments/:id/processes'],
  desktopToken: ['POST', '/api/environments/:id/desktop'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface EnvironmentsApi {
  /** `GET /api/environments?employeeId=&sessionId=&desktop=` → the environments the viewer may see, newest first. */
  environments(query?: EnvironmentQuery): Promise<{ items: Environment[] }>
  /**
   * `POST /api/environments/:id/stop` → tears it down like env.down, and notes in the session's
   * history who stopped it. Admins, and the session's requester.
   */
  stopEnvironment(envId: string): Promise<{ stopped: true; envId: string; sessionId: string | null }>
  /**
   * `POST /api/environments/stop-idle` body `{ idleMinutes?, dryRun? }` → stops every running environment
   * that isn't busy and has been idle that long, each like Stop (its session gets the note). Admins only.
   */
  stopIdleEnvironments(req?: StopIdleRequest): Promise<StopIdleResult>
  /** `GET /api/environments/:id/logs?tail=` → the main container's latest log lines. */
  environmentLogs(envId: string, tail?: number): Promise<{ envId: string; logs: string }>
  /** `GET /api/environments/:id/processes` → what runs in each of its containers (members). */
  environmentProcesses(envId: string): Promise<{ envId: string; containers: EnvContainerProcesses[] }>
  /**
   * `POST /api/environments/:id/desktop` body `{ control? }` → a single-use token and the URL of the
   * desktop viewer on the preview origin. View-only for members who can read the session; control for
   * admins and the session's requester (403 otherwise).
   */
  desktopToken(envId: string, opts?: { control?: boolean; thumbnail?: boolean }): Promise<DesktopToken>
}

type Call = <T>(
  route: keyof typeof ENVIRONMENT_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `EnvironmentsApi` half of `createApiClient`. */
export function environmentsMethods(call: Call): EnvironmentsApi {
  return {
    environments: (q = {}) => call('environments', undefined, { ...q }),
    stopEnvironment: (id) => call('stopEnvironment', { id }, undefined, {}),
    stopIdleEnvironments: (req = {}) => call('stopIdleEnvironments', undefined, undefined, req),
    environmentLogs: (id, tail) => call('environmentLogs', { id }, { tail }),
    environmentProcesses: (id) => call('environmentProcesses', { id }),
    desktopToken: (id, o = {}) => call('desktopToken', { id }, undefined, o),
  }
}
