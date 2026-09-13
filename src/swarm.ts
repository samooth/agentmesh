import Hyperswarm from "hyperswarm"
import { keyPair as keyPairFromSeed } from "hypercore-crypto"
import type { Duplex } from "node:stream"
import {
  clampBytes,
  encodeLine,
  identityKeyPair,
  MAX_NAME_BYTES,
  MAX_PROJECT_BYTES,
  sanitizeForDisplay,
  signChatMessage,
  validateChatMessage,
  validateHelloMessage,
  validateSyncMessage,
  verifyChatSignature,
  type ChatMessage,
  type HelloMessage,
} from "./protocol.ts"
import { PeerRateLimiter } from "./ratelimit.ts"
import type { ChatStore } from "./store.ts"

export type SwarmIdentity = {
  id: string
  name: string
  project: string
}

export type SwarmOptions = {
  topic: Buffer
  identity: SwarmIdentity
  store: ChatStore
  syncCount: number
  /** 32-byte seed (hex) for the persistent noise keypair. */
  seed?: string
  /** Hex-encoded public keys allowed to connect. Empty/undefined = allow all. */
  allow?: Set<string>
  /** Inbound message rate limit (per peer). Defaults in PeerRateLimiter. */
  rateLimit?: { capacity?: number; refillPerSecond?: number }
  /** Persistence hooks: called with each accepted chat message. */
  onPersist?: (msg: ChatMessage) => void
  log?: (message: string, extra?: Record<string, unknown>) => void
}

type PeerConnection = {
  socket: Duplex
  peerId: string
  remoteId?: string
  remotePk?: string
  buffer: string
  sentSync: boolean
  closed: boolean
}

const MAX_CONN_BUFFER = 512 * 1024

/**
 * Wraps one Hyperswarm instance per sidecar process. All peers join the
 * topic in server+client mode; connections are noise-encrypted duplex
 * streams speaking newline-delimited JSON.
 *
 * Chat messages are signed with the persistent identity keypair (same seed
 * as the noise key); signatures are verified on receipt against the
 * *connection's* public key, so `from`/`name` fields stay self-declared
 * but authorship of the text is cryptographic. Unsigned messages from
 * older peers still interoperate and are marked "unsigned".
 */
export class ChatSwarm {
  private readonly swarm: Hyperswarm
  private readonly connections = new Map<string, PeerConnection>()
  private readonly store: ChatStore
  private readonly identity: SwarmIdentity
  private readonly syncCount: number
  private allow: Set<string> | undefined
  private readonly rate = new PeerRateLimiter()
  private readonly localPublicKeyHex: string
  private readonly localSecretKey: Buffer | null
  private readonly onPersist: ((msg: ChatMessage) => void) | undefined
  private readonly log: (message: string, extra?: Record<string, unknown>) => void
  private destroyed = false
  private discovery?: {
    flushed(): Promise<void>
    refresh(opts?: { client?: boolean; server?: boolean }): Promise<void>
    destroy(): Promise<void>
  }
  private refreshTimer?: ReturnType<typeof setInterval>

