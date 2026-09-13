import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import type { ChatMessage } from "./protocol.ts"
import type { PeerInfo } from "./store.ts"
import type { IpcEvent, IpcResponse } from "./ipc.ts"

/**
 * Runs inside opencode's Bun process. Spawns the Node sidecar that owns the
 * Hyperswarm instance and proxies chat calls over NDJSON stdio.
 */

export type SidecarClientOptions = {
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
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private exited = false
  private readySettled = false
  readonly ready: Promise<{ room: string; name: string; topicHex: string; publicKeyHex: string }>
  private resolveReady!: (value: { room: string; name: string; topicHex: string; publicKeyHex: string }) => void
  private rejectReady!: (err: Error) => void

  constructor(private readonly opts: SidecarClientOptions) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    const timeout = opts.spawnTimeoutMs ?? 15_000
    const timer = setTimeout(() => {
      this.rejectReady(new Error(`opencode-chat sidecar not ready after ${timeout}ms`))
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

    const rl = createInterface({ input: child.stdout })
    rl.on("line", (line: string) => {
      if (line.length === 0) return
      this.handleLine(line)
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      this.opts.onLog?.("sidecar stderr", { tail: chunk.slice(-500) })
    })

    child.on("exit", (code) => {
      this.exited = true
      for (const [, pending] of this.pending) {
        pending.resolve({ id: "", ok: false, error: "sidecar exited" })
      }
      this.pending.clear()
      if (!this.readySettled) {
        // ready promise not yet settled; reject it so callers see the failure
        this.rejectReady(
          new Error(`opencode-chat sidecar exited before becoming ready (code ${code})`),
        )
      }
    })
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
  private call(cmd: "history", limit?: number): Promise<IpcResponse>
  private call(cmd: "peers"): Promise<IpcResponse>
  private call(cmd: "whoami"): Promise<IpcResponse>
  private call(cmd: string, arg?: unknown): Promise<IpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.exited) {
        reject(new Error("opencode-chat sidecar is not running"))
        return
      }
      const id = crypto.randomUUID()
      this.pending.set(id, { resolve })
      const body: Record<string, unknown> = { id, cmd }
      if (cmd === "send") body.text = arg as string
      if (cmd === "history" && typeof arg === "number") body.limit = arg
      this.child.stdin.write(JSON.stringify(body) + "\n", (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  async send(text: string): Promise<number> {
    const res = await this.call("send", text)
    if (!res.ok) throw new Error(res.error)
    return (res.result as { reached: number }).reached
  }

  async history(limit?: number): Promise<{ messages: ChatMessage[]; connections: number }> {
    const res = await this.call("history", limit)
    if (!res.ok) throw new Error(res.error)
    return res.result as { messages: ChatMessage[]; connections: number }
  }

  async peers(): Promise<{ peers: PeerInfo[]; connections: number }> {
    const res = await this.call("peers")
    if (!res.ok) throw new Error(res.error)
    return res.result as { peers: PeerInfo[]; connections: number }
  }

  async whoami(): Promise<{ id: string; name: string; room: string; publicKeyHex: string; allowCount: number }> {
    const res = await this.call("whoami")
    if (!res.ok) throw new Error(res.error)
    return res.result as { id: string; name: string; room: string; publicKeyHex: string; allowCount: number }
  }

  async destroy(): Promise<void> {
    const child = this.child
    if (!child || this.exited) return
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
