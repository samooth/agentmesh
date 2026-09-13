import { describe, expect, test } from "bun:test"
import { normalizePublicKey, parseAllowList, fingerprint } from "../src/keys.ts"

const hexKey = "a".repeat(64)
const b64Key = Buffer.alloc(32, 0x42).toString("base64") // "QkJ..." (43 chars + padding)
const b64Raw = Buffer.alloc(32, 0x42).toString("base64url")

describe("normalizePublicKey", () => {
  test("accepts 64-char hex", () => {
    expect(normalizePublicKey(hexKey)?.toString("hex")).toBe(hexKey)
    expect(normalizePublicKey(hexKey.toUpperCase())?.toString("hex")).toBe(hexKey)
  })

  test("accepts whitespace-padded hex", () => {
    expect(normalizePublicKey(`  ${hexKey}  `)?.toString("hex")).toBe(hexKey)
  })

  test("accepts base64 (padded and unpadded)", () => {
    const expected = Buffer.alloc(32, 0x42).toString("hex")
    expect(normalizePublicKey(b64Key)?.toString("hex")).toBe(expected)
    expect(normalizePublicKey(b64Raw)?.toString("hex")).toBe(expected)
  })

  test("accepts @-prefixed z-base-32 hypercore form", () => {
    // round-trip a real key through the z-base-32 encoding used by hypercore
    const key = Buffer.from(hexKey, "hex")
    const z32 = "@" + encodeZBase32(key)
    expect(normalizePublicKey(z32)?.toString("hex")).toBe(hexKey)
  })

  test("rejects garbage and wrong lengths", () => {
    expect(normalizePublicKey("not-a-key")).toBeNull()
    expect(normalizePublicKey("a".repeat(63))).toBeNull()
    expect(normalizePublicKey("a".repeat(65))).toBeNull()
    expect(normalizePublicKey("")).toBeNull()
  })
})

describe("parseAllowList", () => {
  test("parses string with commas and whitespace", () => {
    const other = "b".repeat(64)
    const { keys, invalid } = parseAllowList(`${hexKey}, ${other}`)
    expect(keys.size).toBe(2)
    expect(keys.has(hexKey)).toBe(true)
    expect(keys.has(other)).toBe(true)
    expect(invalid).toEqual([])
  })

  test("parses arrays and reports invalid entries", () => {
    const { keys, invalid } = parseAllowList([hexKey, "bogus", `  ${"c".repeat(64)}  `])
    expect(keys.size).toBe(2)
    expect(invalid).toEqual(["bogus"])
  })

  test("empty input yields empty set", () => {
    expect(parseAllowList(undefined).keys.size).toBe(0)
    expect(parseAllowList("").keys.size).toBe(0)
    expect(parseAllowList([]).keys.size).toBe(0)
    expect(parseAllowList(42 as never).keys.size).toBe(0)
  })
})

describe("fingerprint", () => {
  test("slices hex prefix", () => {
    expect(fingerprint(hexKey)).toBe("aaaaaaaa")
    expect(fingerprint(hexKey, 4)).toBe("aaaa")
  })
})

// z-base-32 encoder matching hypercore's alphabet (decoder lives in keys.ts)
const Z_BASE32 = "ybndrfg8ejkmcpqxotuwiszla34567689"
function encodeZBase32(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += Z_BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += Z_BASE32[(value << (5 - bits)) & 31]
  return out
}
