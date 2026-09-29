/**
 * The slice of the dockerode API this adapter uses. A real `new Docker()` satisfies it,
 * and tests pass a hand-written fake.
 */
export interface DockerLike {
  createNetwork(opts: Record<string, any>): Promise<unknown>
  getNetwork(id: string): {
    remove(opts?: Record<string, any>): Promise<unknown>
    connect(opts: Record<string, any>): Promise<unknown>
    disconnect(opts: Record<string, any>): Promise<unknown>
  }
  createContainer(opts: Record<string, any>): Promise<ContainerLike>
  getContainer(id: string): ContainerLike
  listContainers(opts?: Record<string, any>): Promise<ContainerSummaryLike[]>
  getImage(name: string): { inspect(): Promise<unknown> }
  pull(image: string, opts?: Record<string, any>): Promise<NodeJS.ReadableStream>
  buildImage(file: { context: string; src: string[] }, opts?: Record<string, any>): Promise<NodeJS.ReadableStream>
  modem: {
    demuxStream(stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void
    followProgress(stream: NodeJS.ReadableStream, onFinished: (err: Error | null, output: any[]) => void): void
  }
}

export interface ContainerLike {
  id: string
  start(opts?: Record<string, any>): Promise<unknown>
  inspect(opts?: Record<string, any>): Promise<ContainerInspectLike>
  remove(opts?: Record<string, any>): Promise<unknown>
  logs(opts: Record<string, any>): Promise<Buffer | NodeJS.ReadableStream>
  exec(opts: Record<string, any>): Promise<ExecLike>
}

export interface ExecLike {
  start(opts: Record<string, any>): Promise<NodeJS.ReadableStream & { destroy?(): void }>
  inspect(): Promise<{ ExitCode: number | null; Running: boolean; Pid?: number }>
}

export interface ContainerInspectLike {
  Id: string
  Name: string
  Created: string
  State: { Running: boolean; Status?: string }
  Config: { Labels: Record<string, string> | null }
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
}

export interface ContainerSummaryLike {
  Id: string
  Names: string[]
  Created: number
  State: string
  Labels: Record<string, string>
}
