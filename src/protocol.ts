import { createHash } from "node:crypto"

export const PROTOCOL_VERSION = 1
export const MAX_TEXT_BYTES = 8 * 1024
export const MAX_NAME_BYTES = 128
export const MAX_PROJECT_BYTES = 128
export const NAME_MAX_CHARS = 64
export const SYNC_MAX_MESSAGES = 50

export type HelloMessage = {
  kind: "hello"
  v: number
  id: string
  name: string
  project: string
}

export type ChatMessage = {
  kind: "chat"
  id: string
  v: number
  from: string
  name: string
  text: string
  ts: number
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
  return {
    kind: "chat",
    v: PROTOCOL_VERSION,
    id: v.id,
    from: v.from,
    name: clampBytes(name, MAX_NAME_BYTES),
    text,
    ts: v.ts,
  }
}

export function validateHelloMessage(value: unknown): HelloMessage | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== "string" || v.id.length === 0) return null
  if (typeof v.name !== "string" || v.name.length === 0) return null
  const name = clampBytes(v.name, MAX_NAME_BYTES)
  if (name.length === 0) return null
  return {
    kind: "hello",
    v: PROTOCOL_VERSION,
    id: v.id,
    name,
    project:
      typeof v.project === "string" ? clampBytes(v.project, MAX_PROJECT_BYTES) : "",
  }
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
