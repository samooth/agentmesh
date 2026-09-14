#!/usr/bin/env node
/**
 * coding-chat debug CLI — a standalone room client, no host required.
 *
 * Wraps the same sidecar the hosts use and gives a human a REPL:
 * type messages, see incoming traffic live, run /whoami /peers /history.
 * Useful for debugging rooms, testing connectivity, and demos.
 *
 * Usage:
 *   bun src/cli.ts --room myteam [--secret s] [--name my-debug]
 *   (--allow, --allow-file, --node, --persist as in the plugin options)
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
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const brightCyan = (s: string) => `\x1b[96m${s}\x1b[0m`
const brightGreen = (s: string) => `\x1b[92m${s}\x1b[0m`
const brightYellow = (s: string) => `\x1b[93m${s}\x1b[0m`
const brightMagenta = (s: string) => `\x1b[95m${s}\x1b[0m`
const brightRed = (s: string) => `\x1b[91m${s}\x1b[0m`
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`
const white = (s: string) => `\x1b[37m${s}\x1b[0m`

// Color palette for author names (stable per name via hash)
const AUTHOR_COLORS = [cyan, green, yellow, brightCyan, brightGreen, brightYellow, brightMagenta, brightRed]
function authorColor(name: string): (s: string) => string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return AUTHOR_COLORS[Math.abs(h) % AUTHOR_COLORS.length] ?? cyan
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 0) return "just now"
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return sec === 0 ? "just now" : `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

// ── CLI args ──────────────────────────────────────────────────────────
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
  console.error(`usage: bun src/cli.ts --room <room> [--secret <s>] [--name n] [--allow keys] [--allow-file f] [--node bin]`)
  process.exit(1)
}

const finalRoom = room ?? "default"
const topic = deriveTopic(finalRoom, secret)
const { keys: allowKeys } = parseAllowList(allowRaw)

// ── Drop suppression ──────────────────────────────────────────────────
let dropCount = 0
function flushDrops(): void {
  if (dropCount > 1) {
    prints(`  ${gray(`⚠ ${dropCount} unsigned/invalid messages suppressed`)}`)
  }
  dropCount = 0
}

// ── Sidecar spawn ─────────────────────────────────────────────────────
const pluginDir = new URL(".", import.meta.url).pathname
const sidecarPath = pluginDir.endsWith("src/")
  ? `${pluginDir}sidecar.ts`
  : `${pluginDir}sidecar.js`

let peerCount = 0
let rl: ReturnType<typeof createInterface> | null = null

/** Print a line above the current prompt without eating the user's input. */
function prints(line: string): void {
  if (!rl) { process.stdout.write(line + "\n"); return }
  // Save cursor position, clear current line, print, restore prompt
  const cursor = rl.cursor ?? 0
  const partial = rl.line ?? ""
  process.stdout.write("\r\x1b[2K" + line + "\n")
  process.stdout.write(`\r${cyan(name)}> ${partial}`)
  // Reposition cursor within the partial input
  if (cursor > 0) process.stdout.write(`\x1b[${cursor}C`)
}

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
  onChat: (msg) => {
    const color = authorColor(msg.name)
    const mark = msg.verified === "ok" ? green("✓") : msg.verified === "bad" ? red("!") : gray("·")
    const ts = shortTime(msg.ts)
    const text = sanitizeForDisplay(msg.text).slice(0, 400)
    prints(`  ${dim(ts)}  ${mark} ${color(bold(msg.name))}: ${white(text)}`)
  },
  onPeers: (peers) => { peerCount = peers.length },
  onLog: (message) => {
    if (message.includes("dropped message with invalid signature")) {
      dropCount++
      if (dropCount === 1) {
        prints(`  ${yellow("⚠")} dropped message with invalid signature ${dim("(suppressing…)")}`)
      }
      return
    }
    flushDrops()
    prints(`  ${dim("[sidecar]")} ${gray(message)}`)
  },
})

