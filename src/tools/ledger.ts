import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { enrichTypeName, jsonResult } from "../utils.js";
import { syncWalletLedger } from "../ledger/sync.js";
import { runDailyClose, getStoredClose, getStoredCloseRange } from "../ledger/close.js";
import { getLedgerDb } from "../ledger/db.js";

export function registerLedgerTools(server: McpServer): void {
  server.tool(
    "sync_wallet_ledger",
    "Pull the authenticated character's full available wallet journal + transaction history from ESI and persist it into the local ledger. ESI only retains ~30 days of wallet history — anything not synced before it ages out is permanently unrecoverable, so this must run at least every couple of weeks (daily via run_daily_close is the normal way to do it) to keep the accounting ledger complete. Safe to call repeatedly; already-seen entries are no-ops.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const result = await syncWalletLedger(character_id);
      return jsonResult(result);
    }
  );

  server.tool(
    "run_daily_close",
    "Run (or re-run) a day-close for the authenticated character: syncs the wallet ledger, applies new transactions through the FIFO cost-basis engine, and computes realized P&L (net of actual broker fees + sales tax from the wallet journal, not an estimated rate), plus unrealized P&L / NAV mark-to-market when closing today. Persists one row per (character, date) in the local ledger — re-running for the same date overwrites that date's row. Past dates only get realized figures (unrealized/NAV need live market data, only available for today).",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      close_date: z.string().optional().describe("UTC date to close, YYYY-MM-DD. Defaults to today. Use a past date to backfill a day you missed."),
    },
    async ({ character_id, close_date }) => {
      const report = await runDailyClose(character_id, close_date);
      return jsonResult(report);
    }
  );

  server.tool(
    "get_daily_close",
    "Read a previously computed day-close for the given date, without re-syncing or recomputing anything. Returns nothing if that date hasn't been closed yet — use run_daily_close first.",
    {
      character_id: z.number().describe("Character ID"),
      close_date: z.string().describe("UTC date, YYYY-MM-DD"),
    },
    async ({ character_id, close_date }) => {
      const row = getStoredClose(character_id, close_date);
      if (!row) {
        return jsonResult({ found: false, note: `No close stored for ${close_date}. Use run_daily_close to compute it.` });
      }
      return jsonResult({ found: true, close: row });
    }
  );

  server.tool(
    "get_close_range",
    "Read a range of previously computed day-closes (for trend / period P&L review), without re-syncing or recomputing anything.",
    {
      character_id: z.number().describe("Character ID"),
      from_date: z.string().describe("UTC date, YYYY-MM-DD, inclusive"),
      to_date: z.string().describe("UTC date, YYYY-MM-DD, inclusive"),
    },
    async ({ character_id, from_date, to_date }) => {
      const rows = getStoredCloseRange(character_id, from_date, to_date);
      const totals = rows.reduce(
        (acc: { realizedPnlNet: number; brokerFeesPaid: number; salesTaxPaid: number }, r) => ({
          realizedPnlNet: acc.realizedPnlNet + ((r.realized_pnl_net as number) ?? 0),
          brokerFeesPaid: acc.brokerFeesPaid + ((r.broker_fees_paid as number) ?? 0),
          salesTaxPaid: acc.salesTaxPaid + ((r.sales_tax_paid as number) ?? 0),
        }),
        { realizedPnlNet: 0, brokerFeesPaid: 0, salesTaxPaid: 0 }
      );
      return jsonResult({ days: rows.length, totals, closes: rows });
    }
  );

  server.tool(
    "get_open_lots",
    "List current open FIFO cost-basis lots (unsold inventory, with acquisition date and unit cost) for the authenticated character's ledger — the basis unrealized P&L is computed against.",
    {
      character_id: z.number().describe("Character ID"),
      type_id: z.number().optional().describe("Filter to a specific item type ID"),
    },
    async ({ character_id, type_id }) => {
      const db = getLedgerDb();
      const sdeDb = getDatabase();
      let query = `SELECT buy_transaction_id, type_id, date, original_qty, remaining_qty, unit_cost FROM lots WHERE character_id = ? AND remaining_qty > 0`;
      const params: unknown[] = [character_id];
      if (type_id) {
        query += ` AND type_id = ?`;
        params.push(type_id);
      }
      query += ` ORDER BY type_id, date`;
      const rows = db.prepare(query).all(...params) as Array<{
        buy_transaction_id: number;
        type_id: number;
        date: string;
        original_qty: number;
        remaining_qty: number;
        unit_cost: number;
      }>;
      const lots = rows.map((r) => ({
        buyTransactionId: r.buy_transaction_id,
        typeName: enrichTypeName(sdeDb, r.type_id),
        typeId: r.type_id,
        date: r.date,
        originalQty: r.original_qty,
        remainingQty: r.remaining_qty,
        unitCost: r.unit_cost,
        costBasis: r.remaining_qty * r.unit_cost,
      }));
      return jsonResult({ count: lots.length, lots });
    }
  );
}
