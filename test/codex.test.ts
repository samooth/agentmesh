import { afterEach, describe, expect, test } from "bun:test"
import { buildDefinitions, handlers, dispose } from "../src/codex.ts"

/**
 * OpenCodex entry tests: JSON-Schema definitions are built synchronously,
 * handlers share the lazy core, and the disabled policy (no env config)
 * degrades gracefully instead of starting a swarm.
 */

const ENV_KEYS = [
  "CODING_CHAT_ROOM",
  "CODING_CHAT_SECRET",
  "CODING_CHAT_NAME",
  "CODING_CHAT_ALLOW",
  "CODING_CHAT_HISTORY_LIMIT",
  "CODING_CHAT_SYNC_COUNT",
  "CODING_CHAT_NODE",
] as const

const savedEnv: Record<string, string | undefined> = {}

beforeAllSafe()
function beforeAllSafe() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
}

afterEach(async () => {
  await dispose()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe("OpenCodex definitions", () => {
  test("all four tools expose OpenAI-compatible definitions synchronously", () => {
    const defs = buildDefinitions()
    for (const name of ["send", "history", "peers", "whoami"] as const) {
      const d = defs[name]
      expect(d.type).toBe("function")
      expect(d.function.name).toBe(`agent_chat_${name}`)
      expect(typeof d.function.description).toBe("string")
      expect(d.function.description.length).toBeGreaterThan(20)
      expect((d.function.parameters as { type: string }).type).toBe("object")
    }
  })

  test("send requires text; history has optional integer limit", () => {
    const defs = buildDefinitions()
    const sendParams = defs.send.function.parameters as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(sendParams.required).toEqual(["text"])
    const historyParams = defs.history.function.parameters as {
      properties: Record<string, { type: string; minimum?: number }>
    }
    expect(historyParams.properties.limit?.type).toBe("integer")
    expect(historyParams.properties.limit?.minimum).toBe(1)
  })

  test("descriptions embed untrusted-data guidance", () => {
    const defs = buildDefinitions()
    expect(defs.send.function.description).toContain("UNTRUSTED")
    expect(defs.history.function.description).toContain("untrusted")
  })
})

describe("OpenCodex handlers (unconfigured -> disabled)", () => {
  test("handler returns tool result with exit_code and disabled hint", async () => {
    const ctx = {}
    const result = await handlers.send(ctx, JSON.stringify({ text: "hi" }))
    expect(result.metadata.exit_code).toBe(0)
    expect(result.outputText).toContain("not configured")
  })

  test("handler tolerates malformed JSON args", async () => {
    const result = await handlers.send({}, "not-json{")
    expect(result.metadata.exit_code).toBe(0)
    expect(typeof result.outputText).toBe("string")
  })

  test("history/peers/whoami also degrade to disabled", async () => {
    const h = await handlers.history({}, "{}")
    const p = await handlers.peers({}, "{}")
    const w = await handlers.whoami({}, "{}")
    expect(h.outputText).toContain("not configured")
    expect(p.outputText).toContain("not configured")
    expect(w.outputText).toContain("not configured")
  })
})
