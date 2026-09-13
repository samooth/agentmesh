import { describe, expect, test } from "bun:test"
import {
  deriveTopic,
  encodeLine,
  sanitizeForDisplay,
  validateChatMessage,
  validateHelloMessage,
  validateSyncMessage,
  MAX_TEXT_BYTES,
} from "../src/protocol.ts"

const validChat = {
  kind: "chat",
  id: "abc",
  from: "peer1",
  name: "peer-one",
  text: "hello world",
  ts: 1234567890,
}

describe("deriveTopic", () => {
  test("returns 32-byte buffer", () => {
    expect(deriveTopic("room").length).toBe(32)
  })

  test("same inputs derive same topic", () => {
    expect(deriveTopic("room", "secret").equals(deriveTopic("room", "secret"))).toBe(true)
  })

  test("different rooms derive different topics", () => {
    expect(deriveTopic("room-a").equals(deriveTopic("room-b"))).toBe(false)
  })

  test("secret changes the topic", () => {
    expect(deriveTopic("room").equals(deriveTopic("room", "secret"))).toBe(false)
  })
})

describe("validateChatMessage", () => {
  test("accepts valid message", () => {
    const msg = validateChatMessage(validChat)
    expect(msg).not.toBeNull()
    expect(msg!.text).toBe("hello world")
  })

  test("rejects non-object", () => {
    expect(validateChatMessage(null)).toBeNull()
    expect(validateChatMessage("chat")).toBeNull()
    expect(validateChatMessage(42)).toBeNull()
  })

  test("rejects missing or empty required fields", () => {
    expect(validateChatMessage({ ...validChat, id: "" })).toBeNull()
    expect(validateChatMessage({ ...validChat, from: "" })).toBeNull()
    expect(validateChatMessage({ ...validChat, id: undefined })).toBeNull()
    expect(validateChatMessage({ ...validChat, text: undefined })).toBeNull()
  })

  test("rejects non-numeric or non-finite timestamps", () => {
    expect(validateChatMessage({ ...validChat, ts: "123" })).toBeNull()
    expect(validateChatMessage({ ...validChat, ts: Number.NaN })).toBeNull()
    expect(validateChatMessage({ ...validChat, ts: Infinity })).toBeNull()
  })

  test("rejects whitespace-only text", () => {
    expect(validateChatMessage({ ...validChat, text: "   \n\t " })).toBeNull()
  })

  test("clamps oversized text to byte cap", () => {
    const msg = validateChatMessage({ ...validChat, text: "x".repeat(MAX_TEXT_BYTES + 100) })
    expect(msg).not.toBeNull()
    expect(Buffer.byteLength(msg!.text, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES)
  })

  test("defaults name to sender id when missing", () => {
    const msg = validateChatMessage({ ...validChat, name: undefined })
    expect(msg!.name).toBe("peer1")
  })
})

describe("validateHelloMessage", () => {
  test("accepts valid hello", () => {
    const msg = validateHelloMessage({ kind: "hello", id: "p1", name: "peer", project: "proj" })
    expect(msg).not.toBeNull()
    expect(msg!.project).toBe("proj")
  })

  test("rejects empty id or name", () => {
    expect(validateHelloMessage({ kind: "hello", id: "", name: "x" })).toBeNull()
    expect(validateHelloMessage({ kind: "hello", id: "x", name: "" })).toBeNull()
  })

  test("tolerates missing project", () => {
    const msg = validateHelloMessage({ kind: "hello", id: "p1", name: "peer" })
    expect(msg!.project).toBe("")
  })
})

describe("validateSyncMessage", () => {
  test("accepts array of valid chats and drops invalid ones", () => {
    const msg = validateSyncMessage({
      kind: "sync",
      messages: [validChat, { kind: "chat", id: "", from: "x", text: "y", ts: 1 }],
    })
    expect(msg).not.toBeNull()
    expect(msg!.messages.length).toBe(1)
  })

  test("rejects missing messages array", () => {
    expect(validateSyncMessage({ kind: "sync" })).toBeNull()
    expect(validateSyncMessage({ kind: "sync", messages: "nope" })).toBeNull()
  })
})

describe("sanitizeForDisplay", () => {
  test("strips ANSI escape sequences", () => {
    expect(sanitizeForDisplay("\x1b[31mred\x1b[0m")).toBe("red")
    expect(sanitizeForDisplay("\x1b]0;title\x07visible")).toBe("visible")
  })

  test("strips control characters", () => {
    expect(sanitizeForDisplay("a\x00b\x07c\x7fd")).toBe("a b c d")
  })

  test("flattens line breaks and collapses spaces", () => {
    expect(sanitizeForDisplay("line1\nline2\ttab")).toBe("line1 line2 tab")
  })

  test("leaves normal text intact", () => {
    expect(sanitizeForDisplay("hello world")).toBe("hello world")
    expect(sanitizeForDisplay("héllo wörld ✓")).toBe("héllo wörld ✓")
  })
})

describe("encodeLine", () => {
  test("produces newline-terminated JSON that round-trips", () => {
    const line = encodeLine(validChat as never)
    expect(line.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(line)
    expect(parsed.id).toBe("abc")
    expect(validateChatMessage(parsed)!.text).toBe("hello world")
  })
})
