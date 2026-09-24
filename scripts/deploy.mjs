#!/usr/bin/env node
// Deploy the eve-sde MCP server to its own install directory, separate from
// the development checkout: ~/.eve-sde/server (override with
// EVE_SDE_INSTALL_DIR).
//
// WHY SEPARATE: the server used to run straight from this repo via
// bootstrap.mjs. That meant one shared node_modules between a long-running
// server and active development — and worse, the MCP client launched it
// under /opt/homebrew/bin/node while development ran under fnm. The
// launcher's silent "npm rebuild on ABI mismatch" then flipped the
// better-sqlite3 binary between runtimes on every relaunch, racing the dev
// shell's own rebuilds until a torn binary left macOS killing every loader
// (Code Signature Invalid). Keeping the server in its own directory — with
// its own node_modules built once, for the runtime that actually runs it —
// makes that entire class of failure impossible.
//
// What this does:
//   1. builds dist/ (tsc)
//   2. checks the invoking runtime matches .node-version (the server runs
//      the pinned version; deploy refuses to build for a different one)
//   3. wipes ~/.eve-sde/server/{dist,node_modules} and copies dist/,
//      package.json, package-lock.json, .node-version
//   4. npm ci --omit=dev inside the install dir — production deps only,
//      native binding built for the pinned runtime
//   5. verifies the binding loads there
//   6. verifies the INSTALLED server's tool surface and version — boots it
//      for real over an in-memory MCP connection and checks it exposes
//      everything dist/tools/*.js can register, and reports package.json's
//      version. Independent of createServer() itself (see eve-sde-mcp-5e5i):
//      a tool defined but never wired in — exactly what happened to
//      get_structure (PR #16) — would still pass a naive smoke test, since
//      createServer() is the thing that omitted the call. This instead
//      rediscovers the expected tool set from dist/tools/*.js directly, the
//      same way tests/server-tools.test.ts does against src/.
//   7. writes start.sh (resolved Node path baked in, with fallback discovery
//      and a loud-fail binding check — never an auto-rebuild)
//   8. updates the Claude Desktop config to launch the install (with a
//      timestamped backup; pass --no-config to skip)
//
// Re-run any time — it's a full clean redeploy. Restart Claude Desktop
// afterwards to pick up the new server.

import { execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = join(__dirname, "..");
const installDir = process.env.EVE_SDE_INSTALL_DIR || join(homedir(), ".eve-sde", "server");
const claudeConfigPath = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude_desktop_config.json"
);
const updateConfig = !process.argv.includes("--no-config");

function fail(msg) {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}

// --- 1. Build -------------------------------------------------------------
process.stdout.write("Building dist/ (tsc)...\n");
try {
  execSync("npm run build", { cwd: repoDir, stdio: "inherit" });
} catch {
  fail("build failed — fix TypeScript errors and re-run npm run deploy");
}

// --- 2. Runtime preflight --------------------------------------------------
const pinned = readFileSync(join(repoDir, ".node-version"), "utf8").trim();
const runningMajor = process.versions.node.split(".")[0];
if (pinned.split(".")[0] !== runningMajor) {
  fail(
    `deploying under Node ${process.version} but .node-version pins ${pinned}.\n` +
      `The server runs the pinned version — deploy from it:\n` +
      `  fnm use ${pinned}\n` +
      `  npm run deploy`
  );
}
const nodeBin = process.execPath;
process.stdout.write(`Deploying for Node ${process.version} (${nodeBin})\n`);

// --- 3. Clean + copy -------------------------------------------------------
const distSrc = join(repoDir, "dist");
if (!existsSync(join(distSrc, "index.js"))) fail("dist/index.js missing — build produced nothing?");

for (const sub of ["dist", "node_modules", "scripts"]) {
  rmSync(join(installDir, sub), { recursive: true, force: true });
}
mkdirSync(installDir, { recursive: true });

cpSync(distSrc, join(installDir, "dist"), { recursive: true });
cpSync(join(repoDir, "scripts"), join(installDir, "scripts"), { recursive: true });
for (const f of ["package.json", "package-lock.json", ".node-version"]) {
  copyFileSync(join(repoDir, f), join(installDir, f));
}
process.stdout.write(`Installed tree ready at ${installDir}\n`);

