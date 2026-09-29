import { PassThrough, Readable } from 'node:stream'
import Docker from 'dockerode'
import type { ContainerInspectLike, ContainerLike, ContainerSummaryLike, DockerLike, ExecLike } from '../src/docker-like.ts'

/** What a mocked exec does. `frames` are written as Docker multiplexed frames, in order. */
export interface MockExec {
  frames?: { stream: 'stdout' | 'stderr'; data: Buffer | string }[]
  exitCode?: number
  /** Never ends. */
  hang?: boolean
  /** Emit an error on the stream instead of ending. */
  streamError?: Error
}

export interface MockContainer {
  id: string
  name: string
  opts: Record<string, any>
  running: boolean
  removed: boolean
  created: string
  logs: Buffer
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export const frame = (stream: 'stdout' | 'stderr', data: Buffer | string) => {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const header = Buffer.alloc(8)
  header[0] = stream === 'stdout' ? 1 : 2
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

// The real modem's demuxing and progress parsing, without ever connecting to a daemon.
const realModem = new Docker({ socketPath: '/nonexistent/docker.sock' }).modem as unknown as DockerLike['modem']

/** A hand-written in-memory Docker: records every call and keeps just enough state. */
export class MockDocker implements DockerLike {
  calls: { method: string; args: unknown[] }[] = []
  images = new Set<string>()
  networks = new Map<string, Record<string, any>>()
  containers = new Map<string, MockContainer>()
  execs: { container: string; opts: Record<string, any>; stream?: PassThrough }[] = []
  execHandler: (cmd: string[], opts: Record<string, any>) => MockExec = () => ({ exitCode: 0 })
  /** Methods that throw once when called, e.g. `{ createContainer: new HttpError(500, 'x') }`. */
  failures: Record<string, Error> = {}
  pullOutput: any[] = [{ status: 'Pulling' }, { status: 'Done' }]
  private seq = 0

  modem = {
    demuxStream: (stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream) => {
      this.record('modem.demuxStream')
      realModem.demuxStream(stream, stdout, stderr)
    },
    followProgress: (stream: NodeJS.ReadableStream, cb: (err: Error | null, output: any[]) => void) =>
      realModem.followProgress(stream, cb),
  }

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args })
    const f = this.failures[method]
    if (f) {
      delete this.failures[method]
      throw f
    }
  }

  callsTo(method: string) {
    return this.calls.filter((c) => c.method === method).map((c) => c.args)
  }

  private find(idOrName: string) {
    const c = this.containers.get(idOrName) ?? [...this.containers.values()].find((x) => x.name === idOrName)
    return c && !c.removed ? c : undefined
  }

  async createNetwork(opts: Record<string, any>) {
    this.record('createNetwork', opts)
    if (this.networks.has(opts.Name)) throw new HttpError(409, 'network exists')
    this.networks.set(opts.Name, opts)
    return {}
  }

  getNetwork(id: string) {
    return {
      remove: async () => {
        this.record('network.remove', id)
        if (!this.networks.delete(id)) throw new HttpError(404, 'no such network')
        return {}
      },
      connect: async (opts: Record<string, any>) => {
        this.record('network.connect', id, opts)
        const net = this.networks.get(id)
        if (!net) throw new HttpError(404, 'no such network')
        if (!this.find(opts.Container)) throw new HttpError(404, `no such container: ${opts.Container}`)
        net.connected = [...(net.connected ?? []), opts.Container]
        return {}
      },
    }
  }

  async createContainer(opts: Record<string, any>) {
    this.record('createContainer', opts)
    if (this.find(opts.name)) throw new HttpError(409, 'name in use')
    const id = `c${++this.seq}`.padEnd(12, '0')
    this.containers.set(id, {
      id,
      name: opts.name,
      opts,
      running: false,
      removed: false,
      created: '2026-01-01T00:00:00.000Z',
      logs: Buffer.alloc(0),
    })
    return this.getContainer(id)
  }

  getContainer(idOrName: string): ContainerLike {
    const self = this
    const must = () => {
      const c = self.find(idOrName)
      if (!c) throw new HttpError(404, `no such container: ${idOrName}`)
      return c
    }
    return {
      id: idOrName,
      async start() {
        self.record('container.start', idOrName)
        must().running = true
        return {}
      },
      async inspect(): Promise<ContainerInspectLike> {
        self.record('container.inspect', idOrName)
        const c = must()
        return {
          Id: c.id,
          Name: `/${c.name}`,
          Created: c.created,
          State: { Running: c.running },
          Config: { Labels: c.opts.Labels ?? {} },
        }
      },
      async remove(opts?: Record<string, any>) {
        self.record('container.remove', idOrName, opts)
        const c = must()
        c.removed = true
        return {}
      },
      async logs(opts: Record<string, any>) {
        self.record('container.logs', idOrName, opts)
        return must().logs
      },
      async exec(opts: Record<string, any>): Promise<ExecLike> {
        self.record('container.exec', idOrName, opts)
        const c = must()
        if (!c.running) throw new HttpError(409, `container ${idOrName} is not running`)
        const entry: (typeof self.execs)[number] = { container: idOrName, opts }
        self.execs.push(entry)
        const behaviour = self.execHandler(opts.Cmd, opts)
        let finished = false
        return {
          async start(startOpts: Record<string, any>) {
            self.record('exec.start', startOpts)
            const stream = new PassThrough()
            entry.stream = stream
            setImmediate(() => {
              for (const f of behaviour.frames ?? []) {
                const buf = frame(f.stream, f.data)
                // Split every frame in two writes, to exercise reassembly.
                const cut = Math.max(1, Math.floor(buf.length / 2))
                stream.write(buf.subarray(0, cut))
                stream.write(buf.subarray(cut))
              }
              if (behaviour.streamError) stream.destroy(behaviour.streamError)
              else if (!behaviour.hang) {
                finished = true
                stream.end()
              }
            })
            return stream
          },
          async inspect() {
            self.record('exec.inspect')
            return { ExitCode: finished ? (behaviour.exitCode ?? 0) : null, Running: !finished }
          },
        }
      },
    }
  }

  async listContainers(opts?: Record<string, any>): Promise<ContainerSummaryLike[]> {
    this.record('listContainers', opts)
    const filters: string[] = opts?.filters?.label ?? []
    return [...this.containers.values()]
      .filter((c) => !c.removed)
      .filter((c) =>
        filters.every((f) => {
          const [k, v] = f.split('=', 2) as [string, string]
          return c.opts.Labels?.[k] === v
        }),
      )
      .map((c) => ({
        Id: c.id,
        Names: [`/${c.name}`],
        Created: Date.parse(c.created) / 1000,
        State: c.running ? 'running' : 'exited',
        Labels: c.opts.Labels ?? {},
      }))
  }

  getImage(name: string) {
    return {
      inspect: async () => {
        this.record('image.inspect', name)
        if (!this.images.has(name)) throw new HttpError(404, 'no such image')
        return {}
      },
    }
  }

  async pull(image: string) {
    this.record('pull', image)
    this.images.add(image)
    return Readable.from(this.pullOutput.map((o) => JSON.stringify(o) + '\n'))
  }

  async buildImage(file: { context: string; src: string[] }, opts?: Record<string, any>) {
    this.record('buildImage', file, opts)
    if (opts?.t) this.images.add(opts.t)
    return Readable.from([JSON.stringify({ stream: 'Step 1/1\n' }) + '\n'])
  }
}
