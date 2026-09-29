import { createHash } from 'node:crypto'
import { UnavailableError, ValidationError, errorMessage, silentLogger, systemClock, type Clock, type Logger } from '@mp/core'
import type { ContainerRuntime, EnvSpec } from '@mp/containers'
import type { FilesService } from '@mp/files'
import type { Actor } from '@mp/store'
import { Kernel, LANGUAGES, type CellOutcome, type Language } from './kernel.ts'
import { FILES_DIR, copyWorkspace, mountWorkspace, type Box, type FileChange, type Workspace } from './workspace.ts'

/** Label on sandbox containers: the employee they belong to. */
export const LABEL_SANDBOX = 'mp.sandbox'
/** Label on sandbox containers: the signature of their file mounts. */
export const LABEL_MOUNTS = 'mp.sandbox.mounts'

export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 5 * 60_000
export const DEFAULT_IDLE_MS = 15 * 60_000
/** Characters kept per output stream (and for the result). */
export const DEFAULT_MAX_OUTPUT = 20_000
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024

export interface SandboxOptions {
  runtime: ContainerRuntime
  files: FilesService
  /** An image with `python3` and `node` (see docker/sandbox/Dockerfile). */
  image: string
  clock?: Clock
  logger?: Logger
  /**
   * The named volume that holds the files storage's root (`<volume>/<employeeId>/…`), for mount mode.
   * Without it, or when the runtime can't mount volume subpaths, files are copied in and out.
   */
  filesVolume?: string
  /** The sandbox user, `uid:gid`. Default `1000:1000` (the harness's own, so files on the volume stay writable by both). */
  user?: string
  limits?: { cpus?: number; memoryMb?: number; pids?: number }
  /**
   * Hosts an employee's sandbox may reach through the egress proxy (e.g. PyPI): a list, or the list for
   * an employee (its network setting). Default: no network at all. A change recreates the container at
   * its next run.
   */
  egress?: string[] | ((employeeId: string) => Promise<string[]> | string[])
  /** Kernels (and then containers) unused this long are stopped. Default 15 minutes. */
  idleMs?: number
  /** How often idle kernels are looked for. Default one minute; 0 turns the timer off (call `reapIdle`). */
  reapIntervalMs?: number
  maxOutputChars?: number
  maxFileBytes?: number
  /** A readable, unique name for an employee's container (`mp-<name>-sandbox`). Default: the employee id. */
  nameFor?: (employeeId: string) => Promise<string> | string
}

export interface RunRequest {
  employeeId: string
  sessionId: string
  language: Language
  code: string
  /** Default 30 s, at most 5 min. */
  timeoutMs?: number
  /** Run in a throwaway kernel: nothing from earlier cells, nothing kept. */
  fresh?: boolean
  signal?: AbortSignal
  /** Who file changes are attributed to (the session). */
  actor?: Actor
}

export interface RunResult {
  stdout: string
  stderr: string
  /** The repr of the cell's last expression, like a REPL. */
  result?: string
  /** The error the cell raised, or why it didn't finish (a timeout, a dead kernel). */
  error?: string
  /** Files in /work/files (and write shares) the cell created, changed or deleted. */
  files_changed: FileChange[]
  duration_ms: number
  /** The kernel's state was lost (timeout, crash, restart). */
  state_lost?: boolean
  notes?: string[]
}

export interface Sandbox {
  /** How files get into sandboxes: mounted from the files volume, or copied. */
  mode(): Promise<'mount' | 'copy'>
  run(req: RunRequest): Promise<RunResult>
  /** Stops a session's kernels (one language, or all). Returns the languages that had one. */
  reset(sessionId: string, language?: Language): Promise<Language[]>
  /** The session ended: its kernels go. */
  endSession(sessionId: string): Promise<void>
  /** Whether a session has a kernel. */
  hasSession(sessionId: string): boolean
  /** Stops kernels, and removes containers, idle for longer than `idleMs`. */
  reapIdle(): Promise<{ kernels: number; containers: number }>
  /** Stops every kernel and removes the sandbox containers this process started. */
  close(): Promise<void>
}

interface BoxState extends Box {
  signature: string
  busy: number
  lastUsed: number
}

