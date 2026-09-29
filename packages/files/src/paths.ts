import { ValidationError } from '@mp/core'

/** Directory that lists what others shared with the reader. */
export const SHARED_DIR = '/shared'

const MAX_PATH = 1024

/**
 * Normalizes to an absolute POSIX path: `notes//a.md/` -> `/notes/a.md`.
 * Rejects `..`, backslashes, control characters and overlong paths.
 */
export function normalizePath(p: string): string {
  if (typeof p !== 'string') throw new ValidationError('path must be a string')
  if (p.length > MAX_PATH) throw new ValidationError(`path is longer than ${MAX_PATH} characters`)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new ValidationError('path contains control characters')
  if (p.includes('\\')) throw new ValidationError('path must use forward slashes')
  const parts = p.split('/').filter((s) => s !== '' && s !== '.')
  if (parts.includes('..')) throw new ValidationError('path must not contain ..')
  return `/${parts.join('/')}`
}

/** `/a/b/c` -> `['/a', '/a/b']`. */
export function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)
}

/** Whether `path` is `base` or inside it. */
export function isWithin(base: string, path: string): boolean {
  return base === '/' || path === base || path.startsWith(`${base}/`)
}

/** `/a` + `/b/c` -> `/a/b/c`. */
export function joinPath(base: string, rel: string): string {
  return normalizePath(`${base}/${rel}`)
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? ''
}

const MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  ts: 'text/typescript',
  sh: 'text/x-shellscript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
}

/** A mime type guessed from the extension. */
export function guessMime(path: string, encoding: 'utf8' | 'base64'): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && MIME[ext]) || (encoding === 'base64' ? 'application/octet-stream' : 'text/plain')
}
