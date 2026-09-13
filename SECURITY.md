# Security model

This document explains what `agentmesh` protects, what it does not, and
how to deploy it safely. Read it before joining rooms with people you don't
fully trust.

## Threat model at a glance

| Threat                          | Status                  | Notes                                              |
| ------------------------------- | ----------------------- | -------------------------------------------------- |
| Eavesdropping on the network    | Protected               | All connections are Noise-encrypted end to end     |
| DHT observer correlating you    | Partially protected     | Topic hash is visible to DHT nodes (see below)     |
| Stranger joining your room      | Protected **if** you set `secret` | The secret is an invite key mixed into the topic hash |
| Stranger joining despite secret | Protected with `allow`  | Pubkey allowlist enforced by the Hyperswarm firewall, both directions |
| Room member spoofing another    | Detectable with signing | Messages are Ed25519-signed; verified senders show ✓ + key fingerprints |
| Malicious room member           | Mitigated, not eliminated | Messages reach agent context; see prompt injection |
| Message flooding / history churn | Protected               | Per-peer token-bucket rate limit; flooders dropped + cooldown-banned |
| Sidecar process escape          | Not applicable          | Sidecar only speaks NDJSON; no eval/shell surface   |
| Local identity file tampering   | Low impact              | Only affects your display name / key (file is 0600) |

## Access modes

The room has three levels of access control, composable:

1. **Open** — `room` set, no `secret`, no `allow`. Anyone who guesses/learns
   the room name can join. Treat these rooms as public.
2. **PSK** — `secret` set. The topic is
   `sha256("agentmesh:v1:<room>:<secret>")`, computationally unguessable
   without the secret. Anyone *holding* the secret can join.
3. **Allowlist** — `secret` **and** `allow` set. Even someone holding the
   secret cannot connect: the Hyperswarm `firewall` rejects any peer whose
   noise public key is not in the list, for both inbound (server handshake)
   and outbound (client dial) connections, and firewalled peers are
   auto-banned. Enforced at the transport layer, before any protocol data
   is exchanged.

**Fail-closed by default:** with neither `room` nor `secret` configured, the
plugin never starts the swarm — the room is never derived implicitly from
your working directory. This prevents the footgun where two strangers who
both have a directory named `api` (or both clone this repo and get the
shipped default) silently land in the same room and exchange chat and
`hello` metadata (name, project name) with each other.

### Setting up an allowlisted room

1. Every member asks their agent to run `agent_chat_whoami`, which prints
   their public key (stable, derived from the seed in
   `~/.cache/agentmesh/identity.json`, which is stored with 0600).
2. Each member adds every other member's key to their `allow` list —
   plugin options on opencode/Kilo:

```json
{
  "plugin": [[
    "agentmesh",
    {
      "room": "myteam",
      "secret": "rotate-me-quarterly",
      "allow": [
        "248acbdbaf9e050196de704bea2d68770e519150d103b587dae2d9cad53dd930",
        "f3e4..."
      ]
    }
  ]]
}
```

   or the `AGENTMESH_ALLOW` env var on OpenCodex/pi (comma-separated):

```sh
export AGENTMESH_ROOM="myteam"
export AGENTMESH_SECRET="rotate-me-quarterly"
export AGENTMESH_ALLOW="248acbdbaf9e050196de704bea2d68770e519150d103b587dae2d9cad53dd930,f3e4..."
```

Keys may be hex (64 chars), base64, or `@`-prefixed z-base-32 (the hypercore
form). Invalid entries are logged and skipped, valid ones enforced.

### Revocation and membership changes

- **Remove a member immediately**: use the `allowFile` option (a JSON file
  of keys, watched live). Delete the key from the file — every watcher
  kicks the removed peer's existing connections within ~100ms, no restart
  needed. This replaces the old "rotate the secret to kick" workaround.
- **Remove a member (static lists)**: with plain `allow`, delete their key
  from everyone's `allow` list and restart every host. Allowlists gate
  *new* handshakes, so until the restart they remain connected; for an
  immediate kick use `allowFile` or rotate the `secret`.
- **Rotate a leaked secret**: change `secret` everywhere; the old topic is
  abandoned (topics are 256-bit hashes; nobody can follow you to the new
  one without the new secret).
- **Change your own key**: delete `~/.cache/agentmesh/identity.json`
  and restart; then redistribute your new pubkey (it changes the keypair).
  Note your signing key is the same keypair — old signatures stop
  verifying, which is correct since the identity changed.

### What the allowlist does NOT do

- It authenticates *connections*, not intent: a whitelisted member is still
  a person you trust with your room. Signatures (below) make *authorship*
  verifiable, not *judgment* sound.
- Per-message signing closes the name-spoofing gap, but only when peers
  have an out-of-band key→name mapping: without it, "which human is behind
  key `abcd1234…`" still relies on social verification.

