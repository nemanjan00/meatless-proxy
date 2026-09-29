import { createHash } from 'node:crypto'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'

/** A free TCP port on 127.0.0.1 (closed again before it's returned). */
export async function freePort(): Promise<number> {
  const s = createTcpServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return port
}

export interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
}

/**
 * The "app" an environment serves, on a real port: echoes requests, sets cookies, redirects,
 * streams, and speaks just enough WebSocket to echo short text frames.
 */
export async function upstreamApp(): Promise<{ port: number; seen: Seen[]; server: Server; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/cookies') {
      res.setHeader('set-cookie', [
        'app=1; Path=/; HttpOnly',
        'mp_session=evil; Path=/',
        'MP_CSRF=evil',
        'wide=1; Domain=example.com; Path=/',
        'theme=dark',
      ])
      return res.end('ok')
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/next?x=1` })
      return res.end()
    }
    if (url.pathname === '/elsewhere') {
      res.writeHead(302, { location: 'https://example.com/out' })
      return res.end()
    }
    if (url.pathname === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('first\n')
      setTimeout(() => res.end('second\n'), 150)
      return
    }
    if (url.pathname === '/csp') {
      res.setHeader('content-security-policy', "default-src 'self'")
      return res.end('csp')
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (d) => {
        body += d
      })
      req.on('end', () => res.end(`got ${body}`))
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  const sockets = new Set<Socket>()
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket)
    seen.push({ method: 'UPGRADE', url: req.url ?? '', headers: req.headers })
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        'Set-Cookie: mp_session=evil',
        'Set-Cookie: hmr=1',
        '',
        '',
      ].join('\r\n'),
    )
    socket.on('data', (buf: Buffer) => {
      const text = decodeFrame(buf)
      if (text !== null) socket.write(encodeFrame(`echo: ${text}`, false))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    server,
    close: () =>
      new Promise<void>((r) => {
        for (const so of sockets) so.destroy()
        server.close(() => r())
        server.closeAllConnections()
      }),
  }
}

/** A short text frame, masked when it comes from a client. */
export function encodeFrame(text: string, masked: boolean): Buffer {
  const payload = Buffer.from(text)
  if (payload.length > 125) throw new Error('test frames are short')
  if (!masked) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const mask = Buffer.from([1, 2, 3, 4])
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, body])
}

/** The text of a short (possibly masked) text frame, or null. */
export function decodeFrame(buf: Buffer): string | null {
  if (buf.length < 2 || (buf[0]! & 0x0f) !== 1) return null
  const masked = (buf[1]! & 0x80) !== 0
  const len = buf[1]! & 0x7f
  if (len > 125) return null
  if (!masked) return buf.subarray(2, 2 + len).toString()
  const mask = buf.subarray(2, 6)
  return Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]!)).toString()
}

export interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** A plain HTTP request to 127.0.0.1:port with exactly these headers (including `host`). */
export function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  opts: { method?: string; body?: string; onFirstChunk?: (text: string, at: number) => void } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d: string) => {
        if (!body) opts.onFirstChunk?.(d, Date.now())
        body += d
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

/** A WebSocket upgrade request. Resolves with the status, headers and (on 101) the socket. */
export function rawUpgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    })
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode ?? 0, headers: res.headers, socket }))
    req.on('response', (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0, headers: res.headers })
    })
    req.on('error', reject)
    req.end()
  })
}

/** The next text frame on a socket. */
export function nextFrame(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no frame')), 3000)
    socket.once('data', (buf: Buffer) => {
      clearTimeout(t)
      resolve(decodeFrame(buf) ?? '')
    })
  })
}

/** `name=value` of a `set-cookie` header by cookie name. */
export function setCookieOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  return (headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))
}
