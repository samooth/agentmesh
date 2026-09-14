import { afterEach, describe, expect, test } from "bun:test"
import piExtension from "../src/pi.ts"
import { uniqueRoom, uniqueSecret } from "./helpers/rooms.ts"

/**
 * pi entry tests: the factory registers the four tools + /mesh command,
 * tools degrade to "not configured" without env config, and an enabled
 * e2e (env-configured) round-trips through the real sidecar.
 */

type RegisteredTool = {
  name: string
  parameters: unknown
  execute(
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: { ui: { notify(msg: string, type?: string): void } },
  ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>
}

function makeMockPi() {
  const tools = new Map<string, RegisteredTool>()
  const handlers = {
    session_start: [] as Array<(e: unknown, ctx: unknown) => void | Promise<void>>,
    session_shutdown: [] as Array<(e: unknown, ctx: unknown) => void | Promise<void>>,
  }
  const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>()
  return {
    tools,
    commands,
    handlers,
    api: {
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool)
      },
      registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options)
      },
      on(event: string, handler: (e: unknown, ctx: unknown) => void | Promise<void>) {
        handlers[event as keyof typeof handlers].push(handler)
      },
    } as never,
  }
}

const ENV_KEYS = [
  "CODING_CHAT_ROOM",
  "CODING_CHAT_SECRET",
  "CODING_CHAT_NAME",
  "CODING_CHAT_ALLOW",
  "CODING_CHAT_HISTORY_LIMIT",
  "CODING_CHAT_SYNC_COUNT",
  "CODING_CHAT_NODE",
  "CODING_CHAT_TOAST",
  "CODING_CHAT_PERSIST",
] as const

const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe("pi entry", () => {
  test("registers four tools and /mesh command without starting anything", () => {
    const pi = makeMockPi()
    piExtension(pi.api)
    expect([...pi.tools.keys()].sort()).toEqual([
      "agent_chat_history",
      "agent_chat_peers",
      "agent_chat_send",
      "agent_chat_whoami",
    ])
    expect(pi.commands.has("mesh")).toBe(true)
    expect(pi.handlers.session_start.length).toBe(1)
    expect(pi.handlers.session_shutdown.length).toBe(1)
  })

  test("unconfigured: tools report chat is not configured (no sidecar)", async () => {
    const pi = makeMockPi()
    piExtension(pi.api)
    const send = pi.tools.get("agent_chat_send")!
    const result = await send.execute("t1", { text: "hi" }, undefined, undefined, {
      ui: { notify: () => {} },
    })
    expect(result.content[0]!.text).toContain("not configured")
  })

  test("enabled e2e: send + whoami through the real sidecar, toast bound at session_start", async () => {
    const room = uniqueRoom("pi-e2e")
    process.env.CODING_CHAT_ROOM = room
    process.env.CODING_CHAT_SECRET = uniqueSecret()
    process.env.CODING_CHAT_PERSIST = ""
    const pi = makeMockPi()
    piExtension(pi.api)

    // simulate pi's session_start binding the UI notify channel
    const notifications: string[] = []
    const ctx = { ui: { notify: (msg: string) => notifications.push(msg) } }
    await pi.handlers.session_start[0]!({}, ctx)

    const whoami = pi.tools.get("agent_chat_whoami")!
    const result = await whoami.execute("t1", {}, undefined, undefined, ctx)
    expect(result.content[0]!.text).toContain("public key (share this for allowlisting): ")
    // pubkey is 64-hex on the whoami line
    const line = result.content[0]!.text.split("\n")[2]!
    expect(line).toMatch(/[0-9a-f]{64}/)

    const send = pi.tools.get("agent_chat_send")!
    const sent = await send.execute("t2", { text: "hello from pi" }, undefined, undefined, ctx)
    expect(sent.content[0]!.text).toContain(`room "${room}"`)

    // graceful teardown via session_shutdown
    await pi.handlers.session_shutdown[0]!({}, ctx)
  }, 30_000)
})
