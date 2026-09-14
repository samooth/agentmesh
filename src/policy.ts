import { basename } from "node:path"

export type RoomPolicy =
  | { enabled: true; room: string; openMode: boolean }
  | { enabled: false; reason: string }

/**
 * Decides whether chat should start. Security rule: never derive a room
 * implicitly from the working directory when the user configured nothing —
 * predictable topics (common dir names like "api") would silently place
 * unrelated users in the same room. Chat requires an explicit `room`,
 * or at minimum a `secret` (which makes any derived topic unguessable).
 */
export function resolveRoom(
  opts: { room?: unknown; secret?: unknown },
  directory: string,
): RoomPolicy {
  const room = typeof opts.room === "string" ? opts.room.trim() : ""
  const secret = typeof opts.secret === "string" ? opts.secret.trim() : ""
  if (room.length === 0 && secret.length === 0) {
    return {
      enabled: false,
      reason:
        "chat is not configured. Set `room` (and a `secret` for anything non-public) in the coding-chat plugin options in your host's config (opencode.json / kilo.json), or via CODING_CHAT_ROOM / CODING_CHAT_SECRET env vars (OpenCodex).",
    }
  }
  const derived = basename(directory) || "default"
  const finalRoom = room.length > 0 ? room : derived
  return { enabled: true, room: finalRoom, openMode: secret.length === 0 }
}
