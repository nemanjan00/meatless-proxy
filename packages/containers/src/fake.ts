import { ConflictError, NotFoundError, ValidationError, newId, systemClock, type Clock } from '@mp/core'
import {
  ExecAbortedError,
  TIMEOUT_EXIT_CODE,
  type ContainerRuntime,
  type EnvInfo,
  type EnvSpec,
  type ExecOptions,
  type ExecResult,
  type PreviewTarget,
  invalidExpose,
} from './types.ts'
import { checkEgress, invalidEgressEntries, type EgressLogEntry } from './egress.ts'

/** What a scripted command answers. */
export interface FakeResponse {
  exitCode?: number
  stdout?: string
  stderr?: string
  /** Streamed through `onOutput` in this order. Defaults to `stdout` then `stderr`. */
  chunks?: { stream: 'stdout' | 'stderr'; text: string }[]
  /** How long the command "runs" (real milliseconds). A command longer than `timeoutMs` times out. */
  delayMs?: number
  /** Never finishes on its own: ends only by timeout or abort. */
  hang?: boolean
  /** Throw this instead of returning a result. */
  error?: Error
}

export interface FakeExecCall {
  envId: string
  cmd: string[]
  env?: Record<string, string>
  workdir?: string
  timeoutMs?: number
  at: string
}

export type FakeResponder = FakeResponse | ((call: FakeExecCall, env: FakeEnv) => FakeResponse | Promise<FakeResponse>)

/** Matches against the command joined with spaces, or a predicate on the argv. */
export type FakeMatcher = RegExp | string | ((cmd: string[]) => boolean)

export interface FakeEnv {
  info: EnvInfo
  spec: EnvSpec
  logs: string[]
  /** Decisions made through `egressAllowed`, as the proxy would log them. */
  egress: EgressLogEntry[]
}

export interface FakeRuntimeOptions {
  clock?: Clock
  /** Answer for commands no rule matches. Default: exit 0, no output. */
  defaultResponse?: FakeResponder
  /**
   * Where `previewTarget` points for an exposed port. Default `127.0.0.1:<port>`, so a test can serve
   * the "environment" with a local server. `servePreview` overrides it per environment and port.
   */
  previewTarget?: (env: FakeEnv, port: number) => PreviewTarget
}

export interface FakeRuntime extends ContainerRuntime {
  /** Scripts the answer for matching commands. Later rules win over earlier ones. */
  on(match: FakeMatcher, response: FakeResponder): FakeRuntime
  /** Every exec call, in order. */
  readonly calls: FakeExecCall[]
  /** Live (not destroyed) environments, with the spec they were created from. */
  envs(): FakeEnv[]
  /** Every spec passed to `createEnv`, including failed and destroyed ones. */
  readonly created: EnvSpec[]
  /** Adds text to an environment's logs. */
  appendLog(envId: string, text: string): void
  /** Marks an environment stopped (exec then fails with `ConflictError`). */
  stop(envId: string): void
  /** Makes the next `createEnv` fail with this error. */
  failNextCreate(err: Error): void
  /**
   * Whether a container of the environment could reach `host:port`, as the real runtime would decide
   * it: through the egress allowlist when `egress` is set, anything with `allowInternet`, else nothing.
   * Decisions for proxied environments are added to `egressLog`.
   */
  egressAllowed(envId: string, host: string, port: number): boolean
  egressLog(envId: string): Promise<EgressLogEntry[]>
  previewTarget(envId: string, port: number): Promise<PreviewTarget>
  /** Points an exposed port of an environment at `target`, e.g. a local test server on port 0. */
  servePreview(envId: string, port: number, target: PreviewTarget): void
}

const matches = (m: FakeMatcher, cmd: string[]) =>
  typeof m === 'function' ? m(cmd) : typeof m === 'string' ? cmd.join(' ').includes(m) : m.test(cmd.join(' '))

