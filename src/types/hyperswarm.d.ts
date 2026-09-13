declare module "hyperswarm" {
  import type { Duplex } from "node:stream"

  export type HyperswarmPeerInfo = {
    publicKey: Buffer
    topics: Buffer[]
    prioritized: boolean
    ban(banStatus?: boolean): void
  }

  export type HyperswarmOptions = {
    keyPair?: { publicKey: Buffer; secretKey: Buffer }
    seed?: Buffer
    maxPeers?: number
    firewall?: (remotePublicKey: Buffer) => boolean
    dht?: unknown
  }

  export default class Hyperswarm {
    constructor(opts?: HyperswarmOptions)
    readonly connecting: number
    readonly connections: Set<Duplex>
    readonly peers: Map<string, HyperswarmPeerInfo>
    readonly dht: unknown
    on(event: "connection", listener: (socket: Duplex, peerInfo: HyperswarmPeerInfo) => void): this
    on(event: "update", listener: () => void): this
    on(event: "ban", listener: (peerInfo: HyperswarmPeerInfo, err: Error) => void): this
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean; limit?: number }): {
      flushed(): Promise<void>
      refresh(opts?: { client?: boolean; server?: boolean }): Promise<void>
      destroy(): Promise<void>
    }
    leave(topic: Buffer): Promise<void>
    joinPeer(noisePublicKey: Buffer): void
    leavePeer(noisePublicKey: Buffer): void
    status(topic: Buffer): { flushed(): Promise<void> } | undefined
    listen(): Promise<void>
    flush(): Promise<void>
    suspend(opts?: { log?: () => void }): Promise<void>
    resume(opts?: { log?: () => void }): Promise<void>
    destroy(): Promise<void>
  }
}
