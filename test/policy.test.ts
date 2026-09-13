import { describe, expect, test } from "bun:test"
import { resolveRoom } from "../src/policy.ts"

describe("resolveRoom", () => {
  test("no room and no secret: disabled with guidance", () => {
    const p = resolveRoom({}, "/home/user/repos/api")
    expect(p.enabled).toBe(false)
    if (!p.enabled) expect(p.reason).toContain("room")
  })

  test("empty/whitespace strings count as unset", () => {
    expect(resolveRoom({ room: "  " }, "/x/api").enabled).toBe(false)
    expect(resolveRoom({ room: "", secret: "" }, "/x/api").enabled).toBe(false)
  })

  test("secret alone enables with directory-derived room (topic unguessable)", () => {
    const p = resolveRoom({ secret: "letmein" }, "/home/user/repos/api")
    expect(p.enabled).toBe(true)
    if (p.enabled) {
      expect(p.room).toBe("api")
      expect(p.openMode).toBe(false)
    }
  })

  test("explicit room without secret: open mode", () => {
    const p = resolveRoom({ room: "myteam" }, "/home/user/repos/api")
    expect(p.enabled).toBe(true)
    if (p.enabled) {
      expect(p.room).toBe("myteam")
      expect(p.openMode).toBe(true)
    }
  })

  test("explicit room with secret: psk mode, room name preserved", () => {
    const p = resolveRoom({ room: "myteam", secret: "s3cr3t" }, "/home/user/repos/api")
    expect(p.enabled).toBe(true)
    if (p.enabled) {
      expect(p.room).toBe("myteam")
      expect(p.openMode).toBe(false)
    }
  })
})
