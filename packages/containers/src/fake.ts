import { ConflictError, NotFoundError, ValidationError, newId, systemClock, type Clock } from '@mp/core'
import {
  ExecAbortedError,
  TIMEOUT_EXIT_CODE,
  type ContainerRuntime,
  type EnvInfo,
  type EnvSpec,
  type ExecOptions,
  type ExecResult,
  type FileEntry,
  type PreviewTarget,
  type Process,
  type RuntimeFeatures,
  type SpawnOptions,
  invalidEntryPath,
  invalidExpose,
  invalidNetworkSpec,
  invalidVolumeMounts,
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
  user?: string
  timeoutMs?: number
  at: string
}

export type FakeResponder = FakeResponse | ((call: FakeExecCall, env: FakeEnv) => FakeResponse | Promise<FakeResponse>)

/** Matches against the command joined with spaces, or a predicate on the argv. */
export type FakeMatcher = RegExp | string | ((cmd: string[]) => boolean)

/** A file or directory in a fake environment's filesystem. */
export interface FakeFile {
  type: 'file' | 'dir'
  content: Uint8Array
  mode: number
  uid: number
  gid: number
  mtimeMs: number
}

export interface FakeEnv {
  info: EnvInfo
  spec: EnvSpec
  logs: string[]
  /** Decisions made through `egressAllowed`, as the proxy would log them. */
  egress: EgressLogEntry[]
  /** The main container's filesystem as `copyIn`/`copyOut` and `writeFile` see it, by absolute path. */
  files: Map<string, FakeFile>
}

export interface FakeSpawnCall {
  envId: string
  cmd: string[]
  env?: Record<string, string>
  workdir?: string
  at: string
}

/** What a spawn handler drives: the fake process's side of stdin, stdout, stderr and its exit. */
export interface FakeProcessHost {
  call: FakeSpawnCall
  /** The live environment (its `files` can be changed, as a real process would). */
  env: FakeEnv
  stdout(text: string): void
  stderr(text: string): void
  /** Ends the process with an exit code (default 0). Ignored once ended. */
  exit(code?: number | null): void
  /** Called with each chunk written to stdin, as text. */
  onInput(cb: (text: string) => void): void
  /** Called when stdin is closed. */
  onEnd(cb: () => void): void
  /** Called when the process is killed, before it ends. */
  onKill(cb: () => void): void
  readonly ended: boolean
}

/**
 * Plays a spawned process. Without a matching handler, `cat` echoes its stdin and anything else
 * waits for stdin to close; both then exit 0.
 */
export type FakeSpawnHandler = (host: FakeProcessHost) => void