/** An in-memory `ContainerRuntime` for tests: tracks environments and records and scripts exec calls. */
export function fakeRuntime(opts: FakeRuntimeOptions = {}): FakeRuntime {
  const clock = opts.clock ?? systemClock
  const envs = new Map<string, FakeEnv>()
  const rules: { match: FakeMatcher; response: FakeResponder }[] = []
  const calls: FakeExecCall[] = []
  const created: EnvSpec[] = []
  let nextCreateError: Error | null = null
  const previewTargets = new Map<string, PreviewTarget>()

  const live = (envId: string) => {
    const env = envs.get(envId)
    if (!env) throw new NotFoundError('environment', envId)
    return env
  }
  const copy = (info: EnvInfo): EnvInfo => ({ ...info, labels: { ...info.labels } })

  const runtime: FakeRuntime = {
    calls,
    created,

    async createEnv(spec) {
      created.push(structuredClone(spec))
      if (nextCreateError) {
        const err = nextCreateError
        nextCreateError = null
        throw err
      }
      if (!spec.name) throw new ValidationError('environment needs a name')
      if (!spec.image && !spec.build) throw new ValidationError('environment needs an image or a build')
      if (spec.egress) {
        if (spec.allowInternet) throw new ValidationError('egress and allowInternet exclude each other')
        const bad = invalidEgressEntries(spec.egress.allow ?? [])
        if (!Array.isArray(spec.egress.allow) || bad.length)
          throw new ValidationError('invalid egress allowlist', bad.length ? bad : undefined)
      }
      const badExpose = invalidExpose(spec.expose)
      if (badExpose.length) throw new ValidationError('invalid expose list', badExpose)
      if ([...envs.values()].some((e) => e.info.name === spec.name))
        throw new ConflictError(`environment ${spec.name} already exists`)
      const info: EnvInfo = {
        id: newId('env', clock.now()),
        name: spec.name,
        status: 'running',
        labels: { ...spec.labels, 'mp.env': spec.name, 'mp.managed': 'true' },
        createdAt: clock.iso(),
      }
      envs.set(info.id, { info, spec: structuredClone(spec), logs: [], egress: [] })
      return copy(info)
    },

    async getEnv(id) {
      const env = envs.get(id)
      return env ? copy(env.info) : null
    },

    async listEnvs(labels) {
      return [...envs.values()]
        .filter((e) => Object.entries(labels ?? {}).every(([k, v]) => e.info.labels[k] === v))
        .map((e) => copy(e.info))
    },

    async exec(envId, cmd, o: ExecOptions = {}) {
      const env = live(envId)
      if (env.info.status !== 'running') throw new ConflictError(`environment ${envId} is not running`)
      if (!cmd.length) throw new ValidationError('exec needs a command')
      if (o.signal?.aborted) throw new ExecAbortedError()
      const call: FakeExecCall = {
        envId,
        cmd: [...cmd],
        ...(o.env ? { env: { ...o.env } } : {}),
        ...(o.workdir ? { workdir: o.workdir } : {}),
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
        at: clock.iso(),
      }
      calls.push(call)
      const rule = [...rules].reverse().find((r) => matches(r.match, cmd))
      const responder = rule?.response ?? opts.defaultResponse ?? {}
      const res = typeof responder === 'function' ? await responder(call, env) : responder
      if (res.error) throw res.error

      const delay = res.hang ? Number.POSITIVE_INFINITY : (res.delayMs ?? 0)
      const timeout = o.timeoutMs ?? Number.POSITIVE_INFINITY
      const timedOut = delay >= timeout && timeout !== Number.POSITIVE_INFINITY
      const wait = Math.min(delay, timeout)
      if (wait === Number.POSITIVE_INFINITY && !o.signal)
        throw new ValidationError('a hanging fake command needs a timeout or a signal')

      // Output streams before the command ends; a timed-out command only got to stream what it had.
      const chunks = res.chunks ?? [
        ...(res.stdout ? [{ stream: 'stdout' as const, text: res.stdout }] : []),
        ...(res.stderr ? [{ stream: 'stderr' as const, text: res.stderr }] : []),
      ]
      const streamed = timedOut && res.hang ? [] : chunks
      for (const c of streamed) o.onOutput?.({ ...c })

      if (wait > 0) await waitFor(wait, o.signal)
      else if (o.signal?.aborted) throw new ExecAbortedError()

      const collect = (s: 'stdout' | 'stderr') =>
        streamed
          .filter((c) => c.stream === s)
          .map((c) => c.text)
          .join('')
      const result: ExecResult = {
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : (res.exitCode ?? 0),
        stdout: collect('stdout'),
        stderr: collect('stderr'),
        timedOut,
        durationMs: Number.isFinite(wait) ? wait : 0,
      }
      return result
    },

    async logs(envId, o = {}) {
      const env = live(envId)
      const lines = env.logs.join('').split('\n')
      if (lines.at(-1) === '') lines.pop()
      const kept = o.tail === undefined ? lines : o.tail <= 0 ? [] : lines.slice(-o.tail)
      return kept.length ? kept.join('\n') + '\n' : ''
    },

    async destroyEnv(envId) {
      envs.delete(envId)
      for (const k of [...previewTargets.keys()]) if (k.startsWith(`${envId}:`)) previewTargets.delete(k)
    },

    async previewTarget(envId, port) {
      const env = live(envId)
      if (!(env.spec.expose ?? []).includes(port)) throw new NotFoundError('exposed port', `${envId}:${port}`)
      const set = previewTargets.get(`${envId}:${port}`)
      if (set) return { ...set }
      return opts.previewTarget ? opts.previewTarget(env, port) : { host: '127.0.0.1', port }
    },

    servePreview(envId, port, target) {
      const env = live(envId)
      if (!(env.spec.expose ?? []).includes(port)) throw new NotFoundError('exposed port', `${envId}:${port}`)
      previewTargets.set(`${envId}:${port}`, { ...target })
    },

    on(match, response) {
      rules.push({ match, response })
      return runtime
    },

    envs: () =>
      [...envs.values()].map((e) => ({
        info: copy(e.info),
        spec: structuredClone(e.spec),
        logs: [...e.logs],
        egress: e.egress.map((l) => ({ ...l })),
      })),

    egressAllowed(envId, host, port) {
      const env = live(envId)
      if (!env.spec.egress) return env.spec.allowInternet === true
      const d = checkEgress(env.spec.egress.allow, host, port)
      env.egress.push({
        at: clock.iso(),
        method: 'CONNECT',
        host,
        port,
        allowed: d.allowed,
        ...(d.reason ? { reason: d.reason } : {}),
      })
      return d.allowed
    },

    async egressLog(envId) {
      return live(envId).egress.map((l) => ({ ...l }))
    },

    appendLog(envId, text) {
      live(envId).logs.push(text)
    },

    stop(envId) {
      live(envId).info.status = 'stopped'
    },

    failNextCreate(err) {
      nextCreateError = err
    },
  }
  return runtime
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      reject(new ExecAbortedError())
    }
    const timer = Number.isFinite(ms)
      ? setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
      : null
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
