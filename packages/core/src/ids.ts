import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32

let lastTime = 0
let lastRandom: number[] = []

function encodeTime(ms: number): string {
  let out = ''
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[ms % 32] + out
    ms = Math.floor(ms / 32)
  }
  return out
}

function randomDigits(): number[] {
  const bytes = randomBytes(16)
  return Array.from({ length: 16 }, (_, i) => bytes[i]! % 32)
}

/**
 * A sortable, prefixed id, e.g. `ses_01J9Z3K8Q4…`. Ids created later sort after
 * ids created earlier, also within the same millisecond.
 */
export function newId(prefix: string, nowMs: number = Date.now()): string {
  let random: number[]
  if (nowMs <= lastTime) {
    nowMs = lastTime
    random = [...lastRandom]
    for (let i = random.length - 1; i >= 0; i--) {
      if (random[i]! < 31) {
        random[i]!++
        break
      }
      random[i] = 0
    }
  } else {
    random = randomDigits()
  }
  lastTime = nowMs
  lastRandom = random
  return `${prefix}_${encodeTime(nowMs)}${random.map((d) => ALPHABET[d]).join('')}`
}

/** The prefix of an id: `idPrefix('ses_01J…') === 'ses'`. */
export function idPrefix(id: string): string {
  const i = id.indexOf('_')
  return i < 0 ? '' : id.slice(0, i)
}

export function isId(value: unknown, prefix?: string): value is string {
  if (typeof value !== 'string') return false
  const m = /^([a-z][a-z0-9]*)_[0-9A-HJKMNP-TV-Z]{26}$/.exec(value)
  return !!m && (prefix === undefined || m[1] === prefix)
}
