import { MpError } from '@mp/core'
import type { EgressLogEntry } from './egress.ts'

export interface Mount {
  hostPath: string
  containerPath: string
  readOnly?: boolean
}

export interface EnvSpec {
  /** Stable name, e.g. derived from the session id. */
  name: string
  /** Image to run. One of `image` or `build` is needed. */
  image?: string
  build?: { context: string; dockerfile?: string }
  /** Long-running command that keeps the main container up. Default: `sleep infinity`. */
  command?: string[]
  workdir?: string
  mounts?: Mount[]
  env?: Record<string, string>
  /** Extra containers on the same private network, e.g. a database. */
  services?: { name: string; image: string; env?: Record<string, string> }[]
  limits?: { cpus?: number; memoryMb?: number }
  /**
   * Network access through an allowlisting egress proxy: containers get no direct route out, only
   * `HTTP_PROXY`/`HTTPS_PROXY` pointing at a proxy that lets through `allow` (hostname globs with
   * optional ports, see `checkEgress`). Can't be combined with `allowInternet`.
   */
  egress?: { allow: string[] }
  /**
   * Unrestricted internet access, the escape hatch. Default false: without `egress` there is no
   * network beyond the environment's own private network (no internet, no harness services).
   */
  allowInternet?: boolean
  labels?: Record<string, string>
}

export interface EnvInfo {
  id: string
  name: string
  status: 'running' | 'stopped' | 'missing'
  labels: Record<string, string>
  createdAt: string
}

export interface ExecOptions {
  env?: Record<string, string>
  workdir?: string
  /** On timeout the result has `timedOut: true` and exit code `TIMEOUT_EXIT_CODE`. */
  timeoutMs?: number
  /** Streamed output as it arrives. */
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
  /** Aborting makes `exec` reject with `ExecAbortedError`. */
  signal?: AbortSignal
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

export interface ContainerRuntime {
  createEnv(spec: EnvSpec): Promise<EnvInfo>
  getEnv(id: string): Promise<EnvInfo | null>
  listEnvs(labels?: Record<string, string>): Promise<EnvInfo[]>
  exec(envId: string, cmd: string[], opts?: ExecOptions): Promise<ExecResult>
  logs(envId: string, opts?: { tail?: number }): Promise<string>
  /** The egress proxy's log, oldest first. Empty for an environment without `egress`. Optional. */
  egressLog?(envId: string): Promise<EgressLogEntry[]>
  /** Removes the environment's containers, network and volumes. Idempotent. */
  destroyEnv(envId: string): Promise<void>
}

/** Exit code reported for a command that ran out of time (like coreutils `timeout`). */
export const TIMEOUT_EXIT_CODE = 124

/** Thrown by `exec` when its `signal` is aborted. Implementations stop waiting for the command. */
export class ExecAbortedError extends MpError {
  constructor(message = 'exec aborted') {
    super('aborted', message)
  }
}
