import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { SidecarClient } from "../src/client.ts"
import {
  deriveTopic,
  signChatMessage,
  validateChatMessage,
  verifyChatSignature,
  identityKeyPair,
} from "../src/protocol.ts"

/**
 * Offline sidecar features: history cursor (after_id), JSONL persistence
 * (replay across restarts), and the live allowlist file (watch + kick).
 * No DHT peers are needed — a single sidecar on an unguessable topic.
 */

const NODE = process.env.OPENCODE_CHAT_NODE ?? "node"
const SIDECAR = new URL("../src/sidecar.ts", import.meta.url).pathname
const WORK = "/tmp/opencode/agentmesh-persist-test"
const room = `persist-${Date.now()}`
const topicHex = deriveTopic(room, "offline").toString("hex")
const persistPath = join(WORK, "history.jsonl")
const allowPath = join(WORK, "allow.json")

const seed = "33".repeat(32)
const kp = identityKeyPair(seed)

function spawn(allowFile?: string): SidecarClient {
  return new SidecarClient({
    node: NODE,
    sidecarPath: SIDECAR,
    cwd: WORK,
    args: [
      "--topic", topicHex,
      "--id", "solo",
      "--name", "solo",
      "--room", room,
      "--seed", seed,
      "--history-limit", "50",
      "--sync-count", "10",
      "--persist", persistPath,
      ...(allowFile ? ["--allow-file", allowPath] : []),
    ],
    onChat: () => {},
    onPeers: () => {},
  })
}

let client: SidecarClient

beforeAll(async () => {
  await rm(WORK, { recursive: true, force: true }).catch(() => {})
  await mkdir(WORK, { recursive: true })
  client = spawn()
  await client.ready
}, 30_000)

afterAll(async () => {
  await client?.destroy()
  await rm(WORK, { recursive: true, force: true }).catch(() => {})
})

describe("history cursor", () => {
  test("after_id returns only newer messages and reports a fresh cursor", async () => {
    await client.send("one")
    const first = await client.history(10)
    expect(first.messages.length).toBe(1)
    const cursor = first.messages[0]!.id

    await client.send("two")
    await client.send("three")
    const next = await client.history(10, cursor)
    expect(next.messages.map((m) => m.text)).toEqual(["two", "three"])

    // cursor beyond newest: empty result
    const newest = next.messages[next.messages.length - 1]!.id
    const after = await client.history(10, newest)
    expect(after.messages.length).toBe(0)

    // unknown cursor: falls back to newest slice
    const unknown = await client.history(2, "no-such-id")
    expect(unknown.messages.length).toBe(2)
  }, 20_000)
})

describe("persistence", () => {
  test("sent messages land in the JSONL file signed", async () => {
    const raw = await readFile(persistPath, "utf8")
    const lines = raw.trim().split("\n").map((l) => validateChatMessage(JSON.parse(l)))
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const m of lines) {
      expect(typeof m!.sig).toBe("string")
    }
  })

  test("a restarted sidecar replays persisted history", async () => {
    await client.destroy()
    const revived = spawn()
    try {
      await revived.ready
      const h = await revived.history(50)
      expect(h.messages.map((m) => m.text)).toContain("three")
      // local sends are signed and marked ok
      await revived.send("four")
      const after = await revived.history(1)
      expect(after.messages[0]!.verified).toBe("ok")
      client = revived
    } catch (err) {
      await revived.destroy()
      throw err
    }
  }, 30_000)

  test("signature round-trip rejects tampered lines on replay", () => {
    const msg = validateChatMessage({
      kind: "chat",
      id: crypto.randomUUID(),
      from: "solo",
      name: "solo",
      text: "genuine",
      ts: Date.now(),
    })!
    signChatMessage(msg, kp.secretKey)
    const tampered = validateChatMessage({ ...msg, text: "forged" })!
    tampered.sig = msg.sig
    expect(verifyChatSignature(msg, kp.publicKey.toString("hex"))).toBe("ok")
    expect(verifyChatSignature(tampered, kp.publicKey.toString("hex"))).toBe("bad")
  })
})

describe("live allowlist file", () => {
  test("allow-file activates the allowlist and whoami reflects it", async () => {
    await writeFile(allowPath, JSON.stringify({ allow: [kp.publicKey.toString("hex")] }), "utf8")
    await client.destroy()
    client = spawn(allowPath)
    await client.ready
    const me = await client.whoami()
    expect(me.allowCount).toBe(1)
  }, 30_000)

  test("editing the file drops to allow-all when emptied", async () => {
    await writeFile(allowPath, JSON.stringify({ allow: [] }), "utf8")
    // watcher debounce is 100ms; poll whoami until it flips
    const deadline = Date.now() + 5000
    let count = 1
    while (Date.now() < deadline) {
      await Bun.sleep(150)
      count = (await client.whoami()).allowCount
      if (count === 0) break
    }
    expect(count).toBe(0)
  }, 20_000)
})
