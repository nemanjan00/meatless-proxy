import { createHash } from 'node:crypto'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

/** The image types chat attachments and model input accept. SVG is not one: it is a document that can run script. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMime = (typeof IMAGE_MIMES)[number]

/** What the bytes of an image say about it. */
export interface ImageInfo {
  mime: ImageMime
  /** Pixels, when the header says (it always does for well-formed files). */
  width?: number
  height?: number
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const dims = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : {})

/**
 * The image type of some bytes, from their magic bytes (never from a name or a claimed type), with
 * the dimensions from the header. Null for anything that isn't a PNG, JPEG, GIF or WebP.
 */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const b = bytes
  if (b.length >= 24 && PNG_SIG.every((x, i) => b[i] === x) && ascii(b, 12, 4) === 'IHDR')
    return { mime: 'image/png', ...dims(u32be(b, 16), u32be(b, 20)) }
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a'))
    return { mime: 'image/gif', ...dims(u16le(b, 6), u16le(b, 8)) }
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4)
    if (chunk === 'VP8 ' && b.length >= 30) return { mime: 'image/webp', ...dims(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff) }
    if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { mime: 'image/webp', ...dims((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) }
    }
    if (chunk === 'VP8X' && b.length >= 30) return { mime: 'image/webp', ...dims(u24le(b, 24) + 1, u24le(b, 27) + 1) }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ...jpegSize(b) }
  return null
}

/** Width and height from a JPEG's first start-of-frame marker. */
function jpegSize(b: Uint8Array): { width?: number; height?: number } {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]!
    if (marker === 0xff) {
      i++
      continue
    }
    // Markers without a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = u16be(b, i + 2)
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (sof) return dims(u16be(b, i + 7), u16be(b, i + 5))
    if (len < 2) return {}
    i += 2 + len
  }
  return {}
}

/** The sha256 of some bytes, hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ─── PNG: decode, downscale, encode (no dependencies: node:zlib only) ───────

/** Decoding refuses images with more pixels than this (a decompression bomb guard). */
const MAX_DECODE_PIXELS = 40_000_000

interface Rgba {
  width: number
  height: number
  /** 4 bytes per pixel, row by row. */
  data: Uint8Array
}

/**
 * Decodes a PNG to RGBA. Handles 8-bit grey, RGB, palette, grey+alpha and RGBA, not interlaced
 * (by far the common cases: screenshots and charts). Null for anything else.
 */
