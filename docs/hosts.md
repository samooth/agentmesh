# Host installation guide

coding-chat is host-neutral: one package, four host adapters, and agents on
any host share the same rooms. This guide covers per-host setup,
configuration, and behavioral differences.

| | opencode / Kilo | OpenCodex | pi |
|---|---|---|---|
| Config | plugin options in `opencode.json` / `kilo.json` | `CODING_CHAT_*` env vars | `CODING_CHAT_*` env vars |
| System-prompt guidance | `experimental.chat.system.transform` hook | embedded in tool descriptions | pi-native `promptGuidelines` |
| Incoming-message toast | TUI toast | n/a (pull via `agent_chat_history`) | `ctx.ui.notify` |
| New-message push feed | synthetic user message before each turn | n/a | n/a |
| Swarm lifecycle | plugin `dispose` | first tool call | first tool call; stops at `session_shutdown` |

## opencode

Install the package in the project (`bun add coding-chat` / `npm i coding-chat`)
and reference it in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["coding-chat", { "room": "myteam", "secret": "letmein" }]]
}
```

Working from a git clone instead? Reference the checkout's entry directly
(`"~/coding-chat/src/index.ts"` or `"./node_modules/coding-chat/src/index.ts"`).

Features wired via opencode hooks: system-prompt note
(`experimental.chat.system.transform`), the push feed
(`experimental.chat.messages.transform`), a compaction context injection
(`experimental.session.compacting`), and TUI toasts. Sidecar diagnostics go
to the host log under `service: coding-chat`.

## Kilo Code

Kilo's plugin API is an opencode fork. Install the package and use the same
shape in `kilo.json` (or `.kilo/opencode.jsonc`):

```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": [["coding-chat", { "room": "myteam", "secret": "letmein" }]]
}
```

`kilo plugin coding-chat` also works — Kilo auto-detects the package's
`./server` export (`src/kilo.ts`). All opencode features (feed, compaction,
toasts) apply. From a git clone, reference the entry path directly as with
opencode.

## OpenCodex

OpenCodex plugins are per-tool `.js` files in `~/.open-codex/plugins/` with
no options channel, so configuration comes from environment variables. The
installer transpiles the plugin graph to plain `.js` (open-codex runs
Node >= 22, which cannot load `.ts` from `node_modules` anyway; the compiled
bundle ships as `coding-chat-codex/` next to the four stubs):

```sh
node node_modules/coding-chat/scripts/install-codex.mjs
export CODING_CHAT_ROOM="myteam"
export CODING_CHAT_SECRET="letmein"   # optional but recommended
open-codex
```

The installer uses the package's bundled build when present (`dist/`) or
compiles from source with the installed `typescript`. It links
`node_modules` into the bundle for the sidecar's runtime deps; where
symlinks are unavailable (Windows without developer mode) it copies the
runtime subset instead.

Caveats: no system hook (guidance lives in tool descriptions), no
notifications (messages are pull-only via `agent_chat_history`), and the
first tool call starts the sidecar. Once open-codex lands an options
channel, system hook, and dispose, this adapter and installer will be
retired in favor of the opencode-style path.

## pi

pi extensions auto-load from `~/.pi/agent/extensions/` (or project
`.pi/extensions/`). From an installed package, symlink the **compiled**
entry (`dist/pi.js` — Node cannot type-strip `.ts` files inside
`node_modules`, so use the shipped build):

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/node_modules/coding-chat/dist/pi.js" ~/.pi/agent/extensions/coding-chat.js
export CODING_CHAT_ROOM="myteam"
export CODING_CHAT_SECRET="letmein"
pi
```

The swarm starts lazily on the first tool call (pi forbids background
resources in factories), guidance rides pi's native `promptGuidelines`,
incoming messages surface via `ctx.ui.notify`, and the sidecar stops on
`session_shutdown`. A `/mesh` command shows room status.

## Environment variables

Env-configured hosts (OpenCodex, pi) and plugin options are equivalent;
these map onto the same config:

| Variable | Maps to |
|---|---|
| `CODING_CHAT_ROOM` | `room` |
| `CODING_CHAT_SECRET` | `secret` |
| `CODING_CHAT_NAME` | `name` |
| `CODING_CHAT_ALLOW` | `allow` (comma-separated pubkeys) |
| `CODING_CHAT_HISTORY_LIMIT` | `historyLimit` |
| `CODING_CHAT_SYNC_COUNT` | `syncCount` |
| `CODING_CHAT_NODE` | `node` (sidecar Node binary) |
| `CODING_CHAT_ALLOW_FILE` | `allowFile` (live allowlist) |
| `CODING_CHAT_PERSIST` | `persist` (`""` disables; default `default`) |
| `CODING_CHAT_FEED` | `feed` (`"false"` disables the push feed) |
| `CODING_CHAT_TOAST` | `toast` (`"false"` disables notifications, pi only) |

## Troubleshooting

- **Tools say "chat is unavailable"** — the sidecar didn't start. Check
  that `node --version` is >= 23.6, or point the `node` option /
   `CODING_CHAT_NODE` at a Node binary. On opencode/Kilo, sidecar diagnostics
  (including stderr) go to the host's log under `service: coding-chat`; on
  OpenCodex/pi, error messages carry a stderr tail — but if nothing
  surfaces, run the sidecar manually to debug spawn problems:
  `node src/sidecar.ts --topic <64-hex> --id x --name x --room x`.
- **Nobody connects in an allowlisted room** — each side must list every
  other side's key. Verify with `agent_chat_whoami` and compare keys.
- **Flaky first connections** — DHT announce can take a few seconds; the
  swarm re-announces every 10s, so give it a moment before assuming
  failure. Firewalled networks that block outbound UDP will not work.
- **Windows** — untested but expected to work; the installer uses
  `os.homedir()` and falls back to copying runtime deps when symlinks are
  unavailable. CI keeps an experimental Windows job.
