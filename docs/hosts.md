# Host installation guide

agentmesh is host-neutral: one package, four host adapters, and agents on
any host share the same rooms. This guide covers per-host setup,
configuration, and behavioral differences.

| | opencode / Kilo | OpenCodex | pi |
|---|---|---|---|
| Config | plugin options in `opencode.json` / `kilo.json` | `AGENTMESH_*` env vars | `AGENTMESH_*` env vars |
| System-prompt guidance | `experimental.chat.system.transform` hook | embedded in tool descriptions | pi-native `promptGuidelines` |
| Incoming-message toast | TUI toast | n/a (pull via `agent_chat_history`) | `ctx.ui.notify` |
| New-message push feed | synthetic user message before each turn | n/a | n/a |
| Swarm lifecycle | plugin `dispose` | first tool call | first tool call; stops at `session_shutdown` |

## opencode

Add the plugin to any project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["agentmesh", { "room": "myteam", "secret": "letmein" }]]
}
```

Or, from a local clone, reference the entry directly:

```json
{
  "plugin": [["./node_modules/agentmesh/src/index.ts", { "room": "myteam" }]]
}
```

Features wired via opencode hooks: system-prompt note
(`experimental.chat.system.transform`), the push feed
(`experimental.chat.messages.transform`), a compaction context injection
(`experimental.session.compacting`), and TUI toasts. Sidecar diagnostics go
to the host log under `service: agentmesh`.

## Kilo Code

Kilo's plugin API is an opencode fork. In `kilo.json` (or
`.kilo/opencode.jsonc`):

```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": [["agentmesh", { "room": "myteam", "secret": "letmein" }]]
}
```

Or install the checkout with `kilo plugin agentmesh` — the package's
`./server` export (`src/kilo.ts`) is auto-detected — then add options. All
opencode features (feed, compaction, toasts) apply.

## OpenCodex

OpenCodex plugins are per-tool `.js` files in `~/.open-codex/plugins/` with
no options channel, so configuration comes from environment variables. The
installer transpiles the plugin graph to plain `.js` first (open-codex
targets Node >= 22, which cannot load `.ts` modules; the compiled bundle
ships as `agentmesh-codex/` next to the four stubs):

```sh
node scripts/install-codex.mjs
export AGENTMESH_ROOM="myteam"
export AGENTMESH_SECRET="letmein"   # optional but recommended
open-codex
```

The installer needs the repo's devDependencies (`bun install` in the
checkout). It symlinks `node_modules` into the bundle for the sidecar's
runtime deps; where symlinks are unavailable (Windows without developer
mode) it copies the runtime subset instead.

Caveats: no system hook (guidance lives in tool descriptions), no
notifications (messages are pull-only via `agent_chat_history`), and the
first tool call starts the sidecar. Once open-codex lands an options
channel, system hook, and dispose, this adapter and installer will be
retired in favor of the opencode-style path.

## pi

pi extensions auto-load from `~/.pi/agent/extensions/` (or project
`.pi/extensions/`). From a checkout, symlink or copy the entry (plus `src/`,
since the entry imports from it):

```sh
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/agentmesh/src/pi.ts ~/.pi/agent/extensions/agentmesh.ts
export AGENTMESH_ROOM="myteam"
export AGENTMESH_SECRET="letmein"
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
| `AGENTMESH_ROOM` | `room` |
| `AGENTMESH_SECRET` | `secret` |
| `AGENTMESH_NAME` | `name` |
| `AGENTMESH_ALLOW` | `allow` (comma-separated pubkeys) |
| `AGENTMESH_HISTORY_LIMIT` | `historyLimit` |
| `AGENTMESH_SYNC_COUNT` | `syncCount` |
| `AGENTMESH_NODE` | `node` (sidecar Node binary) |
| `AGENTMESH_ALLOW_FILE` | `allowFile` (live allowlist) |
| `AGENTMESH_PERSIST` | `persist` (`""` disables; default `default`) |
| `AGENTMESH_FEED` | `feed` (`"false"` disables the push feed) |
| `AGENTMESH_TOAST` | `toast` (`"false"` disables notifications, pi only) |

## Troubleshooting

- **Tools say "chat is unavailable"** — the sidecar didn't start. Check
  that `node --version` is >= 23.6, or point the `node` option /
  `AGENTMESH_NODE` at a Node binary. On opencode/Kilo, sidecar diagnostics
  (including stderr) go to the host's log under `service: agentmesh`; on
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