export function decodePng(bytes: Uint8Array): Rgba | null {
  const info = sniffImage(bytes)
  if (info?.mime !== 'image/png') return null
  let pos = 8
  let width = 0
  let height = 0
  let colorType = -1
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  while (pos + 8 <= bytes.length) {
    const len = u32be(bytes, pos)
    const type = ascii(bytes, pos + 4, 4)
    const data = bytes.subarray(pos + 8, pos + 8 + len)
    if (data.length !== len) return null
    if (type === 'IHDR') {
      width = u32be(data, 0)
      height = u32be(data, 4)
      const depth = data[8]
      colorType = data[9]!
      if (depth !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return null
      if (![0, 2, 3, 4, 6].includes(colorType)) return null
      if (!width || !height || width * height > MAX_DECODE_PIXELS) return null
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!width || !idat.length || (colorType === 3 && !palette)) return null
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6]
  const stride = width * channels
  let raw: Uint8Array
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height + 1 })
  } catch {
    return null
  }
  if (raw.length < (stride + 1) * height) return null
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = px.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels]! : 0
      const up = prev ? prev[x]! : 0
      const c = prev && x >= channels ? prev[x - channels]! : 0
      let v = src[x]!
      if (filter === 1) v += a
      else if (filter === 2) v += up
      else if (filter === 3) v += (a + up) >> 1
      else if (filter === 4) {
        const p = a + up - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c
      } else if (filter !== 0) return null
      row[x] = v & 0xff
    }
  }
  const out = new Uint8Array(width * height * 4)
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4
    if (colorType === 6) out.set(px.subarray(o, o + 4), o)
    else if (colorType === 2) {
      out[o] = px[i * 3]!
      out[o + 1] = px[i * 3 + 1]!
      out[o + 2] = px[i * 3 + 2]!
      out[o + 3] = 255
    } else if (colorType === 0) {
      out[o] = out[o + 1] = out[o + 2] = px[i]!
      out[o + 3] = 255
    } else if (colorType === 4) {
      out[o] = out[o + 1] = out[o + 2] = px[i * 2]!
      out[o + 3] = px[i * 2 + 1]!
    } else {
      const k = px[i]!
      out[o] = palette![k * 3] ?? 0
      out[o + 1] = palette![k * 3 + 1] ?? 0
      out[o + 2] = palette![k * 3 + 2] ?? 0
      out[o + 3] = trns && k < trns.length ? trns[k]! : 255
    }
  }
  return { width, height, data: out }
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** Encodes RGBA pixels as a PNG. The same pixels always give the same bytes. */
export function encodePng(img: Rgba): Uint8Array {
  const { width, height, data } = img
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    // Filter "Up": cheap, and it compresses screenshots and charts well.
    raw[y * (stride + 1)] = y > 0 ? 2 : 0
    for (let x = 0; x < stride; x++) {
      const v = data[y * stride + x]!
      raw[y * (stride + 1) + 1 + x] = y > 0 ? (v - data[(y - 1) * stride + x]!) & 0xff : v
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(PNG_SIG),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', new Uint8Array()),
    ]),
  )
}

/** Box-filter downscale of RGBA pixels to fit `maxSide` (alpha-weighted, so transparent pixels don't darken edges). */
export function resizeRgba(img: Rgba, maxSide: number): Rgba {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
  if (scale >= 1) return img
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const out = new Uint8Array(w * h * 4)
  for (let ty = 0; ty < h; ty++) {
    const y0 = Math.floor((ty * img.height) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * img.height) / h))
    for (let tx = 0; tx < w; tx++) {
      const x0 = Math.floor((tx * img.width) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * img.width) / w))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * img.width + x) * 4
          const al = img.data[i + 3]!
          r += img.data[i]! * al
          g += img.data[i + 1]! * al
          b += img.data[i + 2]! * al
          a += al
          n++
        }
      const o = (ty * w + tx) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / n)
    }
  }
  return { width: w, height: h, data: out }
}

/** An image prepared for a model: possibly downscaled. */
export interface PreparedImage {
  mime: string
  bytes: Uint8Array
  width?: number
  height?: number
  /** True when it was downscaled to fit. */
  scaled: boolean
}

/**
 * Fits an image to `maxSide` pixels on its longest side, for model input. PNGs are downscaled here
 * (deterministically: the same input always gives the same bytes, so a cached prompt prefix stays
 * valid). Other types, and PNGs this decoder can't read, are passed through unchanged; providers
 * scale them on their side.
 */
export function prepareImage(bytes: Uint8Array, opts: { maxSide?: number } = {}): PreparedImage | null {
  const info = sniffImage(bytes)
  if (!info) return null
  const maxSide = opts.maxSide ?? 0
  const big = maxSide > 0 && info.width && info.height && Math.max(info.width, info.height) > maxSide
  if (big && info.mime === 'image/png') {
    const img = decodePng(bytes)
    if (img) {
      const small = resizeRgba(img, maxSide)
      return { mime: 'image/png', bytes: encodePng(small), width: small.width, height: small.height, scaled: true }
    }
  }
  return {
    mime: info.mime,
    bytes,
    ...(info.width ? { width: info.width } : {}),
    ...(info.height ? { height: info.height } : {}),
    scaled: false,
  }
}

/** A solid-colour PNG, for tests and examples. */
export function solidPng(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4)
  return encodePng({ width, height, data })
}
