import { readdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import {
  ExecAbortedError,
  TIMEOUT_EXIT_CODE,
  type ContainerRuntime,
  type EnvInfo,
  type EnvSpec,
  type ExecOptions,
  type ExecResult,
} from '@mp/containers'
import {
  ConflictError,
  MpError,
  NotFoundError,
  UnavailableError,
  ValidationError,
  errorMessage,
  silentLogger,
  systemClock,
  type Clock,
  type Logger,
} from '@mp/core'
import Docker from 'dockerode'
import type { ContainerInspectLike, ContainerSummaryLike, DockerLike } from './docker-like.ts'

export interface DockerRuntimeOptions {
  /** A dockerode instance (or anything shaped like one). Default: `new Docker({ socketPath })`. */
  docker?: DockerLike
  /** Docker socket, used when `docker` isn't given. Default: dockerode's default (`/var/run/docker.sock`). */
  socketPath?: string
  logger?: Logger
  clock?: Clock
  /** Prefix for container, network and image names. Default `mp-`. */
  namePrefix?: string
  /** Labels added to every container and network this runtime creates. */
  labels?: Record<string, string>
  /** Capabilities dropped from every container. Default: a set a normal build or test run doesn't need. */
  capDrop?: string[]
  /** Max processes per container. Default 4096. */
  pidsLimit?: number
  /** Output kept per stream and exec; the rest is dropped with a marker. Default 10 MiB. */
  maxOutputBytes?: number
}

export const DEFAULT_CAP_DROP = ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SYS_CHROOT', 'SETFCAP']

export const LABEL_ENV = 'mp.env'
export const LABEL_MANAGED = 'mp.managed'
export const LABEL_ROLE = 'mp.role'
export const LABEL_SERVICE = 'mp.service'

/** The requested feature isn't implemented by this adapter. */
export class NotImplementedError extends MpError {
  constructor(message: string) {
    super('not_implemented', message)
  }
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `ContainerRuntime` on Docker. Each environment is a main container plus service
 * containers on a private network of its own (internal, so no route out, unless
 * `allowInternet`). The environment id is the main container's name, `<prefix><name>`.
 */
export function dockerRuntime(opts: DockerRuntimeOptions = {}): ContainerRuntime {
  const docker: DockerLike =
    opts.docker ?? (new Docker(opts.socketPath ? { socketPath: opts.socketPath } : undefined) as DockerLike)
  const log = opts.logger ?? silentLogger
  const clock = opts.clock ?? systemClock
  const prefix = opts.namePrefix ?? 'mp-'
  const baseLabels = opts.labels ?? {}
  const capDrop = opts.capDrop ?? DEFAULT_CAP_DROP
  const pidsLimit = opts.pidsLimit ?? 4096
  const maxOutput = opts.maxOutputBytes ?? 10 * 1024 * 1024

  const envName = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id)
  const mainName = (name: string) => `${prefix}${name}`
  const serviceName = (name: string, svc: string) => `${prefix}${name}-${svc}`
  const networkName = (name: string) => `${prefix}${name}`

  const hardening = {
    Privileged: false,
    CapDrop: capDrop,
    SecurityOpt: ['no-new-privileges:true'],
    PidsLimit: pidsLimit,
    Init: true,
  }

  async function ensureImage(spec: EnvSpec): Promise<string> {
    if (spec.image) {
      try {
        await docker.getImage(spec.image).inspect()
        return spec.image
      } catch (e) {
        if (statusOf(e) !== 404) throw mapError(e, `image ${spec.image}`)
      }
      log.info('pulling image', { image: spec.image })
      const stream = await docker.pull(spec.image).catch((e) => {
        throw mapError(e, `image ${spec.image}`)
      })
      await follow(docker, stream, `pull ${spec.image}`)
      return spec.image
    }
    const build = spec.build!
    if (build.context.includes('://') || !isAbsolute(build.context)) {
      throw new NotImplementedError('only builds from an absolute local context directory are supported')
    }
    const tag = `${prefix}build/${spec.name}:latest`.toLowerCase()
    let src: string[]
    try {
      src = readdirSync(build.context)
    } catch (e) {
      throw new ValidationError(`build context ${build.context} is not readable: ${errorMessage(e)}`)
    }
    log.info('building image', { tag, context: build.context })
    const stream = await docker
      .buildImage(
        { context: build.context, src },
        { t: tag, ...(build.dockerfile ? { dockerfile: build.dockerfile } : {}), rm: true },
      )
      .catch((e) => {
        throw mapError(e, `build ${tag}`)
      })
    await follow(docker, stream, `build ${tag}`)
    return tag
  }

  async function create(spec: EnvSpec, labels: Record<string, string>): Promise<void> {
    const image = await ensureImage(spec)
    for (const svc of spec.services ?? []) {
      const svcImage = svc.image
      try {
        await docker.getImage(svcImage).inspect()
      } catch (e) {
        if (statusOf(e) !== 404) throw mapError(e, `image ${svcImage}`)
        await follow(docker, await docker.pull(svcImage), `pull ${svcImage}`)
      }
    }
    const net = networkName(spec.name)
    await docker.createNetwork({
      Name: net,
      Driver: 'bridge',
      Internal: !spec.allowInternet,
      CheckDuplicate: true,
      Labels: labels,
    })
    for (const svc of spec.services ?? []) {
      const c = await docker.createContainer({
        name: serviceName(spec.name, svc.name),
        Image: svc.image,
        Env: envList(svc.env),
        Labels: { ...labels, [LABEL_ROLE]: 'service', [LABEL_SERVICE]: svc.name },
        HostConfig: { ...hardening, NetworkMode: net, ...limits(spec) },
        NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [svc.name] } } },
      })
      await c.start()
    }
    const main = await docker.createContainer({
      name: mainName(spec.name),
      Image: image,
      Cmd: spec.command ?? ['sleep', 'infinity'],
      ...(spec.workdir ? { WorkingDir: spec.workdir } : {}),
      Env: envList(spec.env),
      Labels: { ...labels, [LABEL_ROLE]: 'main' },
      HostConfig: {
        ...hardening,
        NetworkMode: net,
        Binds: (spec.mounts ?? []).map((m) => `${m.hostPath}:${m.containerPath}${m.readOnly ? ':ro' : ''}`),
        ...limits(spec),
      },
      NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: ['main'] } } },
    })
    await main.start()
  }

  async function removeAll(name: string): Promise<void> {
    let containers: ContainerSummaryLike[]
    try {
      containers = await docker.listContainers({
        all: true,
        filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_ENV}=${name}`] },
      })
    } catch (e) {
      throw mapError(e, `environment ${name}`)
    }
    const ids = new Set(containers.map((c) => c.Id))
    // The main container is also removed by name, in case a listing missed it.
    const targets = [...ids, mainName(name)]
    for (const id of targets) {
      try {
        await docker.getContainer(id).remove({ force: true, v: true })
      } catch (e) {
        if (statusOf(e) !== 404) throw mapError(e, `container ${id}`)
      }
    }
    try {
      await docker.getNetwork(networkName(name)).remove()
    } catch (e) {
      if (statusOf(e) !== 404) throw mapError(e, `network ${networkName(name)}`)
    }
  }

  const runtime: ContainerRuntime = {
    async createEnv(spec) {
      validate(spec)
      const labels = { ...baseLabels, ...spec.labels, [LABEL_ENV]: spec.name, [LABEL_MANAGED]: 'true' }
      const id = mainName(spec.name)
      try {
        await docker.getContainer(id).inspect()
        throw new ConflictError(`environment ${spec.name} already exists`)
      } catch (e) {
        if (e instanceof ConflictError) throw e
        if (statusOf(e) !== 404) throw mapError(e, `environment ${spec.name}`)
      }
      try {
        await create(spec, labels)
      } catch (e) {
        log.warn('creating environment failed, cleaning up', { env: spec.name, err: errorMessage(e) })
        await removeAll(spec.name).catch((ce) => log.error('cleanup failed', { env: spec.name, err: errorMessage(ce) }))
        throw mapError(e, `environment ${spec.name}`)
      }
      log.info('environment created', { env: spec.name })
      const info = await runtime.getEnv(id)
      if (!info) throw new UnavailableError(`environment ${spec.name} disappeared after creation`)
      return info
    },

    async getEnv(id) {
      try {
        const c = await docker.getContainer(id).inspect()
        if (c.Config.Labels?.[LABEL_MANAGED] !== 'true' || c.Config.Labels?.[LABEL_ROLE] !== 'main') return null
        return infoFromInspect(c)
      } catch (e) {
        if (statusOf(e) === 404) return null
        throw mapError(e, `environment ${id}`)
      }
    },

    async listEnvs(labels = {}) {
      const filters = [`${LABEL_MANAGED}=true`, `${LABEL_ROLE}=main`, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)]
      try {
        const list = await docker.listContainers({ all: true, filters: { label: filters } })
        return list.map(infoFromSummary)
      } catch (e) {
        throw mapError(e, 'environments')
      }
    },

    async exec(envId, cmd, o: ExecOptions = {}) {
      if (!cmd.length) throw new ValidationError('exec needs a command')
      if (o.signal?.aborted) throw new ExecAbortedError()
      const started = clock.now()
      const container = docker.getContainer(envId)
      let exec: Awaited<ReturnType<typeof container.exec>>
      let stream: NodeJS.ReadableStream & { destroy?(): void }
      try {
        exec = await container.exec({
          Cmd: cmd,
          AttachStdout: true,
          AttachStderr: true,
          AttachStdin: false,
          Tty: false,
          Env: envList(o.env),
          ...(o.workdir ? { WorkingDir: o.workdir } : {}),
        })
        stream = await exec.start({ hijack: true, stdin: false })
      } catch (e) {
        throw mapError(e, `environment ${envId}`)
      }

      const out = collector('stdout', maxOutput, o.onOutput)
      const err = collector('stderr', maxOutput, o.onOutput)
      docker.modem.demuxStream(stream, out.writable, err.writable)

      type Outcome = { kind: 'done' } | { kind: 'timeout' } | { kind: 'abort' } | { kind: 'error'; error: unknown }
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const outcome = await new Promise<Outcome>((resolve) => {
        stream.on('end', () => resolve({ kind: 'done' }))
        stream.on('close', () => resolve({ kind: 'done' }))
        stream.on('error', (error) => resolve({ kind: 'error', error }))
        if (o.timeoutMs !== undefined) timer = setTimeout(() => resolve({ kind: 'timeout' }), o.timeoutMs)
        if (o.signal) {
          onAbort = () => resolve({ kind: 'abort' })
          o.signal.addEventListener('abort', onAbort, { once: true })
        }
      })
      if (timer) clearTimeout(timer)
      if (onAbort) o.signal?.removeEventListener('abort', onAbort)

      if (outcome.kind !== 'done') {
        // Docker has no API to kill an exec'd process: stop reading and leave it. The
        // environment's own limits still apply, and destroying the env ends it.
        stream.destroy?.()
        if (outcome.kind === 'abort') throw new ExecAbortedError()
        if (outcome.kind === 'error') throw mapError(outcome.error, `exec in ${envId}`)
        log.warn('exec timed out, abandoning it', { env: envId, cmd: cmd[0], timeoutMs: o.timeoutMs })
        return {
          exitCode: TIMEOUT_EXIT_CODE,
          stdout: out.text(),
          stderr: err.text(),
          timedOut: true,
          durationMs: clock.now() - started,
        }
      }

      let exitCode: number
      try {
        const info = await exec.inspect()
        exitCode = info.ExitCode ?? -1
      } catch (e) {
        throw mapError(e, `exec in ${envId}`)
      }
      const result: ExecResult = {
        exitCode,
        stdout: out.text(),
        stderr: err.text(),
        timedOut: false,
        durationMs: clock.now() - started,
      }
      return result
    },

    async logs(envId, o = {}) {
      try {
        const res = await docker
          .getContainer(envId)
          .logs({ stdout: true, stderr: true, follow: false, ...(o.tail !== undefined ? { tail: o.tail } : {}) })
        const buf = Buffer.isBuffer(res) ? res : await readAll(res)
        return demuxBuffer(buf)
      } catch (e) {
        throw mapError(e, `environment ${envId}`)
      }
    },

    async destroyEnv(envId) {
      const name = envName(envId)
      await removeAll(name)
      log.info('environment destroyed', { env: name })
    },
  }
  return runtime
}

function validate(spec: EnvSpec) {
  const issues: string[] = []
  if (!NAME_RE.test(spec.name ?? '')) issues.push(`name must match ${NAME_RE}`)
  if (!spec.image && !spec.build) issues.push('an image or a build is needed')
  for (const m of spec.mounts ?? []) {
    if (!isAbsolute(m.hostPath) || !isAbsolute(m.containerPath)) issues.push(`mount paths must be absolute: ${m.hostPath}`)
    if (m.hostPath.includes(':') || m.containerPath.includes(':')) issues.push(`mount paths can't contain ':': ${m.hostPath}`)
  }
  for (const svc of spec.services ?? []) {
    if (!NAME_RE.test(svc.name) || svc.name === 'main') issues.push(`bad service name: ${svc.name}`)
  }
  for (const k of [...Object.keys(spec.env ?? {}), ...(spec.services ?? []).flatMap((s) => Object.keys(s.env ?? {}))]) {
    if (!ENV_KEY_RE.test(k)) issues.push(`bad env var name: ${k}`)
  }
  if (spec.limits?.cpus !== undefined && !(spec.limits.cpus > 0)) issues.push('limits.cpus must be > 0')
  if (spec.limits?.memoryMb !== undefined && !(spec.limits.memoryMb > 0)) issues.push('limits.memoryMb must be > 0')
  if (issues.length) throw new ValidationError('invalid environment spec', issues)
}

function limits(spec: EnvSpec): Record<string, number> {
  const out: Record<string, number> = {}
  if (spec.limits?.cpus) out.NanoCpus = Math.round(spec.limits.cpus * 1e9)
  if (spec.limits?.memoryMb) {
    out.Memory = Math.round(spec.limits.memoryMb * 1024 * 1024)
    out.MemorySwap = out.Memory // no swap beyond the memory limit
  }
  return out
}

function envList(env?: Record<string, string>): string[] {
  return Object.entries(env ?? {}).map(([k, v]) => {
    if (!ENV_KEY_RE.test(k)) throw new ValidationError(`bad env var name: ${k}`)
    return `${k}=${v}`
  })
}

function infoFromInspect(c: ContainerInspectLike): EnvInfo {
  const labels = c.Config.Labels ?? {}
  return {
    id: c.Name.replace(/^\//, ''),
    name: labels[LABEL_ENV] ?? c.Name.replace(/^\//, ''),
    status: c.State.Running ? 'running' : 'stopped',
    labels,
    createdAt: new Date(c.Created).toISOString(),
  }
}

function infoFromSummary(c: ContainerSummaryLike): EnvInfo {
  const name = (c.Names[0] ?? c.Id).replace(/^\//, '')
  return {
    id: name,
    name: c.Labels[LABEL_ENV] ?? name,
    status: c.State === 'running' ? 'running' : 'stopped',
    labels: c.Labels,
    createdAt: new Date(c.Created * 1000).toISOString(),
  }
}

function collector(
  stream: 'stdout' | 'stderr',
  max: number,
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
) {
  const decoder = new StringDecoder('utf8')
  const parts: string[] = []
  let size = 0
  let truncated = false
  const push = (text: string) => {
    if (!text) return
    onOutput?.({ stream, text })
    if (truncated) return
    if (size + text.length > max) {
      parts.push(text.slice(0, max - size), `\n[output truncated after ${max} bytes]\n`)
      truncated = true
      return
    }
    parts.push(text)
    size += text.length
  }
  const writable = new Writable({
    write(chunk: Buffer, _enc, cb) {
      push(decoder.write(chunk))
      cb()
    },
  })
  return {
    writable,
    text: () => {
      push(decoder.end())
      return parts.join('')
    },
  }
}

/** Splits Docker's multiplexed log format (8-byte frame headers) back into text. Plain text passes through. */
export function demuxBuffer(buf: Buffer): string {
  const looksMuxed = buf.length >= 8 && buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0
  if (!looksMuxed) return buf.toString('utf8')
  const parts: Buffer[] = []
  let i = 0
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4)
    parts.push(buf.subarray(i + 8, i + 8 + len))
    i += 8 + len
  }
  return Buffer.concat(parts).toString('utf8')
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
  return Buffer.concat(chunks)
}

function follow(docker: DockerLike, stream: NodeJS.ReadableStream, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err, output) => {
      if (err) return reject(mapError(err, what))
      const failed = (output ?? []).find((o) => o && (o.error || o.errorDetail))
      if (failed) return reject(new UnavailableError(`${what} failed: ${failed.error ?? failed.errorDetail?.message}`))
      resolve()
    })
  })
}

function statusOf(e: unknown): number | undefined {
  return typeof e === 'object' && e && 'statusCode' in e ? Number((e as { statusCode: unknown }).statusCode) : undefined
}

/** Docker API errors to harness errors: 404 not found, 409 conflict, socket trouble unavailable. */
export function mapError(e: unknown, what: string): Error {
  if (e instanceof MpError) return e
  const status = statusOf(e)
  const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
  const msg = errorMessage(e)
  if (status === 404) return new NotFoundError(what, undefined, { cause: msg })
  if (status === 409) return new ConflictError(`${what}: ${msg}`)
  if (status === 400) return new ValidationError(`${what}: ${msg}`)
  if (['ECONNREFUSED', 'ENOENT', 'EACCES', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code) || (status && status >= 500)) {
    return new UnavailableError(`docker: ${what}: ${msg}`)
  }
  return e instanceof Error ? e : new Error(msg)
}
