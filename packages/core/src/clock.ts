/** Injected everywhere instead of `Date.now()`, so tests control time. */
export interface Clock {
  now(): number
  iso(): string
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
}

/** A clock for tests. Time only moves when you move it. */
export class ManualClock implements Clock {
  constructor(private ms: number = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.ms
  }
  iso(): string {
    return new Date(this.ms).toISOString()
  }
  advance(ms: number): void {
    this.ms += ms
  }
  set(ms: number): void {
    this.ms = ms
  }
}
