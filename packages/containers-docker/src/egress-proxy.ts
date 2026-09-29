import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { EgressDecision, EgressLogEntry } from '@mp/containers'

/** The port the proxy sidecar listens on. */
export const EGRESS_PROXY_PORT = 3128

export interface EgressProxyOptions {
  /** Allowlist entries: hostname globs with optional ports (see `checkEgress` in `@mp/containers`). */
  allow: string[]
  /** Gets one line per request. Default: a JSON line on stdout. */
  logger?: (line: EgressLogEntry) => void
  /** DNS lookup, as `dns.lookup` with `{ all: true }`. For tests. */
  lookup?: (
    host: string,
    opts: { all: true },
    cb: (err: NodeJS.ErrnoException | null, addrs: { address: string; family: number }[]) => void,
  ) => void
  /** The time for log lines. Default: the current time as ISO. */
  now?: () => string
}

interface Core {
  createEgressProxy(opts: EgressProxyOptions): Server
  decide(allow: string[], host: string, port: number): EgressDecision
}

// The proxy lives in a plain CommonJS file so that the very same code runs in-process and,
// inlined as `EGRESS_PROXY_SOURCE`, in the sidecar with `node -e`.
const CORE_URL = new URL('./egress-proxy-core.cjs', import.meta.url)
const core = createRequire(import.meta.url)(fileURLToPath(CORE_URL)) as Core

/**
 * An HTTP forward proxy (plain HTTP forwarding and `CONNECT` tunnels) that lets through only
 * destinations on the allowlist and answers 403 to everything else. IP literals and hosts that
 * resolve to private or loopback addresses are refused unless listed exactly. Not listening yet:
 * call `listen`.
 */
export function createEgressProxy(opts: EgressProxyOptions): Server {
  return core.createEgressProxy(opts)
}

/** The proxy's allowlist decision before DNS (the same logic as `checkEgress` in `@mp/containers`). */
export function egressProxyDecision(allow: string[], host: string, port: number): EgressDecision {
  return core.decide(allow, host, port)
}

/**
 * The proxy as a self-contained script for `node -e`: node built-ins only. It reads the allowlist
 * as JSON from `ALLOW`, listens on `PORT` (default 3128) and logs JSON lines to stdout.
 */
export const EGRESS_PROXY_SOURCE = `const module = { exports: {} };
(function (module, exports, require) {
${readFileSync(CORE_URL, 'utf8')}
})(module, module.exports, require);
let allow = [];
try { allow = JSON.parse(process.env.ALLOW || '[]'); } catch (e) { console.error('ALLOW is not JSON'); process.exit(2); }
if (!Array.isArray(allow)) { console.error('ALLOW must be a JSON array'); process.exit(2); }
const port = Number(process.env.PORT || ${EGRESS_PROXY_PORT});
const server = module.exports.createEgressProxy({ allow });
server.listen(port, process.env.HOST || '0.0.0.0', () => console.error('egress proxy listening on ' + server.address().port));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`
