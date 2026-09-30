import { Duplex, PassThrough, Readable } from 'node:stream'
import Docker from 'dockerode'
import type { ContainerInspectLike, ContainerLike, ContainerSummaryLike, DockerLike, ExecLike } from '../src/docker-like.ts'
import { packTar, unpackTar, type TarEntry } from '../src/tar.ts'

/** What a mocked exec does. `frames` are written as Docker multiplexed frames, in order. */
export interface MockExec {
  frames?: { stream: 'stdout' | 'stderr'; data: Buffer | string }[]
  exitCode?: number
  /** Never ends. */
  hang?: boolean
  /** Emit an error on the stream instead of ending. */
  streamError?: Error
  /**
   * An interactive exec (stdin attached): called once the stream is open, with what stdin receives,
   * a way to send frames back, and a way to end with an exit code.
   */
  interactive?: (io: {
    onInput(cb: (text: string) => void): void
    onStdinEnd(cb: () => void): void
    send(stream: 'stdout' | 'stderr', data: string): void
    end(exitCode?: number): void
  }) => void
}

export interface MockContainer {
  id: string
  name: string
  opts: Record<string, any>
  running: boolean
  removed: boolean
  created: string
  logs: Buffer
  /** The container's filesystem as the archive API sees it, by absolute path. */
  files: Map<string, TarEntry>
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
  apiVersion = '1.47'
  /** Labels of images, as `image.inspect` reports them. */
  imageLabels = new Map<string, Record<string, string>>()

  /** A made-up, stable image ID for a reference. */
  imageIdOf(ref: string | undefined): string | undefined {
    return ref ? `sha256:${Buffer.from(ref).toString('hex').padEnd(64, '0').slice(0, 64)}` : undefined
  }
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

