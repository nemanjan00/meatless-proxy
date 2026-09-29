import { isIP } from 'node:net'

/**
 * Egress allowlists. An entry is a hostname glob with an optional port: `registry.npmjs.org`,
 * `*.github.com`, `host:443`, `[2001:db8::1]:443`. `*` matches any run of characters (dots
 * included), so `*.github.com` matches `api.github.com` but not `github.com`. An entry without a
 * port allows every port.
 *
 * IP literals are allowed only when listed exactly, and private, loopback and link-local addresses
 * (and `localhost`) only when listed exactly too: a wildcard never reaches them.
 *
 * `@mp/containers-docker` has a standalone copy of this logic for its proxy; its tests check that
 * both agree.
 */

export interface EgressEntry {
  /** Lowercased host or glob, without brackets. */
  host: string
  port?: number
  /** Contains no `*`. */
  exact: boolean
}

export interface EgressDecision {
  allowed: boolean
  /** Why it was refused. */
  reason?: string
  /** The entry that allowed it. */
  entry?: string
  /** Allowed by an exact entry (so it may reach a private address). */
  exact?: boolean
}

/** One line of the egress proxy's log. */
export interface EgressLogEntry {
  at: string
  method: string
  host: string
  port: number
  allowed: boolean
  reason?: string
}

const HOST_RE = /^[a-z0-9*_]([a-z0-9*_.-]*[a-z0-9*_])?$/

/** Parses an allowlist entry. Returns null when it isn't one. */
export function parseEgressEntry(raw: string): EgressEntry | null {
  const s = String(raw).trim().toLowerCase()
  let host = s
  let port: number | undefined
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(s)
  if (v6) {
    host = v6[1]!
    if (v6[2] !== undefined) port = Number(v6[2])
    if (isIP(host) !== 6) return null
  } else {
    const m = /^([^:]+)(?::(\d+))?$/.exec(s)
    if (!m) return isIP(s) === 6 ? { host: s, exact: true } : null
    host = m[1]!.replace(/\.$/, '')
    if (m[2] !== undefined) port = Number(m[2])
    if (!isIP(host) && !HOST_RE.test(host)) return null
  }
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return null
  return { host, ...(port !== undefined ? { port } : {}), exact: !host.includes('*') }
}

/** The entries that aren't valid, for error messages. */
export function invalidEgressEntries(allow: string[]): string[] {
  return allow.filter((e) => typeof e !== 'string' || !parseEgressEntry(e))
}

/** `*` matches any run of characters; everything else is literal. */
export function hostGlobMatch(pattern: string, host: string): boolean {
  const re = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\-]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${re}$`).test(host)
}

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number]
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
    if (mapped) return isPrivateAddress(mapped[1]!)
    if (s === '::' || s === '::1' || /^0*(:0*)*:0*1$/.test(s)) return true
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff')
  }
  return false
}

const isLocalName = (host: string) => host === 'localhost' || host.endsWith('.localhost')

const normHost = (host: string) =>
  String(host)
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')

/**
 * Whether the allowlist lets a request to `host:port` through, before DNS. The proxy also refuses a
 * host that only a wildcard allowed when it resolves to a private address.
 */
export function checkEgress(allow: string[], host: string, port: number): EgressDecision {
  const h = normHost(host)
  if (!h) return { allowed: false, reason: 'no host' }
  const ip = isIP(h) !== 0
  if (h.includes('*') || (!ip && !HOST_RE.test(h))) return { allowed: false, reason: 'bad host' }
  for (const raw of allow) {
    const e = parseEgressEntry(raw)
    if (!e) continue
    if (e.port !== undefined && e.port !== port) continue
    if (ip || isLocalName(h)) {
      if (e.exact && e.host === h) return { allowed: true, entry: raw, exact: true }
      continue
    }
    if (e.exact ? e.host === h : hostGlobMatch(e.host, h)) return { allowed: true, entry: raw, exact: e.exact }
  }
  if (ip) return { allowed: false, reason: isPrivateAddress(h) ? 'private address' : 'ip literal' }
  if (isLocalName(h)) return { allowed: false, reason: 'private address' }
  return { allowed: false, reason: 'not in allowlist' }
}

/**
 * Whether `entry` allows only destinations that `allow` allows too (so using it narrows the list).
 * A requested glob is covered when an allowed glob matches it with its `*` read literally.
 */
export function egressEntryCovered(entry: string, allow: string[]): boolean {
  const r = parseEgressEntry(entry)
  if (!r) return false
  return allow.some((raw) => {
    const e = parseEgressEntry(raw)
    if (!e) return false
    if (e.port !== undefined && r.port !== e.port) return false
    if (e.exact) return r.exact && r.host === e.host
    // A wildcard never covers IP literals or local names (they need an exact entry).
    if (isIP(r.host) || isLocalName(r.host)) return false
    return hostGlobMatch(e.host, r.host)
  })
}
