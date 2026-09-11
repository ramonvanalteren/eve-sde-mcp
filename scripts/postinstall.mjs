#!/usr/bin/env node
// Postinstall check for the better-sqlite3 native binding.
//
// Fresh installs build/download the binding via better-sqlite3's own install
// script (prebuild-install || node-gyp rebuild). But node_modules can survive
// a Node version switch, leaving a binding compiled for a different ABI. This
// script catches that case, rebuilds, and — unlike the old postinstall
// (`npm rebuild ... 2>/dev/null || true`) — never hides a failure: if the
// rebuild can't produce a loadable binding, npm install fails visibly.

import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function bindingLoads() {
  try {
    // The native addon loads lazily on first Database instantiation, so a
    // bare require() can succeed even with a missing/ABI-mismatched binary.
    new (require("better-sqlite3"))(":memory:").close();
    return true;
  } catch (err) {
    console.error(`better-sqlite3 binding failed to load: ${err.message}`);
    return false;
  }
}

if (bindingLoads()) {
  process.exit(0);
}

console.error("Rebuilding better-sqlite3 for the current Node ABI...");
try {
  execSync("npm rebuild better-sqlite3", { stdio: "inherit" });
} catch {
  console.error(
    "\nbetter-sqlite3 rebuild failed, so this install is not usable. Common fixes:" +
      "\n  - install Xcode Command Line Tools: xcode-select --install" +
      "\n  - ensure network access so prebuilt binaries can be downloaded" +
      "\nThen re-run: npm run rebuild"
  );
  process.exit(1);
}

if (!bindingLoads()) {
  console.error("Rebuild reported success but the binding still fails to load.");
  process.exit(1);
}

console.error("better-sqlite3 rebuilt successfully.");
