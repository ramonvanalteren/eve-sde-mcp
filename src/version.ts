// package.json is the single source of truth for the server's own version —
// see README "Versioning". Read once at import time, resolved relative to
// this module: works identically in dev (src/), the built tree (dist/), and
// the deployed install, since package.json always sits one directory above
// wherever this file itself lives.
//
// Factored out of server.ts (rather than importing it from there) so tools
// that also need the version — get_server_status in meta.ts — don't create
// a circular import between server.ts and the tools it registers.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const packageVersion: string = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
).version;
