import { MpError } from '@mp/core'
import type { EgressLogEntry } from './egress.ts'

export interface Mount {
  hostPath: string
  containerPath: string
  readOnly?: boolean
}

/** A named volume, or a directory or file inside it, mounted into a container. */
export interface VolumeMount {
  volume: string
  /** Relative path inside the volume (no `..`). Default: the whole volume. */
  subpath?: string
  containerPath: string
  readOnly?: boolean
}

/** What a runtime supports beyond the basics. */
export interface RuntimeFeatures {
  /** `VolumeMount.subpath` works (Docker Engine 26+). */
  volumeSubpath: boolean
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
  /** `pids`: the most processes the main container may run (default: the runtime's own limit). */
  limits?: { cpus?: number; memoryMb?: number; pids?: number }
  /** The user the main container runs as (`uid:gid` or a name). Default: the image's user. */
  user?: string
  /** Makes the main container's root filesystem read-only. Writable paths then come from `volumes` and `tmpfs`. */
  readOnlyRootfs?: boolean
  /** Container paths that get a fresh volume of their own, removed with the environment. */
  volumes?: string[]
  /**
   * Parts of existing named volumes mounted into the main container, e.g. one employee's directory of
   * a shared files volume. The runtime never creates or removes these volumes. Needs
   * `features().volumeSubpath` when `subpath` is set.
   */
  volumeMounts?: VolumeMount[]
  /** Container paths mounted as in-memory filesystems, with an optional size in MiB (default 64). */
  tmpfs?: Record<string, { sizeMb?: number }>
  /**
   * Network access through an allowlisting egress proxy: containers get no direct route out, only
   * `HTTP_PROXY`/`HTTPS_PROXY` pointing at a proxy that lets through `allow` (hostname globs with
   * optional ports, see `checkEgress`). Can't be combined with `allowInternet` or `direct`.
   */
  egress?: { allow: string[] }
  /**
   * Unrestricted internet access, the escape hatch. Default false: without `egress` or `direct` there
   * is no network beyond the environment's own private network (no internet, no harness services).
   */
  allowInternet?: boolean
  /**
   * A real, unproxied network: the environment's containers also join the shared network `network`
   * (the runtime adds its name prefix), created on demand and kept for the next environment that
   * names it. It routes out through the host (any host, any protocol: SSH, databases, UDP, DNS), with
   * no allowlist and nothing logged. Containers of different environments on it can't reach each
   * other; one environment's containers talk over its own private network. It never joins the
   * harness's own networks. Can't be combined with `egress` or `allowInternet`.
   */
  direct?: { network: string }
  /**
   * Ports the main container serves, e.g. a dev server on 5173, for live previews. Nothing is
   * published on the host: the harness reaches them through `previewTarget`.
   */
  expose?: number[]
  labels?: Record<string, string>
}

/** Where the harness process connects to reach an exposed port of an environment. */
export interface PreviewTarget {
  host: string
  port: number
}

/** The most ports one environment may expose. */
export const MAX_EXPOSED_PORTS = 16

/** Problems with an `expose` list: each port an integer 1-65535, no duplicates, at most `MAX_EXPOSED_PORTS`. */
export function invalidExpose(expose: unknown): string[] {
  if (expose === undefined) return []
  if (!Array.isArray(expose)) return ['expose must be a list of ports']
  const issues: string[] = []
  if (expose.length > MAX_EXPOSED_PORTS) issues.push(`at most ${MAX_EXPOSED_PORTS} exposed ports`)
  const seen = new Set<number>()
  for (const p of expose) {
    if (!Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535) issues.push(`bad port: ${String(p)}`)
    else if (seen.has(p as number)) issues.push(`duplicate port: ${p}`)
    else seen.add(p as number)
  }
  return issues
}

/** What a direct network's name may be (before the runtime's prefix). */
export const DIRECT_NETWORK_RE = /^[a-z0-9][a-z0-9_.-]{0,55}$/

