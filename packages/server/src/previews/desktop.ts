import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The desktop viewer on the preview origin (docs/spec.md "Desktops"): a small page that runs noVNC
 * (`@novnc/novnc`, MPL-2.0) against an environment's VNC-over-WebSocket bridge. Everything it needs
 * is served by the preview listener itself, under the reserved `/__mp_preview/` prefix, so the VNC
 * connection and its credentials never touch the harness's origin:
 *
 * - `/__mp_preview/desktop/<envId>/<port>/`: the page, for a desktop cookie scoped to that very path
 * - `/__mp_preview/desktop/<envId>/<port>/websockify`: its WebSocket, tunnelled to the bridge
 * - `/__mp_preview/desktop.js` and `/__mp_preview/novnc/…`: the viewer script and noVNC, public code
 */

export const DESKTOP_PREFIX = '/__mp_preview/desktop/'
/** The desktop viewer's cookie. Its `Path` is the desktop's own page, so each desktop has its own. */
export const DESKTOP_COOKIE = 'mp_desktop'
export const VIEWER_SCRIPT_PATH = '/__mp_preview/desktop.js'
export const NOVNC_PREFIX = '/__mp_preview/novnc/'
/** The WebSocket under a desktop's page. */
export const DESKTOP_SOCKET = 'websockify'

/** The page of one desktop (with a trailing slash; its cookie's `Path`). */
export const desktopPath = (envId: string, port: number) => `${DESKTOP_PREFIX}${encodeURIComponent(envId)}/${port}/`

/** The environment, port and sub-path of a desktop URL path, or null when it isn't one. */
export function parseDesktopPath(pathname: string): { envId: string; port: number; rest: string } | null {
  if (!pathname.startsWith(DESKTOP_PREFIX)) return null
  const m = /^([^/]+)\/(\d{1,5})\/(.*)$/.exec(pathname.slice(DESKTOP_PREFIX.length))
  if (!m) return null
  let envId: string
  try {
    envId = decodeURIComponent(m[1]!)
  } catch {
    return null
  }
  const port = Number(m[2])
  if (!envId || port < 1 || port > 65535) return null
  return { envId, port, rest: m[3]! }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The viewer page. `viewOnly` and `thumbnail` only change what the page does; the port decides what the VNC server allows. */
export function desktopPage(o: { viewOnly: boolean; thumbnail: boolean; title: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>${escapeHtml(o.title)}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #08090a; overflow: hidden; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #d0d6e0; }
  #screen { position: absolute; inset: 0; }
  #status { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 6px 12px;
    border: 1px solid #23252a; border-radius: 6px; background: #0f1011; color: #8a8f98; pointer-events: none; }
  #status[hidden] { display: none; }
  body.thumbnail #status { font-size: 11px; padding: 2px 8px; }
</style>
</head>
<body class="${o.thumbnail ? 'thumbnail' : ''}" data-view-only="${o.viewOnly ? '1' : '0'}" data-thumbnail="${o.thumbnail ? '1' : '0'}">
<div id="screen"></div>
<div id="status">Connecting…</div>
<script type="module" src="${VIEWER_SCRIPT_PATH}"></script>
</body>
</html>
`
}

/** `Content-Security-Policy` of the viewer page: its own scripts, and WebSockets to its own host only. */
export function desktopPageCsp(host: string, frameAncestors: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src 'self' ws://${host} wss://${host}`,
    "base-uri 'none'",
    "form-action 'none'",
    frameAncestors,
  ].join('; ')
}

const VIEWER_SCRIPT = readFileSync(fileURLToPath(new URL('./desktop-viewer.js', import.meta.url)), 'utf8')

/** The viewer script (an ES module that imports noVNC from `NOVNC_PREFIX`). */
export const viewerScript = () => VIEWER_SCRIPT

let novncRoot: string | null | undefined
/** Where `@novnc/novnc` is installed, or null when it isn't. */
function novncDir(): string | null {
  if (novncRoot === undefined) {
    try {
      // Its only export is core/rfb.js.
      novncRoot = dirname(dirname(createRequire(import.meta.url).resolve('@novnc/novnc')))
    } catch {
      novncRoot = null
    }
  }
  return novncRoot
}

/** One of noVNC's own modules (under `core/` or `vendor/`), or null. Paths can't leave those directories. */
export async function novncFile(rel: string): Promise<{ body: Buffer; type: string } | null> {
  const root = novncDir()
  if (!root || !/^[A-Za-z0-9_./-]+\.js$/.test(rel) || rel.includes('..')) return null
  const clean = normalize(rel)
  if (!(clean.startsWith(`core${sep}`) || clean.startsWith(`vendor${sep}`))) return null
  try {
    return { body: await readFile(join(root, clean)), type: 'text/javascript; charset=utf-8' }
  } catch {
    return null
  }
}
