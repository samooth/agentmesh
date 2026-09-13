/**
 * Public-key normalization helpers for the peer allowlist.
 *
 * Keys may be written in any of these forms (case-insensitive hex, standard
 * base64, or the z-base-32 "hypercore" form prefixed with @). Whitespace and
 * commas are tolerated so the option can be written as a string or an array
 * in opencode.json.
 */

const Z_BASE32 = "ybndrfg8ejkmcpqxotuwiszla34567689"

function zBase32Decode(s: string): Buffer | null {
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of s) {
    const idx = Z_BASE32.indexOf(ch)
    if (idx === -1) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  // trailing bits must be zero for a canonical encoding; we accept any
  return Buffer.from(out)
}

export function normalizePublicKey(raw: string): Buffer | null {
  let s = raw.trim()
  if (s.startsWith("@")) s = s.slice(1)
  // strip inline commas from array-joined strings
  s = s.replace(/,/g, "")

  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex")
  if (/^[A-Za-z0-9+/]{43}={1}$/.test(s) || /^[A-Za-z0-9+/]{44}$/.test(s)) {
    const b = Buffer.from(s, "base64")
    return b.length === 32 ? b : null
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(s)) {
    const b = Buffer.from(s, "base64url")
    return b.length === 32 ? b : null
  }
  if (/^[a-z0-9]{52}$/.test(s)) {
    const b = zBase32Decode(s)
    return b !== null && b.length === 32 ? b : null
  }
  return null
}

/** Parses an allow option (string, array, or nested) into a hex-keyed set. Returns invalid entries for error reporting. */
export function parseAllowList(
  value: unknown,
): { keys: Set<string>; invalid: string[] } {
  const keys = new Set<string>()
  const invalid: string[] = []
  const entries =
    typeof value === "string"
      ? value.split(/[\s,]+/)
      : Array.isArray(value)
        ? value
        : []
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim().length === 0) continue
    const key = normalizePublicKey(entry)
    if (key === null) {
      invalid.push(entry.trim())
    } else {
      keys.add(key.toString("hex"))
    }
  }
  return { keys, invalid }
}

export function fingerprint(hex: string, length = 8): string {
  return hex.slice(0, length)
}
