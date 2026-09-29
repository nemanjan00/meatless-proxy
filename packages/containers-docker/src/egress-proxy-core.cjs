'use strict'
/*
 * The egress proxy, as self-contained CommonJS using only node built-ins. It is loaded
 * in-process by `egress-proxy.ts` (`createEgressProxy`) and inlined verbatim into
 * `EGRESS_PROXY_SOURCE`, which the sidecar runs with `node -e`. Keep it free of imports
 * beyond node built-ins. The allowlist logic mirrors `checkEgress` in `@mp/containers`;
 * the tests check that both agree.
 */
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const dns = require('node:dns')

const HOST_RE = /^[a-z0-9*_]([a-z0-9*_.-]*[a-z0-9*_])?$/

function parseEntry(raw) {
  const s = String(raw).trim().toLowerCase()
  let host = s
  let port
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(s)
  if (v6) {
    host = v6[1]
    if (v6[2] !== undefined) port = Number(v6[2])
    if (net.isIP(host) !== 6) return null
  } else {
    const m = /^([^:]+)(?::(\d+))?$/.exec(s)
    if (!m) return net.isIP(s) === 6 ? { host: s, exact: true } : null
    host = m[1].replace(/\.$/, '')
    if (m[2] !== undefined) port = Number(m[2])
    if (!net.isIP(host) && !HOST_RE.test(host)) return null
  }
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return null
  return { host, port, exact: !host.includes('*') }
}

function globMatch(pattern, host) {
  const re = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\-]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${re}$`).test(host)
}

function isPrivateAddress(ip) {
  const kind = net.isIP(ip)
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (kind === 6) {
    const s = ip.toLowerCase()
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
    if (mapped) return isPrivateAddress(mapped[1])
    if (s === '::' || s === '::1' || /^0*(:0*)*:0*1$/.test(s)) return true
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff')
  }
  return false
}

const isLocalName = (host) => host === 'localhost' || host.endsWith('.localhost')

const normHost = (host) =>
  String(host)
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')

/** The allowlist decision before DNS: `{ allowed, reason?, entry?, exact? }`. */
function decide(allow, host, port) {
  const h = normHost(host)
  if (!h) return { allowed: false, reason: 'no host' }
  const ip = net.isIP(h) !== 0
  if (h.includes('*') || (!ip && !HOST_RE.test(h))) return { allowed: false, reason: 'bad host' }
  for (const raw of allow) {
    const e = parseEntry(raw)
    if (!e) continue
    if (e.port !== undefined && e.port !== port) continue
    if (ip || isLocalName(h)) {
      if (e.exact && e.host === h) return { allowed: true, entry: raw, exact: true }
      continue
    }
    if (e.exact ? e.host === h : globMatch(e.host, h)) return { allowed: true, entry: raw, exact: e.exact }
  }
  if (ip) return { allowed: false, reason: isPrivateAddress(h) ? 'private address' : 'ip literal' }
  if (isLocalName(h)) return { allowed: false, reason: 'private address' }
  return { allowed: false, reason: 'not in allowlist' }
}

/**
 * Resolves a destination the allowlist let through. A host allowed only by a wildcard must not
 * resolve to a private address. Connecting to the checked address (not the name again) closes
 * the DNS-rebinding gap.
 */
function resolveTarget(host, decision, lookup) {
  const h = normHost(host)
  if (net.isIP(h)) return Promise.resolve({ address: h })
  return new Promise((resolve) => {
    lookup(h, { all: true }, (err, addrs) => {
      if (err || !addrs || !addrs.length) return resolve({ error: 'dns failure' })
      if (!decision.exact && addrs.some((a) => isPrivateAddress(a.address))) return resolve({ error: 'private address' })
      resolve({ address: addrs[0].address })
    })
  })
}

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** The body of a 403: which host, why, and what to do about it. */
function refusal(host, port, reason) {
  const why =
    reason === 'private address'
      ? 'private, loopback and link-local addresses are only reachable when listed exactly'
      : reason === 'ip literal'
        ? 'IP addresses are only reachable when listed exactly'
        : `${host || 'it'} is not on this environment's egress allowlist`
  return `egress to ${host}:${port} is blocked: ${why}. Ask an admin to add it to the project's or the employee's network allowlist.\n`
}

/**
 * An HTTP forward proxy (plain HTTP forwarding and CONNECT tunnels) that lets through only
 * destinations on `allow`, refusing everything else with 403. `logger(line)` gets one object per
 * request: `{ at, method, host, port, allowed, reason? }`. Default: JSON lines on stdout.
 */
function createEgressProxy(opts) {
  const allow = Array.isArray(opts?.allow) ? opts.allow.map(String) : []
  const logger = opts?.logger || ((line) => process.stdout.write(`${JSON.stringify(line)}\n`))
  const lookup = opts?.lookup || dns.lookup
  const now = opts?.now || (() => new Date().toISOString())
  const log = (method, host, port, allowed, reason) => {
    const line = { at: now(), method, host, port, allowed }
    if (reason) line.reason = reason
    try {
      logger(line)
    } catch {
      // Logging must never take the proxy down.
    }
  }

  const check = async (host, port) => {
    const d = decide(allow, host, port)
    if (!d.allowed) return d
    const t = await resolveTarget(host, d, lookup)
    return t.error ? { allowed: false, reason: t.error } : { allowed: true, address: t.address }
  }

  const server = http.createServer(async (req, res) => {
    let url
    try {
      url = new URL(req.url)
    } catch {
      url = null
    }
    // Absolute http:// requests, and absolute https:// ones (some clients, e.g. busybox wget,
    // send those instead of CONNECT): the proxy then speaks TLS to the destination itself,
    // verifying its certificate against the requested hostname.
    if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
      log(req.method, '', 0, false, 'not a proxy request')
      res.writeHead(400, { 'content-type': 'text/plain' })
      return res.end('only absolute http:// or https:// requests and CONNECT are proxied\n')
    }
    const secure = url.protocol === 'https:'
    const host = normHost(url.hostname)
    const port = url.port ? Number(url.port) : secure ? 443 : 80
    const d = await check(host, port)
    log(req.method, host, port, d.allowed, d.reason)
    if (!d.allowed) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      return res.end(refusal(host, port, d.reason))
    }
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k)) headers[k] = v
    headers.host = url.host
    const target = { host: d.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false }
    const upstream = (secure ? https : http).request(secure ? { ...target, servername: host } : target, (up) => {
      const out = {}
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_HEADERS.has(k)) out[k] = v
      res.writeHead(up.statusCode || 502, out)
      up.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('upstream error\n')
    })
    req.pipe(upstream)
  })

  server.on('connect', async (req, socket, head) => {
    socket.on('error', () => {})
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || '')
    const host = m ? normHost(m[1]) : ''
    const port = m ? Number(m[2]) : 0
    if (!m || !(port >= 1 && port <= 65535)) {
      log('CONNECT', host, port, false, 'bad target')
      return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    }
    const d = await check(host, port)
    log('CONNECT', host, port, d.allowed, d.reason)
    if (!d.allowed)
      return socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${refusal(host, port, d.reason)}`)
    let established = false
    const upstream = net.connect(port, d.address, () => {
      established = true
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => {
      if (!established && socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      else socket.destroy()
    })
    socket.on('close', () => upstream.destroy())
  })

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  return server
}

module.exports = { createEgressProxy, decide, isPrivateAddress, parseEntry }
