import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { deriveTopic } from "../src/protocol.ts"
import { SidecarClient } from "../src/client.ts"

/**
 * Real-network integration tests: two Node sidecar processes join the same
 * topic over the Hyperswarm DHT and exchange chat/peers/history via the
 * plugin IPC protocol. The sidecar must run under Node (>= 23.6 for .ts
 * type stripping) because hyperswarm's native transport cannot load in Bun.
 */

const NODE = process.env.OPENCODE_CHAT_NODE ?? "node"
const SIDECAR = new URL("../src/sidecar.ts", import.meta.url).pathname
const room = `test-room-${Date.now()}`
const topicHex = deriveTopic(room, "test-secret").toString("hex")

let alpha: SidecarClient
let beta: SidecarClient

function spawnSidecar(id: string, name: string): SidecarClient {
  return new SidecarClient({
    node: NODE,
    sidecarPath: SIDECAR,
    cwd: import.meta.dir,
    args: [
      "--topic", topicHex,
      "--id", id,
      "--name", name,
      "--project", "testproj",
      "--room", room,
      "--history-limit", "100",
      "--sync-count", "20",
    ],
    onChat: () => {},
    onPeers: () => {},
  })
}

beforeAll(async () => {
  alpha = spawnSidecar("agent-alpha", "agent-alpha")
  await alpha.ready
  // slight stagger avoids the simultaneous-join DHT race window
  await Bun.sleep(1000)
  beta = spawnSidecar("agent-beta", "agent-beta")
  await beta.ready
  // allow DHT announce + connection establishment
  await Bun.sleep(6000)
}, 60_000)

afterAll(async () => {
  await alpha?.destroy()
  await beta?.destroy()
})

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await Bun.sleep(250)
  }
  return false
}

describe("sidecar swarm integration", () => {
  test("ready event reports room and topic", async () => {
    const info = await alpha.ready
    expect(info.room).toBe(room)
    expect(info.topicHex).toBe(topicHex)
  }, 30_000)

  test("peers discover each other via hello", async () => {
    const found = await pollUntil(async () => {
      const { peers } = await alpha.peers()
      return peers.some((p) => p.id === "agent-beta")
    }, 30_000)
    expect(found).toBe(true)
  }, 60_000)

  test("chat message flows alpha -> beta", async () => {
    const marker = `hello-from-alpha-${crypto.randomUUID()}`
    await alpha.send(marker)
    const received = await pollUntil(async () => {
      const { messages } = await beta.history(100)
      return messages.some((m) => m.text === marker)
    }, 30_000)
    expect(received).toBe(true)
  }, 60_000)

  test("late joiner receives history sync", async () => {
    const gamma = spawnSidecar("agent-gamma", "agent-gamma")
    try {
      await gamma.ready
      const synced = await pollUntil(async () => {
        const { messages } = await gamma.history(100)
        return messages.length > 0
      }, 60_000)
      expect(synced).toBe(true)
    } finally {
      await gamma.destroy()
    }
  }, 90_000)
})

