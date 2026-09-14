// E2E: the exact scenario from the bug report. alice joins a room and
// sends messages; later bob joins — bob's sidecar syncs alice's history
// from alice directly, but we also add a THIRD node (carol) that joins
// AFTER alice left. Carol gets history ONLY via bob (relay). Before the
// fix carol dropped every alice message ("invalid signature").
import { SidecarClient } from "../src/client.ts"
import { deriveTopic } from "../src/protocol.ts"
import { uniqueRoom, uniqueSecret } from "./helpers/rooms.ts"

const room = uniqueRoom("relay-e2e")
const secret = uniqueSecret()
const topicHex = deriveTopic(room, secret).toString("hex")
const SIDECAR = new URL("../src/sidecar.ts", import.meta.url).pathname
const NODE = process.env.AGENTMESH_NODE ?? "node"

function mk(id: string, name: string, seed: string) {
  return new SidecarClient({
    node: NODE,
    sidecarPath: SIDECAR,
    cwd: process.cwd(),
    args: [
      "--topic", topicHex,
      "--id", id, "--name", name, "--project", "relay-e2e", "--room", room,
      "--seed", seed,
      "--history-limit", "50", "--sync-count", "20",
    ],
    onChat: () => {},
    onPeers: () => {},
  })
}

const aliceSeed = "a1".repeat(32)
const bobSeed = "b2".repeat(32)
const carolSeed = "c3".repeat(32)

let pass = 0, fail = 0
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`(pass) ${label}`) }
  else { fail++; console.log(`(FAIL) ${label} ${detail}`) }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean | Promise<boolean>, ms: number, everyMs = 500): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await wait(everyMs)
  }
  return await fn()
}

// phase 1: alice + bob connected; alice talks
const alice = mk("alice-id", "alice", aliceSeed)
const bob = mk("bob-id", "bob", bobSeed)
await alice.ready
await bob.ready
// let them find each other (DHT waves can take a few seconds)
const linked = await until(async () => (await alice.peers()).connections > 0, 20_000)
console.log(`alice<->bob linked: ${linked}`)
let reached = 0
if (linked) {
  for (let i = 0; i < 5 && reached === 0; i++) {
    reached = await alice.send("message one from alice")
    if (reached === 0) await wait(1000)
  }
}
console.log(`alice-> reached ${reached} peer(s)`)
await wait(1000)

const bobHist = await bob.history(20)
check("bob has alice's message", bobHist.messages.some((m) => m.text === "message one from alice" && m.name === "alice"))
const withPk = bobHist.messages.find((m) => m.name === "alice")
check("alice's message carries pk", !!withPk?.pk && /^[0-9a-f]{64}$/.test(withPk.pk))
check("bob verified it (direct conn)", withPk?.verified === "ok")

// phase 2: alice leaves; carol joins — history now arrives via bob only
await alice.destroy()
await wait(1000)
const carol = mk("carol-id", "carol", carolSeed)
await carol.ready
await wait(4000) // DHT discovery + sync

const carolHist = await carol.history(20)
const gotAlice = carolHist.messages.find((m) => m.name === "alice")
check("carol got alice's history via bob relay", !!gotAlice, `messages: ${carolHist.messages.map((m) => m.name).join(",") || "none"}`)
check("carol verified alice's sig (relay) — the fix", gotAlice?.verified === "ok", `verified=${gotAlice?.verified}`)

await bob.destroy()
await carol.destroy()

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
