import { describe, expect, test } from "bun:test"
import { keyPair as keyPairFromSeed } from "hypercore-crypto"
import {
  deriveTopic,
  encodeLine,
  identityKeyPair,
  sanitizeForDisplay,
  signChatMessage,
  validateChatMessage,
  validateHelloMessage,
  validateSyncMessage,
  verifyChatSignature,
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

describe("message signing (ed25519)", () => {
  const seed = "11".repeat(32)
  const kp = identityKeyPair(seed)

  function makeMsg(): ReturnType<typeof validateChatMessage> {
    return validateChatMessage({
      kind: "chat",
      id: crypto.randomUUID(),
      from: "agent-x",
      name: "agent-x",
      text: "signed hello",
      ts: Date.now(),
    })
  }

  test("identityKeyPair derives a stable 32-byte keypair from the seed", () => {
    const again = identityKeyPair(seed)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.secretKey.length).toBe(64)
    expect(kp.publicKey.equals(again.publicKey)).toBe(true)
    // hypercore-crypto keypairs ARE ed25519: the noise key and the signing
    // key are the same keypair, so signatures verify against the pubkey
    // peers already pin for the connection.
    const noise = keyPairFromSeed(Buffer.from(seed, "hex"))
    expect(noise.publicKey.equals(kp.publicKey)).toBe(true)
  })

  test("signChatMessage attaches a signature that verifyChatSignature accepts", () => {
    const msg = makeMsg()!
    signChatMessage(msg, kp.secretKey)
    expect(typeof msg.sig).toBe("string")
    expect(msg.verified).toBe("ok")
    expect(verifyChatSignature(msg, kp.publicKey.toString("hex"))).toBe("ok")
  })

  test("pk travels with the message and the signature covers it", () => {
    const msg = makeMsg()!
    msg.pk = kp.publicKey.toString("hex")
    signChatMessage(msg, kp.secretKey)
    // wire round-trip keeps pk + sig together
    const back = validateChatMessage(JSON.parse(encodeLine(msg)))!
    expect(back.pk).toBe(msg.pk)
    expect(back.sig).toBe(msg.sig)
    // verify against the author key (as a relay/sync receiver would)
    expect(verifyChatSignature(back, back.pk)).toBe("ok")
    // swapping pk to re-attribute authorship invalidates the signature
    const stolen = { ...back, pk: identityKeyPair("44".repeat(32)).publicKey.toString("hex") }
    expect(verifyChatSignature(stolen as never, stolen.pk)).toBe("bad")
    // tampered pk on the wire also breaks verification
    const tamperedPk = validateChatMessage({ ...back, pk: "ff".repeat(32) })!
    tamperedPk.sig = back.sig
    expect(verifyChatSignature(tamperedPk, tamperedPk.pk)).toBe("bad")
  })

  test("signature survives wire round-trip and still verifies", () => {
    const msg = makeMsg()!
    signChatMessage(msg, kp.secretKey)
    const wire = JSON.parse(encodeLine(msg))
    const back = validateChatMessage(wire)!
    expect(back.sig).toBe(msg.sig)
    expect(verifyChatSignature(back, kp.publicKey.toString("hex"))).toBe("ok")
  })

  test("tampered text invalidates the signature", () => {
    const msg = makeMsg()!
    signChatMessage(msg, kp.secretKey)
    const tampered = validateChatMessage({
      ...msg,
      text: "tampered payload",
    })!
    tampered.sig = msg.sig
    expect(verifyChatSignature(tampered, kp.publicKey.toString("hex"))).toBe("bad")
  })

  test("wrong key rejects; unsigned reports unsigned", () => {
    const msg = makeMsg()!
    signChatMessage(msg, kp.secretKey)
    const other = identityKeyPair("22".repeat(32))
    expect(verifyChatSignature(msg, other.publicKey.toString("hex"))).toBe("bad")
    const unsigned = makeMsg()!
    expect(verifyChatSignature(unsigned, kp.publicKey.toString("hex"))).toBe("unsigned")
  })

  test("garbage sig fields are rejected, not thrown", () => {
    const msg = makeMsg()!
    msg.sig = "zzzz-not-hex"
    expect(verifyChatSignature(msg, kp.publicKey.toString("hex"))).toBe("bad")
    msg.sig = ""
    expect(verifyChatSignature(msg, kp.publicKey.toString("hex"))).toBe("bad")
  })

  test("hello pk is normalized when present", () => {
    const hello = validateHelloMessage({
      kind: "hello",
      id: "x",
      name: "n",
      project: "",
      pk: kp.publicKey.toString("hex").toUpperCase(),
    })
    expect(hello!.pk).toBe(kp.publicKey.toString("hex"))
    const bad = validateHelloMessage({ kind: "hello", id: "x", name: "n", pk: "short" })
    expect(bad!.pk).toBeUndefined()
  })
})
