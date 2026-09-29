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
  /** The profile it runs, when env.up picked one by name. */
  profile?: string
  /** The image it runs (or `build` when it was built from the checkout's Dockerfile). */
  image?: string
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
    environmentLogs: (id, tail) => call('environmentLogs', { id }, { tail }),
    environmentProcesses: (id) => call('environmentProcesses', { id }),
    desktopToken: (id, o = {}) => call('desktopToken', { id }, undefined, o),
  }
}
