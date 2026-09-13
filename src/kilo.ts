import { tool } from "@kilocode/plugin/tool"
import type { Plugin, PluginInput, Hooks } from "@kilocode/plugin"
import { startChat } from "./plugin-core.ts"

/**
 * Kilo Code entry. Kilo's canonical plugin module shape is a descriptor
 * with an `id` and a `server` plugin function; the package exposes this
 * via exports["./server"] so `kilo plugin agentmesh` detects it.
 */
const server: Plugin = async (input: PluginInput, options) => {
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

export default { id: "agentmesh", server }
