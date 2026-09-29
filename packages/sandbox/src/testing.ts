/**
 * Test doubles: a fake container runtime whose kernels speak the drivers' protocol, for tests that
 * don't need Docker. Cells are JavaScript run with `node:vm` in the test process, in a context that
 * lasts as long as the kernel (so state persists like in the real kernels), with a few helpers:
 *
 *   print(...values)              output, like print() / console.log()
 *   write(path, text)             write a file (relative to /work/files, or an absolute /work/... path)
 *   read(path), remove(path)      read or delete one
 *   sleep(ms)                     a promise; the cell's value is awaited
 *   hang()                        never finishes (for timeouts)
 *   die(code)                     the kernel process exits
 *   raw(text), rawErr(text)       write straight to stdout/stderr, like a subprocess
 *
 * Only for tests: nothing here is a sandbox.
 */
import { inspect } from 'node:util'
import vm from 'node:vm'
import { fakeRuntime, type FakeRuntime, type FakeRuntimeOptions } from '@mp/containers'
import type { FileStorage } from '@mp/files'
import { FRAME_MARK, MANIFEST_SCRIPT, NODE_DRIVER, PYTHON_DRIVER } from './drivers.ts'

export interface FakeSandboxRuntimeOptions extends FakeRuntimeOptions {
  /** The storage behind the files volume, for mount mode: fake kernels write through volume mounts into it. */
  storage?: FileStorage
}

export interface FakeSandboxRuntime extends FakeRuntime {
  /** Kernels started so far. */
  readonly kernelsStarted: number
}

