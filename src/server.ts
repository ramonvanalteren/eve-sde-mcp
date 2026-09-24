// Builds the MCP server and wires up every tool module. Kept free of side
// effects (no transport, no heartbeat, no signal handlers) so tests can
// construct the exact server the entry point runs and inspect its tool
// surface — see tests/server-tools.test.ts, which fails when a tools/*.ts
// module exports a register function that is not called here.
//
// Adding a tool module: export `register<Name>Tools(server)` from
// src/tools/<name>.ts and call it below. A module that defines tools but is
// not wired in is silently invisible to clients (get_structure shipped that
// way once), hence the test.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTypeTools } from "./tools/types.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerUniverseTools } from "./tools/universe.js";
import { registerIndustryTools } from "./tools/industry.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerSkillTools } from "./tools/skills.js";
import { registerMarketTools } from "./tools/market.js";
import { registerIndustryEsiTools } from "./tools/industry-esi.js";
import { registerStructureTools } from "./tools/structures.js";
import { registerFittingTools } from "./tools/fittings.js";
import { registerKillmailTools } from "./tools/killmails.js";
import { registerLedgerTools } from "./tools/ledger.js";

// package.json is the single source of truth for the server's version — see
// README "Versioning". Read at call time rather than hardcoded so bumping
// package.json is the only edit needed; it can't drift out of sync with what
// the server actually reports (dist/server.js and src/server.ts both sit one
// directory below package.json, in the repo and in the deployed install).
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageVersion: string = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
).version;

export function createServer(): McpServer {
  const server = new McpServer({
    name: "eve-sde",
    version: packageVersion,
  });

  registerTypeTools(server);
  registerGroupTools(server);
  registerUniverseTools(server);
  registerIndustryTools(server);
  registerMetaTools(server);
  registerAuthTools(server);
  registerSkillTools(server);
  registerMarketTools(server);
  registerIndustryEsiTools(server);
  registerStructureTools(server);
  registerFittingTools(server);
  registerKillmailTools(server);
  registerLedgerTools(server);

  return server;
}
