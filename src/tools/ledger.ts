import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { enrichTypeName, jsonResult } from "../utils.js";
import { syncWalletLedger } from "../ledger/sync.js";
import { runDailyClose, runDailyClosePerPosition, getStoredClose, getStoredCloseRange } from "../ledger/close.js";
import { getLedgerDb } from "../ledger/db.js";
import { autoCloseHeartbeatInfo, gatherCharacterStates } from "../ledger/autoclose.js";
import {
  matchBrokerFees,
  computeOpenChainSunkFees,
  attributeAcquisitionFees,
  computeOpenBuySunkFees,
  type BrokerFeeEntry,
  type OrderRecord,
} from "../ledger/fees.js";
import {
  loadStationFeeSettings,
  resolveStationFeeModels,
  expectedFeeResolver,
  formatFeeModel,
  DEFAULT_BROKER_FEE_PCT,
} from "../ledger/station-fees.js";

export function registerLedgerTools(server: McpServer): void {
  server.tool(
    "sync_wallet_ledger",
    "Pull the authenticated character's full available wallet journal + transaction + order history from ESI and persist it into the local ledger. ESI only retains ~30 days of wallet history and ~90 days of order history — anything not synced before it ages out is permanently unrecoverable. The autonomous daily-close heartbeat (see get_autoclose_status) syncs automatically while the server is running, which is the normal way this stays current; call this tool manually only when you need a sync outside the heartbeat (e.g. right after placing orders, before a manual close). Safe to call repeatedly; already-seen entries are no-ops.",
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
    "Run (or re-run) a day-close for the authenticated character over one full UTC day (00:00–24:00 UTC). Defaults to the most recently completed day — yesterday — since a day can only be officially closed once it's over; pass close_date for another past date, or today's date for an intraday snapshot. Syncs the wallet ledger (journal, transactions, orders), applies new transactions through the FIFO cost-basis engine, and computes realized P&L net of actual broker fees + sales tax from the wallet journal (not an estimated rate). Unrealized P&L / NAV are computed for every date: today's close marks held inventory to the live Jita best SELL price (net of sales_tax_pct; every open lot is already-owned inventory from a filled buy, so bid-side pricing would understate it by the bid-ask spread), while a past date marks to The Forge daily-average market history for that date (publishes at the next downtime, ~11:00 UTC), also net of sales tax — marksMethod in the report says which. Escrow for past dates is reconstructed by backing market_escrow journal movement since that date out of the current live escrow. The NAV reconciliation gap ties NAV change to realized net P&L + non-trading cashflow + the CHANGE in unrealized P&L vs the prior close — investigate any non-trivial gap. Broker fees are split into new-listing vs. relisting by correlating brokers_fee journal entries against order timestamps (best-effort: ESI gives no direct order/fee linkage; brokerFeesUnmatched covers what couldn't be confidently attributed, brokerFeesPaid stays exact), and exitFeesAttributed / exitFeesRelistingAttributed attribute the listing/relisting campaign fees to the day's sales — lifetime position economics, not an extra expense on top of brokerFeesPaid. Persists one row per (character, date) — re-running for the same date overwrites that date's row.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      close_date: z.string().optional().describe("UTC date to close, YYYY-MM-DD. Defaults to the most recently completed UTC day (yesterday) over its full 00:00–24:00 period. Use an explicit past date to backfill a missed day, or today's date for an intraday snapshot."),
      broker_fee_pct: z.number().optional().describe("UNIFORM broker fee percentage applied to every station's fee/order matching — a legacy simple-case override. Only pass it when a single rate truly applies everywhere. Normally OMIT it: fees are resolved per station, CONFIG-FIRST, from ~/.eve-sde/config.json stationFees (see get_station_fees); stations not in config derive a percentage from the character's own unambiguous fee/order history, and stations with neither use the generic default (flagged in the report)."),
      sales_tax_pct: z.number().optional().describe("Character's effective sales tax percentage, used to net unrealized marks (best sell price * (1 - this/100)). Resolution: this param > config.json salesTaxPct > generic default. Pin salesTaxPct in config.json and omit this."),
    },
    async ({ character_id, close_date, broker_fee_pct, sales_tax_pct }) => {
      const report = await runDailyClose(character_id, close_date, broker_fee_pct, sales_tax_pct);
      return jsonResult(report);
    }
  );

  server.tool(
    "get_daily_close_by_position",
    "Per-position variant of run_daily_close: same day-close (same default — yesterday, the most recently completed UTC day), but realized P&L, allocated sales tax, matched broker fees, exit-fee attribution, and unrealized mark-to-market are grouped by item type_id instead of one portfolio total. Runs the same sync + FIFO application as run_daily_close (safe to call directly) but doesn't persist the breakdown — it's recomputed on demand from the same permanent ledger data. Realized sales tax is allocated exactly by each position's revenue share (flat rate on sell value, not item-specific). Broker fees include only what matchBrokerFees could confidently attribute — unattributed fees stay portfolio-level. exitFeesAttributed / exitFeesRelistingAttributed carry the listing/relisting campaign fees of that day's sales (heuristic, see fees.ts): lifetime position economics, already counted in brokerFeesPaid on the days they were paid — realizedPnlNetAfterExitFees (net P&L minus attributed exit fees) is the position's all-in profitability. Unrealized mark-to-market works for any closed date: live Jita best-sell for today, The Forge daily-average market history for past dates (see marksMethod).",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      close_date: z.string().optional().describe("UTC date to close, YYYY-MM-DD. Defaults to yesterday (most recently completed UTC day)."),
      broker_fee_pct: z.number().optional().describe("Same as run_daily_close — omit to auto-derive from history."),
      sales_tax_pct: z.number().optional().describe("Same resolution as run_daily_close (param > config.json salesTaxPct > default) — nets unrealized marks."),
    },
    async ({ character_id, close_date, broker_fee_pct, sales_tax_pct }) => {
      const report = await runDailyClosePerPosition(character_id, close_date, broker_fee_pct, sales_tax_pct);
      const db = getDatabase();
      const positions = report.positions.map((p) => ({ typeName: enrichTypeName(db, p.typeId), ...p }));
      return jsonResult({ ...report, positions });
    }
  );

  server.tool(
    "get_station_fees",
    "Show the broker-fee model per station (location) used for fee/order matching — CONFIG-FIRST: pin models in ~/.eve-sde/config.json `stationFees` (e.g. Jita 4-4 60003760 {brokerFeePct: 1.491}; a Perimeter-style structure {brokerFeePct: 0.5, brokerFeeFlat: 100} — SCC surcharge pct + flat structure fee, additive). Stations not in config derive a percentage from the character's own unambiguous fee/order pairs; stations with neither show the generic default and should be pinned. Fee components are additive: expected fee = order value × pct/100 + flat. Also resolves the sales-tax percentage (explicit param > config.json salesTaxPct > default) — sales tax is character-level (sell-side only). Use this to discover unconfigured station IDs you trade at (each station seen in your orders appears here with its resolution status) and to verify config took effect.",
    {
      character_id: z.number().describe("Character ID"),
    },
    async ({ character_id }) => {
      const db = getLedgerDb();
      const feeRows = db
        .prepare(`SELECT id, date, amount FROM wallet_journal WHERE character_id = ? AND ref_type = 'brokers_fee'`)
        .all(character_id) as Array<{ id: number; date: string; amount: number | null }>;
      const orderRows = db
        .prepare(`SELECT order_id, type_id, is_buy_order, price, volume_total, issued, state, location_id FROM orders WHERE character_id = ?`)
        .all(character_id) as Array<{
        order_id: number;
        type_id: number;
        is_buy_order: number;
        price: number;
        volume_total: number;
        issued: string;
        state: OrderRecord["state"];
        location_id: number | null;
      }>;

      const fees: BrokerFeeEntry[] = feeRows.map((r) => ({ journalId: r.id, date: r.date, amount: r.amount ?? 0 }));
      const orders: OrderRecord[] = orderRows.map((r) => ({
        orderId: r.order_id,
        typeId: r.type_id,
        isBuyOrder: r.is_buy_order === 1,
        price: r.price,
        volumeTotal: r.volume_total,
        issued: r.issued,
        state: r.state,
        locationId: r.location_id,
      }));

      const settings = loadStationFeeSettings();
      const resolution = resolveStationFeeModels(fees, orders, settings);
      const stations = [...resolution.byStation.values()]
        .map((m) => ({
          stationId: m.key,
          label: m.label ?? null,
          fee: formatFeeModel(m.model),
          model: m.model,
          provenance: m.provenance,
          unambiguousPairs: m.sampleCount ?? null,
        }))
        .sort((a, b) => (a.provenance === "default" ? -1 : b.provenance === "default" ? 1 : a.stationId.localeCompare(b.stationId)));
      const unconfigured = stations.filter((st) => st.provenance === "default");
      const notes: string[] = [
        `Resolution order per station: config.json stationFees > derived from this character's unambiguous fee/order pairs > generic ${DEFAULT_BROKER_FEE_PCT}% default.`,
        `Sales tax used: ${settings.salesTaxPct !== null ? `${settings.salesTaxPct}% (config.json salesTaxPct)` : "default (set salesTaxPct in config.json for precision)"}.`,
      ];
      if (unconfigured.length > 0) {
        notes.push(
          `Station(s) ${unconfigured.map((st) => st.stationId).join(", ")} appear in the order history with no config entry and no derivable rate — fee/order matching there uses the generic default. Pin them in ~/.eve-sde/config.json stationFees (flat-fee structures especially: their fees can't be derived from history as a rate).`
        );
      }
      return jsonResult({
        configPath: "~/.eve-sde/config.json",
        salesTaxPct: settings.salesTaxPct,
        stations,
        notes,
      });
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
    "get_autoclose_status",
    "Inspect the server's autonomous daily-close heartbeat: whether it's active, its config (from ~/.eve-sde/config.json -> autoClose), per-character sync/close coverage of recent days, and its recent run log (autoclose_runs — every sync/close attempt, successful or failed). The heartbeat syncs the wallet ledger and closes every completed UTC day after EVE downtime (~11:30 UTC default) while the server runs — no one needs to ask. Characters whose token refresh is failing are listed under authIssues: the heartbeat leaves them alone until esi_login, and their ESI tools fail with a re-login prompt on use. Use this to check coverage after downtime/gaps (a day only stays closeable within ESI's ~30-day journal window) and to see why, if anything, a day didn't close.",
    {},
    async () => {
      const heartbeat = autoCloseHeartbeatInfo();
      const authIssues = gatherCharacterStates()
        .filter((c) => c.authBroken)
        .map((c) => ({
          characterId: c.characterId,
          characterName: c.characterName,
          issue: "token refresh failing (dead/expired refresh token) — heartbeat leaves this character alone; run esi_login before using its ESI tools",
        }));
      const db = getLedgerDb();
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const windowStart = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);

      const charRows = db.prepare(`SELECT DISTINCT character_id FROM sync_state`).all() as Array<{
        character_id: number;
      }>;
      const characters = charRows.map((c) => {
        const syncRow = db
          .prepare(`SELECT last_synced_at FROM sync_state WHERE character_id = ?`)
          .get(c.character_id) as { last_synced_at: string | null } | undefined;
        const closedRows = db
          .prepare(
            `SELECT close_date FROM daily_closes WHERE character_id = ? AND close_date >= ? ORDER BY close_date`
          )
          .all(c.character_id, windowStart) as Array<{ close_date: string }>;
        const closed = closedRows.map((r) => r.close_date);
        const closedSet = new Set(closed);
        const missing: string[] = [];
        for (
          let t = new Date(`${windowStart}T00:00:00Z`).getTime();
          t <= new Date(`${yesterday}T00:00:00Z`).getTime();
          t += 86_400_000
        ) {
          const d = new Date(t).toISOString().slice(0, 10);
          if (!closedSet.has(d)) missing.push(d);
        }
        const failedRows = db
          .prepare(
            `SELECT close_date, COUNT(*) AS attempts, MAX(started_at) AS last_attempt
             FROM autoclose_runs
             WHERE character_id = ? AND kind = 'close' AND outcome = 'failed' AND close_date >= ?
             GROUP BY close_date ORDER BY close_date`
          )
          .all(c.character_id, windowStart) as Array<{
          close_date: string;
          attempts: number;
          last_attempt: string;
        }>;
        return {
          characterId: c.character_id,
          lastSyncedAt: syncRow?.last_synced_at ?? null,
          yesterdayClosed: closedSet.has(yesterday),
          closedDaysLast30: closed.length,
          missingDays: missing,
          recentFailedAttempts: failedRows,
        };
      });

      const runs = db
        .prepare(`SELECT * FROM autoclose_runs ORDER BY started_at DESC, id DESC LIMIT 25`)
        .all() as Array<Record<string, unknown>>;

      return jsonResult({ heartbeat, authIssues, characters, recentRuns: runs });
    }
  );

  server.tool(
    "get_open_lots",
    "List current open FIFO cost-basis lots (unsold inventory with acquisition date and unit cost) for the authenticated character's ledger — the basis unrealized P&L is computed against. Each lot carries both directions of relisting churn as lifetime overlays (never folded into unit_cost or daily P&L — fees are already expensed as brokerFeesPaid when paid): sunkExitFees/sunkRelistingFees (the cancel-and-relist cost of the position's sell campaign so far, see attributeExitFees) and acquisitionFeesPerUnit/allInUnitCost (the buy-campaign fees spent acquiring this lot's units — re-placed buy orders before the fill — giving an all-in cost basis). openBuySunkFees lists pre-acquisition churn: fees sunk into live buy campaigns that haven't produced units yet. Fees that couldn't be confidently matched to orders are excluded (understated, not guessed) and noted in `notes`.",
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

      // Sunk exit fees per type: match every synced brokers_fee entry to its
      // order (global history, same heuristic as the daily close) and sum the
      // campaign fees of each type's still-active sell chain.
      const feeRows = db
        .prepare(`SELECT id, date, amount FROM wallet_journal WHERE character_id = ? AND ref_type = 'brokers_fee'`)
        .all(character_id) as Array<{ id: number; date: string; amount: number | null }>;
      const orderRows = db
        .prepare(`SELECT order_id, type_id, is_buy_order, price, volume_total, issued, state, location_id FROM orders WHERE character_id = ?`)
        .all(character_id) as Array<{
        order_id: number;
        type_id: number;
        is_buy_order: number;
        price: number;
        volume_total: number;
        issued: string;
        state: OrderRecord["state"];
        location_id: number | null;
      }>;
      const fees: BrokerFeeEntry[] = feeRows.map((r) => ({ journalId: r.id, date: r.date, amount: r.amount ?? 0 }));
      const orders: OrderRecord[] = orderRows.map((r) => ({
        orderId: r.order_id,
        typeId: r.type_id,
        isBuyOrder: r.is_buy_order === 1,
        price: r.price,
        volumeTotal: r.volume_total,
        issued: r.issued,
        state: r.state,
        locationId: r.location_id,
      }));

      // Station fee models for sunk-fee attribution — same config-first
      // resolution as the daily close (see get_station_fees).
      const settings = loadStationFeeSettings();
      const resolution = resolveStationFeeModels(fees, orders, settings);
      const notes: string[] = [];
      const modelSummary = [...resolution.byStation.values()]
        .map((m) => `${m.key}: ${formatFeeModel(m.model)} (${m.provenance})`)
        .join(", ");
      notes.push(`station fee models — ${modelSummary}`);
      const unconfigured = [...resolution.byStation.values()].filter((m) => m.provenance === "default");
      if (unconfigured.length > 0) {
        notes.push(
          `station(s) ${unconfigured.map((m) => m.key).join(", ")} have no config entry and no derivable rate — their fees are matched against the generic ${DEFAULT_BROKER_FEE_PCT}% default, so sunk-fee figures there may be off; pin them in ~/.eve-sde/config.json stationFees`
        );
      }
      const match = matchBrokerFees(fees, orders, [], expectedFeeResolver(resolution));
      if (match.unmatchedTotal > 0) {
        notes.push(
          `${match.unmatchedTotal.toFixed(0)} ISK of broker fees couldn't be confidently matched to an order — excluded from sunk-fee attribution, so these figures are a floor, not an estimate`
        );
      }
      const orderFees = new Map(match.matched.map((m) => [m.orderId, m.amount]));
      const sunkByType = computeOpenChainSunkFees(orders, orderFees);

      // Acquisition attribution: every open lot IS a buy transaction, so the
      // buy-campaign fees (re-placed buy orders before the fill) are
      // attributed straight onto lots — as an all-in cost-basis overlay, never
      // folded into unit_cost (fees are already expensed as brokerFeesPaid
      // when paid; capitalizing them would double-count realized COGS).
      const acquisition = attributeAcquisitionFees(
        orders,
        orderFees,
        rows.map((r) => ({
          transactionId: r.buy_transaction_id,
          date: r.date,
          typeId: r.type_id,
          quantity: r.original_qty,
        }))
      );
      const unattributedLots = rows.filter((r) => !acquisition.perPurchase.has(r.buy_transaction_id)).length;
      if (unattributedLots > 0) {
        notes.push(
          `${unattributedLots} of ${rows.length} open lot(s) predate any synced buy order of their type — acquisition-fee attribution skipped for them`
        );
      }

      // Pre-acquisition churn: fees sunk into live buy campaigns that have
      // produced no units yet — they attach to future lots once fills land.
      const openBuySunkFees = [...computeOpenBuySunkFees(orders, orderFees).values()].sort(
        (a, b) => b.total - a.total
      );

      const lots = rows.map((r) => {
        const sunk = sunkByType.get(r.type_id);
        const perUnit = sunk?.perUnit ?? 0;
        const perUnitRelisting = sunk?.perUnitRelisting ?? 0;
        const acq = acquisition.perPurchase.get(r.buy_transaction_id);
        const acqPerUnit = acq ? acq.total / Math.max(r.original_qty, 1) : 0;
        const allInUnitCost = r.unit_cost + acqPerUnit;
        return {
          buyTransactionId: r.buy_transaction_id,
          typeName: enrichTypeName(sdeDb, r.type_id),
          typeId: r.type_id,
          date: r.date,
          originalQty: r.original_qty,
          remainingQty: r.remaining_qty,
          unitCost: r.unit_cost,
          costBasis: r.remaining_qty * r.unit_cost,
          exitCampaignOrders: sunk?.orderCount ?? 0,
          sunkExitFeesPerUnit: perUnit,
          sunkExitFees: perUnit * r.remaining_qty,
          sunkRelistingFeesPerUnit: perUnitRelisting,
          sunkRelistingFees: perUnitRelisting * r.remaining_qty,
          acquisitionFeesPerUnit: acqPerUnit,
          acquisitionFees: acqPerUnit * r.remaining_qty,
          allInUnitCost,
          allInCostBasis: allInUnitCost * r.remaining_qty,
        };
      });
      return jsonResult({
        count: lots.length,
        stationFeeModels: Object.fromEntries(
          [...resolution.byStation.values()].map((m) => [m.key, { fee: formatFeeModel(m.model), model: m.model, provenance: m.provenance }])
        ),
        notes,
        openBuySunkFees,
        lots,
      });
    }
  );
}
