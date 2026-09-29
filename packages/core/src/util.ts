export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export function assertNever(x: never, what = 'value'): never {
  throw new Error(`unexpected ${what}: ${JSON.stringify(x)}`)
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(err: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Stable JSON: object keys sorted, so the same value always gives the same string. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** Glob-style match with `*` (anything but a dot) and `**` (anything). */
export function globMatch(pattern: string, value: string): boolean {
  const re = pattern
    .split('**')
    .map((part) => part.split('*').map(escapeRe).join('[^.]*'))
    .join('.*')
  return new RegExp(`^${re}$`).test(value)
}

function escapeRe(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}
