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
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const feed = await core.pendingFeed()
        if (feed === null) return
        // Prepend a synthetic user part carrying the new room messages so
        // the model sees them at the start of this turn without polling.
        output.messages.unshift({
          info: {
            id: `agentmesh-feed-${crypto.randomUUID()}`,
            sessionID: "",
            role: "user",
            time: { created: Date.now() },
            agent: "",
            model: { providerID: "", modelID: "" },
          },
          parts: [
            {
              id: `agentmesh-feed-${crypto.randomUUID()}`,
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

export default ChatPlugin
