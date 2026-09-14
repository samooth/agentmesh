#!/usr/bin/env node
/**
 * coding-chat debug CLI — a standalone room client, no host required.
 *
 * Wraps the same sidecar the hosts use and gives a human a REPL: type
 * messages, see incoming traffic live, run /whoami /peers /history.
 *
 * Usage:
 *   bun src/cli.ts --room myteam [--secret s] [--name my-debug]
 *   (--allow, --allow-file, --node as in the plugin options)
 */

import { createInterface } from "node:readline"
import { deriveTopic, sanitizeForDisplay } from "./protocol.ts"
import { SidecarClient } from "./client.ts"
import { parseAllowList } from "./keys.ts"

// ── ANSI helpers ──────────────────────────────────────────────────────
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const brightCyan = (s: string) => `\x1b[96m${s}\x1b[0m`
const brightGreen = (s: string) => `\x1b[92m${s}\x1b[0m`
const brightYellow = (s: string) => `\x1b[93m${s}\x1b[0m`
const brightMagenta = (s: string) => `\x1b[95m${s}\x1b[0m`
const brightRed = (s: string) => `\x1b[91m${s}\x1b[0m`
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`
const white = (s: string) => `\x1b[37m${s}\x1b[0m`

const AUTHOR_COLORS = [cyan, green, yellow, brightCyan, brightGreen, brightYellow, brightMagenta, brightRed]
function authorColor(name: string): (s: string) => string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return AUTHOR_COLORS[Math.abs(h) % AUTHOR_COLORS.length] ?? cyan
}

// ── args ──────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const argv = process.argv
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === name) return argv[i + 1]
  }
  return undefined
}

const room = arg("--room")
const secret = arg("--secret")
const name = arg("--name") ?? "debug-cli"
const allowRaw = arg("--allow")
const allowFile = arg("--allow-file")
const nodeBin = arg("--node") ?? "node"

if (!room && !secret) {
  console.error("usage: bun src/cli.ts --room <room> [--secret <s>] [--name n] [--allow keys] [--allow-file f] [--node bin]")
  process.exit(1)
}

const finalRoom = room ?? "default"
const topic = deriveTopic(finalRoom, secret)
const { keys: allowKeys } = parseAllowList(allowRaw)

const PROMPT = `${cyan(name)}> `
const PROMPT_W = name.length + 2
const NAME_COL = 14
const GROUP_WINDOW = 5 * 60_000

// ── output pipeline ───────────────────────────────────────────────────
type DisplayMsg = { name: string; from: string; text: string; ts: number; verified?: "ok" | "unsigned" | "bad" }
const outQueue: string[] = []
let flushScheduled = false
let uiStarted = false
let rl: ReturnType<typeof createInterface> | null = null
let lastFrom = ""
let lastTs = 0
let dropCount = 0
const knownPeers = new Map<string, string>()
let announcedInitial = false

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  setImmediate(() => {
    flushScheduled = false
    flushOut()
  })
}

function queue(line: string): void {
  outQueue.push(line)
  scheduleFlush()
}

function sysLine(line: string): void {
  lastFrom = ""
  queue(line)
}

function redrawPrompt(): void {
  if (!rl || !process.stdout.isTTY) return
  const partial = rl.line ?? ""
  const cursor = rl.cursor ?? 0
  const cols = process.stdout.columns || 80
  process.stdout.write("\r\x1b[2K" + PROMPT + partial)
  if (cursor === partial.length) return
  const endPos = PROMPT_W + partial.length
  const endRow = Math.floor(endPos / cols)
  const targetPos = PROMPT_W + cursor
  const tRow = Math.floor(targetPos / cols)
  const tCol = targetPos % cols
  const up = endRow - tRow
  if (up > 0) process.stdout.write(`\x1b[${up}A`)
  process.stdout.write(`\r\x1b[${tCol}C`)
}

function flushOut(): void {
  if (!uiStarted) return
  const lines = outQueue.splice(0)
  if (!rl || !process.stdout.isTTY) {
    if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n")
    return
  }
  const iface = rl
  iface.pause()
  const partial = iface.line ?? ""
  const cols = process.stdout.columns || 80
  const rows = Math.max(1, Math.ceil((PROMPT_W + partial.length) / cols))
  process.stdout.write("\r" + (rows > 1 ? `\x1b[${rows - 1}A` : "") + "\x1b[J")
  if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n")
  redrawPrompt()
  iface.resume()
}

// ── rendering ─────────────────────────────────────────────────────────
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000)
  if (days === 0) return time
  if (days === 1) return `yesterday ${time}`
  if (days < 7) return `${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()]} ${time}`
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

function displayName(name: string): string {
  const clean = sanitizeForDisplay(name)
  return clean.length > NAME_COL ? clean.slice(0, NAME_COL - 1) + "…" : clean
}

function renderChat(msg: DisplayMsg, grouped: boolean): string {
  const head = `  ${dim(formatTime(msg.ts))}  `
  const text = white(sanitizeForDisplay(msg.text).slice(0, 400))
  if (grouped) return head + " ".repeat(2 + NAME_COL + 2) + text
  const mark = msg.verified === "ok" ? green("✓") : msg.verified === "bad" ? brightRed("!") : gray("·")
  const nm = displayName(msg.name)
  const pad = " ".repeat(Math.max(0, NAME_COL - nm.length))
  return `${head}${mark} ${authorColor(nm)(bold(nm))}${dim(pad)}: ${text}`
}

function queueMsg(msg: DisplayMsg): void {
  const grouped =
    msg.from !== "" && msg.from === lastFrom && msg.ts >= lastTs && msg.ts - lastTs < GROUP_WINDOW
  lastFrom = msg.from
  lastTs = msg.ts
  queue(renderChat(msg, grouped))
}

function flushDrops(): void {
  if (dropCount === 0) return
  sysLine(gray(`  ⚠ ${dropCount} invalid-signature message${dropCount === 1 ? "" : "s"} suppressed`))
  dropCount = 0
}

// ── sidecar ───────────────────────────────────────────────────────────
const pluginDir = new URL(".", import.meta.url).pathname
const sidecarPath = pluginDir.endsWith("src/") ? `${pluginDir}sidecar.ts` : `${pluginDir}sidecar.js`

const client = new SidecarClient({
  node: nodeBin,
  sidecarPath,
  cwd: process.cwd(),
  args: [
    "--topic", topic.toString("hex"),
    "--id", `cli-${crypto.randomUUID().slice(0, 4)}`,
    "--name", name,
    "--project", "debug-cli",
    "--room", finalRoom,
    ...(secret ? ["--seed", Buffer.from(`cli:${secret}:${name}`).toString("hex").slice(0, 64).padEnd(64, "0")] : []),
    ...(allowKeys.size > 0 ? ["--allow", [...allowKeys].join(",")] : []),
    ...(allowFile ? ["--allow-file", allowFile] : []),
  ],
  onChat: (msg) =>
    queueMsg({ name: msg.name, from: msg.from, text: msg.text, ts: msg.ts, verified: msg.verified }),
  onPeers: (peers) => {
    const fresh = new Map<string, string>()
    for (const p of peers) fresh.set(p.id, p.name)
    if (!announcedInitial) {
      announcedInitial = true
      if (fresh.size > 0) {
        sysLine(dim(`  ● ${fresh.size} peer${fresh.size === 1 ? "" : "s"}: ${[...fresh.values()].map(sanitizeForDisplay).join(", ")}`))
      }
    } else {
      for (const [id, peerName] of fresh) {
        if (!knownPeers.has(id)) sysLine(green(`  ● ${sanitizeForDisplay(peerName)} joined`))
      }
      for (const [id, peerName] of knownPeers) {
        if (!fresh.has(id)) sysLine(gray(`  ○ ${sanitizeForDisplay(peerName)} left`))
      }
    }
    knownPeers.clear()
    for (const [k, v] of fresh) knownPeers.set(k, v)
  },
  onLog: (message) => {
    if (message.includes("dropped message with invalid signature")) {
      dropCount++
      return
    }
    flushDrops()
    sysLine(dim(`  [sidecar] ${message}`))
  },
})

// ── help / banner ─────────────────────────────────────────────────────
const HELP = [
  `  ${bold("Messages")}         anything else you type is sent to the room`,
  `  ${bold("/whoami")}          identity + public key`,
  `  ${bold("/peers")}           connected peers (key fingerprints)`,
  `  ${bold("/history [n]")}     last n messages (default 20)`,
  `  ${bold("/clear")}           clear the screen`,
  `  ${bold("/help")}            this help`,
  `  ${bold("/quit")}            leave (${dim("Ctrl+C twice")})`,
  "",
  dim("  ✓ verified  · unsigned  ! bad  · blank line = status"),
].join("\n")

// ── REPL ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const info = await client.ready
  console.log()
  console.log(`  ${bold("coding-chat")} ${dim("· debug CLI")}`)
  console.log(`  ${dim("room")}   ${finalRoom}`)
  console.log(`  ${dim("topic")}  ${dim(info.topicHex)}`)
  console.log(`  ${dim("key")}    ${dim(info.publicKeyHex || "(ephemeral)")}`)
  console.log()
  console.log(HELP)
  uiStarted = true

  rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT })
  let sigintAt = 0
  rl.on("SIGINT", () => {
    const now = Date.now()
    if (now - sigintAt < 2000) {
      process.stdout.write("\n")
      void client.destroy().finally(() => process.exit(0))
      return
    }
    sigintAt = now
    sysLine(dim("  ^C again to exit"))
  })

  rl.on("line", async (raw: string) => {
    const text = raw.trim()
    try {
      if (text.length === 0) {
        const { connections } = await client.peers()
        sysLine(dim(`  ${connections} connection(s) · ${knownPeers.size} peer(s) · room ${finalRoom}`))
      } else if (text === "/help") {
        queue("")
        queue(HELP)
      } else if (text === "/whoami") {
        const me = await client.whoami()
        queue("")
        queue(`  ${bold("identity")}`)
        queue(`  ${dim("name")}    ${cyan(me.name)}`)
        queue(`  ${dim("room")}    ${me.room}`)
        queue(`  ${dim("key")}     ${dim(me.publicKeyHex)}`)
        queue(`  ${dim("allow")}   ${me.allowCount} key(s)`)
        queue("")
      } else if (text === "/peers") {
        const { peers, connections } = await client.peers()
        queue("")
        if (peers.length === 0) {
          queue(gray(`  no peers connected (${connections} connection(s))`))
        } else {
          queue(`  ${bold("peers")}  ${dim(`(${connections} connection(s))`)}`)
          queue("")
          for (const p of peers) {
            const nm = displayName(p.name)
            const pad = " ".repeat(Math.max(0, NAME_COL - nm.length))
            const key = p.key ? dim(` [${p.key.slice(0, 10)}…]`) : ""
            const proj = p.project ? dim(` · ${sanitizeForDisplay(p.project)}`) : ""
            queue(`  ${green("●")} ${authorColor(nm)(bold(nm))}${dim(pad)}${key}${proj}`)
          }
        }
        queue("")
      } else if (text.startsWith("/history")) {
        const n = Number(text.split(/\s+/)[1] ?? 20)
        const { messages, connections } = await client.history(
          Number.isFinite(n) ? Math.min(200, Math.max(1, Math.trunc(n))) : 20,
        )
        queue("")
        if (messages.length === 0) {
          queue(gray("  no messages yet"))
        } else {
          lastFrom = ""
          lastTs = 0
          for (const m of messages) {
            queueMsg({ name: m.name, from: m.from, text: m.text, ts: m.ts, verified: m.verified })
          }
          queue(gray(`  ${messages.length} message(s) · ${connections} connection(s)`))
        }
        queue("")
      } else if (text === "/clear") {
        process.stdout.write("\x1b[2J\x1b[H")
      } else if (text === "/quit" || text === "/exit") {
        process.stdout.write("\n")
        rl?.close()
        await client.destroy()
        process.exit(0)
      } else {
        const reached = await client.send(text)
        lastFrom = ""
        queueMsg({ name, from: "self", text, ts: Date.now(), verified: "ok" })
        if (reached === 0) sysLine(yellow("  ⚠ no peers connected — message stored locally"))
      }
    } catch (err) {
      queue(brightRed(`  error: ${String(err instanceof Error ? err.message : err)}`))
    }
    flushDrops()
    redrawPrompt()
  })

  rl.on("close", async () => {
    await client.destroy()
    process.exit(0)
  })

  // seed the conversation with existing history so the room opens warm
  const { messages } = await client.history(10)
  if (messages.length > 0) {
    for (const m of messages) {
      queueMsg({ name: m.name, from: m.from, text: m.text, ts: m.ts, verified: m.verified })
    }
  }

  rl.prompt()
}

main().catch((err) => {
  console.error(`failed to start: ${String(err instanceof Error ? err.message : err)}`)
  process.exit(1)
})
