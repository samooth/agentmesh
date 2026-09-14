#!/usr/bin/env node
/**
 * agentmesh debug CLI — a standalone room client, no host required.
 *
 * Wraps the same sidecar the hosts use and gives a human a REPL:
 * type messages, see incoming traffic live, run /whoami /peers /history.
 * Useful for debugging rooms, testing connectivity, and demos.
 *
 * Usage:
 *   node src/cli.ts --room myteam [--secret s] [--name my-debug]
 *   (--allow, --allow-file, --node, --persist as in the plugin options)
 */

import { createInterface } from "node:readline"
import { deriveTopic, sanitizeForDisplay } from "./protocol.ts"
import { SidecarClient } from "./client.ts"
import { parseAllowList } from "./keys.ts"

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
  console.error("usage: node src/cli.ts --room <room> [--secret <s>] [--name n] [--allow keys] [--allow-file f] [--node bin]")
  process.exit(1)
}

const finalRoom = room ?? "default"
const topic = deriveTopic(finalRoom, secret)

const { keys: allowKeys } = parseAllowList(allowRaw)

let dropCount = 0

function flushDrops(): void {
  if (dropCount > 1) {
    process.stdout.write(`\r[sidecar] ⚠ ${dropCount} messages with invalid signature dropped\n> `)
  }
  dropCount = 0
}

const pluginDir = new URL(".", import.meta.url).pathname
const sidecarPath = pluginDir.endsWith("src/")
  ? `${pluginDir}sidecar.ts`
  : `${pluginDir}sidecar.js`

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
    const author = sanitizeForDisplay(msg.name).slice(0, 64)
    const mark = msg.verified === "ok" ? "✓" : msg.verified === "bad" ? "!" : " "
    const time = new Date(msg.ts).toISOString().slice(11, 19)
    process.stdout.write(`\r[${time}] ${mark} ${author}: ${sanitizeForDisplay(msg.text).slice(0, 400)}\n> `)
  },
  onPeers: () => {},
  onLog: (message) => {
    if (message.includes("dropped message with invalid signature")) {
      dropCount++
      if (dropCount === 1) {
        process.stdout.write(`\r[sidecar] ⚠ dropped message with invalid signature (repeated drops suppressed…)\n> `)
      }
      return
    }
    flushDrops()
    process.stdout.write(`\r[sidecar] ${message}\n> `)
  },
})

const HELP = `commands:
  /help            this help
  /whoami          identity + public key
  /peers           connected peers (with key fingerprints)
  /history [n]     last n messages (default 20)
  /quit            leave
anything else is sent to the room.

connected peers show a [key: abcd1234…] fingerprint; messages marked
with ✓ carry a verified signature (author pk), unsigned messages show
no marker.`

async function main(): Promise<void> {
  const info = await client.ready
  console.log(`coding-chat debug cli — room "${info.room}"`)
  console.log(`topic: ${info.topicHex}`)
  console.log(`local key: ${info.publicKeyHex || "(ephemeral)"}\n`)
  console.log(HELP + "\n")

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " })
  rl.prompt()

  rl.on("line", async (line) => {
    const text = line.trim()
    try {
      if (text.length === 0) {
        // nothing
      } else if (text === "/help") {
        console.log(HELP)
      } else if (text === "/whoami") {
        const me = await client.whoami()
        console.log(
          `name: ${me.name}\nroom: ${me.room}\npublic key: ${me.publicKeyHex}\nallowlisted keys: ${me.allowCount}`,
        )
      } else if (text === "/peers") {
        const { peers, connections } = await client.peers()
        if (peers.length === 0) {
          console.log(`no peers known yet (connections: ${connections})`)
        }
        for (const p of peers) {
          console.log(
            `- ${sanitizeForDisplay(p.name)}${p.key ? ` [key: ${p.key.slice(0, 8)}…]` : ""}` +
              `${p.project ? ` (project: ${sanitizeForDisplay(p.project)})` : ""}`,
          )
        }
      } else if (text.startsWith("/history")) {
        const n = Number(text.split(/\s+/)[1] ?? 20)
        const { messages, connections } = await client.history(
          Number.isFinite(n) ? Math.min(200, Math.max(1, Math.trunc(n))) : 20,
        )
        for (const m of messages) {
          const mark = m.verified === "ok" ? "✓" : m.verified === "bad" ? "!" : " "
          console.log(`[${new Date(m.ts).toISOString().slice(11, 19)}] ${mark} ${sanitizeForDisplay(m.name)}: ${sanitizeForDisplay(m.text).slice(0, 400)}`)
        }
        console.log(`(${messages.length} message(s), ${connections} connection(s))`)
      } else if (text === "/quit" || text === "/exit") {
        rl.close()
        await client.destroy()
        process.exit(0)
      } else {
        const reached = await client.send(text)
        console.log(`(delivered to ${reached} peer${reached === 1 ? "" : "s"})`)
      }
    } catch (err) {
      console.log(`error: ${String(err instanceof Error ? err.message : err)}`)
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
