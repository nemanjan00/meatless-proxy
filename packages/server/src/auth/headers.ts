import type { MiddlewareHandler } from 'hono'
import type { Config } from '../config.ts'
import { previewFrameSources } from '../previews/origins.ts'

type HeaderConfig = Pick<Config, 'PREVIEW_DOMAIN' | 'PREVIEW_PORT' | 'PUBLIC_URL'>

/**
 * The Content-Security-Policy of the web UI: everything from our own origin
 * (the fonts are bundled, so no font CDN), inline styles (component
 * libraries set them), no framing of the UI anywhere, and frames only from
 * live previews: `https://*.<PREVIEW_DOMAIN>`, or the harness's host on
 * `PREVIEW_PORT` without a domain (from `PUBLIC_URL`, else the request's
 * `host` and scheme).
 */
export function contentSecurityPolicy(
  config: Partial<HeaderConfig> & Pick<Config, 'PUBLIC_URL'>,
  requestHost?: string,
  requestScheme?: string,
): string {
  const connect = ["'self'"]
  if (config.PUBLIC_URL) {
    const u = new URL(config.PUBLIC_URL)
    connect.push(`${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`)
  }
  const previews = previewFrameSources(
    { PREVIEW_DOMAIN: config.PREVIEW_DOMAIN, PREVIEW_PORT: config.PREVIEW_PORT ?? 0, PUBLIC_URL: config.PUBLIC_URL },
    requestHost,
    requestScheme,
  )
  const frames = previews.length ? previews : ["'none'"]
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    `connect-src ${connect.join(' ')}`,
    `frame-src ${frames.join(' ')}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}

/**
 * Security headers on every response: `X-Content-Type-Options: nosniff` and
 * `Referrer-Policy: same-origin` (sign-in links carry a token in the URL),
 * plus the CSP and `X-Frame-Options: DENY` on HTML pages.
 */
export function securityHeaders(config: Partial<HeaderConfig> & Pick<Config, 'PUBLIC_URL'>): MiddlewareHandler {
  // The same for every request, unless previews are on a port of whatever host the UI is served at.
  const perRequest = !config.PREVIEW_DOMAIN && !config.PUBLIC_URL && !!config.PREVIEW_PORT
  const fixed = contentSecurityPolicy(config)
  return async (c, next) => {
    await next()
    // A WebSocket upgrade's response can't take headers.
    if (c.res.status === 101) return
    c.res.headers.set('x-content-type-options', 'nosniff')
    c.res.headers.set('referrer-policy', 'same-origin')
    if (c.res.headers.get('content-type')?.startsWith('text/html')) {
      const csp = perRequest
        ? contentSecurityPolicy(
            config,
            c.req.header('host') ?? new URL(c.req.url).host,
            new URL(c.req.url).protocol.replace(':', ''),
          )
        : fixed
      c.res.headers.set('content-security-policy', csp)
      c.res.headers.set('x-frame-options', 'DENY')
    }
  }
}
