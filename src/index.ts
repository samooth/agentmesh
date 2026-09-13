import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import { deriveTopic, MAX_NAME_BYTES, sanitizeForDisplay } from "./protocol.ts"
import type { ChatMessage } from "./protocol.ts"
import { SidecarClient } from "./client.ts"
import { parseAllowList } from "./keys.ts"
import { resolveRoom } from "./policy.ts"
import { systemInstruction, systemInstructionDisabled, toolsFor } from "./tools.ts"
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type PluginOptions = {
  /** Room name; agents with the same room+secret see each other. */
  room?: string
  /** Shared secret mixed into the topic derivation (invite key). */
  secret?: string
  /** Display name for this agent. Default: stable random name per machine. */
  name?: string
  /**
   * Public-key allowlist (hex/base64/z-base-32 strings or array). When set,
   * only peers whose noise keys are listed may connect; the local key must
   * be whitelisted on the other peers' side too.
   */
  allow?: string | string[]
  /** Chat history capacity (ring buffer size). Default: 200. */
  historyLimit?: number
  /** Messages offered to newly connected peers. Default: 20. */
  syncCount?: number
  /** Show TUI toasts for incoming messages. Default: true. */
  toast?: boolean
  /** Add a system-prompt note telling the agent about the chat tools. Default: true. */
  instruction?: boolean
  /** Path to the node binary used to run the swarm sidecar. Default: "node" from PATH. */
  node?: string
}

const IDENTITY_DIR = "opencode-chat"
const IDENTITY_FILE = "identity.json"

type Identity = { id: string; name: string; seed: string }

async function loadOrCreateIdentity(explicitName?: string): Promise<Identity> {
  const dir = `${homedir()}/.cache/${IDENTITY_DIR}`
  const file = `${dir}/${IDENTITY_FILE}`
  let cached: Partial<Identity> = {}
  try {
    cached = JSON.parse(await readFile(file, "utf8")) as Partial<Identity>
  } catch {
    // no cached identity — create one below
  }
  let { id, name, seed } = cached
  let dirty = false
  if (typeof seed !== "string" || !/^[0-9a-f]{64}$/.test(seed)) {
    seed = crypto.randomUUID().replace(/-/g, "")
    dirty = true
  }
  if (explicitName && explicitName.length > 0) {
    if (name !== explicitName) dirty = true
    name = sliceBytes(explicitName, MAX_NAME_BYTES)
  } else if (typeof name !== "string" || name.length === 0) {
    name = `agent-${seed.slice(0, 4)}`
    dirty = true
  }
  if (typeof id !== "string" || id.length === 0) {
    // keep old stable-id scheme for named agents; else derive from seed
    id = explicitName
      ? stableIdFromName(explicitName)
      : Buffer.from(`seed:${seed}`).toString("base64url").slice(0, 43)
    dirty = true
  }
  if (dirty) {
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify({ id, name, seed }, null, 2) + "\n", "utf8")
      await chmod(file, 0o600)
    } catch {
      // cache is best-effort; a fresh identity per session still works
    }
  }
  return { id, name, seed }
}

function stableIdFromName(name: string): string {
  // deterministic id so peers see the same logical agent across restarts
  return Buffer.from(`nm:${name}`).toString("base64url").slice(0, 43)
}

function sliceBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s
  return Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8")
}

export const ChatPlugin: Plugin = async (input, options) => {
  const opts = (options ?? {}) as PluginOptions
  const historyLimit = clampInt(opts.historyLimit, 1, 1000, 200)
  const syncCount = clampInt(opts.syncCount, 0, 50, 20)
  const toastEnabled = opts.toast !== false
  const instructionEnabled = opts.instruction !== false

  const identity = await loadOrCreateIdentity(opts.name)
  const project = basename(input.directory)

  const policy = resolveRoom(opts, input.directory)
  let room = ""
  const secret = policy.enabled && !policy.openMode ? String(opts.secret) : undefined

  const log = async (message: string, extra?: Record<string, unknown>) => {
    try {
      await input.client.app.log({
        body: { service: "opencode-chat", level: "info", message, extra: extra ?? {} },
      })
    } catch {
      // logging is best-effort
    }
  }

  if (!policy.enabled) {
    // No explicit room/secret configured: stay offline entirely. Deriving a
    // room from the directory name would put strangers in the same topic.
    await log(policy.reason)
    const disabledTools = toolsFor({ sidecar: null, room: "", startupError: policy.reason })
    return {
      tool: disabledTools,
      "experimental.chat.system.transform": async (_input, output) => {
        if (!instructionEnabled) return
        try {
          output.system.push(systemInstructionDisabled(policy.reason))
        } catch {
          // best-effort
        }
      },
      dispose: async () => {},
    }
  }
  room = policy.room
  const topic = deriveTopic(room, secret)

  // The sidecar script ships next to this plugin file.
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const sidecarPath = join(pluginDir, "sidecar.ts")
  const nodeBin =
    typeof opts.node === "string" && opts.node.length > 0
      ? opts.node
      : process.env.OPENCODE_CHAT_NODE ?? "node"

  const incoming = (msg: ChatMessage) => {
    if (!toastEnabled) return
    input.client.tui
      .showToast({
        body: {
          title: `chat: ${sanitizeForDisplay(msg.name).slice(0, 64)}`,
          message: sanitizeForDisplay(
            msg.text.length > 200 ? msg.text.slice(0, 200) + "…" : msg.text,
          ),
          variant: "info",
        },
      })
      .catch(() => {})
  }

  let sidecar: SidecarClient | null = null
  let startupError: string | null = null

  // Parse the allowlist before spawning: invalid entries fail loudly.
  const { keys: allowKeys, invalid: invalidKeys } = parseAllowList(opts.allow)
  if (invalidKeys.length > 0) {
    await log("ignoring invalid allowlist entries", { invalid: invalidKeys })
  }

  try {
    sidecar = new SidecarClient({
      node: nodeBin,
      sidecarPath,
      cwd: input.directory,
      args: [
        "--topic", topic.toString("hex"),
        "--id", identity.id,
        "--name", identity.name,
        "--project", project,
        "--room", room,
        "--seed", identity.seed,
        "--history-limit", String(historyLimit),
        "--sync-count", String(syncCount),
        ...(allowKeys.size > 0 ? ["--allow", [...allowKeys].join(",")] : []),
      ],
      onChat: incoming,
      onPeers: () => {},
      onLog: (message, extra) => void log(message, extra),
    })
    const info = await sidecar.ready
    await log(`joined room "${info.room}" as "${info.name}"`, {
      topic: info.topicHex,
      publicKey: info.publicKeyHex,
      historyLimit,
      syncCount,
      allowlisted: allowKeys.size,
      access: policy.openMode ? "open" : "psk",
    })
    if (policy.openMode && allowKeys.size === 0) {
      await log(
        "room has no secret and no allowlist: anyone who learns the topic can join",
        { room },
      )
    }
  } catch (err) {
    startupError = String(err instanceof Error ? err.message : err)
    const dead = sidecar
    sidecar = null
    await dead?.destroy().catch(() => {})
    await log("sidecar startup failed", { error: startupError })
  }

  const tools = toolsFor({ sidecar, room, startupError })

  return {
    tool: tools,
    "experimental.chat.system.transform": async (_input, output) => {
      if (!instructionEnabled) return
      try {
        output.system.push(systemInstruction(room, startupError))
      } catch {
        // best-effort
      }
    },
    dispose: async () => {
      await sidecar?.destroy().catch(() => {})
    },
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export default ChatPlugin
