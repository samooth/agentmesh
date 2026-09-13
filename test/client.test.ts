import { describe, expect, test } from "bun:test"
import { MIN_NODE_VERSION, checkNodeVersion, resetNodeVersionCache } from "../src/client.ts"

/**
 * Sidecar client unit tests: the Node >= 23.6 spawn precheck (item 10)
 * parses version strings, rejects old ones with an actionable error, and
 * turns a missing binary into an install hint.
 */

test("MIN_NODE_VERSION matches the documented requirement", () => {
  expect(MIN_NODE_VERSION).toEqual([23, 6])
})

describe("checkNodeVersion", () => {
  test("accepts a version above the minimum", async () => {
    const res = await checkNodeVersion("fake-node", async () => "v24.1.0\n", { useCache: false })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.version).toBe("v24.1.0")
  })

  test("accepts the exact minimum version", async () => {
    const res = await checkNodeVersion("fake-node", async () => "v23.6.0\n", { useCache: false })
    expect(res.ok).toBe(true)
  })

  test("rejects an older minor on the same major", async () => {
    const res = await checkNodeVersion("fake-node", async () => "v23.5.0\n", { useCache: false })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain("Node >= 23.6")
      expect(res.error).toContain("v23.5.0")
    }
  })

  test("rejects an older major", async () => {
    const res = await checkNodeVersion("fake-node", async () => "v22.20.0\n", { useCache: false })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("Node >= 23.6")
  })

  test("ENOENT becomes an install hint", async () => {
    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException
    err.code = "ENOENT"
    const res = await checkNodeVersion(
      "definitely-missing-node",
      async () => {
        throw err
      },
      { useCache: false },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain("not found")
      expect(res.error).toContain("node` option")
    }
  })

  test("unparseable version output fails clearly", async () => {
    const res = await checkNodeVersion("fake-node", async () => "garbage\n", { useCache: false })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("could not parse")
  })

  test("result is cached for the same binary", async () => {
    resetNodeVersionCache()
    const res1 = await checkNodeVersion("fake-node", async () => "v24.0.0\n")
    expect(res1.ok).toBe(true)
    // second call returns the cached result even with a lying runner
    const res2 = await checkNodeVersion("fake-node", async () => "v18.0.0\n")
    expect(res2.ok).toBe(true)
    resetNodeVersionCache()
  })
})
