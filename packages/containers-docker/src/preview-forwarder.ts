import { readFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** One forwarded port: connections to `listen` go to `port` of the target. */
export interface PreviewForward {
  listen: number
  port: number
}

export interface PreviewForwarderOptions {
  /** Host to forward to. In the sidecar: `main`, the main container's alias on the env network. */
  target: string
  forwards: PreviewForward[]
}

interface Core {
  createPreviewForwarder(opts: PreviewForwarderOptions): (PreviewForward & { server: Server })[]
}

// Like the egress proxy: the same file runs in-process and, inlined, in the sidecar with `node -e`.
const CORE_URL = new URL('./preview-forwarder-core.cjs', import.meta.url)
const core = createRequire(import.meta.url)(fileURLToPath(CORE_URL)) as Core

/** What the forwarder writes (to stderr) once every port is listening. */
export const PREVIEW_READY_MARKER = 'preview forwarder listening on'

/**
 * A TCP forwarder for live previews: one server per forward, piping each connection to
 * `target:port` and nowhere else (HTTP, WebSockets and anything else over TCP). Not listening yet.
 */
export function createPreviewForwarder(opts: PreviewForwarderOptions): (PreviewForward & { server: Server })[] {
  return core.createPreviewForwarder(opts)
}

/**
 * The forwarder as a self-contained script for `node -e`: node built-ins only. It reads the forwards
 * as JSON from `FORWARDS` (`[{ "listen": 5173, "port": 5173 }]`) and the target host from `TARGET`
 * (default `main`), listens on all interfaces and logs `PREVIEW_READY_MARKER` to stderr.
 */
export const PREVIEW_FORWARDER_SOURCE = `const module = { exports: {} };
(function (module, exports, require) {
${readFileSync(CORE_URL, 'utf8')}
})(module, module.exports, require);
let forwards = [];
try { forwards = JSON.parse(process.env.FORWARDS || '[]'); } catch (e) { console.error('FORWARDS is not JSON'); process.exit(2); }
if (!Array.isArray(forwards) || !forwards.length) { console.error('FORWARDS must be a non-empty JSON array'); process.exit(2); }
const servers = module.exports.createPreviewForwarder({ target: process.env.TARGET || 'main', forwards });
let pending = servers.length;
for (const s of servers) {
  s.server.on('error', (e) => { console.error('forwarder error on ' + s.listen + ': ' + e.message); process.exit(1); });
  s.server.listen(s.listen, '0.0.0.0', () => { if (--pending === 0) console.error('${PREVIEW_READY_MARKER} ' + servers.map((x) => x.listen).join(',')); });
}
process.on('SIGTERM', () => process.exit(0));
`
