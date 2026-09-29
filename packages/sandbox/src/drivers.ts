/**
 * The kernel drivers: small programs that run inside the sandbox container and turn a long-lived
 * `python3` or `node` process into a notebook-style kernel. They read one JSON request per line on
 * stdin (`{"id": 1, "code": "..."}`) and answer with a frame on stdout: `\x1e<token>{json}\n`.
 * Anything else a cell writes straight to the file descriptors (a subprocess, `os.write`) arrives
 * around the frames as raw output. `print` and `console.log` are captured inside the driver, capped
 * at a size, and returned in the frame.
 *
 * Frames:
 *   { ready: true, pid, language, version }
 *   { id, stdout, stderr, stdoutTotal, stderrTotal, result?, error? }
 *
 * The token comes as the first argument and the output cap (characters per stream) as the second.
 */

/** Separates frames from raw output. */
export const FRAME_MARK = '\x1e'

export const PYTHON_DRIVER = String.raw`
import ast, asyncio, inspect, io, json, linecache, os, sys, traceback

TOKEN = sys.argv[1]
MAX = int(sys.argv[2]) if len(sys.argv) > 2 else 20000
try:
    os.setpgrp()
except Exception:
    pass

proto_in = os.fdopen(os.dup(0), 'r', encoding='utf-8')
proto_out = os.fdopen(os.dup(1), 'w', encoding='utf-8')
_null = os.open(os.devnull, os.O_RDONLY)
os.dup2(_null, 0)
sys.stdin = open(os.devnull)

class Capture(io.TextIOBase):
    def __init__(self):
        self.parts, self.size, self.total = [], 0, 0
    def writable(self):
        return True
    def write(self, s):
        s = str(s)
        self.total += len(s)
        if self.size < MAX:
            keep = s[: MAX - self.size]
            self.parts.append(keep)
            self.size += len(keep)
        return len(s)
    def text(self):
        return ''.join(self.parts)

def frame(obj):
    sys.__stdout__.flush()
    sys.__stderr__.flush()
    proto_out.write('\x1e' + TOKEN + json.dumps(obj) + '\n')
    proto_out.flush()

g = {'__name__': '__main__', '__builtins__': __builtins__}
FLAGS = getattr(ast, 'PyCF_ALLOW_TOP_LEVEL_AWAIT', 0)

def run_maybe_async(value):
    if inspect.iscoroutine(value):
        return asyncio.run(value)
    return value

def format_error(name):
    et, ev, tb = sys.exc_info()
    te = traceback.TracebackException(et, ev, tb)
    te.stack = traceback.StackSummary.from_list([f for f in te.stack if f.filename != '<string>'])
    return ''.join(te.format())

def run(n, code):
    out, err = Capture(), Capture()
    sys.stdout, sys.stderr = out, err
    result, error = None, None
    name = '<cell %d>' % n
    linecache.cache[name] = (len(code), None, code.splitlines(True), name)
    try:
        tree = ast.parse(code, name, 'exec')
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        run_maybe_async(eval(compile(tree, name, 'exec', flags=FLAGS), g))
        if last is not None:
            value = run_maybe_async(eval(compile(last, name, 'eval', flags=FLAGS), g))
            if value is not None:
                g['_'] = value
                result = repr(value)
    except SystemExit as e:
        error = 'SystemExit: %s (the kernel keeps running)' % (e.code,)
    except BaseException:
        error = format_error(name)
    finally:
        sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
    res = {'id': n, 'stdout': out.text(), 'stderr': err.text(), 'stdoutTotal': out.total, 'stderrTotal': err.total}
    if result is not None:
        res['result'] = result if len(result) <= MAX else result[:MAX]
        res['resultTotal'] = len(result)
    if error is not None:
        res['error'] = error[-MAX:]
    return res

frame({'ready': True, 'pid': os.getpid(), 'language': 'python', 'version': sys.version.split()[0]})
for line in proto_in:
    if not line.strip():
        continue
    req = json.loads(line)
    frame(run(req.get('id', 0), req.get('code', '')))
`

