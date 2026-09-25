import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase, getMetadata, sdeExists, listTables, reopenDatabase } from "../database.js";
import { downloadSde } from "../downloader.js";
import { jsonResult } from "../utils.js";
import { packageVersion } from "../version.js";
import { getBuildInfo } from "../build-info.js";

export function registerMetaTools(server: McpServer): void {
  server.tool(
    "query_sde",
    "Run a read-only SQL query against the Eve Online SDE database. Only SELECT statements are allowed. Use this for anything the other tools don't cover.",
    {
      sql: z.string().describe("SQL SELECT query to execute"),
      params: z
        .array(z.union([z.string(), z.number()]))
        .optional()
        .describe("Bind parameters for the query"),
    },
    async ({ sql, params }) => {
      const normalized = sql.trim().replace(/\s+/g, " ");
      const firstWord = normalized.split(" ")[0].toUpperCase();

      if (firstWord !== "SELECT" && firstWord !== "WITH" && firstWord !== "EXPLAIN") {
        return {
          content: [
            {
              type: "text",
              text: "Only SELECT, WITH (CTE), and EXPLAIN queries are allowed. This is a read-only interface.",
            },
          ],
        };
      }

      // Defense-in-depth: the database is opened in readonly mode, so writes
      // fail at the SQLite level regardless. This check catches common mistakes
      // before they hit the database, but may false-positive on queries
      // referencing columns/values containing these words.
      const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|PRAGMA)\b/i;
      if (forbidden.test(normalized)) {
        return {
          content: [
            { type: "text", text: "Query contains forbidden keywords. Only read-only queries are allowed. (Note: the database is read-only, so writes would fail regardless.)" },
          ],
        };
      }

      const db = getDatabase();
      try {
        const rows = db.prepare(sql).all(...(params ?? []));
        return jsonResult(rows);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Query error: ${message}` }] };
      }
    }
  );

  server.tool(
    "get_sde_status",
    "Get the current status of the Eve Online SDE database — version, download date, file size, and available tables.",
    {},
    async () => {
      const exists = sdeExists();
      const metadata = getMetadata();

      if (!exists) {
        return {
          content: [
            {
              type: "text",
              text: "SDE database not downloaded. Use the refresh_sde tool to download it.",
            },
          ],
        };
      }

      const tables = listTables();
      const result = { installed: true, metadata, tableCount: tables.length, tables };
      return jsonResult(result);
    }
  );

  server.tool(
    "get_server_status",
    "Get the running MCP server's own version, process info, and (when deployed via npm run deploy) the git commit it was built from — confirms a redeploy actually reached the client you're talking to, without cross-referencing a tool result by hand. Distinct from get_sde_status, which is about the SDE data, not the server process.",
    {},
    async () => {
      const buildInfo = getBuildInfo();
      return jsonResult({
        version: packageVersion,
        pid: process.pid,
        nodeVersion: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        build: buildInfo,
      });
    }
  );

  server.tool(
    "refresh_sde",
    "Download or update the Eve Online SDE database from Fuzzwork. This replaces the current database with the latest version. Takes a minute or two.",
    {},
    async () => {
      try {
        const message = await downloadSde();
        reopenDatabase();
        return { content: [{ type: "text", text: message }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to download SDE: ${message}` }] };
      }
    }
  );
}