export interface FakeRuntimeOptions {
  clock?: Clock
  /** Answer for commands no rule matches. Default: exit 0, no output. */
  defaultResponse?: FakeResponder
  /**
   * Where `previewTarget` points for an exposed port. Default `127.0.0.1:<port>`, so a test can serve
   * the "environment" with a local server. `servePreview` overrides it per environment and port.
   */
  previewTarget?: (env: FakeEnv, port: number) => PreviewTarget
  /** What `features()` reports. Default: everything supported. */
  features?: RuntimeFeatures
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
   * it: through the egress allowlist when `egress` is set, anything with `allowInternet` or `direct` (not
   * logged), else nothing.
   * Decisions for proxied environments are added to `egressLog`.
   */
  egressAllowed(envId: string, host: string, port: number): boolean
  egressLog(envId: string): Promise<EgressLogEntry[]>
  previewTarget(envId: string, port: number): Promise<PreviewTarget>
  /** Points an exposed port of an environment at `target`, e.g. a local test server on port 0. */
  servePreview(envId: string, port: number, target: PreviewTarget): void
  spawn(envId: string, cmd: string[], opts?: SpawnOptions): Promise<Process>
  copyIn(envId: string, dir: string, entries: FileEntry[]): Promise<void>
  copyOut(envId: string, path: string): Promise<FileEntry[]>
  features(): Promise<RuntimeFeatures>
  /** Scripts spawned processes. Later handlers win over earlier ones. */
  onSpawn(match: FakeMatcher, handler: FakeSpawnHandler): FakeRuntime
  /** Every spawn call, in order. */
  readonly spawns: FakeSpawnCall[]
  /** Processes that haven't ended yet. */
  running(): number
  /** Writes a file into an environment's filesystem (creating parent directories), as a process in it would. */
  writeFile(envId: string, path: string, content: string | Uint8Array, opts?: Partial<Omit<FakeFile, 'type' | 'content'>>): void
  /** A file's content as text, or null when there is none. */
  readFile(envId: string, path: string): string | null
  /** Removes a file or a directory tree from an environment's filesystem. */
  removeFile(envId: string, path: string): void
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
  const spawnRules: { match: FakeMatcher; handler: FakeSpawnHandler }[] = []
  const spawns: FakeSpawnCall[] = []
  let live_ = 0
  let lastMtime = 0
  /** Distinct, increasing modification times, even when the clock stands still. */
  const mtime = () => {
    lastMtime = Math.max(clock.now(), lastMtime + 1)
    return lastMtime
  }

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
      const badNetwork = invalidNetworkSpec(spec)
      if (badNetwork.length) throw new ValidationError(badNetwork[0]!, badNetwork.length > 1 ? badNetwork : undefined)
      if (spec.egress) {
        const bad = invalidEgressEntries(spec.egress.allow ?? [])
        if (!Array.isArray(spec.egress.allow) || bad.length)
          throw new ValidationError('invalid egress allowlist', bad.length ? bad : undefined)
      }
      const badExpose = invalidExpose(spec.expose)
      if (badExpose.length) throw new ValidationError('invalid expose list', badExpose)
      const badMounts = invalidVolumeMounts(spec.volumeMounts)
      if (badMounts.length) throw new ValidationError('invalid volume mounts', badMounts)
      if (spec.volumeMounts?.some((m) => m.subpath) && !(opts.features?.volumeSubpath ?? true))
        throw new ValidationError('volume subpaths are not supported by this runtime')
      if ([...envs.values()].some((e) => e.info.name === spec.name))
        throw new ConflictError(`environment ${spec.name} already exists`)
      const info: EnvInfo = {
        id: newId('env', clock.now()),
        name: spec.name,
        status: 'running',
        labels: { ...spec.labels, 'mp.env': spec.name, 'mp.managed': 'true' },
        createdAt: clock.iso(),
      }
      const files = new Map<string, FakeFile>()
      for (const p of ['/', ...(spec.volumes ?? []), ...Object.keys(spec.tmpfs ?? {})]) mkdirs(files, p, 0)
      envs.set(info.id, { info, spec: structuredClone(spec), logs: [], egress: [], files })
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
        ...(o.user ? { user: o.user } : {}),
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

    spawns,

    async spawn(envId, cmd, o: SpawnOptions = {}) {
      const env = live(envId)
      if (env.info.status !== 'running') throw new ConflictError(`environment ${envId} is not running`)
      if (!cmd.length) throw new ValidationError('spawn needs a command')
      const call: FakeSpawnCall = {
        envId,
        cmd: [...cmd],
        ...(o.env ? { env: { ...o.env } } : {}),
        ...(o.workdir ? { workdir: o.workdir } : {}),
        at: clock.iso(),
      }
      spawns.push(call)
      const inputs: ((t: string) => void)[] = []
      const ends: (() => void)[] = []
      const kills: (() => void)[] = []
      let ended = false
      let stdinOpen = true
      let resolveExit!: (v: { exitCode: number | null }) => void
      const exited = new Promise<{ exitCode: number | null }>((r) => {
        resolveExit = r
      })
      live_++
      const finish = (code: number | null) => {
        if (ended) return
        ended = true
        live_--
        resolveExit({ exitCode: code })
      }
      const host: FakeProcessHost = {
        call,
        env,
        stdout: (text) => {
          if (!ended && text) o.onOutput?.({ stream: 'stdout', text })
        },
        stderr: (text) => {
          if (!ended && text) o.onOutput?.({ stream: 'stderr', text })
        },
        exit: (code = 0) => finish(code),
        onInput: (cb) => inputs.push(cb),
        onEnd: (cb) => ends.push(cb),
        onKill: (cb) => kills.push(cb),
        get ended() {
          return ended
        },
      }
      const rule = [...spawnRules].reverse().find((r) => matches(r.match, cmd))
      if (rule) rule.handler(host)
      else {
        if (cmd[0] === 'cat') host.onInput((t) => host.stdout(t))
        host.onEnd(() => host.exit(0))
      }
      const proc: Process = {
        async write(data) {
          if (ended || !stdinOpen) throw new ConflictError('the process has ended')
          const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
          // Delivered asynchronously, like a pipe.
          await Promise.resolve()
          for (const cb of inputs) cb(text)
        },
        end() {
          if (!stdinOpen) return
          stdinOpen = false
          queueMicrotask(() => {
            for (const cb of ends) cb()
          })
        },
        exited,
        async kill() {
          if (!ended) {
            for (const cb of kills) cb()
            finish(null)
          }
          await exited
        },
      }
      return proc
    },

