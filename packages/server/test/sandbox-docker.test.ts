/**
 * code.run against a real Docker daemon, with the real sandbox image. Opt-in: it builds
 * docker/sandbox (tagged mp-sandbox:test) and starts containers:
 *
 *   MP_DOCKER_TEST=1 npx vitest run --project node packages/server/test/sandbox-docker.test.ts
 *
 * Mount mode uses a named volume (mp-itest-…-files) backed by a temporary directory, which stands in
 * for the app's files volume: the test writes files there the way the app does, and the sandbox
 * container mounts the employee's part of it through a volume subpath.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dockerRuntime } from '@mp/containers-docker'
import { createFiles, directoryStorage, memoryStorage, type FileStorage } from '@mp/files'
import { createRecords } from '@mp/records'
import { createSandbox, type Sandbox, type SandboxOptions } from '@mp/sandbox'
import { memoryStore } from '@mp/store'
import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ENABLED = process.env.MP_DOCKER_TEST === '1'
const IMAGE = 'mp-sandbox:test'
const PREFIX = `mp-itest-${randomBytes(3).toString('hex')}-`
const VOLUME = `${PREFIX}files`
const REPO = resolve(import.meta.dirname, '../../..')
const uid = process.getuid?.() ?? 1000
const gid = process.getgid?.() ?? 1000

async function world(
  storage: FileStorage,
  filesVolume?: string,
  o: { prefix?: string; egress?: SandboxOptions['egress']; nameFor?: SandboxOptions['nameFor'] } = {},
) {
  const records = createRecords({ store: memoryStore() })
  records.kinds.define({ kind: 'contact', prefix: 'con', core: [{ name: 'name', type: 'string' }] })
  records.kinds.define({ kind: 'employee', prefix: 'emp', core: [{ name: 'contactId', type: 'ref' }] })
  const meC = (await records.create('contact', { name: 'Bot' })).id
  const otherC = (await records.create('contact', { name: 'Other' })).id
  const me = (await records.create('employee', { contactId: meC })).id
  const other = (await records.create('employee', { contactId: otherC })).id
  const files = createFiles({ records, storage })
  const runtime = dockerRuntime({ namePrefix: o.prefix ?? PREFIX })
  const sandbox = createSandbox({
    runtime,
    namePrefix: o.prefix ?? PREFIX,
    ...(o.egress ? { egress: o.egress } : {}),
    files,
    image: IMAGE,
    user: `${uid}:${gid}`,
    reapIntervalMs: 0,
    limits: { cpus: 1, memoryMb: 512, pids: 128 },
    ...(filesVolume ? { filesVolume } : {}),
    nameFor: o.nameFor ?? ((id) => `itest-${id.slice(-6).toLowerCase()}`),
  })
  let n = 0
  const run = (code: string, o: { language?: 'python' | 'node'; timeoutMs?: number; sessionId?: string } = {}) =>
    sandbox.run({
      employeeId: me,
      sessionId: o.sessionId ?? 'ses_itest',
      language: o.language ?? 'python',
      code,
      timeoutMs: o.timeoutMs ?? 60_000,
      actor: { type: 'session', id: `ses_${n++}` },
    })
  return { records, files, sandbox, runtime, me, other, meC, run }
}

describe.skipIf(!ENABLED)('code.run in the real sandbox image', () => {
  const docker = new Docker()
  const dirs: string[] = []
  const sandboxes: Sandbox[] = []
  let root = ''

  beforeAll(async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, join(REPO, 'docker/sandbox')], { stdio: 'pipe' })
    root = mkdtempSync(join(tmpdir(), 'mp-itest-files-'))
    chmodSync(root, 0o755)
    dirs.push(root)
    await docker.createVolume({ Name: VOLUME, Driver: 'local', DriverOpts: { type: 'none', o: 'bind', device: root } })
  }, 600_000)

  afterAll(async () => {
    for (const s of sandboxes) await s.close().catch(() => undefined)
    for (const c of await docker.listContainers({ all: true }))
      if (c.Names.some((n) => n.includes(`${PREFIX}app`))) await docker.getContainer(c.Id).remove({ force: true })
    // Direct networks are kept for the next sandbox; the test removes its own.
    for (const n of await docker.listNetworks())
      if (n.Name.startsWith(PREFIX))
        await docker
          .getNetwork(n.Id)
          .remove()
          .catch(() => undefined)
    const nets = (await docker.listNetworks()).map((n) => n.Name).filter((n) => n.startsWith(PREFIX))
    await docker
      .getVolume(VOLUME)
      .remove()
      .catch(() => undefined)
    const left = (await docker.listContainers({ all: true })).flatMap((c) => c.Names).filter((n) => n.includes(PREFIX))
    const vols = ((await docker.listVolumes()).Volumes ?? []).map((v) => v.Name).filter((n) => n.startsWith(PREFIX))
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    expect(left).toEqual([])
    expect(vols).toEqual([])
    expect(nets).toEqual([])
  }, 120_000)

  /** A stand-in for the harness's compose network: a database container called `postgres` on it. */
  const appNetwork = async () => {
    const name = `${PREFIX}app`
    await docker.createNetwork({ Name: name, Driver: 'bridge', Labels: { 'mp.itest': 'app' } })
    const db = await docker.createContainer({
      name: `${PREFIX}app-db`,
      Image: 'python:3-alpine',
      Cmd: ['python3', '-m', 'http.server', '5432'],
      HostConfig: { NetworkMode: name },
      NetworkingConfig: { EndpointsConfig: { [name]: { Aliases: ['postgres'] } } },
    })
    await db.start()
    const ip = (await db.inspect()).NetworkSettings.Networks[name]!.IPAddress
    return { name, db: `${PREFIX}app-db`, ip }
  }

  const TCP = (host: string, port: number) =>
    `import socket\ns = socket.create_connection((${JSON.stringify(host)}, ${port}), timeout=5)\ns.close()\n"connected"`

  it('direct network: raw TCP and DNS out, but not the harness network; the default and the proxy get neither', async () => {
    const app = await appNetwork()
    const storage = memoryStorage()
    const direct = await world(storage, undefined, { egress: () => ({ direct: 'direct' }), nameFor: () => 'direct' })
    sandboxes.push(direct.sandbox)
    const tcp = await direct.run(TCP('1.1.1.1', 53), { timeoutMs: 30_000 })
    expect(tcp.error).toBeUndefined()
    expect(tcp.result).toBe("'connected'")
    const dns = await direct.run('import socket\nlen(socket.getaddrinfo("example.com", 443)) > 0', { timeoutMs: 30_000 })
    expect(dns.result).toBe('True')
    // The harness's own services: not by name, not by address.
    for (const name of ['postgres', app.db]) {
      const r = await direct.run(`import socket\nsocket.gethostbyname(${JSON.stringify(name)})`, { timeoutMs: 30_000 })
      expect(r.error, name).toMatch(/gaierror|Name or service not known|Temporary failure/)
    }
    // It listens (reachable from its own network), and a direct network doesn't get there.
    expect((await direct.run(TCP(app.ip, 5432), { timeoutMs: 30_000 })).error).toMatch(/timed out|unreachable/i)
    // The rest of the hardening stays.
    expect((await direct.run('import os\nopen("/etc/x", "w")')).error).toMatch(/Read-only file system|Permission denied/)
    expect((await direct.run('os.getuid()')).result).toBe(String(uid))
    expect((await direct.run('sorted(k for k in os.environ if "PROXY" in k.upper())')).result).toBe('[]')
    const net = (await docker.listNetworks()).find((n) => n.Name === `${PREFIX}direct`)!
    expect(net.Internal).toBe(false)
    expect(net.Options?.['com.docker.network.bridge.enable_icc']).toBe('false')
    expect(net.Labels?.['mp.deployment']).toBe(PREFIX)

    // The default setting: no network at all.
    const none = await world(storage, undefined, { nameFor: () => 'none' })
    sandboxes.push(none.sandbox)
    expect((await none.run(TCP('1.1.1.1', 53), { timeoutMs: 30_000 })).error).toMatch(/unreachable|timed out|refused/i)
    // Through the proxy: HTTP(S) to allowed hosts only, no raw TCP.
    const proxied = await world(storage, undefined, { egress: ['example.com'], nameFor: () => 'proxied' })
    sandboxes.push(proxied.sandbox)
    expect((await proxied.run(TCP('1.1.1.1', 53), { timeoutMs: 30_000 })).error).toMatch(/unreachable|timed out|refused/i)
  }, 600_000)

  it('two deployments with the same employee handle: separate sandboxes, and neither cleans up the other', async () => {
    const storage = memoryStorage()
    const other = `${PREFIX}b-`
    const a = await world(storage, undefined, { nameFor: () => 'meatless' })
    const b = await world(storage, undefined, { prefix: other, nameFor: () => 'meatless' })
    sandboxes.push(a.sandbox, b.sandbox)
    expect((await a.run('x = "a"; x')).result).toBe("'a'")
    expect((await b.run('x = "b"; x')).result).toBe("'b'")
    const names = (await docker.listContainers({ all: true })).flatMap((c) => c.Names.map((n) => n.slice(1)))
    expect(names).toEqual(expect.arrayContaining([`${PREFIX}meatless-sandbox`, `${other}meatless-sandbox`]))
    // `${PREFIX}b-meatless-sandbox` also reads as a's environment "b-meatless-sandbox": a still leaves it alone.
    expect((await a.runtime.listEnvs()).map((e) => e.id)).not.toContain(`${other}meatless-sandbox`)
    await a.runtime.destroyEnv(`${other}meatless-sandbox`)
    await a.sandbox.close()
    expect((await b.run('x')).result).toBe("'b'")
    const after = (await docker.listContainers({ all: true })).flatMap((c) => c.Names.map((n) => n.slice(1)))
    expect(after).toContain(`${other}meatless-sandbox`)
    expect(after).not.toContain(`${PREFIX}meatless-sandbox`)
  }, 600_000)

  it('mount mode: state across cells, node, sympy, files and shares on the volume, no network', async () => {
    const storage = directoryStorage({ root })
    const w = await world(storage, VOLUME)
    sandboxes.push(w.sandbox)
    expect(await w.sandbox.mode()).toBe('mount')

    await storage.write(w.me, '/data/in.csv', new TextEncoder().encode('q,amount\nq1,10\nq2,32\n'))
    await storage.write(w.other, '/reports/q3.md', new TextEncoder().encode('# Q3'))
    await w.files.share(w.other, '/reports', w.meC, 'read')

    expect((await w.run('import math; x = 2**100')).error).toBeUndefined()
    const next = await w.run('x + 1')
    expect(next.result).toBe('1267650600228229401496703205377')

    const js = await w.run('const big = 2n ** 64n; let seen = 1', { language: 'node' })
    expect(js.error).toBeUndefined()
    expect((await w.run('seen += 1; await Promise.resolve(big + BigInt(seen))', { language: 'node' })).result).toBe(
      '18446744073709551618n',
    )

    expect((await w.run('import sympy\nsympy.factorint(2**32 + 1)')).result).toBe('{641: 1, 6700417: 1}')

    const pandas = await w.run(
      'import pandas as pd\ndf = pd.read_csv("data/in.csv")\nwith open("total.txt", "w") as f: f.write(str(df.amount.sum()))\nint(df.amount.sum())',
    )
    expect(pandas.result).toBe('42')
    expect(pandas.files_changed).toEqual([{ path: '/total.txt', change: 'created', size: 2 }])
    expect(new TextDecoder().decode(await storage.read(w.me, '/total.txt'))).toBe('42')

    const chart = await w.run(
      'import os\nimport matplotlib.pyplot as plt\nos.makedirs("charts", exist_ok=True)\nplt.plot([1, 2, 3], [1, 4, 9])\nplt.savefig("charts/squares.png")\n"saved"',
    )
    expect(chart.error).toBeUndefined()
    expect(chart.files_changed.map((c) => [c.path, c.change])).toEqual([['/charts/squares.png', 'created']])
    const png = await storage.read(w.me, '/charts/squares.png')
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])

    // A share is mounted read-only.
    expect((await w.run(`open("/work/shared/${w.other}/reports/q3.md").read()`)).result).toBe("'# Q3'")
    const ro = await w.run(`open("/work/shared/${w.other}/reports/q3.md", "w").write("hacked")`)
    expect(ro.error).toMatch(/Read-only file system|Permission denied/)
    expect(new TextDecoder().decode(await storage.read(w.other, '/reports/q3.md'))).toBe('# Q3')
    // Only the employee's own directory is there: not the other employee's files.
    expect((await w.run('import os; sorted(os.listdir("/work/files"))')).result).toBe("['charts', 'data', 'total.txt']")

    // No network, not even DNS.
    const net = await w.run('import urllib.request\nurllib.request.urlopen("http://example.com", timeout=5)', {
      timeoutMs: 30_000,
    })
    expect(net.error).toMatch(/URLError|gaierror|Temporary failure|Name or service|timed out|Network is unreachable/)

    // Hardening: read-only root, non-root user.
    const hard = await w.run('import os\nopen("/etc/x", "w")')
    expect(hard.error).toMatch(/Read-only file system|Permission denied/)
    expect((await w.run('os.getuid()')).result).toBe(String(uid))

    // A timeout kills the kernel; its state is gone afterwards.
    const slow = await w.run('while True: pass', { timeoutMs: 2000 })
    expect(slow.error).toMatch(/timed out after 2 s/)
    expect((await w.run('x')).error).toMatch(/NameError/)
  }, 600_000)

  it('copy mode: files are copied in, and changes come back out', async () => {
    const storage = memoryStorage()
    const w = await world(storage)
    sandboxes.push(w.sandbox)
    expect(await w.sandbox.mode()).toBe('copy')
    await storage.write(w.me, '/notes/in.txt', new TextEncoder().encode('seven'))
    await storage.write(w.other, '/reports/q3.md', new TextEncoder().encode('# Q3'))
    await w.files.share(w.other, '/reports', w.meC, 'write')
    const r = await w.run('open("notes/in.txt").read().upper()')
    expect(r.result).toBe("'SEVEN'")
    const wr = await w.run('import os\nopen("notes/out.txt", "w").write("out")\nos.remove("notes/in.txt")')
    expect(wr.files_changed).toEqual([
      { path: '/notes/in.txt', change: 'deleted' },
      { path: '/notes/out.txt', change: 'created', size: 3 },
    ])
    expect(new TextDecoder().decode(await storage.read(w.me, '/notes/out.txt'))).toBe('out')
    expect(await storage.stat(w.me, '/notes/in.txt')).toBeNull()
    // Shares are read-only copies in copy mode.
    expect((await w.run(`open("/work/shared/${w.other}/reports/q3.md").read()`)).result).toBe("'# Q3'")
    expect((await w.run(`open("/work/shared/${w.other}/reports/q3.md", "w")`)).error).toMatch(/Permission denied/)
    // Node sees the same files.
    expect((await w.run('require("node:fs").readFileSync("notes/out.txt", "utf8")', { language: 'node' })).result).toBe("'out'")
  }, 600_000)
})
