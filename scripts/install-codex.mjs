#!/usr/bin/env node
/**
 * coding-chat installer for OpenCodex.
 *
 * OpenCodex loads plugins as plain .js files from ~/.open-codex/plugins/,
 * one tool per file, default-exporting { definition, handler }. There is no
 * package manager or config channel for plugins there, so this installer
 * generates four tiny stub files that re-export from a compiled coding-chat
 * bundle.
 *
 * Why compiled: the stubs and everything they import must load under Node
 * >= 22 (the engines range open-codex declares), and Node 22 cannot import
 * .ts modules at all. So the installer transpiles the TypeScript entry
 * graph (src/codex.ts + imports, except type-only modules) to plain .js
 * under <plugins-dir>/coding-chat-codex/ first. The compiled bundle loads on
 * Node >= 22; the swarm sidecar process itself still requires Node >= 23.6
 * (checked at spawn with an actionable error).
 *
 * Usage:
 *   node scripts/install-codex.mjs [--plugins-dir <dir>] [--entry <file>]
 *
 * --plugins-dir  target directory (default: ~/.open-codex/plugins)
 * --entry        absolute path to coding-chat's codex entry (src/codex.ts).
 *                Default: resolved relative to this repo checkout.
 */

import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { homedir, tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")
const require = createRequire(import.meta.url)

function argValue(name, fallback) {
  const argv = process.argv
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === name) return argv[i + 1]
  }
  return fallback
}

// homedir() works on Windows too (env HOME is unix-flavored)
const pluginsDir = argValue("--plugins-dir", join(homedir(), ".open-codex", "plugins"))
const entry = argValue("--entry", resolve(repoRoot, "src", "codex.ts"))

// ---------------------------------------------------------------------------
// 1. Locate a tsc binary: the checkout's own devDependency first.
// ---------------------------------------------------------------------------

async function findTsc() {
  const local = join(repoRoot, "node_modules", "typescript", "bin", "tsc")
  try {
    await stat(local)
    return [process.execPath, local]
  } catch {
    try {
      return [process.execPath, require.resolve("typescript/bin/tsc")]
    } catch {
      const npx = spawnSync("npx", ["--yes", "typescript@latest", "--bin", "tsc"], { stdio: "ignore" })
      if (npx.status !== 0) {
        throw new Error("coding-chat installer: typescript not found. Run `bun install` in the coding-chat checkout first.")
      }
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Transpile the entry graph to plain .js in a temp dir.
// ---------------------------------------------------------------------------

async function compileEntry() {
  const tsc = await findTsc()
  if (!tsc) throw new Error("coding-chat installer: could not locate tsc")
  const outDir = await mkdtemp(join(tmpdir(), "coding-chat-codex-"))
  const result = spawnSync(
    tsc[0],
    [
      tsc[1],
      "--target", "ES2022",
      "--module", "ES2022",
      "--moduleResolution", "node",
      "--lib", "ES2022",
      "--skipLibCheck",
      // strict: the source relies on discriminated-union narrowing for
      // `res.ok` checks; without strictNullChecks tsc flags them as errors
      "--strict",
      // sources import with .ts extensions; let tsc rewrite them to .js
      "--allowImportingTsExtensions",
      "--rewriteRelativeImportExtensions",
      // outDir root: compile the sidecar entry too so the runtime deps
      // (hyperswarm, hypercore-crypto) end up resolvable from the bundle;
      // the ambient type stubs keep --strict happy about the sidecar graph
      resolve(repoRoot, "src/codex.ts"),
      resolve(repoRoot, "src/sidecar.ts"),
      resolve(repoRoot, "src/types/hypercore-crypto.d.ts"),
      resolve(repoRoot, "src/types/hyperswarm.d.ts"),
      "--outDir", outDir,
    ],
    { stdio: ["ignore", "pipe", "inherit"], cwd: repoRoot },
  )
  if (result.status !== 0) {
    await rm(outDir, { recursive: true, force: true }).catch(() => {})
    throw new Error("coding-chat installer: tsc failed to compile the coding-chat entry graph")
  }
  return outDir
}

// ---------------------------------------------------------------------------
// 3. Install the compiled bundle + four stubs.
// ---------------------------------------------------------------------------

const tmpOut = await compileEntry()

const bundleDir = join(pluginsDir, "coding-chat-codex")
await rm(bundleDir, { recursive: true, force: true }).catch(() => {})
await mkdir(pluginsDir, { recursive: true })
await cp(tmpOut, bundleDir, { recursive: true })
await rm(tmpOut, { recursive: true, force: true }).catch(() => {})

const STUBS = [
  ["coding-chat-send.js", "send"],
  ["coding-chat-history.js", "history"],
  ["coding-chat-peers.js", "peers"],
  ["coding-chat-whoami.js", "whoami"],
]

const TEMPLATE = (tool) => `/**
 * coding-chat (https://github.com/samooth/coding-chat) — OpenCodex plugin stub.
 * Generated by scripts/install-codex.mjs; safe to delete and regenerate.
 * Configure via CODING_CHAT_ROOM / CODING_CHAT_SECRET / CODING_CHAT_ALLOW env vars.
 */
import { buildDefinitions, handlers } from "./coding-chat-codex/codex.js"

export default {
  definition: buildDefinitions().${tool},
  handler: handlers.${tool},
}
`

for (const [file, tool] of STUBS) {
  await writeFile(join(pluginsDir, file), TEMPLATE(tool), "utf8")
  console.log(`wrote ${join(pluginsDir, file)}`)
}
// The compiled bundle spawns `node .../coding-chat-codex/sidecar.js`, which
// resolves hyperswarm/hypercore-crypto via node_modules lookup. Link the
// checkout's node_modules into the bundle dir so the sidecar can run
// without a separate install step. Symlinks may be unavailable (Windows
// without developer mode); fall back to copying the runtime deps.
const nmDir = join(bundleDir, "node_modules")
try {
  await stat(nmDir)
} catch {
  let linked = false
  try {
    await symlink(join(repoRoot, "node_modules"), nmDir, "dir")
    linked = true
    console.log(`linked ${join(repoRoot, "node_modules")} for the sidecar runtime`)
  } catch {
    // fall back to copying just the runtime deps of the sidecar graph
    try {
      await cp(join(repoRoot, "node_modules"), nmDir, {
        recursive: true,
        verbatimSymlinks: true,
        dereference: true,
        filter: (src) => {
          const rel = relative(join(repoRoot, "node_modules"), src)
          const top = rel.split(sep)[0] ?? ""
          return (
            rel === "" ||
            top === "hyperswarm" ||
            top === "hypercore-crypto" ||
            top === "udx-native" ||
            top === "sodium-native" ||
            top === "b4a" ||
            top === "compact-encoding" ||
            top === "dht-rpc" ||
            top === "hyperswarm-utils" ||
            top === "noise-curve-ed" ||
            top === "protocol-noise" ||
            top === "bare"
          )
        },
      })
      console.log("copied sidecar runtime deps (symlink unavailable)")
    } catch {
      console.warn(
        "warning: could not link or copy node_modules; the sidecar may fail to resolve hyperswarm",
      )
    }
  }
  if (!linked) {
    // nothing extra; messages already printed
  }
}
console.log(`wrote ${bundleDir}/ (compiled bundle, loads under Node >= 22)`)
console.log(`\ncoding-chat tools installed for OpenCodex.`)
console.log(`Set CODING_CHAT_ROOM (and CODING_CHAT_SECRET for non-public rooms) before starting open-codex.`)
console.log(`Note: the swarm sidecar still requires Node >= 23.6 on PATH (or CODING_CHAT_NODE).`)
