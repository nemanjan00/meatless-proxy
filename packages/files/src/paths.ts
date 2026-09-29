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

/** Where code.run sees the employee's own files: `/work/files/a.txt` is `/a.txt` for the fs tools. */
export const SANDBOX_FILES_DIR = '/work/files'
/** Where code.run sees files shared with the employee: `/work/shared/<owner>/p` is `/shared/<owner>/p`. */
export const SANDBOX_SHARED_DIR = '/work/shared'

/**
 * An employee-file path as any tool takes it, in the fs tools' form. `/work/files/a.txt`, `a.txt` and
 * `/a.txt` are the same file (`/a.txt`); `/work/shared/<owner>/p` is `/shared/<owner>/p`. Rejects what
 * `normalizePath` rejects (`..` included), so nothing escapes the employee's tree.
 */
export function employeePath(p: string): string {
  const n = normalizePath(p)
  if (isWithin(SANDBOX_FILES_DIR, n)) return n.slice(SANDBOX_FILES_DIR.length) || '/'
  if (isWithin(SANDBOX_SHARED_DIR, n)) return `${SHARED_DIR}${n.slice(SANDBOX_SHARED_DIR.length)}`
  return n
}

/** The other way: a fs-tools path as code.run sees it (`/a.txt` -> `/work/files/a.txt`, `/shared/o/p` -> `/work/shared/o/p`). */
export function sandboxPath(p: string): string {
  const n = normalizePath(p)
  if (isWithin(SHARED_DIR, n)) return `${SANDBOX_SHARED_DIR}${n.slice(SHARED_DIR.length)}`
  return n === '/' ? SANDBOX_FILES_DIR : `${SANDBOX_FILES_DIR}${n}`
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