// --- 4. Production dependencies -------------------------------------------
process.stdout.write("Installing production dependencies (npm ci --omit=dev)...\n");
try {
  execSync("npm ci --omit=dev", { cwd: installDir, stdio: "inherit" });
} catch {
  fail(
    `npm ci failed inside ${installDir}.\n` +
      `The install dir is incomplete — fix the error above and re-run npm run deploy.`
  );
}

// --- 5. Verify the binding under this runtime ------------------------------
try {
  execSync(
    `${JSON.stringify(nodeBin)} -e "new (require('better-sqlite3'))(':memory:').close()"`,
    { cwd: installDir, stdio: "pipe" }
  );
} catch {
  fail(
    `the freshly installed better-sqlite3 binding does not load under ${nodeBin}.\n` +
      `This should never happen after a clean npm ci — report it, don't patch the install by hand.`
  );
}
process.stdout.write("Native binding verified in the install dir.\n");

// --- 6. Verify the installed server's tool surface and version -------------
// "Expected" comes from dist/tools/*.js (just built, mirrors src/tools/*.ts
// 1:1) — every register*Tools export, discovered independently of
// createServer(). "Actual" comes from booting the INSTALLED server for real
// and listing its tools over a genuine MCP connection. A tool module that
// exists but was never wired into createServer() fails here, the same way
// it fails tests/server-tools.test.ts — this just re-checks it against the
// artifact that's actually about to be launched, not the dev tree.
process.stdout.write("Verifying the installed server's tool surface...\n");
try {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  async function listToolNames(server) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "deploy-verify", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      return { names: tools.map((t) => t.name), version: client.getServerVersion()?.version };
    } finally {
      await client.close();
    }
  }

  // Expected: every register*Tools export in the just-built dist/tools/*.js.
  const toolsDir = join(distSrc, "tools");
  const registrars = [];
  for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".js"))) {
    const mod = await import(pathToFileURL(join(toolsDir, file)).href);
    for (const [name, fn] of Object.entries(mod)) {
      if (/^register[A-Z]/.test(name) && typeof fn === "function") {
        registrars.push({ name, file: `tools/${file}`, register: fn });
      }
    }
  }
  if (registrars.length === 0) {
    fail("discovered zero register*Tools exports in dist/tools/*.js — the check itself is broken, not the server");
  }

  // Actual: the real installed server, booted fresh.
  const { createServer } = await import(pathToFileURL(join(installDir, "dist", "server.js")).href);
  const { names: exposedNames, version: reportedVersion } = await listToolNames(createServer());
  const exposed = new Set(exposedNames);

  const missingByModule = [];
  for (const { name, file, register } of registrars) {
    const solo = new McpServer({ name: "solo", version: "0.0.0" });
    register(solo);
    const { names: provided } = await listToolNames(solo);
    const missing = provided.filter((t) => !exposed.has(t));
    if (missing.length > 0) missingByModule.push(`  ${name} (${file}): ${missing.join(", ")}`);
  }
  if (missingByModule.length > 0) {
    fail(
      `the installed server does not expose every tool its own source can register:\n${missingByModule.join("\n")}\n` +
        `Check that createServer() in src/server.ts calls every register*Tools function.`
    );
  }

  const installedPackageVersion = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")).version;
  if (reportedVersion !== installedPackageVersion) {
    fail(
      `the installed server reports version "${reportedVersion}" but its own package.json says "${installedPackageVersion}".\n` +
        `src/server.ts should read package.json directly (see README "Versioning") — this should be impossible; report it.`
    );
  }

  process.stdout.write(
    `Tool surface verified: ${exposed.size} tools exposed, matching all ${registrars.length} tool modules; ` +
      `version ${reportedVersion}.\n`
  );
} catch (err) {
  // fail() above exits directly (never throws), so only a genuinely
  // unexpected crash (an import failing, the in-memory connection breaking)
  // reaches here.
  fail(`tool-surface verification crashed: ${err instanceof Error ? err.stack : err}`);
}

