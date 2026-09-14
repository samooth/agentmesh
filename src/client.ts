import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import type { ChatMessage } from "./protocol.ts"
import type { PeerInfo } from "./store.ts"
import type { IpcEvent, IpcResponse } from "./ipc.ts"

/**
 * Runs inside the host's Bun process. Spawns the Node sidecar that owns the
 * Hyperswarm instance and proxies chat calls over NDJSON stdio.
 */

/** Minimum Node version for the sidecar (native .ts type stripping). */
export const MIN_NODE_VERSION = [23, 6] as const

/** One-shot spawn precheck result, cached across respawn attempts. */
let nodeVersionCheck: { ok: true; version: string } | { ok: false; error: string } | null = null

/** Test/escape hatch: drop the cached precheck result. */
export function resetNodeVersionCache(): void {
  nodeVersionCheck = null
}

function parseNodeMajorMinor(raw: string): [number, number] | null {
  const m = /^v(\d+)\.(\d+)/.exec(raw.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2])]
}

/**
 * Verify the sidecar's Node binary is new enough. Running the sidecar under
 * an older Node fails with a raw ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, so we
 * precheck once and turn it into a actionable error message.
 */
export async function checkNodeVersion(
  node: string,
  run: (bin: string, args: string[]) => Promise<string> = defaultRun,
  opts?: { useCache?: boolean },
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  if (opts?.useCache !== false && nodeVersionCheck) return nodeVersionCheck
  try {
    const raw = await run(node, ["--version"])
    const parsed = parseNodeMajorMinor(raw)
    if (!parsed) {
      nodeVersionCheck = { ok: false, error: `coding-chat: could not parse Node version from "${raw.trim()}"` }
      return nodeVersionCheck
    }
    const [wantMajor, wantMinor] = MIN_NODE_VERSION
    const [major, minor] = parsed
    if (major < wantMajor || (major === wantMajor && minor < wantMinor)) {
      nodeVersionCheck = {
        ok: false,
        error: `coding-chat: Node >= ${wantMajor}.${wantMinor} is required to run the swarm sidecar (found ${raw.trim()}). Install a newer Node or point the \`node\` option / AGENTMESH_NODE at one.`,
      }
      return nodeVersionCheck
    }
    if (opts?.useCache !== false) nodeVersionCheck = { ok: true, version: raw.trim() }
    return { ok: true, version: raw.trim() }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === "ENOENT") {
      const result = {
        ok: false as const,
        error: `coding-chat: Node binary "${node}" not found. Install Node >= ${MIN_NODE_VERSION[0]}.${MIN_NODE_VERSION[1]} or set the \`node\` option / AGENTMESH_NODE.`,
      }
      if (opts?.useCache !== false) nodeVersionCheck = result
      return result
    }
    const result = {
      ok: false as const,
      error: `coding-chat: could not run "${node}" (${String(err instanceof Error ? err.message : err)})`,
    }
    if (opts?.useCache !== false) nodeVersionCheck = result
    return result
  }
}

