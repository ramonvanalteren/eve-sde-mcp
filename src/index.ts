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
import { registerStructureTools } from "./tools/structures.js";
import { registerFittingTools } from "./tools/fittings.js";
import { registerKillmailTools } from "./tools/killmails.js";
import { registerLedgerTools } from "./tools/ledger.js";
import { sdeExists, closeDatabase } from "./database.js";
import { closeAuthDb } from "./auth/tokens.js";
import { closeLedgerDb } from "./ledger/db.js";
import { startAutoClose, stopAutoClose } from "./ledger/autoclose.js";
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
registerLedgerTools(server);

function shutdown(): void {
  stopAutoClose();
  closeDatabase();
  closeAuthDb();
  closeLedgerDb();
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
  transport.onclose = () => {
    // Client closed the transport (app quit/restart) — stop the heartbeat
    // immediately rather than letting its last actions race the exit path.
    stopAutoClose();
  };

  // Autonomous daily close: sync + close completed UTC days while this
  // server is running, no one asking required (config: ~/.eve-sde/config.json
  // -> autoClose; see src/ledger/autoclose.ts). The heartbeat's timers are
  // unref'd, so this never prevents the process from exiting with the
  // transport.
  startAutoClose();
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  shutdown();
  process.exit(1);
});