// --- 7. Launcher ------------------------------------------------------------
// Resolved Node path baked in at deploy time; falls back to discovery
// (fnm's pinned-version dirs first — same order as the repo's start.sh) if
// that binary disappears (e.g. fnm upgrade). Never rebuilds: on a mismatch
// it fails loudly and points back at `npm run deploy` in the dev checkout.
const launcher = `#!/bin/sh
# Launcher for the installed eve-sde MCP server.
# Generated by npm run deploy from the eve-sde-mcp checkout — edit there,
# not here. This install is separate from the development tree on purpose:
# the server must never share node_modules with development (racing native
# rebuilds under different Node runtimes have corrupted shared installs
# before — see README "Server install").

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Node resolved at deploy time, with discovery fallback: fnm's version dirs
# go LAST in the loop so they end up FIRST in PATH.
NODE_BIN="${nodeBin}"
if [ ! -x "$NODE_BIN" ]; then
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.local/share/fnm/node-versions"/*/installation/bin; do
    case ":$PATH:" in
      *:"$p":*) ;;
      *) [ -d "$p" ] && PATH="$p:$PATH" ;;
    esac
  done
  export PATH
  NODE_BIN="$(command -v node || true)"
fi

if ! "$NODE_BIN" -e "new (require('better-sqlite3'))(':memory:').close()" 2>/dev/null; then
  echo "FATAL: the installed server's better-sqlite3 binding does not load" >&2
  echo "under $("$NODE_BIN" -v 2>/dev/null || echo 'the resolved Node'). The install" >&2
  echo "is stale or was deployed under a different runtime. Fix it at the source:" >&2
  echo "" >&2
  echo "  cd ${repoDir} && npm run deploy" >&2
  echo "" >&2
  echo "This launcher never rebuilds — see README 'Server install'." >&2
  exit 1
fi

exec "$NODE_BIN" "$DIR/dist/index.js"
`;
writeFileSync(join(installDir, "start.sh"), launcher, { mode: 0o755 });
chmodSync(join(installDir, "start.sh"), 0o755); // writeFileSync alone won't fix the mode of an existing file
process.stdout.write("Launcher written (start.sh).\n");

// --- 8. Claude Desktop config ----------------------------------------------
const snippet = `{
  "mcpServers": {
    "eve-sde": {
      "command": "${join(installDir, "start.sh")}"
    }
  }
}`;

if (!updateConfig) {
  process.stdout.write(`Config update skipped (--no-config). Point your MCP client at:\n${snippet}\n`);
} else if (!existsSync(claudeConfigPath)) {
  process.stdout.write(
    `No Claude Desktop config found at ${claudeConfigPath}.\nPoint your MCP client at ${join(installDir, "start.sh")} — e.g.:\n${snippet}\n`
  );
} else {
  try {
    const config = JSON.parse(readFileSync(claudeConfigPath, "utf8"));
    config.mcpServers = config.mcpServers || {};
    const previous = config.mcpServers["eve-sde"];
    const backup = `${claudeConfigPath}.bak-${Date.now()}`;
    copyFileSync(claudeConfigPath, backup);
    config.mcpServers["eve-sde"] = { command: join(installDir, "start.sh") };
    writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2) + "\n");
    process.stdout.write(
      `Claude Desktop config updated (backup: ${basename(backup)}).\n` +
        (previous && previous.command
          ? `  was: ${previous.command} ${JSON.stringify(previous.args || [])}\n`
          : "") +
        `  now: ${join(installDir, "start.sh")}\n` +
        `Restart Claude Desktop to launch the installed server.\n`
    );
  } catch (err) {
    process.stderr.write(
      `WARNING: could not update ${claudeConfigPath} (${err.message}).\n` +
        `The install itself succeeded. Update the config manually — point\n` +
        `"eve-sde" at ${join(installDir, "start.sh")}:\n${snippet}\n`
    );
  }
}

process.stdout.write(
  `\nDeployed: ${installDir}\n` +
    `Data (SDE, ledger, auth) stays in ~/.eve-sde and is shared with dev — unchanged.\n`
);
