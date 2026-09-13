/**
 * Unique-per-run room naming and portable temp dirs for network tests.
 *
 * Rooms with hardcoded names + fixed secrets derive a predictable topic
 * (sha256 is public) — an attacker could pre-compute it and wait for test
 * runs to join, injecting messages into test swarms (and, worse, into any
 * real host session an e2e test drives). Every network test room therefore
 * carries a random suffix; keep secrets random too.
 *
 * Temp dirs use os.tmpdir() (never a hard "/tmp" path) so the suite runs on
 * Linux, macOS, and Windows.
 */

import { randomBytes } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

/** Random 8-hex-char suffix, unique per call. */
export function runId(): string {
  return randomBytes(4).toString("hex")
}

/** Room name unique per run: `${prefix}-${runId()}`. */
export function uniqueRoom(prefix: string): string {
  return `${prefix}-${runId()}`
}

/** Secret unique per run — use for every non-public test room. */
export function uniqueSecret(): string {
  return randomBytes(16).toString("hex")
}

/**
 * Creates a fresh temp directory (under the OS temp root) for a test to
 * use as a working directory. Returns the path. Cross-platform: uses
 * os.tmpdir() + mkdtemp, so no hard "/tmp" paths.
 */
export async function testWorkDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `agentmesh-${prefix}-`))
}
