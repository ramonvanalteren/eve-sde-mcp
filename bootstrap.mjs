#!/usr/bin/env node

// Bootstrap for the MCP server.
// Checks if better-sqlite3's native module matches the current Node version.
// If not, rebuilds it before starting the server.
//
// The check runs in a subprocess so that a failed require() doesn't pollute
// this process's module cache — the server import must see a fresh module.

import { execFileSync, execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure npm is findable — it lives alongside the running node binary
const nodeDir = dirname(process.execPath);
if (!process.env.PATH?.includes(nodeDir)) {
  process.env.PATH = `${nodeDir}:${process.env.PATH || ""}`;
}

try {
  execFileSync(
    process.execPath,
    ["-e", "new (require('better-sqlite3'))(':memory:').close()"],
    { cwd: __dirname, stdio: "pipe" }
  );
} catch {
  process.stderr.write(
    `better-sqlite3 needs rebuild for Node ${process.version}...\n`
  );
  try {
    execSync("npm rebuild better-sqlite3", {
      cwd: __dirname,
      stdio: "pipe",
    });
    process.stderr.write("Rebuild complete.\n");
  } catch (e) {
    process.stderr.write(
      `Rebuild failed: ${e instanceof Error ? e.message : e}\n` +
      `Try: cd ${__dirname} && npm rebuild better-sqlite3\n`
    );
    process.exit(1);
  }
}

await import("./dist/index.js");