// ── Help text ─────────────────────────────────────────────────────────
const HELP = `
  ${bold("coding-chat")} ${dim("debug CLI")}

  ${bold("Messages")}       type anything → send to room
  ${bold("/whoami")}        your identity + public key
  ${bold("/peers")}         connected peers with key fingerprints
  ${bold("/history [n]")}   last n messages (default 20)
  ${bold("/help")}          this help
  ${bold("/quit")}          leave

  ${dim("✓")} verified signature   ${dim("·")} unsigned   ${dim("!")} bad signature
`

// ── REPL ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const info = await client.ready
  const prompt = `${cyan(name)}> `

  // Banner
  console.log()
  console.log(`  ${bold("coding-chat")}  ${dim("debug CLI")}`)
  console.log(`  room:    ${bold(info.room)}`)
  console.log(`  topic:   ${dim(info.topicHex)}`)
  console.log(`  key:     ${dim(info.publicKeyHex || "(ephemeral)")}`)
  console.log()
  console.log(HELP)

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt })
  rl.prompt()

  rl.on("line", async (line) => {
    const text = line.trim()
    try {
      if (text.length === 0) {
        // blank line — show status
        const { connections } = await client.peers()
        prints(`  ${dim(`${connections} connection(s) · room ${info.room}`)}`)
      } else if (text === "/help") {
        console.log(HELP)
      } else if (text === "/whoami") {
        const me = await client.whoami()
        console.log()
        console.log(`  ${bold("Identity")}`)
        console.log(`  name:      ${cyan(me.name)}`)
        console.log(`  room:      ${me.room}`)
        console.log(`  public key:${dim(me.publicKeyHex)}`)
        console.log(`  allowlist: ${me.allowCount} key(s)`)
        console.log()
      } else if (text === "/peers") {
        const { peers, connections } = await client.peers()
        console.log()
        if (peers.length === 0) {
          console.log(`  ${dim("no peers connected")} ${dim(`(${connections} connection(s))`)}`)
        } else {
          console.log(`  ${bold("Peers")} ${dim(`(${connections} connection(s))`)}`)
          console.log()
          for (const p of peers) {
            const color = authorColor(p.name)
            const key = p.key ? dim(`[${p.key.slice(0, 12)}…]`) : ""
            const proj = p.project ? dim(` · ${p.project}`) : ""
            console.log(`  ${color(bold(p.name))} ${key}${proj}`)
          }
        }
        console.log()
      } else if (text.startsWith("/history")) {
        const n = Number(text.split(/\s+/)[1] ?? 20)
        const { messages, connections } = await client.history(
          Number.isFinite(n) ? Math.min(200, Math.max(1, Math.trunc(n))) : 20,
        )
        console.log()
        if (messages.length === 0) {
          console.log(`  ${dim("no messages yet")}`)
        } else {
          for (const m of messages) {
            const color = authorColor(m.name)
            const mark = m.verified === "ok" ? green("✓") : m.verified === "bad" ? red("!") : gray("·")
            const ts = dim(shortTime(m.ts))
            const text = sanitizeForDisplay(m.text).slice(0, 400)
            console.log(`  ${ts}  ${mark} ${color(m.name)}: ${text}`)
          }
        }
        console.log(`  ${dim(`${messages.length} message(s) · ${connections} connection(s)`)}\n`)
      } else if (text === "/quit" || text === "/exit") {
        console.log(`  ${dim("bye!")}`)
        rl.close()
        await client.destroy()
        process.exit(0)
      } else {
        const reached = await client.send(text)
        const status = reached > 0 ? green(`${reached} peer(s)`) : yellow("no peers")
        prints(`  ${dim("→")} ${status}`)
      }
    } catch (err) {
      console.log(`  ${red("error:")} ${String(err instanceof Error ? err.message : err)}`)
    }
    flushDrops()
    rl.prompt()
  })

  rl.on("close", async () => {
    await client.destroy()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(`failed to start: ${String(err instanceof Error ? err.message : err)}`)
  process.exit(1)
})
