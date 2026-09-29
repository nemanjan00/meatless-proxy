/**
 * A minimal tar (ustar + pax path headers) writer and reader, for Docker's archive API
 * (`putArchive`/`getArchive`). Regular files and directories only; everything else is skipped
 * when reading.
 */

export interface TarEntry {
  /** Relative POSIX path inside the archive, without a leading slash. */
  path: string
  type: 'file' | 'dir'
  content?: Uint8Array
  mode?: number
  uid?: number
  gid?: number
  /** Modification time, milliseconds since the epoch. */
  mtimeMs?: number
}

const BLOCK = 512

function octal(value: number, width: number): string {
  // `width - 1` digits and a NUL, as ustar expects.
  return `${Math.max(0, Math.floor(value))
    .toString(8)
    .padStart(width - 1, '0')}\0`
}

function header(
  name: string,
  prefix: string,
  e: { size: number; type: string; mode: number; uid: number; gid: number; mtime: number },
) {
  const b = Buffer.alloc(BLOCK)
  b.write(name, 0, 100, 'utf8')
  b.write(octal(e.mode, 8), 100, 8, 'ascii')
  b.write(octal(e.uid, 8), 108, 8, 'ascii')
  b.write(octal(e.gid, 8), 116, 8, 'ascii')
  b.write(octal(e.size, 12), 124, 12, 'ascii')
  b.write(octal(e.mtime, 12), 136, 12, 'ascii')
  b.write('        ', 148, 8, 'ascii') // checksum placeholder
  b.write(e.type, 156, 1, 'ascii')
  b.write('ustar\0', 257, 6, 'ascii')
  b.write('00', 263, 2, 'ascii')
  b.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of b) sum += byte
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return b
}

const pad = (n: number) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK)

/** A pax record `"<len> path=<value>\n"`, where `<len>` counts the whole record including itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  return Buffer.from(`${len}${body}`)
}

/** Packs entries into a tar archive. Long paths get a pax `path` record. */
export function packTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const path = e.type === 'dir' && !e.path.endsWith('/') ? `${e.path}/` : e.path
    const content = e.type === 'file' ? Buffer.from(e.content ?? new Uint8Array()) : Buffer.alloc(0)
    const meta = {
      size: content.length,
      type: e.type === 'dir' ? '5' : '0',
      mode: e.mode ?? (e.type === 'dir' ? 0o755 : 0o644),
      uid: e.uid ?? 0,
      gid: e.gid ?? 0,
      mtime: Math.floor((e.mtimeMs ?? Date.now()) / 1000),
    }
    if (Buffer.byteLength(path) > 100) {
      const pax = paxRecord('path', path)
      parts.push(header('PaxHeader', '', { ...meta, size: pax.length, type: 'x' }), pax, pad(pax.length))
      parts.push(header(path.slice(0, 99), '', meta))
    } else parts.push(header(path, '', meta))
    parts.push(content, pad(content.length))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

const cstr = (b: Buffer, start: number, len: number) => {
  const slice = b.subarray(start, start + len)
  const nul = slice.indexOf(0)
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8')
}
const num = (b: Buffer, start: number, len: number) => Number.parseInt(cstr(b, start, len).trim() || '0', 8)

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < body.length) {
    const space = body.indexOf(0x20, i)
    if (space === -1) break
    const len = Number.parseInt(body.subarray(i, space).toString('ascii'), 10)
    if (!(len > 0)) break
    const rec = body.subarray(space + 1, i + len - 1).toString('utf8')
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    i += len
  }
  return out
}

/** Reads regular files and directories from a tar archive (ustar, pax `path`, GNU long names). */
export function unpackTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  let i = 0
  let longName: string | undefined
  while (i + BLOCK <= buf.length) {
    const h = buf.subarray(i, i + BLOCK)
    if (h.every((x) => x === 0)) break
    const size = num(h, 124, 12)
    const type = String.fromCharCode(h[156] || 0x30)
    const body = buf.subarray(i + BLOCK, i + BLOCK + size)
    i += BLOCK + size + ((BLOCK - (size % BLOCK)) % BLOCK)
    if (type === 'x') {
      longName = parsePax(body).path ?? longName
      continue
    }
    if (type === 'L') {
      longName = cstr(body, 0, body.length)
      continue
    }
    if (type === 'g') continue
    const prefix = cstr(h, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100))
    longName = undefined
    const meta = { mode: num(h, 100, 8), uid: num(h, 108, 8), gid: num(h, 116, 8), mtimeMs: num(h, 136, 12) * 1000 }
    if (type === '0' || type === '\0' || type === '7') out.push({ path: name, type: 'file', content: Buffer.from(body), ...meta })
    else if (type === '5') out.push({ path: name.replace(/\/+$/, ''), type: 'dir', ...meta })
  }
  return out
}