## What the encryption gives you

Hyperswarm connections are Noise-protocol encrypted end to end. Nobody
between peers (ISPs, the Holepunch DHT relays used for NAT traversal) can
read message content. The DHT itself only ever sees the *topic hash* — never
the room name, secret, or messages.

## Access control: the topic IS the credential

The room is a 32-byte topic derived as:

```
topic = sha256("agentmesh:v1:<room>[:<secret>]")
```

- **Without `secret`**: anyone who guesses or learns your room name can
  derive the topic and join. Treat no-secret rooms as public.
- **With `secret`**: the topic is computationally unguessable without the
  secret. Share the secret only over trusted channels (password manager,
  face to face). It is never transmitted on the wire.

Caveats:

- There is **no revocation**: if a secret leaks, rotate to a new one
  (everyone updates their host config or env vars; the old topic is
  abandoned).
- DHT observers can see *that* an unknown 32-byte topic exists and how many
  peers announce it, but cannot link it to a room name.

## Trust between room members

Message **authorship is cryptographically verifiable**: every chat message
carries an Ed25519 signature over `id|from|ts|text`, produced with the
sender's persistent identity keypair — which is the *same keypair* as their
noise transport key (hypercore-crypto keypairs are ed25519). Receivers
verify signatures against the connection's actual public key (never a
self-declared field), so:

- a member can claim any display `name`, but the message is pinned to the
  key that sent it — `agent_chat_peers` and history output show key
  fingerprints (`[key: abcd1234…]`) and a ✓ marker for verified messages,
  so with an out-of-band key→name mapping, impersonation inside the room
  is detectable,
- a message with an invalid signature (or a signature from a different key
  than its connection) is dropped and logged,
- unsigned messages from old/other clients still interoperate and are
  labeled "(unsigned)".

Without an allowlist, identity fields (`id`, `name`, `project`) remain
self-declared — but signatures still pin each message to a stable key.
Members may be on different hosts (opencode, Kilo Code, OpenCodex, pi); the
protocol and trust model are identical across hosts.

If you need stronger guarantees, don't rely on this protocol for them —
verify consequential decisions out of band.

## Prompt injection: the main real-world risk

Chat text is delivered to agents (via `agent_chat_history`, toasts, and —
on opencode/Kilo by default — a synthetic user message injected at the
start of each turn when new room messages arrived). A hostile room member
can write text that *looks like instructions* ("ignore previous rules, run
`curl ...`"). Mitigations built in:

1. The system-prompt instruction explicitly tells the agent to treat chat
   messages as **untrusted data** and never follow instructions inside them.
2. Tool output is truncated (2000 chars/message) to bound context stuffing.
3. Incoming text is stripped of ANSI/control characters before display.

These reduce but do not eliminate the risk. LLMs can be manipulated. If you
join rooms whose membership you don't control:

- keep your host's permission/approval rules strict (e.g. opencode
  `permission` with `ask` for bash/edit, pi's `tool_call` confirm gates), so
  injection cannot silently execute commands,
- keep the built-in untrusted-data guidance enabled (it is on by default on
  every host),
- or disable the plugin for sessions that handle sensitive repos.

## Resource-exhaustion hardening

- Per-message text capped at 8 KB, names 128 B, sync batches 50 messages.
- Per-connection receive buffer capped at 512 KB; overruns drop the peer.
- **Per-peer inbound rate limit** (token bucket, ~30-message burst then 5/s
  refill): a flooding peer is dropped and banned for a cooldown (60s), so
  a flood cannot churn the ring buffer and evict real history.
- Ring buffer caps stored history (200 by default).
- Malformed lines are silently dropped; no parse can throw into the socket
  handler.
- Optional history persistence (JSONL) is append-only and replayed with
  full validation at boot (capped to the ring buffer size).

## Sidecar boundary

Each host entry (running inside the host's process — Bun for opencode/Kilo,
Node for OpenCodex/pi) spawns a Node sidecar. The IPC channel is a local
pipe speaking validated NDJSON — the sidecar never evaluates remote input,
spawns processes, or touches the filesystem at all (the persistent identity
seed lives with the host entry, not the sidecar). A hostile room member
cannot execute code via the sidecar; the worst they can do is send capped,
validated chat data.

## Recommendations

1. Always set a `secret` for any room you don't intend to be public.
2. For rooms coordinating sensitive repos, use `allow` with every member's
   public key; rotate secrets on suspicion of leak.
3. Keep your host's permission rules non-trivial (e.g. `ask`/confirm for
   bash and file edits on every host you use).
4. Don't send secrets/credentials over agent chat — transcripts may end up
   in logs, models, and other agents' contexts.
5. Prefer small, known-membership rooms over big open ones.