/** Problems with a spec's network settings: `egress`, `allowInternet` and `direct` exclude each other. */
export function invalidNetworkSpec(spec: Pick<EnvSpec, 'egress' | 'allowInternet' | 'direct'>): string[] {
  const issues: string[] = []
  if (spec.egress && spec.allowInternet) issues.push('egress and allowInternet exclude each other')
  if (spec.direct !== undefined) {
    if (spec.egress) issues.push('egress and direct exclude each other')
    if (spec.allowInternet) issues.push('allowInternet and direct exclude each other')
    if (!spec.direct || typeof spec.direct.network !== 'string' || !DIRECT_NETWORK_RE.test(spec.direct.network))
      issues.push(`direct.network must match ${DIRECT_NETWORK_RE}`)
  }
  return issues
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
  /** Run as this user (`uid:gid` or a name) instead of the container's. */
  user?: string
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

/** Options for a long-running process started with `spawn`. */
export interface SpawnOptions {
  env?: Record<string, string>
  workdir?: string
  /** Output as it arrives. Chunks are text (UTF-8, split on character boundaries). */
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
}

/**
 * A process running inside an environment, with its stdin open. It ends by itself, when its stdin
 * is closed and it exits, or with `kill`.
 */
export interface Process {
  /** Writes to the process's stdin. Rejects once the process has ended. */
  write(data: string | Uint8Array): Promise<void>
  /** Closes stdin. */
  end(): void
  /** Settles when the process has ended. `exitCode` is null when it was killed or its stream broke. */
  readonly exited: Promise<{ exitCode: number | null }>
  /** Kills the process (and its process group, when it leads one). Idempotent; resolves once it has ended. */
  kill(): Promise<void>
}

/** A file or directory copied into or out of an environment. */
export interface FileEntry {
  /** Relative POSIX path (no leading slash, no `..`), under the directory given to `copyIn` or `copyOut`. */
  path: string
  type: 'file' | 'dir'
  /** File content. Directories have none. */
  content?: Uint8Array
  /** Permission bits. Default 0644 for files, 0755 for directories. */
  mode?: number
  /** Owner. Default 0 (root). */
  uid?: number
  gid?: number
  /** Modification time, milliseconds since the epoch. */
  mtimeMs?: number
}

export interface ContainerRuntime {
  createEnv(spec: EnvSpec): Promise<EnvInfo>
  getEnv(id: string): Promise<EnvInfo | null>
  listEnvs(labels?: Record<string, string>): Promise<EnvInfo[]>
  exec(envId: string, cmd: string[], opts?: ExecOptions): Promise<ExecResult>
  logs(envId: string, opts?: { tail?: number }): Promise<string>
  /** The egress proxy's log, oldest first. Empty for an environment without `egress`. Optional. */
  egressLog?(envId: string): Promise<EgressLogEntry[]>
  /**
   * Where the harness connects to reach `port` of the environment's main container, for live
   * previews. Throws `NotFoundError` when the environment is gone or doesn't expose the port.
   * Optional: runtimes without it have no previews.
   */
  previewTarget?(envId: string, port: number): Promise<PreviewTarget>
  /**
   * Starts a long-running process in the main container, with stdin, stdout and stderr attached
   * (e.g. a REPL). Optional: runtimes without it can't host interactive processes.
   */
  spawn?(envId: string, cmd: string[], opts?: SpawnOptions): Promise<Process>
  /**
   * Copies files and directories into the main container under the absolute directory `dir`, which
   * must exist. Missing parent directories are created (owned by root) unless listed. Existing files
   * are replaced. Optional, like `spawn`.
   */
  copyIn?(envId: string, dir: string, entries: FileEntry[]): Promise<void>
  /**
   * Copies a file, or a directory and everything under it, out of the main container. Paths in the
   * result are relative to the parent of `path` (so copying `/work/a.txt` gives `a.txt`). A missing
   * path gives `[]`. Only regular files and directories are returned. Optional, like `spawn`.
   */
  copyOut?(envId: string, path: string): Promise<FileEntry[]>
  /** What this runtime supports. Optional: without it, nothing beyond the basics. */
  features?(): Promise<RuntimeFeatures>
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

/** Problems with volume mounts: volume names, relative subpaths without `..`, absolute container paths. */
export function invalidVolumeMounts(mounts: unknown): string[] {
  if (mounts === undefined) return []
  if (!Array.isArray(mounts)) return ['volumeMounts must be a list']
  const issues: string[] = []
  for (const m of mounts as VolumeMount[]) {
    if (!m || typeof m.volume !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(m.volume))
      issues.push(`bad volume name: ${String(m?.volume)}`)
    if (m?.subpath !== undefined && invalidEntryPath(m.subpath)) issues.push(`bad subpath: ${String(m.subpath)}`)
    if (typeof m?.containerPath !== 'string' || !m.containerPath.startsWith('/') || m.containerPath.includes('..'))
      issues.push(`container paths must be absolute: ${String(m?.containerPath)}`)
  }
  return issues
}

/** Why a `FileEntry` path is unusable (absolute, `..`, empty segments, NUL), or null when it's fine. */
export function invalidEntryPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return 'path must be a non-empty string'
  if (path.startsWith('/')) return `path must be relative: ${path}`
  if (path.includes('\0')) return 'path contains NUL'
  const parts = path.replace(/\/+$/, '').split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return `bad path: ${path}`
  return null
}
