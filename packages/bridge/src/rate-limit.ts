/**
 * Keyed token-bucket limiter: each key may spend `perMin` per minute, with a burst
 * of the same size. Buckets idle long enough to be full are pruned on access.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private lastPrune = 0;

  constructor(
    private readonly perMin: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Spend one token for `key`; false when the key is over its rate. */
  take(key: string): boolean {
    const t = this.now();
    this.prune(t);
    const rate = this.perMin / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.perMin, at: t };
    b.tokens = Math.min(this.perMin, b.tokens + (t - b.at) * rate);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }

  private prune(t: number): void {
    if (t - this.lastPrune < 60_000) return;
    this.lastPrune = t;
    for (const [key, b] of this.buckets) {
      if (b.tokens + (t - b.at) * (this.perMin / 60_000) >= this.perMin) this.buckets.delete(key);
    }
  }
}