  constructor(opts: SwarmOptions) {
    this.store = opts.store
    this.identity = opts.identity
    this.syncCount = opts.syncCount
    this.allow = opts.allow && opts.allow.size > 0 ? opts.allow : undefined
    if (opts.rateLimit) {
      this.rate = new PeerRateLimiter(opts.rateLimit)
    }
    this.onPersist = opts.onPersist
    this.log = opts.log ?? (() => {})
    const seedBuffer = opts.seed
      ? Buffer.from(opts.seed, "hex")
      : null
    const keyPair = seedBuffer && seedBuffer.length === 32 ? keyPairFromSeed(seedBuffer) : undefined
    this.localPublicKeyHex = keyPair ? keyPair.publicKey.toString("hex") : ""
    this.localSecretKey = keyPair ? keyPair.secretKey : null
    // hypercore-crypto keypairs are ed25519: the same persistent keypair
    // serves as the noise transport key and the message signing key, so a
    // message signature verifies against the pubkey peers already pin for
    // the connection.
    this.swarm = new Hyperswarm({
      keyPair,
      ...(this.allow
        ? {
            firewall: (remotePublicKey: Buffer) => {
              const hex = remotePublicKey.toString("hex")
              return !this.allow!.has(hex)
            },
          }
        : {}),
    })
    this.swarm.on("connection", (socket, peerInfo) => {
      // Outbound double-check: the firewall gates dialing in hyperswarm, but
      // a peer added to the allow set after discovery queued it could slip a
      // handshake through relayed paths — enforce locally too.
      const hex = peerInfo.publicKey.toString("hex")
      if (this.allow && !this.allow.has(hex)) {
        this.log("rejected non-whitelisted peer", { peer: hex.slice(0, 8) })
        socket.destroy()
        return
      }
      if (this.rate.isBanned(hex)) {
        this.log("rejected banned peer", { peer: hex.slice(0, 8) })
        socket.destroy()
        return
      }
      this.handleConnection(socket, hex)
    })
    this.discovery = this.swarm.join(opts.topic, { server: true, client: true })
    // Re-announce and re-lookup periodically: two peers joining a topic at
    // the exact same moment can otherwise miss each other's first DHT wave.
    this.refreshTimer = setInterval(() => {
      const d = this.discovery
      if (!d || this.destroyed) return
      void d.refresh({ client: true, server: true }).catch(() => {})
    }, 10_000)
  }

  get peerCount(): number {
    return this.connections.size
  }

  /** Noise public key of this peer (hex), or "" when using an ephemeral key. */
  get publicKeyHex(): string {
    return this.localPublicKeyHex
  }

  /** Send a locally-authored message: store it, then broadcast. */
  sendChat(msg: ChatMessage): number {
    if (this.localSecretKey) {
      signChatMessage(msg, this.localSecretKey)
      this.onPersist?.(msg)
    }
    this.store.add(msg)
    return this.broadcastChat(msg)
  }

  /** Broadcast an arbitrary chat message to all connected peers. */
  broadcastChat(msg: ChatMessage): number {
    const line = encodeLine(msg)
    let reached = 0
    for (const conn of this.connections.values()) {
      if (this.writeLine(conn, line)) reached++
    }
    return reached
  }

  /**
   * Live allowlist update (revocation): replaces the allow set, then drops
   * any existing connection whose key is no longer allowed. New handshakes
   * from removed keys are already gated by the updated firewall closure.
   */
  updateAllow(allow: Set<string> | undefined): number {
    const next = allow && allow.size > 0 ? allow : undefined
    this.allow = next
    if (!next) return 0
    let kicked = 0
    for (const conn of [...this.connections.values()]) {
      if (!next.has(conn.peerId)) {
        this.log("kicked peer removed from allowlist", { peer: conn.peerId.slice(0, 8) })
        this.closeConnection(conn)
        kicked++
      }
    }
    return kicked
  }

  get allowKeys(): Set<string> | undefined {
    return this.allow
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    for (const conn of [...this.connections.values()]) {
      this.closeConnection(conn)
    }
    try {
      await this.swarm.destroy()
    } catch {
      // ignore teardown errors during shutdown
    }
  }

  private handleConnection(socket: Duplex, peerId: string): void {
    // hyperswarm deduplicates peer pairs, but guard anyway
    if (this.connections.has(peerId)) {
      socket.destroy()
      return
    }

    const conn: PeerConnection = {
      socket,
      peerId,
      buffer: "",
      sentSync: false,
      closed: false,
    }
    this.connections.set(peerId, conn)

    socket.on("data", (chunk: Buffer) => {
      if (conn.closed) return
      conn.buffer += chunk.toString("utf8")
      // hard cap to prevent a misbehaving peer from ballooning memory
      if (conn.buffer.length > MAX_CONN_BUFFER) {
        this.closeConnection(conn)
        return
      }
      const newline = conn.buffer.lastIndexOf("\n")
      if (newline === -1) return
      const complete = conn.buffer.slice(0, newline)
      conn.buffer = conn.buffer.slice(newline + 1)
      for (const raw of complete.split("\n")) {
        if (raw.length === 0) continue
        this.handleLine(conn, raw)
      }
    })

    socket.on("close", () => this.closeConnection(conn))
    socket.on("error", () => this.closeConnection(conn))

    this.sendHello(conn)
  }

