// Three-node relay test for the pk-carrying signature fix:
// alice (persistent key) sends -> bob relays -> carol receives via bob's
// sync/relay. Before the fix carol dropped alice's messages ("invalid
// signature") because she verified against bob's connection key.
import { deriveTopic, validateChatMessage, encodeLine, identityKeyPair } from "../src/protocol.ts"

const topic = deriveTopic("relay-fix", `relay-secret-${Date.now()}`)
const alice = identityKeyPair("aa".repeat(32))
const bob = identityKeyPair("bb".repeat(32))
const carol = identityKeyPair("cc".repeat(32))

function msg(from: string, name: string, text: string, kp = alice) {
  const m: any = {
    kind: "chat", id: crypto.randomUUID(), v: 1,
    from, name, text, ts: Date.now(),
    pk: kp.publicKey.toString("hex"),
  }
  return m
}

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log(`(pass) ${label}`) }
  else { fail++; console.log(`(FAIL) ${label}`) }
}

// 1. alice authors a signed message
const m = msg("alice-id", "alice", "hello via relay")
// sign it with alice's key using the real signer
const { signChatMessage, verifyChatSignature } = await import("../src/protocol.ts")
signChatMessage(m, alice.secretKey)
check("alice signs with pk attached", m.pk === alice.publicKey.toString("hex") && typeof m.sig === "string")

// 2. bob receives it directly (conn key == alice key)
const bobRecv = validateChatMessage(JSON.parse(encodeLine(m)))!
check("bob wire-accepts it", bobRecv.id === m.id)
let v = verifyChatSignature(bobRecv, bobRecv.pk!)
check("bob verifies against author pk (direct)", v === "ok")

// 3. bob relays to carol: carol's conn key is BOB's, not alice's.
//    Old code verified against bob's key -> "bad" -> dropped.
//    New code verifies against msg.pk (alice) -> "ok".
v = verifyChatSignature(bobRecv, bob.publicKey.toString("hex"))
check("old-path check against bob key would fail (relay scenario)", v === "bad")
v = verifyChatSignature(bobRecv, bobRecv.pk!)
check("carol verifies against author pk (relay)", v === "ok")

// 4. impersonation: eve relays a message claiming alice's pk but signed by eve
const eve = identityKeyPair("ee".repeat(32))
const fake = msg("alice-id", "alice", "i am totally alice")
fake.pk = alice.publicKey.toString("hex") // claim alice's key
signChatMessage(fake, eve.secretKey) // but sign with eve's key
const fakeWire = validateChatMessage(JSON.parse(encodeLine(fake)))!
v = verifyChatSignature(fakeWire, fakeWire.pk!)
check("impersonation via stolen pk claim is rejected", v === "bad")

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
