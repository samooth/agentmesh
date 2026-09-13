import type { ChatMessage } from "./protocol.ts"
import type { PeerInfo } from "./store.ts"

/**
 * Wire contract between the opencode plugin (runs inside opencode's Bun
 * process) and the sidecar process (runs under Node, owns the Hyperswarm
 * instance). NDJSON over the sidecar's stdin/stdout.
 *
 * The split exists because hyperswarm's native transport (udx-native) cannot
 * load inside Bun (missing libuv uv_interface_addresses support), so the
 * swarm must live in a Node child process.
 */

export type IpcRequest =
  | { id: string; cmd: "send"; text: string }
  | { id: string; cmd: "history"; limit?: number }
  | { id: string; cmd: "peers" }
  | { id: string; cmd: "whoami" }

export type IpcSendResult = { reached: number }
export type IpcHistoryResult = { messages: ChatMessage[]; connections: number }
export type IpcPeersResult = { peers: PeerInfo[]; connections: number }
export type IpcWhoamiResult = {
  id: string
  name: string
  room: string
  publicKeyHex: string
  allowCount: number
}

export type IpcResult = IpcSendResult | IpcHistoryResult | IpcPeersResult | IpcWhoamiResult

export type IpcResponse =
  | { id: string; ok: true; result: IpcResult }
  | { id: string; ok: false; error: string }

export type IpcEvent =
  | { ev: "ready"; room: string; name: string; topicHex: string; publicKeyHex: string }
  | { ev: "chat"; msg: ChatMessage }
  | { ev: "peers"; peers: PeerInfo[] }
  | { ev: "log"; message: string; extra?: Record<string, unknown> }

export type IpcLine = IpcRequest | IpcResponse | IpcEvent
