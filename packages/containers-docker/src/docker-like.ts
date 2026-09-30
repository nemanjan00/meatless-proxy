/**
 * The slice of the dockerode API this adapter uses. A real `new Docker()` satisfies it,
 * and tests pass a hand-written fake.
 */
export interface DockerLike {
  createNetwork(opts: Record<string, any>): Promise<unknown>
  getNetwork(id: string): {
    inspect(opts?: Record<string, any>): Promise<NetworkInspectLike>
    remove(opts?: Record<string, any>): Promise<unknown>
    connect(opts: Record<string, any>): Promise<unknown>
    disconnect(opts: Record<string, any>): Promise<unknown>
  }
  createContainer(opts: Record<string, any>): Promise<ContainerLike>
  getContainer(id: string): ContainerLike
  listContainers(opts?: Record<string, any>): Promise<ContainerSummaryLike[]>
  getImage(name: string): { inspect(): Promise<unknown> }
  /** The daemon's version (`ApiVersion`, e.g. `1.45`). */
  version(): Promise<{ ApiVersion?: string; Version?: string }>
  pull(image: string, opts?: Record<string, any>): Promise<NodeJS.ReadableStream>
  buildImage(file: { context: string; src: string[] }, opts?: Record<string, any>): Promise<NodeJS.ReadableStream>
  modem: {
    demuxStream(stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void
    followProgress(stream: NodeJS.ReadableStream, onFinished: (err: Error | null, output: any[]) => void): void
  }
}

export interface NetworkInspectLike {
  Name: string
  Internal?: boolean
  Options?: Record<string, string> | null
  Labels?: Record<string, string> | null
  Containers?: Record<string, unknown> | null
}

export interface ContainerLike {
  id: string
  start(opts?: Record<string, any>): Promise<unknown>
  inspect(opts?: Record<string, any>): Promise<ContainerInspectLike>
  remove(opts?: Record<string, any>): Promise<unknown>
  logs(opts: Record<string, any>): Promise<Buffer | NodeJS.ReadableStream>
  exec(opts: Record<string, any>): Promise<ExecLike>
  /** Extracts a tar archive into the container at `opts.path`. */
  putArchive(file: Buffer | NodeJS.ReadableStream, opts: { path: string }): Promise<unknown>
  /** A tar archive of `opts.path`. */
  getArchive(opts: { path: string }): Promise<NodeJS.ReadableStream>
  /** One sample of the container's resource use (`stream: false`). Optional in fakes. */
  stats?(opts: Record<string, any>): Promise<ContainerStatsLike>
  /** The container's processes, from the host's `ps` (`ps_args`). Optional in fakes. */
  top?(opts?: Record<string, any>): Promise<{ Titles?: string[]; Processes?: string[][] }>
}

/** The fields of Docker's container stats this adapter reads. */
export interface ContainerStatsLike {
  read?: string
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number }
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number }
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> }
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>
  pids_stats?: { current?: number }
}

export interface ExecLike {
  start(opts: Record<string, any>): Promise<NodeJS.ReadableStream & { destroy?(): void }>
  inspect(): Promise<{ ExitCode: number | null; Running: boolean; Pid?: number }>
}

export interface ContainerInspectLike {
  Id: string
  Name: string
  Created: string
  /** The image ID. */
  Image?: string
  State: { Running: boolean; Status?: string; StartedAt?: string }
  /** `Image`: the reference the container was created from. */
  Config: { Labels: Record<string, string> | null; Image?: string }
  HostConfig?: { NanoCpus?: number; Memory?: number; PidsLimit?: number | null }
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
}

export interface ContainerSummaryLike {
  Id: string
  Names: string[]
  Created: number
  State: string
  Labels: Record<string, string>
  /** The reference the container was created from (Docker shows the ID once that tag is gone). */
  Image?: string
  ImageID?: string
}

/** The fields of Docker's image inspect this adapter reads. */
export interface ImageInspectLike {
  Id: string
  RepoTags?: string[] | null
  RepoDigests?: string[] | null
  Size?: number
  Created?: string
  Os?: string
  Architecture?: string
  Variant?: string
  Config?: { Labels?: Record<string, string> | null } | null
}
