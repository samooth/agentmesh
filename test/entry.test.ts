import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

/**
 * Entry-shape smoke tests: both host entries must load, call their plugin
 * function with a mock context, and return the tool registry without
 * starting a sidecar (disabled policy — no room/secret configured).
 */

const mockInput = {
  directory: join(tmpdir(), "agentmesh-entry-shape-test"),
  client: {
    app: {
      log: async () => true,
    },
    tui: {
      showToast: async () => true,
    },
  },
} as unknown as Parameters<Plugin>[0]

describe("opencode entry shape", () => {
  test("default export is a plugin function returning hooks", async () => {
    const mod = await import("../src/index.ts")
    expect(typeof mod.default).toBe("function")
    const hooks = await mod.default(mockInput, {})
    expect(hooks).not.toBeNull()
    expect(Object.keys(hooks.tool ?? {})).toEqual([
      "agent_chat_send",
      "agent_chat_history",
      "agent_chat_peers",
      "agent_chat_whoami",
    ])
    expect(typeof hooks.dispose).toBe("function")
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")
    await hooks.dispose?.()
  })

  test("unconfigured stays disabled: send tool reports it", async () => {
    const mod = await import("../src/index.ts")
    const hooks = await mod.default(mockInput, {})
    const send = hooks.tool?.["agent_chat_send"]
    expect(send).toBeDefined()
    const result = await send!.execute({ text: "hi" }, undefined as never)
    expect(String(result)).toContain("not configured")
  })
})

describe("kilo entry shape", () => {
  test("default export is { id, server } descriptor", async () => {
    const mod = await import("../src/kilo.ts")
    expect(mod.default.id).toBe("agentmesh")
    expect(typeof mod.default.server).toBe("function")
    const hooks = await mod.default.server(mockInput as never, {})
    expect(Object.keys(hooks.tool ?? {})).toEqual([
      "agent_chat_send",
      "agent_chat_history",
      "agent_chat_peers",
      "agent_chat_whoami",
    ])
    expect(typeof hooks.dispose).toBe("function")
    await hooks.dispose?.()
  })

  test("system transform pushes disabled note when unconfigured", async () => {
    const mod = await import("../src/kilo.ts")
    const hooks = await mod.default.server(mockInput as never, {})
    const system: string[] = []
    const transform = hooks["experimental.chat.system.transform"]!
    await transform({} as never, { system })
    expect(system.length).toBe(1)
    expect(system[0]).toContain("Chat is currently disabled")
  })
})
