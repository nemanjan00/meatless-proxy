/**
 * A small in-memory rate limit: at most `limit` hits per key in a sliding
 * window of `windowMs`. Per process, which is enough to slow down guessing
 * sign-in links and tokens. Keys are pruned as their windows pass.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  private lastSweep = 0

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit. Returns false when the key is over its limit (the hit is not counted then). */
  hit(key: string): boolean {
    const t = this.now()
    this.sweep(t)
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(t)
    this.hits.set(key, recent)
    return true
  }

  /** Whether the key is currently over its limit, without counting a hit. */
  blocked(key: string): boolean {
    const t = this.now()
    return (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs).length >= this.limit
  }

  /** Seconds until the key may try again (0 when it may now). */
  retryAfter(key: string): number {
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs)
    if (recent.length < this.limit) return 0
    return Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000))
  }

  private sweep(t: number) {
    if (t - this.lastSweep < this.windowMs) return
    this.lastSweep = t
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k)
  }
}
