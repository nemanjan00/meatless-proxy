import type { FileContent } from '@mp/api'

/** What the server sniffs on a file read (`mime`, and an image's size), done in the browser for the mock. */

const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

function bytesOf(f: Pick<FileContent, 'content' | 'encoding'>): Uint8Array {
  if (f.encoding !== 'base64') return new TextEncoder().encode(f.content)
  const bin = atob(f.content)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** PNG, GIF and JPEG/WebP by their magic bytes (dimensions for PNG and GIF); text by extension, like the server. */
export function mockSniff(f: Pick<FileContent, 'path' | 'content' | 'encoding'>): Pick<FileContent, 'mime' | 'width' | 'height'> {
  const b = bytesOf(f)
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR')
    return { mime: 'image/png', width: u32be(b, 16), height: u32be(b, 20) }
  if (b.length >= 10 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return { mime: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg' }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { mime: 'image/webp' }
  if (f.encoding === 'base64') return { mime: 'application/octet-stream' }
  if (/\.svg$/i.test(f.path)) return { mime: 'image/svg+xml' }
  if (/\.md$/i.test(f.path)) return { mime: 'text/markdown' }
  return { mime: 'text/plain' }
}

/** The mock's `fileUrl`: a data URL of the bytes (only images get their type; the rest are downloads). */
export function mockFileUrl(f: FileContent | undefined): string {
  if (!f) return ''
  const { mime = 'application/octet-stream' } = mockSniff(f)
  const type = mime.startsWith('image/') && mime !== 'image/svg+xml' ? mime : 'application/octet-stream'
  let bin = ''
  if (f.encoding !== 'base64') for (const x of new TextEncoder().encode(f.content)) bin += String.fromCharCode(x)
  const b64 = f.encoding === 'base64' ? f.content : btoa(bin)
  return `data:${type};base64,${b64}`
}
