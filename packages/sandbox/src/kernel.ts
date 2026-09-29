import { randomBytes } from 'node:crypto'
import { UnavailableError, errorMessage } from '@mp/core'
import type { ContainerRuntime, Process } from '@mp/containers'
import { FRAME_MARK, NODE_DRIVER, PYTHON_DRIVER } from './drivers.ts'

export type Language = 'python' | 'node'
export const LANGUAGES: readonly Language[] = ['python', 'node']

/** What a kernel's driver answers for one cell. */
export interface CellFrame {
  id: number
  stdout: string
  stderr: string
  stdoutTotal: number
  stderrTotal: number
  result?: string
  resultTotal?: number
  error?: string
}

export type CellOutcome =
  | { kind: 'done'; frame: CellFrame; rawStdout: string; rawStderr: string }
  | { kind: 'timeout'; rawStdout: string; rawStderr: string }
  | { kind: 'died'; exitCode: number | null; rawStdout: string; rawStderr: string }
  | { kind: 'aborted'; rawStdout: string; rawStderr: string }

/** The command that starts a kernel's driver. */
export function kernelCommand(language: Language, token: string, maxChars: number): string[] {
  return language === 'python'
    ? ['python3', '-u', '-c', PYTHON_DRIVER, token, String(maxChars)]
    : ['node', '--expose-internals', '-e', NODE_DRIVER, token, String(maxChars)]
}

const READY_TIMEOUT_MS = 30_000
/** Raw output kept per stream while waiting for a frame. */
const RAW_CAP = 256 * 1024

/**
 * One long-lived interpreter in the sandbox container, driven over stdin/stdout. Cells run one at a
 * time (the caller serializes them); variables persist between them until the kernel ends.
 */
export class Kernel {
  readonly language: Language
  private proc!: Process
  private readonly token = randomBytes(8).toString('hex')
  private buf = ''
  private rawOut = ''
  private rawErr = ''
  private waiter: ((frame: Record<string, unknown>) => void) | null = null
  private dead = false
  private next = 1
  exitCode: number | null = null
  pid: number | null = null
  version = ''

  private constructor(language: Language) {
    this.language = language
  }

  /** Starts a kernel and waits for its driver to be ready. */
  static async start(
    runtime: ContainerRuntime,
    envId: string,
    language: Language,
    opts: { workdir?: string; maxChars: number; readyTimeoutMs?: number },
  ): Promise<Kernel> {
    if (!runtime.spawn) throw new UnavailableError('this container runtime cannot run interactive processes')
    const k = new Kernel(language)
    const ready = new Promise<Record<string, unknown>>((resolve) => {
      k.waiter = resolve
    })
    k.proc = await runtime.spawn(envId, kernelCommand(language, k.token, opts.maxChars), {
      ...(opts.workdir ? { workdir: opts.workdir } : {}),
      onOutput: (c) => k.onOutput(c.stream, c.text),
    })
    void k.proc.exited.then((r) => {
      k.dead = true
      k.exitCode = r.exitCode
      k.waiter?.({ died: true })
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const first = await Promise.race([
      ready,
      new Promise<Record<string, unknown>>((r) => {
        timer = setTimeout(() => r({ timeout: true }), opts.readyTimeoutMs ?? READY_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timer)
    k.waiter = null
    if (!first.ready) {
      await k.kill()
      const why = first.timeout ? "didn't start in time" : `exited (code ${k.exitCode ?? 'unknown'})`
      throw new UnavailableError(`the ${language} kernel ${why}: ${(k.rawErr || k.rawOut).slice(-2000).trim()}`)
    }
    k.pid = typeof first.pid === 'number' ? first.pid : null
    k.version = String(first.version ?? '')
    k.rawOut = ''
    k.rawErr = ''
    return k
  }

  get alive(): boolean {
    return !this.dead
  }

  private onOutput(stream: 'stdout' | 'stderr', text: string) {
    if (stream === 'stderr') {
      if (this.rawErr.length < RAW_CAP) this.rawErr += text
      return
    }
    this.buf += text
    const mark = `${FRAME_MARK}${this.token}`
    for (;;) {
      const at = this.buf.indexOf(mark)
      if (at < 0) {
        // Keep what may be the start of a mark split across chunks; everything before it is raw output.
        const last = this.buf.lastIndexOf(FRAME_MARK)
        const partial = last >= 0 && mark.startsWith(this.buf.slice(last))
        const rawEnd = partial ? last : this.buf.length
        this.raw(this.buf.slice(0, rawEnd))
        this.buf = this.buf.slice(rawEnd)
        return
      }
      const nl = this.buf.indexOf('\n', at)
      if (nl < 0) {
        this.raw(this.buf.slice(0, at))
        this.buf = this.buf.slice(at)
        return
      }
      this.raw(this.buf.slice(0, at))
      const json = this.buf.slice(at + mark.length, nl)
      this.buf = this.buf.slice(nl + 1)
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(json) as Record<string, unknown>
      } catch (e) {
        this.raw(`[kernel frame unreadable: ${errorMessage(e)}]\n`)
        continue
      }
      this.waiter?.(frame)
    }
  }

  private raw(text: string) {
    if (text && this.rawOut.length < RAW_CAP) this.rawOut += text
  }

  /** Runs one cell. On timeout or abort the caller should kill the kernel: its state is unknown. */
  async run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<CellOutcome> {
    const raws = () => {
      const r = { rawStdout: this.rawOut, rawStderr: this.rawErr }
      this.rawOut = ''
      this.rawErr = ''
      return r
    }
    if (this.dead) return { kind: 'died', exitCode: this.exitCode, ...raws() }
    const id = this.next++
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const outcome = await new Promise<Record<string, unknown>>((resolve) => {
      this.waiter = (f) => {
        if (f.died || f.id === id) resolve(f)
      }
      timer = setTimeout(() => resolve({ timeout: true }), timeoutMs)
      if (signal) {
        onAbort = () => resolve({ aborted: true })
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      this.proc.write(`${JSON.stringify({ id, code })}\n`).catch(() => resolve({ died: true }))
    })
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    this.waiter = null
    // Raw output a subprocess wrote just before the frame may still be in flight on the other stream.
    if (outcome.id === id) await new Promise((r) => setTimeout(r, 10))
    if (outcome.timeout) return { kind: 'timeout', ...raws() }
    if (outcome.aborted) return { kind: 'aborted', ...raws() }
    if (outcome.died) {
      await this.proc.exited
      return { kind: 'died', exitCode: this.exitCode, ...raws() }
    }
    return { kind: 'done', frame: outcome as unknown as CellFrame, ...raws() }
  }

  /** Ends the kernel (and whatever it started). Idempotent. */
  async kill(): Promise<void> {
    if (!this.proc) return
    this.proc.end()
    await this.proc.kill()
    this.dead = true
  }
}
