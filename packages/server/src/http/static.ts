import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { Hono } from 'hono'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

/** The default location of the built web UI: `packages/web/dist` in this repository. */
export const defaultWebDist = () => resolve(new URL('../../../web/dist', import.meta.url).pathname)

/**
 * Serves the built web UI from `dir`: files by path, and `index.html` for any
 * other GET that isn't an API, WebSocket or MCP path (client-side routing).
 * Returns false when there is no build.
 */
export function serveWeb(app: Hono, dir: string): boolean {
  const root = resolve(dir)
  const index = join(root, 'index.html')
  if (!existsSync(index)) return false
  app.get('*', (c, next) => {
    const path = c.req.path
    if (path.startsWith('/api/') || path === '/ws' || path === '/mcp' || path === '/healthz' || path === '/readyz') return next()
    let rel: string
    try {
      rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '')
    } catch {
      return next()
    }
    const file = resolve(root, rel)
    const inside = file === root || file.startsWith(root + sep)
    const target = inside && rel && existsSync(file) && statSync(file).isFile() ? file : index
    const body = readFileSync(target)
    const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
    const cache =
      target === index ? 'no-cache' : rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300'
    return c.body(body, 200, { 'content-type': type, 'cache-control': cache })
  })
  return true
}
