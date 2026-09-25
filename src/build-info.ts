// Optional build provenance for get_server_status (src/tools/meta.ts).
// Written by scripts/deploy.mjs at deploy time as dist/build-info.json,
// sitting next to dist/server.js — never produced by `tsc` itself, and
// absent in dev (`npm run dev` runs tsx directly against src/, which never
// goes through deploy.mjs) or in any install predating this file. Always
// treated as optional — a missing or unreadable file returns null, never a
// guess or a thrown error.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  gitCommit: string | null;
  builtAt: string | null;
}

/** Pure parse step, kept separate from the filesystem lookup so it's testable without touching disk. */
export function parseBuildInfo(raw: string): BuildInfo | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      gitCommit: typeof parsed.gitCommit === "string" ? parsed.gitCommit : null,
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : null,
    };
  } catch {
    return null;
  }
}

// __dirname is dist/ in the built/deployed artifact (where deploy.mjs writes
// build-info.json) and src/ under tsx in dev (where the file never exists —
// getBuildInfo() correctly returns null there, no special-casing needed).
const __dirname = dirname(fileURLToPath(import.meta.url));
const buildInfoPath = join(__dirname, "build-info.json");

export function getBuildInfo(): BuildInfo | null {
  if (!existsSync(buildInfoPath)) return null;
  try {
    return parseBuildInfo(readFileSync(buildInfoPath, "utf8"));
  } catch {
    return null;
  }
}
