import { describe, expect, test } from "bun:test"
import { startChat } from "../src/plugin-core.ts"
import { uniqueRoom, uniqueSecret, testWorkDir } from "./helpers/rooms.ts"

/**
 * Resilience test (item 9): when the sidecar process dies mid-session, the
 * next tool call respawns it instead of reporting "unavailable" forever.
 * Kills the child process directly through the debug handle (portable —
 * no pgrep/process-list scanning) and verifies the resilient proxy
 * self-heals on the next tool call.
 */

const TEST_ROOM = uniqueRoom("plugin-core-restart")
const TEST_SECRET = uniqueSecret()
const TEST_CWD = await testWorkDir("restart")

function mockHost() {
  const logs: Array<{ message: string; extra?: Record<string, unknown> }> = []
  const chain = {
    describe: () => chain,
    int: () => chain,
    min: () => chain,
    max: () => chain,
    optional: () => chain,
  }
  const factory = (input: { execute(args: unknown): Promise<string> }) => input
  factory.schema = { string: () => chain, number: () => chain }
  return {
    logs,
    host: {
      tool: factory as never,
      log: async (message: string, extra?: Record<string, unknown>) => {
        logs.push({ message, extra })
      },
      toast: async () => {},
    },
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe("sidecar resilience", () => {
  test("respawns the sidecar after a mid-session crash", async () => {
    const { host } = mockHost()
    const hooks = await startChat(
      { directory: TEST_CWD },
      { room: TEST_ROOM, secret: TEST_SECRET, name: "restart-probe", persist: "" },
      host,
    )
    try {
      const whoami = hooks.tool["agent_chat_whoami"] as {
        execute(): Promise<string>
      }

      // baseline: sidecar alive
      const before = await whoami.execute()
      expect(before).toContain("restart-probe")

      // hard-kill this session's own sidecar process (crash simulation)
      const sidecar = hooks.debugSidecar()
      expect(sidecar).not.toBeNull()
      sidecar!.kill()
      await wait(100)
      expect(sidecar!.isDead()).toBe(true)

      // tools would report "not running" without respawn; with the
      // resilient proxy the next call restarts the sidecar
      const after = await whoami.execute()
      expect(after).toContain("restart-probe")
      expect(after).not.toContain("unavailable")
    } finally {
      await hooks.dispose()
    }
  }, 30_000)

  test("dispose after crash exits cleanly", async () => {
    const { host } = mockHost()
    const hooks = await startChat(
      { directory: TEST_CWD },
      { room: TEST_ROOM, secret: TEST_SECRET, name: "restart-probe-2", persist: "" },
      host,
    )
    hooks.debugSidecar()?.kill()
    await wait(100)
    await hooks.dispose()
    // no hang: dispose resolved
  }, 30_000)
})
