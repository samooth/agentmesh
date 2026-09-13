import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { startChat } from "../src/plugin-core.ts"

/**
 * Resilience test (item 9): when the sidecar process dies mid-session, the
 * next tool call respawns it instead of reporting "unavailable" forever.
 * Uses a real sidecar (offline: no peers needed) and kills the child by
 * scanning for the sidecar command line.
 */

const TEST_ROOM = "plugin-core-restart-test"
const TEST_CWD = "/tmp/opencode/agentmesh-restart-test"

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
    await mkdir(TEST_CWD, { recursive: true })
    const { host } = mockHost()
    const hooks = await startChat(
      { directory: TEST_CWD },
      { room: TEST_ROOM, secret: "test", name: "restart-probe" },
      host,
    )
    try {
      const whoami = hooks.tool["agent_chat_whoami"] as {
        execute(): Promise<string>
      }

      // baseline: sidecar alive
      const before = await whoami.execute()
      expect(before).toContain("restart-probe")

      // kill the sidecar child process behind the proxy
      const killed = await killOwnSidecar()
      expect(killed).toBe(true)

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
    await mkdir(TEST_CWD, { recursive: true })
    const { host } = mockHost()
    const hooks = await startChat(
      { directory: TEST_CWD },
      { room: TEST_ROOM, secret: "test", name: "restart-probe-2" },
      host,
    )
    await killOwnSidecar()
    await hooks.dispose()
    expect(true).toBe(true)
  }, 30_000)
})

/** Kill any sidecar node processes spawned from this test run. */
async function killOwnSidecar(): Promise<boolean> {
  const { exec } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const run = promisify(exec)
  try {
    const { stdout } = await run(
      `pgrep -f "sidecar[.]ts --topic" | grep -v grep || true`,
    )
    const pids = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (pids.length === 0) return false
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL")
      } catch {
        // already gone
      }
    }
    await wait(200)
    return true
  } catch {
    return false
  }
}
