import { ChatStore } from "./store.ts"
import { ChatSwarm } from "./swarm.ts"
import { parseAllowList } from "./keys.ts"
import { keyPair as keyPairFromSeed } from "hypercore-crypto"
import type { IpcEvent, IpcRequest, IpcResponse, IpcResult } from "./ipc.ts"

/**
 * Sidecar entry: runs under Node (>= 23.6 for native .ts type stripping).
 * Owns the Hyperswarm instance and chat store; serves plugin RPC over
 * stdin/stdout as NDJSON. Exits when stdin closes or on SIGTERM/SIGINT.
 */

function arg(name: string): string | undefined {
  const argv = process.argv
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === name) return argv[i + 1]
  }
  return undefined
}

function intArg(name: string, fallback: number): number {
  const raw = arg(name)
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

const topicHex = arg("--topic")
const id = arg("--id") ?? `agent-${crypto.randomUUID().slice(0, 4)}`
const name = arg("--name") ?? id
const project = arg("--project") ?? ""
const room = arg("--room") ?? ""
const seed = arg("--seed")
const allowRaw = arg("--allow")
const historyLimit = intArg("--history-limit", 200)
const syncCount = intArg("--sync-count", 20)

// pubkey inspection mode: print derived public key, exit 0
if (arg("--print-pubkey") !== undefined) {
  if (!seed || !/^[0-9a-f]{64}$/i.test(seed)) {
    console.error("sidecar: --print-pubkey requires --seed <64-hex>")
    process.exit(1)
  }
  const kp = keyPairFromSeed(Buffer.from(seed, "hex"))
  process.stdout.write(kp.publicKey.toString("hex") + "\n")
  process.exit(0)
}

if (topicHex === undefined || !/^[0-9a-f]{64}$/i.test(topicHex)) {
  console.error("sidecar: --topic <64-hex> is required")
  process.exit(1)
}

let allow: Set<string> | undefined
if (typeof allowRaw === "string" && allowRaw.length > 0) {
  const parsed = parseAllowList(allowRaw)
  if (parsed.keys.size === 0) {
    console.error("sidecar: --allow was provided but contains no valid public keys")
    process.exit(1)
  }
  allow = parsed.keys
}

const store = new ChatStore(historyLimit)
const swarm = new ChatSwarm({
  topic: Buffer.from(topicHex, "hex"),
  identity: { id, name, project },
  store,
  syncCount,
  seed,
  allow,
  log: (message, extra) => write({ ev: "log", message, extra }),
})

function write(line: object): void {
  try {
    process.stdout.write(JSON.stringify(line) + "\n")
  } catch {
    // stdout gone; nothing useful to do
  }
}

function respond(id: string, fn: () => IpcResult): void {
  try {
    write({ id, ok: true, result: fn() } satisfies IpcResponse)
  } catch (err) {
    write({ id, ok: false, error: String(err) } satisfies IpcResponse)
  }
}

store.onMessage((msg) => {
  if (msg.from === id) return
  write({ ev: "chat", msg } satisfies IpcEvent)
})

store.onPeers((peers) => {
  write({ ev: "peers", peers } satisfies IpcEvent)
})

write({
  ev: "ready",
  room,
  name,
  topicHex,
  publicKeyHex: swarm.publicKeyHex,
} satisfies IpcEvent)

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  const newline = buffer.lastIndexOf("\n")
  if (newline === -1) return
  const complete = buffer.slice(0, newline)
  buffer = buffer.slice(newline + 1)
  for (const raw of complete.split("\n")) {
    if (raw.length === 0) continue
    handle(raw)
  }
})

function handle(raw: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof parsed !== "object" || parsed === null) return
  const req = parsed as Partial<IpcRequest>
  if (typeof req.id !== "string" || typeof req.cmd !== "string") return

  switch (req.cmd) {
    case "send": {
      const text = typeof req.text === "string" ? req.text.trim() : ""
      respond(req.id, () => {
        if (text.length === 0) throw new Error("message is empty")
        return { reached: swarm.sendChat({
          kind: "chat",
          v: 1,
          id: crypto.randomUUID(),
          from: id,
          name,
          text,
          ts: Date.now(),
        }) }
      })
      return
    }
    case "history": {
      const limit =
        typeof req.limit === "number" && Number.isFinite(req.limit)
          ? Math.min(200, Math.max(1, Math.trunc(req.limit)))
          : 20
      respond(req.id, () => ({
        messages: store.history(limit),
        connections: swarm.peerCount,
      }))
      return
    }
    case "peers": {
      respond(req.id, () => ({
        peers: store.peersList(),
        connections: swarm.peerCount,
      }))
      return
    }
    case "whoami": {
      respond(req.id, () => ({
        id,
        name,
        room,
        publicKeyHex: swarm.publicKeyHex,
        allowCount: allow?.size ?? 0,
      }))
      return
    }
    default:
      respond(req.id, () => {
        throw new Error(`unknown command: ${String(req.cmd)}`)
      })
  }
}

async function shutdown(): Promise<void> {
  try {
    await swarm.destroy()
  } finally {
    process.exit(0)
  }
}

process.stdin.on("close", () => void shutdown())
process.stdin.on("end", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
