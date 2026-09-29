import type { MiddlewareHandler } from 'hono'
import type { Config } from '../config.ts'

/**
 * The Content-Security-Policy of the web UI: everything from our own origin
 * (the fonts are bundled, so no font CDN), inline styles (component
 * libraries set them), no framing of the UI anywhere, and frames only from
 * live previews (`https://*.<PREVIEW_DOMAIN>`) when that is configured.
 */
export function contentSecurityPolicy(config: Pick<Config, 'PREVIEW_DOMAIN' | 'PUBLIC_URL'>): string {
  const connect = ["'self'"]
  if (config.PUBLIC_URL) {
    const u = new URL(config.PUBLIC_URL)
    connect.push(`${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`)
  }
  const frames = config.PREVIEW_DOMAIN ? [`https://*.${config.PREVIEW_DOMAIN}`] : ["'none'"]
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
export function securityHeaders(config: Pick<Config, 'PREVIEW_DOMAIN' | 'PUBLIC_URL'>): MiddlewareHandler {
  const csp = contentSecurityPolicy(config)
  return async (c, next) => {
    await next()
    // A WebSocket upgrade's response can't take headers.
    if (c.res.status === 101) return
    c.res.headers.set('x-content-type-options', 'nosniff')
    c.res.headers.set('referrer-policy', 'same-origin')
    if (c.res.headers.get('content-type')?.startsWith('text/html')) {
      c.res.headers.set('content-security-policy', csp)
      c.res.headers.set('x-frame-options', 'DENY')
    }
  }
}
