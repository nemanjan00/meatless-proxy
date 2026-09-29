import { DeniedError } from '@mp/core'
import type { MiddlewareHandler } from 'hono'
import type { Config } from '../config.ts'

/**
 * Where previews live (docs/spec.md "Live previews"): never on the harness's own origin.
 *
 * - **Domain mode** (`PREVIEW_DOMAIN` set): each preview has its own origin,
 *   `<env>-<port>.<PREVIEW_DOMAIN>`, served by the preview listener behind a reverse proxy with
 *   wildcard DNS and a wildcard certificate.
 * - **Port mode**: one origin for every preview, the harness's host name on `PREVIEW_PORT`.
 */
export type PreviewMode = { kind: 'domain'; domain: string; scheme: 'http' | 'https' } | { kind: 'port'; port: number }

export type PreviewConfig = Pick<Config, 'PREVIEW_DOMAIN' | 'PREVIEW_PORT' | 'PUBLIC_URL'>

export function previewMode(config: PreviewConfig): PreviewMode {
  if (config.PREVIEW_DOMAIN) {
    const scheme = config.PUBLIC_URL?.startsWith('http:') ? 'http' : 'https'
    return { kind: 'domain', domain: config.PREVIEW_DOMAIN.toLowerCase(), scheme }
  }
  return { kind: 'port', port: config.PREVIEW_PORT }
}

/** `host[:port]` split, with IPv6 brackets kept on the name. */
export function splitHost(host: string): { name: string; port: string } {
  const h = host.trim().toLowerCase()
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(h)
  return { name: (m?.[1] ?? h).replace(/\.$/, ''), port: m?.[2] ?? '' }
}

/** The DNS label of a preview in domain mode: `<env>-<port>`, lowercased. */
export const previewLabel = (envId: string, port: number) => `${envId.toLowerCase()}-${port}`

/** The env label and port of a preview host in domain mode, or null when it isn't one. */
export function parsePreviewHost(host: string, domain: string): { label: string; port: number } | null {
  const { name } = splitHost(host)
  const suffix = `.${domain}`
  if (!name.endsWith(suffix)) return null
  const label = name.slice(0, -suffix.length)
  const m = /^([a-z0-9][a-z0-9_.-]*)-(\d{1,5})$/.exec(label)
  if (!m || label.includes('.')) return null
  const port = Number(m[2])
  return port >= 1 && port <= 65535 ? { label, port } : null
}

/** Whether a `Host` header names a preview origin. */
export function isPreviewHost(mode: PreviewMode, host: string | undefined): boolean {
  if (!host) return false
  const { name, port } = splitHost(host)
  if (mode.kind === 'domain') return name === mode.domain || name.endsWith(`.${mode.domain}`)
  return mode.port !== 0 && port === String(mode.port)
}

/** Whether an `Origin` header is a preview origin. */
export function isPreviewOrigin(mode: PreviewMode, origin: string | undefined): boolean {
  if (!origin || origin === 'null') return false
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (mode.kind === 'domain') return isPreviewHost(mode, u.hostname)
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  return mode.port !== 0 && port === String(mode.port)
}

/**
 * The origin of one preview. In port mode it is the harness's host name (from `PUBLIC_URL`, else
 * `requestHost`, the host the viewer reached the harness at) on the preview port.
 */
export function previewOrigin(
  config: PreviewConfig,
  scope: { envId: string; port: number },
  requestHost: string,
  previewPort = config.PREVIEW_PORT,
): string {
  const mode = previewMode(config)
  if (mode.kind === 'domain') return `${mode.scheme}://${previewLabel(scope.envId, scope.port)}.${mode.domain}`
  const pub = config.PUBLIC_URL ? new URL(config.PUBLIC_URL) : null
  const scheme = pub ? pub.protocol.replace(':', '') : 'http'
  const name = pub ? pub.hostname : splitHost(requestHost).name
  return `${scheme}://${name}:${previewPort}`
}

/**
 * `frame-src` for the harness UI's CSP: the preview origins and nothing else. In port mode without
 * `PUBLIC_URL` it depends on the host the UI is served at (`requestHost`).
 */
export function previewFrameSources(config: PreviewConfig, requestHost?: string, requestScheme = 'http'): string[] {
  const mode = previewMode(config)
  if (mode.kind === 'domain') return [`${mode.scheme}://*.${mode.domain}`]
  if (!mode.port) return []
  if (config.PUBLIC_URL) {
    const u = new URL(config.PUBLIC_URL)
    return [`${u.protocol}//${u.hostname}:${mode.port}`]
  }
  if (!requestHost) return []
  return [`${requestScheme}://${splitHost(requestHost).name}:${mode.port}`]
}

/**
 * Mounted first on the harness app: refuses every request whose `Host` or `Origin` is a preview
 * origin. Code in a preview (anything the employee wrote or installed) can never call the harness
 * API, WebSocket or MCP server, and the harness never answers on a preview origin.
 */
export function refusePreviewOrigins(config: PreviewConfig): MiddlewareHandler {
  const mode = previewMode(config)
  return async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (isPreviewHost(mode, host)) throw new DeniedError('this is a preview origin: the harness does not answer here')
    if (isPreviewOrigin(mode, c.req.header('origin'))) throw new DeniedError('requests from preview origins are refused')
    return next()
  }
}
