import { IMAGE_MIMES, type ImageMime, sniffImage } from './images.ts'

/**
 * What a file is, for chat attachments and downloads: an image (by its magic bytes), a known binary
 * format (by its magic bytes), text (valid UTF-8 without NUL bytes, typed by its extension), or
 * `application/octet-stream`. Never from a type the uploader claims.
 */
export interface FileInfo {
  mime: string
  /** `image` only for PNG, JPEG, GIF and WebP by content; everything else is a `file`. */
  kind: 'image' | 'file'
  /** Valid UTF-8 without NUL bytes. */
  text: boolean
  width?: number
  height?: number
}

/** Text files up to this size get a preview (`GET /api/chat/attachments/:id/text`, chat.attachment_text). */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024

const TEXT_MIME: Record<string, string> = {
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  py: 'text/x-python',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  ini: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  sql: 'application/sql',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  css: 'text/css',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  rb: 'text/x-ruby',
  php: 'text/x-php',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
}

const OFFICE: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Types a browser could run or render as a document: always downloaded as `application/octet-stream`. */
const ACTIVE = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'text/javascript',
  'application/javascript',
  'application/pdf',
  'text/css',
])

const utf8 = new TextDecoder('utf-8', { fatal: true })

const extOf = (name: string | undefined) => /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1]?.toLowerCase()
const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

function isUtf8Text(b: Uint8Array): boolean {
  if (b.includes(0)) return false
  try {
    utf8.decode(b)
    return true
  } catch {
    return false
  }
}

/** A binary format recognised by its magic bytes. */
function sniffBinary(b: Uint8Array, ext: string | undefined): string | null {
  if (startsWith(b, ascii('%PDF-'))) return 'application/pdf'
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return (ext && OFFICE[ext]) || 'application/zip'
  if (startsWith(b, [0x1f, 0x8b])) return 'application/gzip'
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed'
  if (startsWith(b, ascii('ustar'), 257)) return 'application/x-tar'
  return null
}

/** What some bytes are (see `FileInfo`). `name` only types text by its extension, or a script by its `#!` line. */
export function sniffFile(bytes: Uint8Array, name?: string): FileInfo {
  const img = sniffImage(bytes)
  if (img) return { kind: 'image', text: false, ...img }
  const ext = extOf(name)
  const bin = sniffBinary(bytes, ext)
  if (bin) return { mime: bin, kind: 'file', text: false }
  if (isUtf8Text(bytes)) {
    let mime = (ext && TEXT_MIME[ext]) || 'text/plain'
    if (!ext || mime === 'text/plain') {
      const bang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(new TextDecoder().decode(bytes.subarray(0, 100)))
      const first = bang?.[1]?.split('/').pop()
      const prog = first === 'env' ? bang?.[2] : first
      if (prog && /^(ba|z|da|k)?sh$/.test(prog)) mime = 'text/x-shellscript'
      else if (prog && /^python/.test(prog)) mime = 'text/x-python'
      else if (prog === 'node') mime = 'text/javascript'
    }
    return { mime, kind: 'file', text: true }
  }
  return { mime: 'application/octet-stream', kind: 'file', text: false }
}

/** Whether a mime type is one of the image types chat shows inline. */
export const isImageMime = (mime: string): mime is ImageMime => (IMAGE_MIMES as readonly string[]).includes(mime)

/** Whether a mime type `sniffFile` gives only to UTF-8 text. */
export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || Object.values(TEXT_MIME).includes(mime)
}

/**
 * The type to serve a download with: the file's own type, unless a browser could run or render it
 * (HTML, SVG, XML, JavaScript, CSS, PDF), then `application/octet-stream`.
 */
export function downloadMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]!.trim()
  if (ACTIVE.has(m) || m.includes('html') || m.includes('xml') || m.includes('script')) {
    // Shell and Python scripts render as nothing; they keep their type.
    if (m === 'text/x-shellscript') return m
    return 'application/octet-stream'
  }
  return m || 'application/octet-stream'
}

/** A file name's extension for a type, for default names (`file.txt`). */
export function extensionFor(mime: string): string | undefined {
  if (isImageMime(mime)) return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime]
  const text = Object.entries(TEXT_MIME).find(([, m]) => m === mime)?.[0]
  if (text) return text
  return (
    { 'application/pdf': 'pdf', 'application/zip': 'zip', 'application/gzip': 'gz', 'application/x-tar': 'tar' } as Record<
      string,
      string
    >
  )[mime]
}
