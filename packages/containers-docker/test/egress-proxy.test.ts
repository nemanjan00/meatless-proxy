import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { checkEgress, type EgressLogEntry } from '@mp/containers'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EGRESS_PROXY_SOURCE, createEgressProxy, egressProxyDecision } from '../src/index.ts'

const portOf = (s: net.Server) => (s.address() as AddressInfo).port

let upstream: http.Server
let echo: net.Server
let upPort: number
let echoPort: number
const upstreamRequests: { method?: string; url?: string; host?: string; proxyAuth?: string }[] = []

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    upstreamRequests.push({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      ...(req.headers['proxy-authorization'] ? { proxyAuth: String(req.headers['proxy-authorization']) } : {}),
    })
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' })
      res.end(`hello ${req.method} ${req.url} ${body}`)
    })
  })
  echo = net.createServer((sock) => sock.on('data', (d) => sock.write(`echo:${d}`)))
  upstream.listen(0, '127.0.0.1')
  echo.listen(0, '127.0.0.1')
  await Promise.all([once(upstream, 'listening'), once(echo, 'listening')])
  upPort = portOf(upstream)
  echoPort = portOf(echo)
})

afterAll(async () => {
  upstream.close()
  echo.close()
})

/** Resolves every `*.test` name to loopback, and fails anything else. */
const testLookup: Parameters<typeof createEgressProxy>[0]['lookup'] = (host, _o, cb) => {
  if (host.endsWith('.test')) return cb(null, [{ address: '127.0.0.1', family: 4 }])
  const err = Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
  cb(err, [])
}

const servers: http.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function startProxy(allow: string[]) {
  const lines: EgressLogEntry[] = []
  const server = createEgressProxy({ allow, logger: (l) => lines.push(l), lookup: testLookup, now: () => 'NOW' })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { port: portOf(server), lines }
}

/** A plain HTTP request through the proxy (absolute URI). */
function viaProxy(
  proxyPort: number,
  url: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, method: opts.method ?? 'GET', path: url, headers: opts.headers, agent: false },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

/** A CONNECT through the proxy. Resolves with the status and, when tunnelled, the socket. */
function connect(proxyPort: number, target: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target, agent: false })
    req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }))
    req.on('error', reject)
    req.end()
  })
}

async function roundTrip(socket: net.Socket, text: string): Promise<string> {
  socket.write(text)
  const [data] = await once(socket, 'data')
  return String(data)
}

