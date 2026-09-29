import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodePng, encodePng, prepareImage, resizeRgba, sha256Hex, sniffImage, solidPng } from '../src/index.ts'

const bytes = (...xs: number[]) => new Uint8Array(xs)
const pad = (b: Uint8Array, n = 64) => {
  const out = new Uint8Array(Math.max(n, b.length))
  out.set(b)
  return out
}

describe('sniffImage', () => {
  it('reads PNG type and size from the header', () => {
    expect(sniffImage(solidPng(7, 3, [255, 0, 0, 255]))).toEqual({ mime: 'image/png', width: 7, height: 3 })
  })

  it('reads GIF, JPEG and the three WebP flavours', () => {
    const gif = pad(new Uint8Array([...Buffer.from('GIF89a'), 10, 0, 20, 0]))
    expect(sniffImage(gif)).toEqual({ mime: 'image/gif', width: 10, height: 20 })
    // SOI, an APP0 segment, then SOF0 with height 0x0102 and width 0x0304.
    const jpeg = pad(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x02, 0x03, 0x04))
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', width: 0x0304, height: 0x0102 })
    const riff = (chunk: string, body: number[]) =>
      pad(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), ...Buffer.from(chunk), ...body]))
    const vp8 = riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 50, 0, 40, 0])
    expect(sniffImage(vp8)).toEqual({ mime: 'image/webp', width: 50, height: 40 })
    // VP8L: signature 0x2f, then (w-1) in 14 bits and (h-1) in the next 14.
    const bits = 99 | (49 << 14)
    const vp8l = riff('VP8L', [0, 0, 0, 0, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff])
    expect(sniffImage(vp8l)).toEqual({ mime: 'image/webp', width: 100, height: 50 })
    const vp8x = riff('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 199, 0, 0, 99, 0, 0])
    expect(sniffImage(vp8x)).toEqual({ mime: 'image/webp', width: 200, height: 100 })
  })

  it('refuses SVG, HTML, text and truncated or spoofed headers', () => {
    for (const s of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<!doctype html><script>x</script>', 'hello', 'GIF8'])
      expect(sniffImage(new TextEncoder().encode(s))).toBeNull()
    expect(sniffImage(solidPng(2, 2, [0, 0, 0, 255]).slice(0, 10))).toBeNull()
    expect(sniffImage(bytes())).toBeNull()
    // RIFF but not WebP (a WAV file).
    expect(sniffImage(pad(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')])))).toBeNull()
  })
})

describe('PNG decode, resize and encode', () => {
  it('round-trips RGBA pixels', () => {
    const data = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) % 256)
    const png = encodePng({ width: 3, height: 2, data })
    const back = decodePng(png)!
    expect(back.width).toBe(3)
    expect([...back.data]).toEqual([...data])
  })

  it('decodes RGB, grey and palette PNGs with every filter type', () => {
    const w = 4
    const h = 5
    const rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 11) % 256)
    const rows: number[] = []
    // Encode with filter types 0..4 on successive rows (the encoder here only uses 0 and 2).
    for (let y = 0; y < h; y++) {
      const f = y % 5
      rows.push(f)
      for (let x = 0; x < w * 3; x++) {
        const v = rgb[y * w * 3 + x]!
        const a = x >= 3 ? rgb[y * w * 3 + x - 3]! : 0
        const up = y > 0 ? rgb[(y - 1) * w * 3 + x]! : 0
        const c = y > 0 && x >= 3 ? rgb[(y - 1) * w * 3 + x - 3]! : 0
        let pred = 0
        if (f === 1) pred = a
        else if (f === 2) pred = up
        else if (f === 3) pred = (a + up) >> 1
        else if (f === 4) {
          const p = a + up - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - c)
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c
        }
        rows.push((v - pred) & 0xff)
      }
    }
    const png = rawPng(w, h, 2, new Uint8Array(rows))
    const img = decodePng(png)!
    for (let i = 0; i < w * h; i++) {
      expect([...img.data.subarray(i * 4, i * 4 + 4)]).toEqual([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255])
    }
    const grey = decodePng(rawPng(2, 1, 0, new Uint8Array([0, 10, 200])))!
    expect([...grey.data]).toEqual([10, 10, 10, 255, 200, 200, 200, 255])
    const pal = decodePng(rawPng(2, 1, 3, new Uint8Array([0, 1, 0]), { plte: [1, 2, 3, 4, 5, 6], trns: [9] }))!
    expect([...pal.data]).toEqual([4, 5, 6, 255, 1, 2, 3, 9])
  })

  it('returns null for 16-bit, interlaced and broken PNGs', () => {
    expect(decodePng(rawPng(1, 1, 2, new Uint8Array([0, 0, 0, 0, 0, 0, 0]), { depth: 16 }))).toBeNull()
    expect(decodePng(rawPng(1, 1, 2, new Uint8Array([0, 1, 2, 3]), { interlace: 1 }))).toBeNull()
    const png = solidPng(4, 4, [1, 2, 3, 255])
    expect(decodePng(png.slice(0, png.length - 30))).toBeNull()
    expect(decodePng(new TextEncoder().encode('not a png'))).toBeNull()
  })

  it('downscales with a box filter, keeping the aspect ratio', () => {
    const img = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) }
    // Left half white, right half black.
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 4; x++) img.data.set(x < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 4 + x) * 4)
    const small = resizeRgba(img, 2)
    expect([small.width, small.height]).toEqual([2, 1])
    expect([...small.data]).toEqual([255, 255, 255, 255, 0, 0, 0, 255])
    expect(resizeRgba(img, 10)).toBe(img)
  })
})

describe('prepareImage', () => {
  it('downscales big PNGs deterministically and leaves small ones alone', () => {
    const big = solidPng(3000, 1000, [255, 0, 0, 255])
    const a = prepareImage(big, { maxSide: 1568 })!
    const b = prepareImage(big, { maxSide: 1568 })!
    expect(a.scaled).toBe(true)
    expect([a.width, a.height]).toEqual([1568, 523])
    expect(sha256Hex(a.bytes)).toBe(sha256Hex(b.bytes))
    expect(sniffImage(a.bytes)).toEqual({ mime: 'image/png', width: 1568, height: 523 })
    const small = solidPng(10, 10, [0, 0, 255, 255])
    expect(prepareImage(small, { maxSide: 1568 })).toMatchObject({ scaled: false, bytes: small, width: 10 })
  })

  it('passes other types through and refuses non-images', () => {
    const gif = pad(new Uint8Array([...Buffer.from('GIF89a'), 0xd0, 0x07, 0xd0, 0x07]))
    expect(prepareImage(gif, { maxSide: 100 })).toMatchObject({ mime: 'image/gif', scaled: false, width: 2000 })
    expect(prepareImage(new TextEncoder().encode('<svg/>'))).toBeNull()
  })
})

/** A PNG from already-filtered scanlines. */
function rawPng(
  w: number,
  h: number,
  colorType: number,
  scanlines: Uint8Array,
  o: { depth?: number; interlace?: number; plte?: number[]; trns?: number[] } = {},
) {
  const chunk = (type: string, data: Uint8Array) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = o.depth ?? 8
  ihdr[9] = colorType
  ihdr[12] = o.interlace ?? 0
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      ...(o.plte ? [chunk('PLTE', new Uint8Array(o.plte))] : []),
      ...(o.trns ? [chunk('tRNS', new Uint8Array(o.trns))] : []),
      chunk('IDAT', deflateSync(scanlines)),
      chunk('IEND', new Uint8Array()),
    ]),
  )
}