interface KernelState {
  kernel: Kernel
  employeeId: string
  sessionId: string
  lastUsed: number
}

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

/** `<name>-sandbox`, at most 45 characters, so `mp-<…>-proxy` and friends fit Docker's limits. */
export function sandboxName(base: string, employeeId: string): string {
  const b = clean(base) || clean(employeeId) || 'employee'
  if (b.length <= 37) return `${b}-sandbox`
  const h = createHash('sha256').update(employeeId).digest('hex').slice(0, 6)
  return `${b.slice(0, 30).replace(/-+$/, '')}-${h}-sandbox`
}

/** Keeps the start of long output and says how much was cut. */
export function truncate(text: string, max: number, total = text.length): string {
  if (total <= max && text.length <= max) return text
  const kept = text.slice(0, max)
  return `${kept}\n… [truncated: ${Math.max(total, text.length) - kept.length} more characters]`
}

/** Serializes async work per key. */
function lockMap() {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return next
  }
}

/**
 * Runs code for employees in sandbox containers: one container per employee (`mp-<employee>-sandbox`,
 * no network unless `egress`, read-only root, non-root user, CPU, memory and process limits, no
 * secrets), one long-lived kernel per session and language inside it. The employee's files are at
 * /work/files and shares under /work/shared.
 */