describe('createEgressProxy', () => {
  it('forwards an allowed plain HTTP request, without hop-by-hop headers', async () => {
    const p = await startProxy([`upstream.test:${upPort}`])
    const r = await viaProxy(p.port, `http://upstream.test:${upPort}/hello?x=1`, {
      method: 'POST',
      body: 'hi',
      headers: { 'proxy-authorization': 'Basic c2stdGVzdA==' },
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('hello POST /hello?x=1 hi')
    expect(r.headers['x-upstream']).toBe('yes')
    const seen = upstreamRequests.at(-1)!
    expect(seen).toMatchObject({ method: 'POST', url: '/hello?x=1', host: `upstream.test:${upPort}` })
    expect(seen.proxyAuth).toBeUndefined()
    expect(p.lines).toEqual([{ at: 'NOW', method: 'POST', host: 'upstream.test', port: upPort, allowed: true }])
  })

  it('refuses hosts not on the list with 403 and logs them', async () => {
    const p = await startProxy([`upstream.test:${upPort}`])
    const before = upstreamRequests.length
    const r = await viaProxy(p.port, `http://evil.test:${upPort}/`)
    expect(r.status).toBe(403)
    // The body names the host, says why, and what to do.
    expect(r.body).toBe(
      `egress to evil.test:${upPort} is blocked: evil.test is not on this environment's egress allowlist. Ask an admin to add it to the project's or the employee's network allowlist.\n`,
    )
    // Right host, wrong port.
    expect((await viaProxy(p.port, `http://upstream.test:${upPort + 1}/`)).status).toBe(403)
    const priv = await viaProxy(p.port, 'http://10.0.0.1/')
    expect(priv.body).toMatch(
      /^egress to 10\.0\.0\.1:80 is blocked: private, loopback and link-local addresses are only reachable when listed exactly\./,
    )
    p.lines.pop()
    expect(upstreamRequests.length).toBe(before)
    expect(p.lines).toEqual([
      { at: 'NOW', method: 'GET', host: 'evil.test', port: upPort, allowed: false, reason: 'not in allowlist' },
      { at: 'NOW', method: 'GET', host: 'upstream.test', port: upPort + 1, allowed: false, reason: 'not in allowlist' },
    ])
  })

  it('tunnels CONNECT to an allowed host:port', async () => {
    const p = await startProxy([`upstream.test:${echoPort}`])
    const { status, socket } = await connect(p.port, `upstream.test:${echoPort}`)
    expect(status).toBe(200)
    expect(await roundTrip(socket, 'ping')).toBe('echo:ping')
    expect(await roundTrip(socket, 'again')).toBe('echo:again')
    socket.destroy()
    expect(p.lines).toEqual([{ at: 'NOW', method: 'CONNECT', host: 'upstream.test', port: echoPort, allowed: true }])
  })

  it('refuses CONNECT to a blocked host or port with 403', async () => {
    const p = await startProxy([`upstream.test:${echoPort}`])
    const a = await connect(p.port, `other.test:${echoPort}`)
    expect(a.status).toBe(403)
    a.socket.destroy()
    const b = await connect(p.port, `upstream.test:${upPort}`)
    expect(b.status).toBe(403)
    b.socket.destroy()
    const c = await connect(p.port, 'no-port.test')
    expect(c.status).toBe(400)
    c.socket.destroy()
    expect(p.lines.map((l) => [l.host, l.allowed])).toEqual([
      ['other.test', false],
      ['upstream.test', false],
      ['', false],
    ])
  })

  it('blocks IP literals and private addresses by default', async () => {
    const p = await startProxy(['*'])
    expect((await viaProxy(p.port, `http://127.0.0.1:${upPort}/`)).status).toBe(403)
    const c = await connect(p.port, `127.0.0.1:${echoPort}`)
    expect(c.status).toBe(403)
    c.socket.destroy()
    expect((await viaProxy(p.port, `http://localhost:${upPort}/`)).status).toBe(403)
    // A name allowed only by a wildcard that resolves to loopback (DNS rebinding) is refused too.
    expect((await viaProxy(p.port, `http://sneaky.test:${upPort}/`)).status).toBe(403)
    expect(p.lines.map((l) => l.reason)).toEqual(['private address', 'private address', 'private address', 'private address'])
  })

  it('lets private destinations through when listed exactly', async () => {
    const p = await startProxy([`127.0.0.1:${upPort}`, `staging.test:${echoPort}`])
    expect((await viaProxy(p.port, `http://127.0.0.1:${upPort}/ok`)).status).toBe(200)
    const c = await connect(p.port, `staging.test:${echoPort}`)
    expect(c.status).toBe(200)
    expect(await roundTrip(c.socket, 'x')).toBe('echo:x')
    c.socket.destroy()
    // Wildcards still don't reach them.
    const w = await startProxy(['*.test'])
    expect((await viaProxy(w.port, `http://staging.test:${upPort}/`)).status).toBe(403)
  })

  it('answers 400 to non-proxy requests and 502 when the upstream is down', async () => {
    const p = await startProxy(['down.test'])
    const r = await viaProxy(p.port, '/relative')
    expect(r.status).toBe(400)
    const closed = net.createServer()
    closed.listen(0, '127.0.0.1')
    await once(closed, 'listening')
    const deadPort = portOf(closed)
    closed.close()
    expect((await viaProxy(p.port, `http://down.test:${deadPort}/`)).status).toBe(502)
    expect((await viaProxy(p.port, `http://nxdomain.example.com/`)).status).toBe(403)
  })
})

describe('allowlist decisions', () => {
  const cases: [string[], string, number][] = [
    [['registry.npmjs.org'], 'registry.npmjs.org', 443],
    [['registry.npmjs.org'], 'registry.npmjs.org.', 80],
    [['*.github.com'], 'api.github.com', 443],
    [['*.github.com'], 'codeload.eu.github.com', 443],
    [['*.github.com'], 'github.com', 443],
    [['*.github.com'], 'github.com.evil.io', 443],
    [['*.github.com:443'], 'api.github.com', 22],
    [['*.github.com:443'], 'api.github.com', 443],
    [['host.example.com:8080'], 'HOST.example.com', 8080],
    [['*'], '8.8.8.8', 443],
    [['8.8.8.8:443'], '8.8.8.8', 443],
    [['*'], '10.0.0.1', 80],
    [['*'], '[::1]', 80],
    [['[::1]:80'], '::1', 80],
    [['*'], 'localhost', 80],
    [['localhost'], 'localhost', 80],
    [['*'], 'bad_host!', 80],
    [['bad entry', 'ok.example.com'], 'ok.example.com', 80],
    [[], 'ok.example.com', 80],
  ]
  it('the proxy and @mp/containers agree', () => {
    for (const [allow, host, port] of cases) {
      const a = egressProxyDecision(allow, host, port)
      const b = checkEgress(allow, host, port)
      expect({ allowed: a.allowed, reason: a.reason }, `${allow} ${host}:${port}`).toEqual({
        allowed: b.allowed,
        reason: b.reason,
      })
    }
    expect(egressProxyDecision(['*.github.com:443'], 'api.github.com', 443).allowed).toBe(true)
    expect(egressProxyDecision(['*.github.com:443'], 'api.github.com', 22).allowed).toBe(false)
    expect(egressProxyDecision(['*.github.com'], 'github.com', 443).allowed).toBe(false)
  })
})

describe('EGRESS_PROXY_SOURCE', () => {
  let child: ChildProcess | undefined
  afterEach(() => {
    child?.kill('SIGTERM')
    child = undefined
  })

  it('runs standalone with node -e: one allowed and one blocked request', async () => {
    expect(EGRESS_PROXY_SOURCE).not.toMatch(/\bimport\b/)
    child = spawn(process.execPath, ['-e', EGRESS_PROXY_SOURCE], {
      env: { PATH: process.env.PATH ?? '', ALLOW: JSON.stringify([`127.0.0.1:${upPort}`]), PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout!.on('data', (d) => (stdout += d))
    const port = await new Promise<number>((resolve, reject) => {
      let err = ''
      child!.stderr!.on('data', (d) => {
        err += d
        const m = /listening on (\d+)/.exec(err)
        if (m) resolve(Number(m[1]))
      })
      child!.on('exit', (code) => reject(new Error(`proxy exited ${code}: ${err}`)))
    })
    const ok = await viaProxy(port, `http://127.0.0.1:${upPort}/standalone`)
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('/standalone')
    const blocked = await viaProxy(port, `http://127.0.0.1:${upPort + 1}/`)
    expect(blocked.status).toBe(403)
    const deadline = Date.now() + 5000
    while (stdout.trim().split('\n').length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    const lines = stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { at: expect.any(String), method: 'GET', host: '127.0.0.1', port: upPort, allowed: true },
      { at: expect.any(String), method: 'GET', host: '127.0.0.1', port: upPort + 1, allowed: false, reason: 'private address' },
    ])
    expect(Number.isNaN(Date.parse(lines[0].at))).toBe(false)
  })

  it('exits when ALLOW is not a JSON list', async () => {
    child = spawn(process.execPath, ['-e', EGRESS_PROXY_SOURCE], {
      env: { PATH: process.env.PATH ?? '', ALLOW: '{nope', PORT: '0', HOST: '127.0.0.1' },
      stdio: 'ignore',
    })
    const [code] = await once(child, 'exit')
    expect(code).toBe(2)
  })
})
