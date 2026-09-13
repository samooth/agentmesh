import { describe, expect, test } from "bun:test"
import { ChatStore, type PeerInfo } from "../src/store.ts"
import type { ChatMessage } from "../src/protocol.ts"

function chat(id: string, text: string, ts = 1): ChatMessage {
  return { kind: "chat", v: 1, id, from: "peer", name: "peer", text, ts }
}

describe("ChatStore", () => {
  test("add returns true once and false for duplicates", () => {
    const store = new ChatStore(10)
    expect(store.add(chat("m1", "hello"))).toBe(true)
    expect(store.add(chat("m1", "hello"))).toBe(false)
    expect(store.history(10).length).toBe(1)
  })

  test("addMany counts only new messages", () => {
    const store = new ChatStore(10)
    const added = store.addMany([chat("m1", "a"), chat("m2", "b"), chat("m1", "a")])
    expect(added).toBe(2)
  })

  test("ring buffer evicts oldest beyond capacity and forgets their ids", () => {
    const store = new ChatStore(3)
    store.add(chat("m1", "a"))
    store.add(chat("m2", "b"))
    store.add(chat("m3", "c"))
    store.add(chat("m4", "d"))
    const history = store.history(10)
    expect(history.map((m) => m.id)).toEqual(["m2", "m3", "m4"])
    // evicted id is forgotten: re-adding m1 is treated as new
    expect(store.has("m1")).toBe(false)
    expect(store.add(chat("m1", "a"))).toBe(true)
  })

  test("history returns the newest slice in order", () => {
    const store = new ChatStore(10)
    for (let i = 1; i <= 5; i++) store.add(chat(`m${i}`, `t${i}`, i))
    const history = store.history(3)
    expect(history.map((m) => m.id)).toEqual(["m3", "m4", "m5"])
  })

  test("recentForSync returns tail up to count", () => {
    const store = new ChatStore(10)
    for (let i = 1; i <= 5; i++) store.add(chat(`m${i}`, `t${i}`, i))
    expect(store.recentForSync(2).map((m) => m.id)).toEqual(["m4", "m5"])
    expect(store.recentForSync(0).length).toBe(0)
  })

  test("notifies message listeners", () => {
    const store = new ChatStore(10)
    const received: ChatMessage[] = []
    const off = store.onMessage((m) => received.push(m))
    store.add(chat("m1", "hello"))
    off()
    store.add(chat("m2", "world"))
    expect(received.map((m) => m.id)).toEqual(["m1"])
  })

  test("tracks peers and notifies on change", () => {
    const store = new ChatStore(10)
    const snapshots: PeerInfo[][] = []
    store.onPeers((peers) => snapshots.push(peers))
    store.upsertPeer({ id: "p1", name: "beta", project: "x", connectedAt: 1 })
    store.upsertPeer({ id: "p2", name: "alpha", project: "y", connectedAt: 2 })
    store.removePeer("p1")
    const names = store.peersList().map((p) => p.name)
    expect(names).toEqual(["alpha"])
    expect(snapshots.length).toBe(3)
    expect(snapshots[0]!.map((p) => p.name)).toEqual(["beta"])
    // removing an unknown peer does not emit
    store.removePeer("nope")
    expect(snapshots.length).toBe(3)
  })
})
