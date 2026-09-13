/**
 * Per-peer token-bucket rate limiter for inbound traffic.
 *
 * A misbehaving peer flooding chat/sync lines could otherwise churn the
 * ring buffer and evict real history (see SECURITY.md). Each peer gets a
 * bucket of tokens refilled at a fixed rate; when a peer exhausts its
 * bucket the swarm drops the connection, and it stays banned for a
 * cooldown window so reconnect floods also fail.
 */

export type RateLimiterOptions = {
  /** Bucket capacity (messages allowed in a burst). Default 30. */
  capacity?: number
  /** Tokens refilled per second. Default 5. */
  refillPerSecond?: number
  /** How long (ms) a peer stays banned after tripping the limit. Default 60_000. */
  banMs?: number
  /** Wall clock injectable for tests. */
  now?: () => number
}

type Bucket = { tokens: number; last: number }

export class PeerRateLimiter {
  private readonly capacity: number
  private readonly refillPerMs: number
  private readonly banMs: number
  private readonly now: () => number
  private readonly buckets = new Map<string, Bucket>()
  private readonly banned = new Map<string, number>()

  constructor(opts: RateLimiterOptions = {}) {
    this.capacity = opts.capacity ?? 30
    this.refillPerMs = (opts.refillPerSecond ?? 5) / 1000
    this.banMs = opts.banMs ?? 60_000
    this.now = opts.now ?? (() => Date.now())
  }

  /** True when the message may be processed; false means the peer is
   *  flooding and should be dropped. */
  allow(peerId: string): boolean {
    const t = this.now()
    const bannedUntil = this.banned.get(peerId)
    if (bannedUntil !== undefined) {
      if (t < bannedUntil) return false
      this.banned.delete(peerId)
      // cooldown served: grant a fresh bucket so the peer can reconnect
      // cleanly (a hostile peer re-floods and re-bans; a well-behaved
      // one that hit a transient burst recovers)
      this.buckets.set(peerId, { tokens: this.capacity, last: t })
    }
    const b = this.buckets.get(peerId)
    if (b === undefined) {
      this.buckets.set(peerId, { tokens: this.capacity - 1, last: t })
      return true
    }
    const elapsed = t - b.last
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerMs)
    b.last = t
    if (b.tokens >= 1) {
      b.tokens -= 1
      return true
    }
    this.ban(peerId, t)
    return false
  }

  /** Explicitly ban a peer (e.g. protocol violations), starting the cooldown. */
  ban(peerId: string, t = this.now()): void {
    this.banned.set(peerId, t + this.banMs)
  }

  isBanned(peerId: string): boolean {
    const until = this.banned.get(peerId)
    return until !== undefined && this.now() < until
  }

  /** Forget a peer entirely (connection closed cleanly). */
  forget(peerId: string): void {
    this.buckets.delete(peerId)
  }
}
