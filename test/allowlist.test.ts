import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { deriveTopic } from "../src/protocol.ts"
import { SidecarClient } from "../src/client.ts"

/**
 * Real-network integration tests for the public-key allowlist:
 * - two peers that whitelist each other connect and chat
 * - a rogue peer that knows the topic but is NOT allowlisted cannot
 *   connect in either direction (firewall blocks inbound; local check
 *   blocks outbound)
 */

const NODE = process.env.OPENCODE_CHAT_NODE ?? "node"
const SIDECAR = new URL("../src/sidecar.ts", import.meta.url).pathname
const room = `allow-room-${Date.now()}`
const topicHex = deriveTopic(room, "allow-secret").toString("hex")

// fixed seeds => deterministic pubkeys we can cross-allowlist
const SEED_ALPHA = "ab".repeat(32)
const SEED_BETA = "cd".repeat(32)
const SEED_ROGUE = "ef".repeat(32)

function printPubkey(seed: string): string {
  return execSync(`${JSON.stringify(NODE)} ${JSON.stringify(SIDECAR)} --print-pubkey --seed ${seed}`)
    .toString()
    .trim()
}

const PUB_ALPHA = printPubkey(SEED_ALPHA)
const PUB_BETA = printPubkey(SEED_BETA)

let alpha: SidecarClient
let beta: SidecarClient
let rogue: SidecarClient

function spawnSidecar(id: string, seed: string, allow?: string): SidecarClient {
  return new SidecarClient({
    node: NODE,
    sidecarPath: SIDECAR,
    cwd: import.meta.dir,
    args: [
      "--topic", topicHex,
      "--id", id,
      "--name", id,
      "--project", "allowtest",
      "--room", room,
      "--seed", seed,
      "--history-limit", "100",
      "--sync-count", "20",
      ...(allow ? ["--allow", allow] : []),
    ],
    onChat: () => {},
    onPeers: () => {},
  })
}

beforeAll(async () => {
  // alpha and beta whitelist each other; nobody whitelists the rogue
  alpha = spawnSidecar("agent-alpha", SEED_ALPHA, PUB_BETA)
  await alpha.ready
  await Bun.sleep(1000)
  beta = spawnSidecar("agent-beta", SEED_BETA, PUB_ALPHA)
  await beta.ready
  await Bun.sleep(6000)
}, 60_000)

afterAll(async () => {
  await alpha?.destroy()
  await beta?.destroy()
  await rogue?.destroy()
})

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await Bun.sleep(250)
  }
  return false
}

describe("allowlist enforcement", () => {
  test("pubkeys derive deterministically from seeds", async () => {
    const me = await alpha.whoami()
    expect(me.publicKeyHex).toBe(PUB_ALPHA)
    const other = await beta.whoami()
    expect(other.publicKeyHex).toBe(PUB_BETA)
  }, 30_000)

  test("mutually whitelisted peers connect and chat", async () => {
    const marker = `allow-chat-${crypto.randomUUID()}`
    await alpha.send(marker)
    const received = await pollUntil(async () => {
      const { messages } = await beta.history(100)
      return messages.some((m) => m.text === marker)
    }, 30_000)
    expect(received).toBe(true)
  }, 60_000)

  test("rogue peer (knows topic, not allowlisted) cannot connect", async () => {
    rogue = spawnSidecar("agent-rogue", SEED_ROGUE)
    await rogue.ready
    // give the rogue plenty of time to be discovered and to attempt dialing
    const sneakedIn = await pollUntil(async () => {
      const { peers: seenByAlpha } = await alpha.peers()
      return seenByAlpha.some((p) => p.id === "agent-rogue")
    }, 25_000)
    expect(sneakedIn).toBe(false)
    // and the rogue sees nobody either (alpha/beta reject its outbound dials)
    const rogueSees = await pollUntil(async () => {
      const { peers } = await rogue.peers()
      return peers.length > 0
    }, 25_000)
    expect(rogueSees).toBe(false)
  }, 90_000)
})
