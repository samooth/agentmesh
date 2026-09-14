import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { startChat } from "../src/plugin-core.ts"
import { uniqueRoom, uniqueSecret, testWorkDir } from "./helpers/rooms.ts"

/**
 * Multi-room (D14): a session joins a primary room eagerly plus a second
 * room lazily on first use; tools route by their optional `room` argument.
 * Offline (no peers): the second sidecar starts on demand.
 */

const CWD = await testWorkDir("multiroom")
// unique per run so nobody can pre-compute a test topic and inject into it
const ROOM_PRIMARY = uniqueRoom("multi-primary")
const ROOM_SECONDARY = uniqueRoom("multi-secondary")
const ROOM_SYS = uniqueRoom("sys-primary")
const ROOM_SYS2 = uniqueRoom("sys-2")
const ROOM_COMPACT = uniqueRoom("compact-room")
const ENV_KEYS = ["AGENTMESH_NODE", "AGENTMESH_ALLOW_FILE", "AGENTMESH_PERSIST"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}

function mockHost() {
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
    host: {
      tool: factory as never,
      log: async () => {},
      toast: async () => {},
    },
  }
}

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe("multi-room", () => {
  test("primary room works; second room starts lazily and routes", async () => {
    await mkdir(CWD, { recursive: true })
    const { host } = mockHost()
    const hooks = await startChat(
      { directory: CWD },
      {
        room: ROOM_PRIMARY,
        secret: uniqueSecret(),
        name: "multi-probe",
        persist: "",
        rooms: {
          [ROOM_SECONDARY]: uniqueSecret(),
        },
      },
      host,
    )
    try {
      const send = hooks.tool["agent_chat_send"] as {
        execute(args: { text: string; room?: string }): Promise<string>
      }
      const whoami = hooks.tool["agent_chat_whoami"] as {
        execute(args: { room?: string }): Promise<string>
      }

      // primary: default routing
      const primaryInfo = await whoami.execute({})
      expect(primaryInfo).toContain(`room: ${ROOM_PRIMARY}`)

      // second room: lazy spawn on first use
      const secondaryInfo = await whoami.execute({ room: ROOM_SECONDARY })
      expect(secondaryInfo).toContain(`room: ${ROOM_SECONDARY}`)

      // send routed per room; both see their own room's echo
      const sent1 = await send.execute({ text: "to primary" })
      expect(sent1).toContain(`room "${ROOM_PRIMARY}"`)
      const sent2 = await send.execute({ text: "to secondary", room: ROOM_SECONDARY })
      expect(sent2).toContain(`room "${ROOM_SECONDARY}"`)

      // unknown room is rejected with a clear hint
      const rejected = await send.execute({ text: "to nowhere", room: "does-not-exist" })
      expect(rejected).toContain("not configured")
      expect(rejected).toContain(ROOM_PRIMARY)
    } finally {
      await hooks.dispose()
    }
  }, 30_000)

  test("system transform lists all rooms", async () => {
    await mkdir(CWD, { recursive: true })
    const { host } = mockHost()
    const hooks = await startChat(
      { directory: CWD },
      {
        room: ROOM_SYS,
        secret: uniqueSecret(),
        name: "probe",
        persist: "",
        rooms: { [ROOM_SYS2]: "" },
      },
      host,
    )
    try {
      const system: string[] = []
      await hooks.systemTransform((text) => system.push(text))
      expect(system[0]).toContain(ROOM_SYS)
      expect(system[0]).toContain(ROOM_SYS2)
    } finally {
      await hooks.dispose()
    }
  }, 30_000)

  test("compactionContext surfaces recent primary-room history", async () => {
    await mkdir(CWD, { recursive: true })
    const { host } = mockHost()
    const hooks = await startChat(
      { directory: CWD },
      { room: ROOM_COMPACT, secret: uniqueSecret(), name: "probe", persist: "" },
      host,
    )
    try {
      const send = hooks.tool["agent_chat_send"] as {
        execute(args: { text: string }): Promise<string>
      }
      await send.execute({ text: "important coordination note" })
      const ctx = await hooks.compactionContext()
      expect(ctx.length).toBeGreaterThan(0)
      expect(ctx.join("\n")).toContain("important coordination note")
    } finally {
      await hooks.dispose()
    }
  }, 30_000)
})