  private sendHello(conn: PeerConnection): void {
    const hello: HelloMessage = {
      kind: "hello",
      v: 1,
      id: this.identity.id,
      name: clampBytes(this.identity.name, MAX_NAME_BYTES),
      project: clampBytes(this.identity.project, MAX_PROJECT_BYTES),
      ...(this.localPublicKeyHex ? { pk: this.localPublicKeyHex } : {}),
    }
    this.writeLine(conn, encodeLine(hello))
  }

  private sendSync(conn: PeerConnection): void {
    if (conn.sentSync) return
    conn.sentSync = true
    const messages = this.store.recentForSync(this.syncCount)
    if (messages.length === 0) return
    this.writeLine(conn, encodeLine({ kind: "sync", v: 1, messages }))
  }

  private handleLine(conn: PeerConnection, raw: string): void {
    // rate limit: every inbound protocol line counts
    if (!this.rate.allow(conn.peerId)) {
      this.log("dropping flooding peer", { peer: conn.peerId.slice(0, 8) })
      this.closeConnection(conn)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof parsed !== "object" || parsed === null) return
    const kind = (parsed as { kind?: unknown }).kind

    if (kind === "hello") {
      const hello = validateHelloMessage(parsed)
      if (hello === null) return
      // The connection's key is ground truth; hello.pk is informational.
      // A hello claiming a different key than the transport pins is lying.
      if (hello.pk && hello.pk !== conn.peerId) {
        this.log("hello claims a key that does not match its connection", {
          claimed: hello.pk.slice(0, 8),
          actual: conn.peerId.slice(0, 8),
        })
      }
      conn.remoteId = hello.id
      conn.remotePk = conn.peerId
      this.store.upsertPeer({
        id: hello.id,
        name: hello.name,
        project: hello.project,
        connectedAt: Date.now(),
        key: conn.peerId,
      })
      if (!conn.sentSync) {
        // Peer is live: offer recent history so it catches up.
        this.sendSync(conn)
      }
      return
    }

    if (kind === "sync") {
      const sync = validateSyncMessage(parsed)
      if (sync === null) return
      for (const msg of sync.messages) {
        this.acceptChat(conn, msg)
      }
      return
    }

    if (kind === "chat") {
      const msg = validateChatMessage(parsed)
      if (msg === null) return
      this.acceptChat(conn, msg)
      return
    }
  }

  /** Validate + verify + dedupe + store + relay an inbound chat message. */
  private acceptChat(conn: PeerConnection, msg: ChatMessage): void {
    if (this.store.has(msg.id)) return
    // Verify against the connection's actual noise public key when this
    // peer has a stable key; ephemeral-key peers cannot be verified.
    const claimedKey = conn.remotePk ?? conn.peerId
    msg.verified = verifyChatSignature(msg, claimedKey)
    if (msg.verified === "bad") {
      this.log("dropped message with invalid signature", {
        from: sanitizeForDisplay(msg.from).slice(0, 32),
        peer: conn.peerId.slice(0, 8),
      })
      return
    }
    if (this.store.add(msg)) {
      this.onPersist?.(msg)
      // Relay to the rest of the mesh (their dedupe absorbs loops).
      this.broadcastChat(msg)
    }
  }

  private writeLine(conn: PeerConnection, line: string): boolean {
    if (conn.closed) return false
    try {
      conn.socket.write(line)
      return true
    } catch {
      this.closeConnection(conn)
      return false
    }
  }

  private closeConnection(conn: PeerConnection): void {
    if (conn.closed) return
    conn.closed = true
    this.connections.delete(conn.peerId)
    this.rate.forget(conn.peerId)
    // Remove the peer identity registered via hello, if any.
    if (conn.remoteId) this.store.removePeer(conn.remoteId)
    try {
      conn.socket.destroy()
    } catch {
      // already destroyed
    }
  }
}
