import { watch, type FSWatcher } from "node:fs"
import { open } from "node:fs/promises"
import { dirname } from "node:path"
import { ChatStore } from "./store.ts"
import { ChatSwarm } from "./swarm.ts"
import { parseAllowList } from "./keys.ts"
import { validateChatMessage } from "./protocol.ts"
import { keyPair as keyPairFromSeed } from "hypercore-crypto"
import type { IpcEvent, IpcRequest, IpcResponse, IpcResult } from "./ipc.ts"

/**
 * Sidecar entry: runs under Node (>= 23.6 for native .ts type stripping).
 * Owns the Hyperswarm instance and chat store; serves plugin RPC over
 * stdin/stdout as NDJSON. Exits when stdin closes or on SIGTERM/SIGINT.
 *
 * Optional flags beyond the swarm basics:
 *   --persist <file>     append accepted chat messages to a JSONL file and
 *                        replay it (last N) at boot so history survives
 *                        sidecar restarts
 *   --allow-file <file>  JSON file (array or {allow:[...]}) of public keys;
 *                        watched for changes and applied live (revocation
 *                        kicks existing connections)
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
const allowFile = arg("--allow-file")
const persistPath = arg("--persist")
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

// ---------------------------------------------------------------------------
// History persistence (optional): append accepted messages as JSONL; replay
// the newest `historyLimit` at boot so a restarted sidecar keeps history.
// ---------------------------------------------------------------------------

let persistHandle: import("node:fs/promises").FileHandle | null = null

async function openPersistence(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    persistHandle = await open(path, "a")
  } catch (err) {
    write({ ev: "log", message: "history persistence unavailable", extra: { error: String(err) } })
  }
}

async function replayPersistence(path: string): Promise<void> {
  try {
    const raw = await readFile(path, "utf8")
    const msgs: import("./protocol.ts").ChatMessage[] = []
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue
      const parsed: unknown = JSON.parse(line)
      const msg = validateChatMessage(parsed)
      if (msg !== null) msgs.push(msg)
    }
    store.addManySilently(msgs.slice(-historyLimit))
    if (msgs.length > 0) {
      write({ ev: "log", message: "replayed persisted history", extra: { count: Math.min(msgs.length, historyLimit) } })
    }
  } catch {
    // no persisted history yet — fine
  }
}

const { mkdir, readFile } = await import("node:fs/promises")

if (persistPath) {
  await replayPersistence(persistPath)
  await openPersistence(persistPath)
}

const swarm = new ChatSwarm({
  topic: Buffer.from(topicHex, "hex"),
  identity: { id, name, project },
  store,
  syncCount,
  seed,
  allow,
  onPersist: (msg) => {
    void persistHandle?.appendFile(JSON.stringify(msg) + "\n").catch(() => {})
  },
  log: (message, extra) => write({ ev: "log", message, extra }),
})

// note: message signing happens inside ChatSwarm using the same persistent
// ed25519 keypair as the noise transport key (see swarm.ts).

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

// ---------------------------------------------------------------------------
// Live allowlist from --allow-file: parse, apply, and watch for edits.
// ---------------------------------------------------------------------------

let allowWatcher: FSWatcher | null = null

async function loadAllowFile(path: string): Promise<Set<string> | undefined> {
  const raw = await readFile(path, "utf8")
  const parsed = JSON.parse(raw) as unknown
  const value =
    Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { allow?: unknown }).allow)
        ? ((parsed as { allow: unknown[] }).allow)
        : []
  const { keys } = parseAllowList(value)
  return keys.size > 0 ? keys : undefined
}

function applyAllow(keys: Set<string> | undefined): void {
  const kicked = swarm.updateAllow(keys)
  write({ ev: "log", message: "allowlist updated", extra: { keys: keys?.size ?? 0, kicked } })
}

if (allowFile) {
  try {
    const keys = await loadAllowFile(allowFile)
    if (keys && (!allow || allow.size === 0)) allow = keys
    // apply even when --allow was also given: file is the live source
    applyAllow(keys)
  } catch (err) {
    write({ ev: "log", message: "allowlist file unreadable", extra: { error: String(err) } })
  }
  let applying = false
  allowWatcher = watch(allowFile, { persistent: false }, () => {
    if (applying) return
    applying = true
    setTimeout(async () => {
      try {
        applyAllow(await loadAllowFile(allowFile))
      } catch {
        // transient read during write; next event retries
      } finally {
        applying = false
      }
    }, 100)
  })
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
      const afterId = typeof req.afterId === "string" && req.afterId.length > 0 ? req.afterId : undefined
      respond(req.id, () => ({
        messages: store.history(limit, afterId),
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
        allowCount: swarm.allowKeys?.size ?? 0,
      }))
      return
    }
    case "allow": {
      respond(req.id, () => {
        const keys = parseAllowList(req.keys)
        const live = swarm.updateAllow(keys.keys.size > 0 ? keys.keys : undefined)
        return { active: swarm.allowKeys?.size ?? 0, kicked: live }
      })
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
    allowWatcher?.close()
    await persistHandle?.close()
    await swarm.destroy()
  } finally {
    process.exit(0)
  }
}

process.stdin.on("close", () => void shutdown())
process.stdin.on("end", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