async function defaultRun(bin: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process")
  return new Promise<string>((resolve, reject) => {
    execFile(bin, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/** Appends a short stderr tail to a sidecar error, when one was captured. */

export type SidecarClientOptions = {
  /** Node binary to run the sidecar. */
  node: string
  sidecarPath: string
  args: string[]
  cwd: string
  onChat: (msg: ChatMessage) => void
  onPeers: (peers: PeerInfo[]) => void
  onLog?: (message: string, extra?: Record<string, unknown>) => void
  spawnTimeoutMs?: number
}

type Pending = {
  resolve: (result: IpcResponse) => void
}

export class SidecarClient {
  private readonly opts: SidecarClientOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private exited = false
  private exitCode: number | null = null
  private readySettled = false
  /** Rolling tail of the sidecar's stderr, surfaced in errors (hosts with
   *  no log channel — OpenCodex/pi — would otherwise drop it silently). */
  private stderrTailText = ""
  readonly ready: Promise<{ room: string; name: string; topicHex: string; publicKeyHex: string }>
  private resolveReady!: (value: { room: string; name: string; topicHex: string; publicKeyHex: string }) => void
  private rejectReady!: (err: Error) => void

  constructor(opts: SidecarClientOptions) {
    this.opts = opts
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    const timeout = opts.spawnTimeoutMs ?? 15_000
    const timer = setTimeout(() => {
      this.rejectReady(new Error(`coding-chat sidecar not ready after ${timeout}ms`))
    }, timeout)
    this.ready.then(
      () => {
        this.readySettled = true
        clearTimeout(timer)
      },
      () => {
        this.readySettled = true
        clearTimeout(timer)
      },
    )
    this.spawn()
  }

  private spawn(): void {
    const child = spawn(this.opts.node, [this.opts.sidecarPath, ...this.opts.args], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    })
    this.child = child
    this.exited = false
    this.exitCode = null

    // spawn failures (missing binary, bad cwd) surface here asynchronously;
    // reject `ready` so the host process never crashes on an unhandled event.
    child.on("error", (err) => {
      this.exited = true
      for (const [, pending] of this.pending) {
        pending.resolve({ id: "", ok: false, error: "sidecar failed to spawn" })
      }
      this.pending.clear()
      const code = (err as NodeJS.ErrnoException).code
      // ENOENT can mean either a missing node binary or a missing cwd;
      // check the cwd so the hint points at the right fix.
      let hint: string
      if (code === "ENOENT" && !existsSync(this.opts.cwd)) {
        hint = `coding-chat: the sidecar's working directory does not exist (${this.opts.cwd}).`
      } else {
        hint = `coding-chat: failed to spawn the Node sidecar (${String(code ?? err)}). Install Node >= 23.6 or set the \`node\` option.`
      }
      this.opts.onLog?.("sidecar spawn failed", { error: String(err) })
      if (!this.readySettled) {
        this.readySettled = true
        this.rejectReady(new Error(hint))
      }
    })

    const rl = createInterface({ input: child.stdout })
    rl.on("line", (line: string) => {
      if (line.length === 0) return
      this.handleLine(line)
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      this.stderrTailText = (this.stderrTailText + chunk).slice(-1000)
      this.opts.onLog?.("sidecar stderr", { tail: chunk.slice(-500) })
    })

    child.on("exit", (code) => {
      this.exited = true
      this.exitCode = code
      for (const [, pending] of this.pending) {
        pending.resolve({ id: "", ok: false, error: "sidecar exited" })
      }
      this.pending.clear()
      if (!this.readySettled) {
        // ready promise not yet settled; reject it so callers see the failure
        this.rejectReady(
          new Error(`agentmesh sidecar exited before becoming ready (code ${code})`),
        )
      }
    })
  }

  /** True once the child process has exited (crash or clean shutdown). */
  isDead(): boolean {
    return this.exited
  }

  /** Exit code if the process already exited; null while running. */
  lastExitCode(): number | null {
    return this.exitCode
  }

  /**
   * Hard-kill the child process (crash simulation). Marks the client dead
   * without the graceful stdin shutdown — used by tests and by anyone
   * debugging sidecar restart behavior. Cross-platform: process.kill(pid)
   * works on Windows (terminate).
   */
  kill(): void {
    const child = this.child
    if (!child || this.exited) return
    this.exited = true
    try {
      child.kill("SIGKILL")
    } catch {
      // already gone
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (typeof parsed !== "object" || parsed === null) return
    const v = parsed as Record<string, unknown>

    if (v.ev === "ready") {
      this.readySettled = true
      this.resolveReady({
        room: String(v.room ?? ""),
        name: String(v.name ?? ""),
        topicHex: String(v.topicHex ?? ""),
        publicKeyHex: String(v.publicKeyHex ?? ""),
      })
      return
    }
    if (v.ev === "chat") {
      const msg = v.msg
      if (typeof msg === "object" && msg !== null) {
        this.opts.onChat(msg as ChatMessage)
      }
      return
    }
    if (v.ev === "peers") {
      if (Array.isArray(v.peers)) this.opts.onPeers(v.peers as PeerInfo[])
      return
    }
    if (v.ev === "log") {
      this.opts.onLog?.(String(v.message ?? ""), v.extra as Record<string, unknown>)
      return
    }
    if (typeof v.id === "string") {
      if (v.id.length === 0) return
      const pending = this.pending.get(v.id)
      if (pending) {
        this.pending.delete(v.id)
        pending.resolve(v as IpcResponse)
      }
    }
  }

  private call(cmd: "send", text: string): Promise<IpcResponse>
  private call(cmd: "history", limit?: number, afterId?: string): Promise<IpcResponse>
  private call(cmd: "peers"): Promise<IpcResponse>
  private call(cmd: "whoami"): Promise<IpcResponse>
  private call(cmd: "allow", keys: string | string[]): Promise<IpcResponse>
  private call(cmd: string, arg?: unknown, afterId?: string): Promise<IpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.exited) {
        reject(new Error("agentmesh sidecar is not running"))
        return
      }
      const id = crypto.randomUUID()
      this.pending.set(id, { resolve })
      const body: Record<string, unknown> = { id, cmd }
      if (cmd === "send") body.text = arg as string
      if (cmd === "allow") body.keys = arg as string | string[]
      if (cmd === "history" && typeof arg === "number") body.limit = arg
      if (cmd === "history" && typeof afterId === "string" && afterId.length > 0) {
        body.afterId = afterId
      }
      this.child.stdin.write(JSON.stringify(body) + "\n", (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private fail(error: string): Error {
    const tail = this.stderrTailText.trim()
    return new Error(tail ? `${error} (sidecar stderr: ${tail.slice(-300)})` : error)
  }

  async send(text: string): Promise<number> {
    const res = await this.call("send", text)
    if (!res.ok) throw this.fail(res.error)
    return (res.result as { reached: number }).reached
  }

  async history(limit?: number, afterId?: string): Promise<{ messages: ChatMessage[]; connections: number }> {
    const res = await this.call("history", limit, afterId)
    if (!res.ok) throw this.fail(res.error)
    return res.result as { messages: ChatMessage[]; connections: number }
  }

  async peers(): Promise<{ peers: PeerInfo[]; connections: number }> {
    const res = await this.call("peers")
    if (!res.ok) throw this.fail(res.error)
    return res.result as { peers: PeerInfo[]; connections: number }
  }

  async whoami(): Promise<{ id: string; name: string; room: string; publicKeyHex: string; allowCount: number }> {
    const res = await this.call("whoami")
    if (!res.ok) throw this.fail(res.error)
    return res.result as { id: string; name: string; room: string; publicKeyHex: string; allowCount: number }
  }

  /** Live-apply a new allowlist; kicks connections no longer allowed. */
  async allow(keys: string | string[]): Promise<{ active: number; kicked: number }> {
    const res = await this.call("allow", keys)
    if (!res.ok) throw this.fail(res.error)
    return res.result as { active: number; kicked: number }
  }

  /** Tail of captured sidecar stderr — attached to error messages so
   *  OpenCodex/pi (which have no log channel) still surface spawn issues. */
  stderrTail(): string {
    return this.stderrTailText
  }

  async destroy(): Promise<void> {
    const child = this.child
    if (!child || this.exited) return
    this.exited = true
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, 3000)
      child.on("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin.end()
    })
  }
}
