import { tool } from "@opencode-ai/plugin"
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { startChat, type PluginOptions } from "./plugin-core.ts"

export type { PluginOptions }

/**
 * opencode entry. opencode plugin modules export a plugin function
 * (default or named) returning a Hooks object.
 */
export const ChatPlugin: Plugin = async (input: PluginInput, options) => {
  const core = await startChat(input, options, {
    tool,
    log: async (message, extra) => {
      try {
        await input.client.app.log({
          body: { service: "agentmesh", level: "info", message, extra: extra ?? {} },
        })
      } catch {
        // logging is best-effort
      }
    },
    toast: async (title, message) => {
      try {
        await input.client.tui.showToast({
          body: { title, message, variant: "info" },
        })
      } catch {
        // best-effort
      }
    },
  })

  const hooks: Hooks = {
    tool: core.tool,
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        await core.systemTransform((text) => output.system.push(text))
      } catch {
        // best-effort
      }
    },
    dispose: core.dispose,
  }
  return hooks
}

export default ChatPlugin
