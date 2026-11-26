import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { isPrivateAddress } from '@mp/containers'

/** Most redirects web.fetch follows. */
export const WEB_FETCH_MAX_REDIRECTS = 5
/** Longest a fetch may take, redirects included (ms). */
export const WEB_FETCH_TIMEOUT_MS = 20_000
/** Largest body read (bytes, after decompression). */
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024

/** A fetched response: where it ended up, its status, type and body. */
export interface FetchedPage {
  url: string
  status: number
  contentType: string
  body: Uint8Array
  /** The body was longer than the limit and was cut. */
  truncated: boolean
}

export interface FetchOptions {
  /** Whether a URL may be fetched (checked for the first URL and every redirect): null, or why not. */
  check(url: URL): string | null
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
}

/** A page fetcher: `fetchPublic` by default, a fake in tests. */
export type WebFetcher = (url: string, opts: FetchOptions) => Promise<FetchedPage>

/** A fetch refused or failed for a reason the model can act on. */
export class WebFetchError extends Error {
  override name = 'WebFetchError'
}

/**
 * DNS lookup that refuses private, loopback and link-local answers. It is the lookup the connection
 * uses, so the address checked is the address connected to (no rebinding between check and connect).
 */
const publicLookup = (hostname: string, options: { all?: boolean; family?: number }, cb: (...a: any[]) => void) => {
  dnsLookup(hostname, { all: true, ...(options.family ? { family: options.family } : {}) }, (err, addrs: LookupAddress[]) => {
    if (err) return cb(err)
    if (!addrs.length) return cb(new WebFetchError(`${hostname} has no address`))
    if (addrs.some((a) => isPrivateAddress(a.address)))
      return cb(new WebFetchError(`${hostname} resolves to a private address: web.fetch only reaches public hosts`))
    if (options.all) return cb(null, addrs)
    cb(null, addrs[0]!.address, addrs[0]!.family)
  })
}

const decoder = (encoding: string | undefined) => {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'br':
      return createBrotliDecompress()
    default:
      return null
  }
}

/** One request, no redirects followed. */
function requestOnce(
  url: URL,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ status: number; location?: string; contentType: string; body: Uint8Array; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      url,
      {
        method: 'GET',
        signal,
        lookup: publicLookup as never,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; vegan-fetch/1.0)',
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'en;q=0.9, *;q=0.5',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const contentType = String(res.headers['content-type'] ?? '')
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          return resolve({ status, location: res.headers.location, contentType, body: new Uint8Array(), truncated: false })
        }
        const unzip = decoder(res.headers['content-encoding'] as string | undefined)
        const stream = unzip ? res.pipe(unzip) : res
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        const done = () => resolve({ status, contentType, body: new Uint8Array(Buffer.concat(chunks)), truncated })
        stream.on('data', (c: Buffer) => {
          if (truncated) return
          if (size + c.length > maxBytes) {
            chunks.push(c.subarray(0, maxBytes - size))
            size = maxBytes
            truncated = true
            res.destroy()
            done()
            return
          }
          chunks.push(c)
          size += c.length
        })
        stream.on('end', () => !truncated && done())
        stream.on('error', (e) => !truncated && reject(e))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * GETs a public http(s) URL from the harness, following redirects. Each URL (the first and every
 * redirect) must pass `opts.check`, and no connection is made to a private, loopback or link-local
 * address, by IP or by what a name resolves to.
 */
export const fetchPublic: WebFetcher = async (raw, opts) => {
  const maxBytes = opts.maxBytes ?? WEB_FETCH_MAX_BYTES
  const signal = AbortSignal.any([
    AbortSignal.timeout(opts.timeoutMs ?? WEB_FETCH_TIMEOUT_MS),
    ...(opts.signal ? [opts.signal] : []),
  ])
  let url = parseUrl(raw)
  for (let hop = 0; ; hop++) {
    const why = opts.check(url) ?? addressProblem(url)
    if (why) throw new WebFetchError(why)
    let r: Awaited<ReturnType<typeof requestOnce>>
    try {
      r = await requestOnce(url, signal, maxBytes)
    } catch (e) {
      if (e instanceof WebFetchError) throw e
      const err = e as NodeJS.ErrnoException
      if (err.name === 'TimeoutError' || (err.name === 'AbortError' && !opts.signal?.aborted))
        throw new WebFetchError(`${url.host} took longer than ${Math.round((opts.timeoutMs ?? WEB_FETCH_TIMEOUT_MS) / 1000)} s`)
      throw new WebFetchError(`couldn't fetch ${url.href}: ${err.code ?? err.message}`)
    }
    if (r.location === undefined)
      return { url: url.href, status: r.status, contentType: r.contentType, body: r.body, truncated: r.truncated }
    if (hop >= WEB_FETCH_MAX_REDIRECTS)
      throw new WebFetchError(`more than ${WEB_FETCH_MAX_REDIRECTS} redirects, last to ${r.location}`)
    url = parseUrl(new URL(r.location, url).href)
  }
}

/** An http(s) URL without credentials, or a `WebFetchError`. */
export function parseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new WebFetchError(`not a URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebFetchError(`only http and https URLs: ${raw}`)
  if (url.username || url.password) throw new WebFetchError('URLs with credentials in them are refused')
  return url
}

/** Why an IP-literal or local host can't be reached, before any DNS. */
function addressProblem(url: URL): string | null {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isPrivateAddress(host)))
    return `${url.hostname} is a private address: web.fetch only reaches public hosts`
  return null
}