export const NODE_DRIVER = String.raw`
const vm = require('node:vm')
const util = require('node:util')
const path = require('node:path')
const readline = require('node:readline')
const { createRequire } = require('node:module')

const TOKEN = process.argv[1]
const MAX = Number(process.argv[2] || 20000)
let processTopLevelAwait = null
try {
  processTopLevelAwait = require('internal/repl/await').processTopLevelAwait
} catch {}

const realOut = process.stdout.write.bind(process.stdout)
const frame = (obj) => realOut('\x1e' + TOKEN + JSON.stringify(obj) + '\n')

function capture() {
  const c = { parts: [], size: 0, total: 0 }
  c.write = (s) => {
    s = String(s)
    c.total += s.length
    if (c.size < MAX) {
      const keep = s.slice(0, MAX - c.size)
      c.parts.push(keep)
      c.size += keep.length
    }
  }
  c.text = () => c.parts.join('')
  return c
}

// Output of the running cell; output after a cell (timers, promises) goes to the raw streams.
let current = null
const { Writable } = require('node:stream')
const sink = (streamName) =>
  new Writable({
    decodeStrings: false,
    write(chunk, _enc, cb) {
      if (current) current[streamName].write(chunk)
      else if (streamName === 'stdout') realOut(chunk)
      else process.stderr.write(chunk)
      cb()
    },
  })
const cellConsole = new console.Console({ stdout: sink('stdout'), stderr: sink('stderr') })

const ctx = vm.createContext({
  console: cellConsole,
  require: createRequire(path.join(process.cwd(), '[cell]')),
  process, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
  setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
  structuredClone, atob, btoa, fetch, performance,
})

// Errors from the cell, without the driver's own frames.
const show = (e) =>
  e && typeof e === 'object' && 'stack' in e
    ? String(e.stack)
        .split('\n')
        .filter((l) => !/^\s+at .*(node:vm|\[eval\]|node:internal\/process)/.test(l))
        .join('\n')
    : 'Uncaught ' + util.inspect(e)
process.on('uncaughtException', (e) => (current ? current.stderr.write(show(e) + '\n') : process.stderr.write(show(e) + '\n')))
process.on('unhandledRejection', (e) => (current ? current.stderr.write(show(e) + '\n') : process.stderr.write(show(e) + '\n')))

async function run(n, code) {
  current = { stdout: capture(), stderr: capture() }
  const filename = 'cell-' + n
  let result, error
  try {
    let script
    let wrapped = false
    try {
      script = new vm.Script(code, { filename })
    } catch (e) {
      const t = e && e.name === 'SyntaxError' && processTopLevelAwait ? processTopLevelAwait(code) : null
      if (!t) throw e
      script = new vm.Script(t, { filename })
      wrapped = true
    }
    let value = script.runInContext(ctx, { displayErrors: false })
    if (wrapped) value = (await value)?.value
    if (value !== undefined) {
      ctx._ = value
      result = util.inspect(value, { depth: 4, maxArrayLength: 200, maxStringLength: MAX, breakLength: 100 })
    }
  } catch (e) {
    error = show(e)
  }
  const c = current
  current = null
  const res = { id: n, stdout: c.stdout.text(), stderr: c.stderr.text(), stdoutTotal: c.stdout.total, stderrTotal: c.stderr.total }
  if (result !== undefined) {
    res.result = result.slice(0, MAX)
    res.resultTotal = result.length
  }
  if (error !== undefined) res.error = error.slice(-MAX)
  return res
}

frame({ ready: true, pid: process.pid, language: 'node', version: process.version })
const rl = readline.createInterface({ input: process.stdin, terminal: false })
let queue = Promise.resolve()
rl.on('line', (line) => {
  if (!line.trim()) return
  const req = JSON.parse(line)
  queue = queue.then(() => run(req.id || 0, req.code || '')).then(frame)
})
rl.on('close', () => queue.then(() => process.exit(0)))
`

/**
 * Lists the regular files under a directory as JSON lines `[path, size, mtimeMs]`, paths relative
 * and without a leading slash. Links are skipped. Used to see what a cell changed when the files are
 * copied into the sandbox rather than mounted.
 */
export const MANIFEST_SCRIPT = `
import json, os, sys
root = sys.argv[1]
for base, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(base, d))]
    for f in files:
        p = os.path.join(base, f)
        try:
            st = os.lstat(p)
        except OSError:
            continue
        if not os.path.isfile(p) or os.path.islink(p):
            continue
        print(json.dumps([os.path.relpath(p, root), st.st_size, st.st_mtime_ns // 1000000]))
`
