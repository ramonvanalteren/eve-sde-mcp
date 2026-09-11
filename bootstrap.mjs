#!/usr/bin/env node

// Dev-tree launcher for the MCP server.
//
// It checks that the better-sqlite3 native binding loads under the CURRENT
// Node runtime and then starts the server — and that is ALL it does.
//
// This file used to auto-rebuild the binding on mismatch. That silent
// mutation is exactly what corrupted this checkout in practice: an MCP
// client launched the server from the dev tree under a different Node
// (/opt/homebrew/bin/node) than the development shell (fnm), so every
// relaunch silently rebuilt node_modules for the wrong ABI while the dev
// shell kept rebuilding it back — and the racing writes left a torn binary
// that macOS killed every loader of (Code Signature Invalid).
//
// The supported setup is now a separate install for the server
// (`npm run deploy`, see README "Server install") so this file should only
// ever run from a developer's own shell, under the Node version pinned in
// .node-version. On any mismatch it fails loudly with instructions rather
// than touching node_modules.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The check runs in a subprocess so that a failed require() doesn't pollute
// this process's module cache — the server import must see a fresh module.
// NOTE: the binding loads lazily on first Database instantiation, so the
// check has to actually open an in-memory database, not just require().
try {
  execFileSync(
    process.execPath,
    ["-e", "new (require('better-sqlite3'))(':memory:').close()"],
    { cwd: __dirname, stdio: "pipe" }
  );
} catch {
  const pinned = readFileSync(join(__dirname, ".node-version"), "utf8").trim();
  process.stderr.write(
    [
      "FATAL: better-sqlite3's native binding does not load under this runtime.",
      "",
      `  runtime in use : Node ${process.version} (ABI ${process.versions.modules})`,
      `  project pin   : Node ${pinned} (.node-version)`,
      "",
      "This checkout's node_modules was built for a different Node version.",
      "It will NOT be rebuilt automatically — silent rebuilds from a launcher",
      "running under an unexpected runtime have corrupted installs before",
      "(see README 'Server install'). Fix it explicitly:",
      "",
      `  fnm use ${pinned}        # switch this shell to the pinned runtime`,
      "  npm run rebuild          # rebuild the binding for it",
      "",
      "If you meant to run the installed server (not the dev checkout),",
      "launch ~/.eve-sde/server/start.sh instead — see README 'Server install'.",
      "",
    ].join("\n")
  );
  process.exit(1);
}

await import("./dist/index.js");
