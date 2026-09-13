import type { ChatMessage } from "./protocol.ts"

export type PeerInfo = {
  id: string
  name: string
  project: string
  connectedAt: number
}

export class ChatStore {
  private readonly capacity: number
  private seen = new Set<string>()
  private messages: ChatMessage[] = []
  private peers = new Map<string, PeerInfo>()
  private messageListeners = new Set<(msg: ChatMessage) => void>()
  private peerListeners = new Set<(peers: PeerInfo[]) => void>()

  constructor(capacity: number) {
    this.capacity = capacity
  }

  onMessage(listener: (msg: ChatMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onPeers(listener: (peers: PeerInfo[]) => void): () => void {
    this.peerListeners.add(listener)
    return () => this.peerListeners.delete(listener)
  }

  /** Returns true if the message was new, false if it was a duplicate. */
  add(msg: ChatMessage): boolean {
    if (this.seen.has(msg.id)) return false
    this.seen.add(msg.id)
    this.messages.push(msg)
    if (this.messages.length > this.capacity) {
      const dropped = this.messages.length - this.capacity
      for (const m of this.messages.splice(0, dropped)) this.seen.delete(m.id)
    }
    for (const listener of this.messageListeners) listener(msg)
    return true
  }

  addMany(msgs: ChatMessage[]): number {
    let added = 0
    for (const msg of msgs) {
      if (this.add(msg)) added++
    }
    return added
  }

  has(id: string): boolean {
    return this.seen.has(id)
  }

  history(limit: number): ChatMessage[] {
    return this.messages.slice(Math.max(0, this.messages.length - limit))
  }

  recentForSync(count: number): ChatMessage[] {
    return this.messages.slice(Math.max(0, this.messages.length - count))
  }

  upsertPeer(peer: PeerInfo): void {
    this.peers.set(peer.id, peer)
    this.emitPeers()
  }

  removePeer(id: string): void {
    if (this.peers.delete(id)) this.emitPeers()
  }

  peersList(): PeerInfo[] {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private emitPeers(): void {
    const peers = this.peersList()
    for (const listener of this.peerListeners) listener(peers)
  }
}