  /** A container's networks with made-up addresses: its own `NetworkMode`, and every network it was connected to. */
  networksOf(c: MockContainer): Record<string, { IPAddress: string }> {
    const names = [...this.networks.keys()]
    const out: Record<string, { IPAddress: string }> = {}
    const add = (net: string) => {
      out[net] = { IPAddress: `172.30.${names.indexOf(net) + 1}.${[...this.containers.keys()].indexOf(c.id) + 2}` }
    }
    if (c.opts.HostConfig?.NetworkMode && this.networks.has(c.opts.HostConfig.NetworkMode)) add(c.opts.HostConfig.NetworkMode)
    for (const [name, net] of this.networks) if ((net.connected ?? []).some((x: string) => x === c.name || x === c.id)) add(name)
    return out
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
      inspect: async () => {
        this.record('network.inspect', id)
        const net = this.networks.get(id)
        if (!net) throw new HttpError(404, 'no such network')
        return {
          Name: id,
          Internal: net.Internal === true,
          Options: net.Options ?? {},
          Labels: net.Labels ?? {},
          Containers: Object.fromEntries((net.connected ?? []).map((c: string) => [c, {}])),
        }
      },
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
        if ((net.connected ?? []).includes(opts.Container)) throw new HttpError(403, 'endpoint already exists in network')
        net.connected = [...(net.connected ?? []), opts.Container]
        return {}
      },
      disconnect: async (opts: Record<string, any>) => {
        this.record('network.disconnect', id, opts)
        const net = this.networks.get(id)
        if (!net) throw new HttpError(404, 'no such network')
        if (!(net.connected ?? []).includes(opts.Container)) throw new HttpError(404, 'not connected')
        net.connected = net.connected.filter((c: string) => c !== opts.Container)
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
      files: new Map([['/', { path: '/', type: 'dir' }]]),
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
        const c = must()
        c.running = true
        // Like the real sidecar, the egress proxy says so on stderr once it's listening.
        if ((c.opts.Cmd ?? []).includes('-e') && String(c.opts.Cmd?.at(-1) ?? '').includes('createEgressProxy'))
          c.logs = Buffer.concat([c.logs, frame('stderr', 'egress proxy listening on 3128\n')])
        return {}
      },
      async inspect(): Promise<ContainerInspectLike> {
        self.record('container.inspect', idOrName)
        const c = must()
        return {
          Id: c.id,
          Name: `/${c.name}`,
          Created: c.created,
          Image: self.imageIdOf(c.opts.Image),
          State: { Running: c.running, StartedAt: c.running ? c.created : '0001-01-01T00:00:00Z' },
          Config: { Labels: c.opts.Labels ?? {}, Image: c.opts.Image },
          HostConfig: c.opts.HostConfig ?? {},
          NetworkSettings: { Networks: self.networksOf(c) },
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
      async putArchive(file: Buffer | NodeJS.ReadableStream, opts: { path: string }) {
        self.record('container.putArchive', idOrName, opts)
        const c = must()
        if (c.files.get(opts.path)?.type !== 'dir') throw new HttpError(404, `Could not find the file ${opts.path} in container`)
        const buf = Buffer.isBuffer(file) ? file : Buffer.concat(await Readable.from(file as any).toArray())
        const base = opts.path === '/' ? '' : opts.path.replace(/\/+$/, '')
        for (const e of unpackTar(buf)) c.files.set(`${base}/${e.path}`, { ...e, path: `${base}/${e.path}` })
        return {}
      },
      async getArchive(opts: { path: string }) {
        self.record('container.getArchive', idOrName, opts)
        const c = must()
        const abs = opts.path.replace(/\/+$/, '') || '/'
        const top = c.files.get(abs)
        if (!top) throw new HttpError(404, `Could not find the file ${opts.path} in container`)
        const parent = abs.slice(0, abs.lastIndexOf('/'))
        const entries = [...c.files.values()]
          .filter((e) => e.path === abs || e.path.startsWith(`${abs}/`))
          .map((e) => ({ ...e, path: e.path.slice(parent.length + 1) }))
        return Readable.from([packTar(entries)])
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
            if (behaviour.interactive) {
              const inputs: ((t: string) => void)[] = []
              const ends: (() => void)[] = []
              const pending: string[] = []
              let exitCode = 0
              const duplex = new Duplex({
                read() {},
                write(chunk, _enc, cb) {
                  // Like a pipe: input waits until the process reads it.
                  if (inputs.length) for (const f of inputs) f(String(chunk))
                  else pending.push(String(chunk))
                  cb()
                },
                final(cb) {
                  for (const f of ends) f()
                  cb()
                },
              })
              setImmediate(() =>
                behaviour.interactive!({
                  onInput: (cb) => {
                    inputs.push(cb)
                    for (const t of pending.splice(0)) cb(t)
                  },
                  onStdinEnd: (cb) => ends.push(cb),
                  send: (stream, data) => duplex.push(frame(stream, data)),
                  end: (code = 0) => {
                    exitCode = code
                    finished = true
                    duplex.push(null)
                  },
                }),
              )
              behaviour.exitCode = undefined
              Object.defineProperty(behaviour, 'exitCode', { get: () => exitCode })
              return duplex as unknown as PassThrough
            }
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
        Image: c.opts.Image,
        ImageID: this.imageIdOf(c.opts.Image),
      }))
  }

  async version() {
    this.record('version')
    return { ApiVersion: this.apiVersion, Version: '29.0.0' }
  }

  getImage(name: string) {
    return {
      inspect: async () => {
        this.record('image.inspect', name)
        const ref = [...this.images].find((i) => i === name || this.imageIdOf(i) === name)
        if (!ref) throw new HttpError(404, 'no such image')
        return {
          Id: this.imageIdOf(ref),
          RepoTags: [ref],
          RepoDigests: ref.includes('build/') ? [] : [`${ref.split(':')[0]}@sha256:${'ab'.repeat(32)}`],
          Size: 123_456_789,
          Created: '2026-09-01T10:00:00.000000000Z',
          Os: 'linux',
          Architecture: 'arm',
          Variant: 'v8',
          Config: { Labels: this.imageLabels.get(ref) ?? null },
        }
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