    onSpawn(match, handler) {
      spawnRules.push({ match, handler })
      return runtime
    },

    running: () => live_,

    async features() {
      return { volumeSubpath: true, ...opts.features }
    },

    async copyIn(envId, dir, entries) {
      const env = live(envId)
      if (!dir.startsWith('/')) throw new ValidationError(`dir must be absolute: ${dir}`)
      const base = dir.replace(/\/+$/, '') || '/'
      const d = env.files.get(base)
      if (d?.type !== 'dir') throw new NotFoundError('directory', dir)
      const bad = entries.map((e) => invalidEntryPath(e.path)).filter((x): x is string => !!x)
      if (bad.length) throw new ValidationError('invalid entries', bad)
      for (const e of entries) {
        const abs = `${base === '/' ? '' : base}/${e.path.replace(/\/+$/, '')}`
        mkdirs(env.files, parentOf(abs), 0)
        const existing = env.files.get(abs)
        if (e.type === 'dir') {
          env.files.set(abs, {
            type: 'dir',
            content: new Uint8Array(),
            mode: e.mode ?? existing?.mode ?? 0o755,
            uid: e.uid ?? existing?.uid ?? 0,
            gid: e.gid ?? existing?.gid ?? 0,
            mtimeMs: e.mtimeMs ?? mtime(),
          })
        } else {
          if (existing?.type === 'dir') removeTree(env.files, abs)
          env.files.set(abs, {
            type: 'file',
            content: new Uint8Array(e.content ?? new Uint8Array()),
            mode: e.mode ?? 0o644,
            uid: e.uid ?? 0,
            gid: e.gid ?? 0,
            mtimeMs: e.mtimeMs ?? mtime(),
          })
        }
      }
    },

    async copyOut(envId, path) {
      const env = live(envId)
      const abs = path.replace(/\/+$/, '') || '/'
      const top = env.files.get(abs)
      if (!top) return []
      const name = abs === '/' ? '' : abs.slice(abs.lastIndexOf('/') + 1)
      const entry = (rel: string, f: FakeFile): FileEntry => ({
        path: rel,
        type: f.type,
        ...(f.type === 'file' ? { content: new Uint8Array(f.content) } : {}),
        mode: f.mode,
        uid: f.uid,
        gid: f.gid,
        mtimeMs: f.mtimeMs,
      })
      if (top.type === 'file') return [entry(name, top)]
      const out: FileEntry[] = name ? [entry(name, top)] : []
      const prefix = abs === '/' ? '/' : `${abs}/`
      for (const [p, f] of [...env.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (p === abs || !p.startsWith(prefix)) continue
        out.push(entry(`${name ? `${name}/` : ''}${p.slice(prefix.length)}`, f))
      }
      return out
    },

    writeFile(envId, path, content, o = {}) {
      const env = live(envId)
      mkdirs(env.files, parentOf(path), o.uid ?? 0)
      env.files.set(path, {
        type: 'file',
        content: typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content),
        mode: o.mode ?? 0o644,
        uid: o.uid ?? 0,
        gid: o.gid ?? 0,
        mtimeMs: o.mtimeMs ?? mtime(),
      })
    },

    readFile(envId, path) {
      const f = live(envId).files.get(path)
      return f?.type === 'file' ? new TextDecoder().decode(f.content) : null
    },

    removeFile(envId, path) {
      removeTree(live(envId).files, path)
    },

    envs: () =>
      [...envs.values()].map((e) => ({
        info: copy(e.info),
        spec: structuredClone(e.spec),
        logs: [...e.logs],
        egress: e.egress.map((l) => ({ ...l })),
        files: new Map([...e.files].map(([p, f]) => [p, { ...f, content: new Uint8Array(f.content) }])),
      })),

    egressAllowed(envId, host, port) {
      const env = live(envId)
      if (!env.spec.egress) return env.spec.allowInternet === true || env.spec.direct !== undefined
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

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

/** Creates `dir` and its missing ancestors as directories. */
function mkdirs(files: Map<string, FakeFile>, dir: string, uid: number) {
  const parts = dir.split('/').filter(Boolean)
  for (let i = 0; i <= parts.length; i++) {
    const p = `/${parts.slice(0, i).join('/')}`
    if (!files.has(p)) files.set(p, { type: 'dir', content: new Uint8Array(), mode: 0o755, uid, gid: uid, mtimeMs: 0 })
  }
}

function removeTree(files: Map<string, FakeFile>, path: string) {
  for (const p of [...files.keys()]) if (p === path || p.startsWith(`${path}/`)) files.delete(p)
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
