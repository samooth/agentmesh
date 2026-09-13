# Development

## Setup

Requirements: [Bun](https://bun.sh) for tests/typecheck, Node >= 23.6 on
`PATH` (the swarm sidecar runs under Node — see
[architecture](/docs/architecture.md)).

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # full suite; integration tests need outbound UDP
```

## Test suites

Offline (run anywhere):

| Suite | Covers |
|---|---|
| `test/protocol.test.ts` | wire validation, topic derivation, sanitization, Ed25519 signing/tampering |
| `test/store.test.ts` | ring buffer, dedupe, cursor, peers |
| `test/keys.test.ts` | pubkey normalization for allowlists |
| `test/policy.test.ts` | disabled-unless-configured room policy |
| `test/ratelimit.test.ts` | token bucket, bans, refill |
| `test/client.test.ts` | Node >= 23.6 spawn precheck |
| `test/entry.test.ts` | opencode/Kilo entry shapes |
| `test/codex.test.ts` | OpenCodex definitions/handlers |
| `test/persistence.test.ts` | history cursor, JSONL replay, live allowlist file |
| `test/multiroom.test.ts` | room routing, lazy spawn, compaction context |
| `test/resilience.test.ts` | sidecar crash + auto-respawn |

Real network (outbound UDP/DHT):

| Suite | Covers |
|---|---|
| `test/sidecar.test.ts` | three sidecars: discovery, chat, late-joiner sync |
| `test/allowlist.test.ts` | mutually whitelisted pair connects; rogue rejected both directions |
| `test/pi.test.ts` | pi factory e2e with a real sidecar |

## CI

`.github/workflows/ci.yml` runs three jobs on every push/PR:

1. **unit** — typecheck + offline suites (ubuntu)
2. **integration** — DHT suites with a 2-attempt retry matrix (first
   announce can race), ubuntu
3. **windows** — experimental, `continue-on-error`; offline suites plus a
   sidecar spawn smoke test

## Debugging the sidecar

Run it standalone to test swarm behavior without a host:

```sh
node src/sidecar.ts --topic <64-hex> --id me --name me --room myroom \
  [--seed <64-hex>] [--allow <keys>] [--allow-file <file>] [--persist <file>]
```

Or use the [debug CLI](/docs/usage.md#debug-cli) for a full REPL. On
opencode/Kilo, sidecar diagnostics (including stderr) go to the host log
under `service: agentmesh`; on OpenCodex/pi error messages carry a stderr
tail.

## Building the OpenCodex bundle

`scripts/install-codex.mjs` transpiles `src/codex.ts` + `src/sidecar.ts`
to plain `.js` (Node >= 22 compatible) with the repo's `typescript`, links
or copies the sidecar runtime deps, and writes the four plugin stubs:

```sh
bun install                       # tsc must be present
node scripts/install-codex.mjs    # --plugins-dir / --entry to override
```

## Publishing checklist

1. `bun run typecheck && bun test` — all green
2. `npm publish --dry-run` — review the file list (the `files` whitelist
   ships `src/`, `scripts/`, `docs/`, and the legal files only)
3. Bump `package.json` version, commit, tag (`git tag -a vX.Y.Z`)
4. Push commits + tag; verify CI passes on GitHub
5. `npm publish`
6. Post-publish smoke: `npm i -g agentmesh@latest` in a temp dir,
   `agentmesh-debug --room … --secret …` joins, send/whoami work