/** A `fakeRuntime` that plays kernels, the file manifest and `rm`, as the sandbox uses them. */
export function fakeSandboxRuntime(opts: FakeSandboxRuntimeOptions = {}): FakeSandboxRuntime {
  const rt = fakeRuntime(opts) as FakeSandboxRuntime
  let started = 0
  let pid = 100
  Object.defineProperty(rt, 'kernelsStarted', { get: () => started })

  rt.on(
    (cmd) => cmd[0] === 'python3' && cmd[2] === MANIFEST_SCRIPT,
    (call, env) => {
      const root = call.cmd[3]!
      const lines = [...env.files.entries()]
        .filter(([p, f]) => f.type === 'file' && p.startsWith(`${root}/`))
        .map(([p, f]) => JSON.stringify([p.slice(root.length + 1), f.content.length, f.mtimeMs]))
      return { stdout: lines.length ? `${lines.join('\n')}\n` : '' }
    },
  )
  rt.on(
    (cmd) => cmd[0] === 'rm',
    (call) => {
      for (const p of call.cmd.slice(3)) rt.removeFile(call.envId, p)
      return {}
    },
  )
  rt.on(
    (cmd) => cmd[0] === 'sh' && /^rm -rf \/work\/shared\/\*/.test(cmd[2] ?? ''),
    (call, env) => {
      for (const p of [...env.files.keys()]) if (p.startsWith('/work/shared/')) rt.removeFile(call.envId, p)
      return {}
    },
  )

  rt.onSpawn(
    (cmd) => cmd.includes(PYTHON_DRIVER) || cmd.includes(NODE_DRIVER),
    (host) => {
      started++
      const cmd = host.call.cmd
      const token = cmd.at(-2)!
      const max = Number(cmd.at(-1))
      const language = cmd.includes(PYTHON_DRIVER) ? 'python' : 'node'
      const frame = (o: object) => host.stdout(`${FRAME_MARK}${token}${JSON.stringify(o)}\n`)
      let out = ''
      let err = ''
      const fsPath = (p: string) => (p.startsWith('/') ? p : `/work/files/${p}`)
      /** Where a container path lands: a volume mount into storage, or the fake container filesystem. */
      const target = (abs: string) => {
        const mounts = [...(host.env.spec.volumeMounts ?? [])].sort((a, b) => b.containerPath.length - a.containerPath.length)
        const m = mounts.find((x) => abs === x.containerPath || abs.startsWith(`${x.containerPath}/`))
        if (!m || !opts.storage) return { kind: 'container' as const }
        const [owner, ...rest] = (m.subpath ?? '').split('/')
        const inner = `/${[...rest, ...abs.slice(m.containerPath.length).split('/')].filter(Boolean).join('/')}`
        return { kind: 'volume' as const, owner: owner!, path: inner, readOnly: m.readOnly === true }
      }
      const writable = (abs: string) => {
        // The sandbox user (uid 1000) can't write into root-owned read-only files or directories.
        const f = host.env.files.get(abs)
        if (f && f.uid === 0 && !(f.mode & 0o002)) return false
        const parent = host.env.files.get(abs.slice(0, abs.lastIndexOf('/')) || '/')
        return !(parent && parent.uid === 0 && !(parent.mode & 0o002))
      }
      const helpers = {
        print: (...v: unknown[]) => {
          out += `${v.map((x) => (typeof x === 'string' ? x : inspect(x))).join(' ')}\n`
        },
        write: async (p: string, text: string) => {
          const abs = fsPath(p)
          const t = target(abs)
          if (t.kind === 'volume') {
            if (t.readOnly) throw new Error(`EROFS: read-only file system, open '${abs}'`)
            await opts.storage!.write(t.owner, t.path, new TextEncoder().encode(text))
            return
          }
          if (!writable(abs)) throw new Error(`EACCES: permission denied, open '${abs}'`)
          rt.writeFile(host.call.envId, abs, text, { uid: 1000, gid: 1000 })
        },
        read: async (p: string) => {
          const abs = fsPath(p)
          const t = target(abs)
          if (t.kind === 'volume') return new TextDecoder().decode(await opts.storage!.read(t.owner, t.path))
          const v = rt.readFile(host.call.envId, abs)
          if (v === null) throw new Error(`ENOENT: no such file, open '${abs}'`)
          return v
        },
        remove: async (p: string) => {
          const abs = fsPath(p)
          const t = target(abs)
          if (t.kind === 'volume') {
            if (t.readOnly) throw new Error(`EROFS: read-only file system, unlink '${abs}'`)
            return opts.storage!.delete(t.owner, t.path)
          }
          if (!writable(abs)) throw new Error(`EACCES: permission denied, unlink '${abs}'`)
          rt.removeFile(host.call.envId, abs)
        },
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
        hang: () => new Promise(() => {}),
        die: (code = 1) => host.exit(code),
        raw: (t: string) => host.stdout(t),
        rawErr: (t: string) => host.stderr(t),
      }
      const ctx = vm.createContext({ ...helpers })
      let queue = Promise.resolve()
      let buf = ''
      const cell = async (id: number, code: string) => {
        out = ''
        err = ''
        const res: Record<string, unknown> = { id }
        try {
          let v = vm.runInContext(code, ctx)
          if (v && typeof (v as { then?: unknown }).then === 'function') v = await v
          if (v !== undefined) {
            const r = typeof v === 'string' ? JSON.stringify(v) : inspect(v)
            res.result = r.slice(0, max)
            res.resultTotal = r.length
          }
        } catch (e) {
          res.error = `${(e as Error).name ?? 'Error'}: ${(e as Error).message ?? String(e)}`
        }
        if (host.ended) return
        frame({ ...res, stdout: out.slice(0, max), stderr: err.slice(0, max), stdoutTotal: out.length, stderrTotal: err.length })
      }
      host.onInput((t) => {
        buf += t
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.trim()) {
            const req = JSON.parse(line) as { id: number; code: string }
            queue = queue.then(() => cell(req.id, req.code))
          }
          nl = buf.indexOf('\n')
        }
      })
      host.onEnd(() => void queue.then(() => host.exit(0)))
      frame({ ready: true, pid: pid++, language, version: 'fake' })
    },
  )
  return rt
}
