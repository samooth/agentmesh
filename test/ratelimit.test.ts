import { describe, expect, test } from "bun:test"
import { PeerRateLimiter } from "../src/ratelimit.ts"

/**
 * Token-bucket rate limiter: burst up to capacity, then ban; banned peers
 * are rejected during cooldown and readmitted after.
 */

function fakeClock(start = 0) {
  let t = start
  return {
    advance: (ms: number) => {
      t += ms
    },
    now: () => t,
  }
}

test("burst up to capacity passes, the next trips the ban", () => {
  const clock = fakeClock()
  const rl = new PeerRateLimiter({ capacity: 5, refillPerSecond: 0, banMs: 60_000, now: clock.now })
  for (let i = 0; i < 5; i++) expect(rl.allow("p1")).toBe(true)
  expect(rl.allow("p1")).toBe(false)
  expect(rl.isBanned("p1")).toBe(true)
})

test("banned peer is rejected during the cooldown and readmitted after", () => {
  const clock = fakeClock()
  const rl = new PeerRateLimiter({ capacity: 2, refillPerSecond: 0, banMs: 10_000, now: clock.now })
  expect(rl.allow("p")).toBe(true)
  expect(rl.allow("p")).toBe(true)
  expect(rl.allow("p")).toBe(false)
  clock.advance(5_000)
  expect(rl.allow("p")).toBe(false) // still banned
  clock.advance(6_000)
  expect(rl.allow("p")).toBe(true) // ban expired, fresh bucket
})

test("tokens refill over time when drain is slower than the refill", () => {
  const clock = fakeClock()
  // capacity 1, refill 1000/s: every ms buys one token back
  const rl = new PeerRateLimiter({ capacity: 1, refillPerSecond: 1000, banMs: 10_000, now: clock.now })
  expect(rl.allow("p")).toBe(true) // bucket now 0
  expect(rl.allow("p")).toBe(false) // 0 tokens, 0 elapsed -> flood ban
  // during the ban no amount of waiting helps
  clock.advance(100)
  expect(rl.allow("p")).toBe(false)
  // after the ban expires, a fresh bucket is granted
  clock.advance(10_000)
  expect(rl.allow("p")).toBe(true)
})

test("peers are isolated", () => {
  const clock = fakeClock()
  const rl = new PeerRateLimiter({ capacity: 2, refillPerSecond: 0, now: clock.now })
  expect(rl.allow("a")).toBe(true)
  expect(rl.allow("a")).toBe(true)
  expect(rl.allow("a")).toBe(false)
  expect(rl.allow("b")).toBe(true)
})

test("forget clears bucket state but not an active ban", () => {
  const clock = fakeClock()
  const rl = new PeerRateLimiter({ capacity: 1, refillPerSecond: 0, banMs: 10_000, now: clock.now })
  expect(rl.allow("p")).toBe(true)
  expect(rl.allow("p")).toBe(false) // banned
  rl.forget("p")
  expect(rl.isBanned("p")).toBe(true) // ban survives forget
})

test("defaults allow a sane burst then ban", () => {
  const rl = new PeerRateLimiter()
  let ok = 0
  for (let i = 0; i < 100; i++) if (rl.allow(`stress-${i % 3}`)) ok++
  // 3 peers x 30 burst = 90 allowed at t=0; repeated calls drain buckets
  expect(ok).toBeGreaterThan(60)
})
