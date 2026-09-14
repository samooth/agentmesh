import { createHash } from "node:crypto"
import { sign as edSign, verify as edVerify, keyPair as keyPairFromSeed } from "hypercore-crypto"

export const PROTOCOL_VERSION = 1
export const MAX_TEXT_BYTES = 8 * 1024
export const MAX_NAME_BYTES = 128
export const MAX_PROJECT_BYTES = 128
export const NAME_MAX_CHARS = 64
export const SYNC_MAX_MESSAGES = 50
export const MAX_SIG_HEX = 128 * 2

export type HelloMessage = {
  kind: "hello"
  v: number
  id: string
  name: string
  project: string
  /** Sender's noise public key (hex). Self-declared but cross-checkable
   *  against the connection's actual remote key by the swarm layer. */
  pk?: string
}

export type ChatMessage = {
  kind: "chat"
  id: string
  v: number
  from: string
  name: string
  text: string
  ts: number
  /** Author's public key (hex) — the same persistent keypair that signed
   *  `sig`. Travels with the message so relays and history syncs can verify
   *  against the *author*, not the peer that happens to deliver it. */
  pk?: string
  /** Ed25519 signature (hex) over the signed-message payload, produced with
   *  the sender's persistent identity keypair. Optional so unsigned peers
   *  still interoperate; verified by receivers when present. */
  sig?: string
  /** Resolved verification state, computed locally on receipt/authoring:
   *  "ok" (signature verified against a known key), "unsigned", or
   *  "bad" (signature present but invalid). Never taken from the wire. */
  verified?: "ok" | "unsigned" | "bad"
}

export type SyncMessage = {
  kind: "sync"
  v: number
  messages: ChatMessage[]
}

export type WireMessage = HelloMessage | ChatMessage | SyncMessage

export function deriveTopic(room: string, secret?: string): Buffer {
  const material = secret
    ? `agentmesh:v${PROTOCOL_VERSION}:${room}:${secret}`
    : `agentmesh:v${PROTOCOL_VERSION}:${room}`
  return createHash("sha256").update(material).digest()
}

/** The canonical signed payload for a chat message (fields an attacker could
 *  not mutate without invalidating the signature — including pk, so a key
 *  swap cannot re-attribute a signed message to another author). */
function signedPayload(msg: Pick<ChatMessage, "id" | "from" | "ts" | "text" | "pk">): Buffer {
  return Buffer.from(`${msg.id}|${msg.from}|${msg.ts}|${msg.pk ?? ""}|${msg.text}`, "utf8")
}

/** Signs a chat message in place with an ed25519 secret key. */
export function signChatMessage(msg: ChatMessage, secretKey: Buffer): void {
  msg.sig = edSign(signedPayload(msg), secretKey).toString("hex")
  msg.verified = "ok"
}

/** Result of checking a message's signature against a claimed public key. */
export function verifyChatSignature(
  msg: ChatMessage,
  publicKeyHex: string | undefined,
): "ok" | "unsigned" | "bad" {
  if (typeof msg.sig !== "string") return "unsigned"
  if (!publicKeyHex || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return "bad"
  let sig: Buffer
  try {
    sig = Buffer.from(msg.sig, "hex")
  } catch {
    return "bad"
  }
  const ok =
    sig.length === 64 &&
    edVerify(signedPayload(msg), sig, Buffer.from(publicKeyHex, "hex"))
  return ok ? "ok" : "bad"
}

/** Derives the persistent identity keypair (same seed as the noise key). */
export function identityKeyPair(seedHex: string) {
  return keyPairFromSeed(Buffer.from(seedHex, "hex"))
}

/** Returns the message with all fields clamped to protocol limits, or null if malformed. */
export function validateChatMessage(value: unknown): ChatMessage | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (
    typeof v.id !== "string" ||
    typeof v.from !== "string" ||
    typeof v.text !== "string" ||
    typeof v.ts !== "number" ||
    !Number.isFinite(v.ts) ||
    v.id.length === 0 ||
    v.from.length === 0
  ) {
    return null
  }
  const text = clampBytes(v.text, MAX_TEXT_BYTES)
  if (text.trim().length === 0) return null
  const name = typeof v.name === "string" && v.name.length > 0 ? v.name : v.from
  const msg: ChatMessage = {
    kind: "chat",
    v: PROTOCOL_VERSION,
    id: v.id,
    from: v.from,
    name: clampBytes(name, MAX_NAME_BYTES),
    text,
    ts: v.ts,
  }
  // pk must precede sig extraction: the signature covers pk
  if (typeof v.pk === "string" && /^[0-9a-f]{64}$/i.test(v.pk)) {
    msg.pk = v.pk.toLowerCase()
  }
  if (typeof v.sig === "string" && /^[0-9a-f]{64,128}$/i.test(v.sig)) {
    msg.sig = v.sig.toLowerCase().slice(0, MAX_SIG_HEX)
  }
  return msg
}

export function validateHelloMessage(value: unknown): HelloMessage | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== "string" || v.id.length === 0) return null
  if (typeof v.name !== "string" || v.name.length === 0) return null
  const name = clampBytes(v.name, MAX_NAME_BYTES)
  if (name.length === 0) return null
  const hello: HelloMessage = {
    kind: "hello",
    v: PROTOCOL_VERSION,
    id: v.id,
    name,
    project:
      typeof v.project === "string" ? clampBytes(v.project, MAX_PROJECT_BYTES) : "",
  }
  if (typeof v.pk === "string" && /^[0-9a-f]{64}$/i.test(v.pk)) {
    hello.pk = v.pk.toLowerCase()
  }
  return hello
}

/** Returns a validated sync message, or null if malformed. */
export function validateSyncMessage(value: unknown): SyncMessage | null {
  if (typeof value !== "object" || value === null) return null
  const messages = (value as Record<string, unknown>).messages
  if (!Array.isArray(messages)) return null
  const chats = messages
    .map((m) => validateChatMessage(m))
    .filter((m): m is ChatMessage => m !== null)
    .slice(0, SYNC_MAX_MESSAGES)
  return { kind: "sync", v: PROTOCOL_VERSION, messages: chats }
}

/**
 * Strips ANSI escape sequences and control characters so remote text is safe
 * to hand to terminals/TUIs. Flattens line breaks to spaces.
 */
export function sanitizeForDisplay(s: string): string {
  return s
    .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
}

export function encodeLine(msg: WireMessage): string {
  return JSON.stringify(msg) + "\n"
}

/** Slices a string to at most maxBytes of UTF-8 without splitting a character. */
export function clampBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s
  return Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8")
}
