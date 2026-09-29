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
  /** Default false: no route to the internet or to the harness's own services. */
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
  timeoutMs?: number
  /** Streamed output as it arrives. */
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
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
  /** Removes the environment's containers, network and volumes. Idempotent. */
  destroyEnv(envId: string): Promise<void>
}
