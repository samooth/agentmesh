import { tool } from "@kilocode/plugin/tool"
import type { Plugin, PluginInput, Hooks } from "@kilocode/plugin"
import { startChat } from "./plugin-core.ts"

/**
 * Kilo Code entry. Kilo's canonical plugin module shape is a descriptor
 * with an `id` and a `server` plugin function; the package exposes this
 * via exports["./server"] so `kilo plugin coding-chat` detects it.
 */
const server: Plugin = async (input: PluginInput, options) => {
  const core = await startChat(input, options, {
    tool,
    log: async (message, extra) => {
      try {
        await input.client.app.log({
          body: { service: "coding-chat", level: "info", message, extra: extra ?? {} },
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
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const feed = await core.pendingFeed()
        if (feed === null) return
        output.messages.unshift({
          info: {
            id: `coding-chat-feed-${crypto.randomUUID()}`,
            sessionID: "",
            role: "user",
            time: { created: Date.now() },
            agent: "",
            model: { providerID: "", modelID: "" },
          },
          parts: [
            {
              id: `coding-chat-feed-${crypto.randomUUID()}`,
              sessionID: "",
              messageID: "",
              type: "text",
              text: feed,
            },
          ],
        } as never)
      } catch {
        // best-effort
      }
    },
    "experimental.session.compacting": async (_input, output) => {
      try {
        output.context.push(...(await core.compactionContext()))
      } catch {
        // best-effort
      }
    },
    dispose: core.dispose,
  }
  return hooks
}

export default { id: "coding-chat", server }
