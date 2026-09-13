/**
 * Ambient type declarations for the pi coding agent extension API
 * (https://pi.dev/docs/latest/extensions), limited to the surface agentmesh
 * uses. The real package is @earendil-works/pi-coding-agent; these
 * declarations let the repo typecheck without installing it, and the pi
 * entry imports only documented, stable API.
 */

declare module "@earendil-works/pi-coding-agent" {
  export type TSchema = {
    [key: string]: unknown
  }
  export type Static<T> = T extends { static: infer S } ? S : Record<string, unknown>
  export type Theme = unknown
  export type Component = unknown

  export type ExtensionUIDialogContext = {
    notify(message: string, type?: "info" | "warning" | "error"): void
  }

  export type ExtensionContext = {
    mode: "tui" | "rpc" | "json" | "print"
    hasUI: boolean
    cwd: string
    ui: {
      notify(message: string, type?: "info" | "warning" | "error"): void
    }
    signal: AbortSignal | undefined
  }

  export type AgentToolResult<TDetails = unknown> = {
    content: Array<{ type: "text"; text: string }>
    details: TDetails
  }

  export type ToolDefinition<TParams extends Record<string, unknown> = Record<string, unknown>, TDetails = unknown> = {
    name: string
    label: string
    description: string
    promptSnippet?: string
    promptGuidelines?: string[]
    parameters: TParams
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: ((result: AgentToolResult<TDetails>) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TDetails>>
  }

  export type SessionStartEvent = {
    type: "session_start"
    reason: "startup" | "reload" | "new" | "resume" | "fork"
    previousSessionFile?: string
  }
  export type SessionShutdownEvent = {
    type: "session_shutdown"
    reason: "quit" | "reload" | "new" | "resume" | "fork"
  }

  export type ExtensionAPI = {
    on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>): void
    on(event: "session_shutdown", handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => void | Promise<void>): void
    registerTool(tool: ToolDefinition): void
    registerCommand(
      name: string,
      options: {
        description: string
        handler(args: string, ctx: ExtensionContext): void | Promise<void>
      },
    ): void
  }

  export const CONFIG_DIR_NAME: string
}

declare module "typebox" {
  export type TSchema = Record<string, unknown>
  export type Static<T extends TSchema> = T extends { static: infer S } ? S : never
  export const Type: {
    Object(properties: Record<string, TSchema>, options?: Record<string, unknown>): TSchema & { static: unknown }
    String(options?: { description?: string }): TSchema
    Optional<T extends TSchema>(schema: T): TSchema
    Integer(options?: { minimum?: number; maximum?: number; description?: string }): TSchema
  }
}
