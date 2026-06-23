#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTypeTools } from "./tools/types.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerUniverseTools } from "./tools/universe.js";
import { registerIndustryTools } from "./tools/industry.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerSkillTools } from "./tools/skills.js";
import { registerMarketTools } from "./tools/market.js";
import { registerIndustryEsiTools } from "./tools/industry-esi.js";
import { registerFittingTools } from "./tools/fittings.js";
import { registerKillmailTools } from "./tools/killmails.js";
import { sdeExists, closeDatabase } from "./database.js";
import { closeAuthDb } from "./auth/tokens.js";
import { downloadSde } from "./downloader.js";

const server = new McpServer({
  name: "eve-sde",
  version: "1.0.0",
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
registerFittingTools(server);
registerKillmailTools(server);

function shutdown(): void {
  closeDatabase();
  closeAuthDb();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

async function main(): Promise<void> {
  if (!sdeExists()) {
    process.stderr.write("SDE database not found. Downloading from Fuzzwork...\n");
    try {
      const msg = await downloadSde();
      process.stderr.write(msg + "\n");
    } catch (err) {
      process.stderr.write(
        `Warning: Failed to auto-download SDE. Use refresh_sde tool manually. Error: ${err}\n`
      );
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  shutdown();
  process.exit(1);
});