export function createSandbox(opts: SandboxOptions): Sandbox {
  const { runtime, files } = opts
  const clock = opts.clock ?? systemClock
  const log = opts.logger ?? silentLogger
  const user = opts.user ?? '1000:1000'
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
  const maxOutput = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT
  const boxes = new Map<string, BoxState>()
  const kernels = new Map<string, KernelState>()
  const bySession = lockMap()
  const byEmployee = lockMap()
  const syncLock = lockMap()
  const kernelKey = (sessionId: string, language: Language) => `${sessionId}:${language}`

  let workspace: Promise<Workspace> | null = null
  const getWorkspace = () => {
    workspace ??= (async () => {
      const base = {
        runtime,
        files,
        logger: log,
        user,
        maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
        maxChanges: 500,
      }
      let why = ''
      if (!opts.filesVolume) why = 'no files volume is configured'
      else if (!files.storage.localPath) why = 'file storage is not a local directory'
      else if (!runtime.features) why = 'the container runtime reports no features'
      else if (!(await runtime.features()).volumeSubpath) why = 'the container runtime cannot mount volume subpaths'
      if (!why) {
        log.info('sandbox files: mounted from the files volume', { volume: opts.filesVolume })
        return mountWorkspace({ ...base, volume: opts.filesVolume! })
      }
      log.info('sandbox files: copied in and out', { reason: why })
      return copyWorkspace(base)
    })().catch((e) => {
      workspace = null
      throw e
    })
    return workspace
  }

  const killKernel = async (key: string) => {
    const k = kernels.get(key)
    if (!k) return
    kernels.delete(key)
    await k.kernel.kill().catch((e) => log.warn('sandbox: could not stop a kernel', { key, err: errorMessage(e) }))
  }

  const dropBox = async (employeeId: string) => {
    for (const [key, k] of [...kernels]) if (k.employeeId === employeeId) await killKernel(key)
    const box = boxes.get(employeeId)
    boxes.delete(employeeId)
    ;(await workspace)?.forget(employeeId)
    if (box)
      await runtime
        .destroyEnv(box.envId)
        .catch((e) => log.warn('sandbox: could not remove a container', { err: errorMessage(e) }))
  }

  const egressOf = async (employeeId: string): Promise<string[]> =>
    typeof opts.egress === 'function' ? [...(await opts.egress(employeeId))] : [...(opts.egress ?? [])]

  const createBox = async (
    employeeId: string,
    ws: Workspace,
    spec: Partial<EnvSpec>,
    signature: string,
    egress: string[],
  ): Promise<BoxState> => {
    const contactId = await files.contactOf(employeeId)
    // Containers left by an earlier process: their kernels and copied files are unknown, so start over.
    for (const e of await runtime.listEnvs({ [LABEL_SANDBOX]: employeeId })) await runtime.destroyEnv(e.id)
    const name = sandboxName(String((await opts.nameFor?.(employeeId)) ?? employeeId), employeeId)
    const info = await runtime.createEnv({
      name,
      image: opts.image,
      user,
      readOnlyRootfs: true,
      volumes: ['/work'],
      tmpfs: { '/tmp': { sizeMb: 256 } },
      workdir: FILES_DIR,
      limits: { cpus: opts.limits?.cpus ?? 1, memoryMb: opts.limits?.memoryMb ?? 1024, pids: opts.limits?.pids ?? 256 },
      ...(egress.length ? { egress: { allow: egress } } : {}),
      ...spec,
      labels: { [LABEL_SANDBOX]: employeeId, 'mp.employee': employeeId, [LABEL_MOUNTS]: signature },
    })
    const box: BoxState = { employeeId, contactId, envId: info.id, signature, busy: 0, lastUsed: clock.now() }
    await ws.attached(box)
    boxes.set(employeeId, box)
    log.info('sandbox: container started', { employeeId, env: info.id, mode: ws.mode })
    return box
  }

  /** The employee's container, running and with the right mounts; recreated when it died or the shares changed. */
  const ensureBox = (employeeId: string, notes: string[]) =>
    byEmployee(employeeId, async () => {
      const ws = await getWorkspace()
      const contactId = await files.contactOf(employeeId)
      const { spec, signature: mounts } = await ws.containerSpec(employeeId, contactId)
      const egress = await egressOf(employeeId)
      const signature = createHash('sha256')
        .update(JSON.stringify([mounts, egress]))
        .digest('hex')
        .slice(0, 16)
      const box = boxes.get(employeeId)
      if (box) {
        const info = await runtime.getEnv(box.envId).catch(() => null)
        if (info?.status !== 'running') {
          notes.push('the sandbox container had stopped, so it was started again: variables from earlier cells are gone')
          await dropBox(employeeId)
        } else if (box.signature !== signature) {
          if (box.busy === 0) {
            notes.push(
              'files shared with you or your network access changed, so the sandbox restarted: variables from earlier cells are gone',
            )
            await dropBox(employeeId)
          } else
            notes.push('files shared with you or your network access changed: that applies once the sandbox is idle and restarts')
        }
        const still = boxes.get(employeeId)
        if (still) return still
      }
      return createBox(employeeId, ws, spec, signature, egress)
    })

  const kernelFor = async (box: BoxState, req: RunRequest, notes: string[]) => {
    const key = kernelKey(req.sessionId, req.language)
    const existing = kernels.get(key)
    if (existing?.kernel.alive && existing.employeeId === box.employeeId) return { kernel: existing.kernel, lost: false }
    let lost = false
    if (existing) {
      notes.push(`the ${req.language} kernel had stopped, so a new one was started: variables from earlier cells are gone`)
      lost = true
      await killKernel(key)
    }
    const kernel = await Kernel.start(runtime, box.envId, req.language, { workdir: FILES_DIR, maxChars: maxOutput })
    kernels.set(key, { kernel, employeeId: box.employeeId, sessionId: req.sessionId, lastUsed: clock.now() })
    return { kernel, lost }
  }

  const describe = (o: CellOutcome, timeoutMs: number): string | undefined => {
    if (o.kind === 'timeout')
      return `timed out after ${Math.round(timeoutMs / 1000)} s: the kernel was stopped and will restart on the next run, so variables and imports from earlier cells are gone`
    if (o.kind === 'died')
      return `the kernel died${o.exitCode !== null ? ` (exit code ${o.exitCode}${o.exitCode === 137 ? ', probably out of memory' : ''})` : ''}: variables and imports from earlier cells are gone`
    if (o.kind === 'aborted') return 'cancelled: the kernel was stopped, so variables from earlier cells are gone'
    return undefined
  }

  const sandbox: Sandbox = {
    async mode() {
      return (await getWorkspace()).mode
    },

    run(req) {
      if (!LANGUAGES.includes(req.language)) throw new ValidationError(`language must be one of ${LANGUAGES.join(', ')}`)
      if (typeof req.code !== 'string') throw new ValidationError('code must be a string')
      if (!runtime.spawn) throw new UnavailableError('this container runtime cannot run code')
      const timeoutMs = Math.min(Math.max(1000, Math.round(req.timeoutMs ?? DEFAULT_TIMEOUT_MS)), MAX_TIMEOUT_MS)
      // One cell at a time per session, like a notebook.
      return bySession(req.sessionId, async () => {
        const started = clock.now()
        const notes: string[] = []
        const box = await ensureBox(req.employeeId, notes)
        box.busy++
        let result: RunResult
        try {
          const ws = await getWorkspace()
          const fresh = req.fresh === true
          let lost = false
          let kernel: Kernel
          if (fresh) kernel = await Kernel.start(runtime, box.envId, req.language, { workdir: FILES_DIR, maxChars: maxOutput })
          else ({ kernel, lost } = await kernelFor(box, req, notes))
          const snapshot = await syncLock(req.employeeId, () => ws.before(box))
          const outcome = await kernel.run(req.code, timeoutMs, req.signal)
          if (fresh) await kernel.kill()
          else if (outcome.kind !== 'done') {
            lost = true
            await killKernel(kernelKey(req.sessionId, req.language))
          } else {
            const k = kernels.get(kernelKey(req.sessionId, req.language))
            if (k) k.lastUsed = clock.now()
          }
          const synced = await syncLock(req.employeeId, () => ws.after(box, snapshot, req.actor))
          notes.push(...synced.notes)
          const f = outcome.kind === 'done' ? outcome.frame : undefined
          const stdout = `${f?.stdout ?? ''}${outcome.rawStdout}`
          const stderr = `${f?.stderr ?? ''}${outcome.rawStderr}`
          const stdoutTotal = (f?.stdoutTotal ?? 0) + outcome.rawStdout.length
          const stderrTotal = (f?.stderrTotal ?? 0) + outcome.rawStderr.length
          const error = f?.error ?? describe(outcome, timeoutMs)
          result = {
            stdout: truncate(stdout, maxOutput, stdoutTotal),
            stderr: truncate(stderr, maxOutput, stderrTotal),
            ...(f?.result !== undefined ? { result: truncate(f.result, maxOutput, f.resultTotal) } : {}),
            ...(error ? { error } : {}),
            files_changed: synced.changes,
            duration_ms: clock.now() - started,
            ...(lost ? { state_lost: true } : {}),
            ...(notes.length ? { notes } : {}),
          }
        } finally {
          box.busy--
          box.lastUsed = clock.now()
        }
        return result
      })
    },

    async reset(sessionId, language) {
      const langs = language ? [language] : [...LANGUAGES]
      const had: Language[] = []
      for (const l of langs) {
        if (!kernels.has(kernelKey(sessionId, l))) continue
        had.push(l)
        await bySession(sessionId, () => killKernel(kernelKey(sessionId, l)))
      }
      return had
    },

    async endSession(sessionId) {
      await sandbox.reset(sessionId)
    },

    hasSession(sessionId) {
      return LANGUAGES.some((l) => kernels.has(kernelKey(sessionId, l)))
    },

    async reapIdle() {
      const now = clock.now()
      let k = 0
      let c = 0
      for (const [key, st] of [...kernels]) {
        const box = boxes.get(st.employeeId)
        if (now - st.lastUsed < idleMs || (box && box.busy > 0)) continue
        await bySession(st.sessionId, () => killKernel(key))
        k++
      }
      for (const [employeeId, box] of [...boxes]) {
        if (box.busy > 0 || now - box.lastUsed < idleMs) continue
        if ([...kernels.values()].some((x) => x.employeeId === employeeId)) continue
        await byEmployee(employeeId, () => dropBox(employeeId))
        c++
      }
      if (k || c) log.info('sandbox: stopped idle kernels and containers', { kernels: k, containers: c })
      return { kernels: k, containers: c }
    },

    async close() {
      if (timer) clearInterval(timer)
      for (const key of [...kernels.keys()]) await killKernel(key)
      for (const employeeId of [...boxes.keys()]) await dropBox(employeeId)
    },
  }

  const interval = opts.reapIntervalMs ?? 60_000
  const timer =
    interval > 0
      ? setInterval(() => {
          sandbox.reapIdle().catch((e) => log.warn('sandbox: reaping failed', { err: errorMessage(e) }))
        }, interval)
      : null
  timer?.unref?.()
  return sandbox
}
