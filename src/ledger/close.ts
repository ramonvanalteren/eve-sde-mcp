import { esiGet, esiGetAll, getActiveCharacter, ESI_CACHE_TTL } from "../auth/esi-client.js";
import { mapConcurrent } from "../tools/market.js";
import { getLedgerDb } from "./db.js";
import { syncWalletLedger } from "./sync.js";
import {
  applyFifo,
  summarizeRealized,
  summarizeFeesAndTax,
  splitCashflow,
  computeUnrealized,
  type LotState,
  type TransactionInput,
} from "./fifo.js";

const JITA_TRADE_HUB = 60003760;
const THE_FORGE = 10000002;
const MAX_CONCURRENT_ESI = 10;

interface EsiOrder {
  order_id: number;
  type_id: number;
  location_id: number;
  volume_remain: number;
  price: number;
  is_buy_order: boolean;
  escrow?: number;
}

interface EsiAsset {
  type_id: number;
  quantity: number;
}

function dayRange(closeDate: string): { start: string; end: string } {
  const start = new Date(`${closeDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid close_date "${closeDate}" — expected YYYY-MM-DD`);
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Run any transactions not yet processed through the FIFO engine, persisting
 * updated lot state + consumption events. Idempotent — transactions are
 * marked fifo_applied=1 once processed, so re-running is a no-op unless new
 * transactions arrived since the last run.
 */
function applyPendingFifo(characterId: number): { transactionsApplied: number; consumptions: number } {
  const db = getLedgerDb();

  const existingLotRows = db
    .prepare(
      `SELECT buy_transaction_id, type_id, date, original_qty, remaining_qty, unit_cost
       FROM lots WHERE character_id = ? AND remaining_qty > 0`
    )
    .all(characterId) as Array<{
    buy_transaction_id: number;
    type_id: number;
    date: string;
    original_qty: number;
    remaining_qty: number;
    unit_cost: number;
  }>;
  const existingLots: LotState[] = existingLotRows.map((r) => ({
    buyTransactionId: r.buy_transaction_id,
    typeId: r.type_id,
    date: r.date,
    originalQty: r.original_qty,
    remainingQty: r.remaining_qty,
    unitCost: r.unit_cost,
  }));

  const pendingRows = db
    .prepare(
      `SELECT transaction_id, date, type_id, quantity, unit_price, is_buy
       FROM wallet_transactions WHERE character_id = ? AND fifo_applied = 0
       ORDER BY date, transaction_id`
    )
    .all(characterId) as Array<{
    transaction_id: number;
    date: string;
    type_id: number;
    quantity: number;
    unit_price: number;
    is_buy: number;
  }>;

  if (pendingRows.length === 0) return { transactionsApplied: 0, consumptions: 0 };

  const pending: TransactionInput[] = pendingRows.map((r) => ({
    transactionId: r.transaction_id,
    date: r.date,
    typeId: r.type_id,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    isBuy: r.is_buy === 1,
  }));

  const result = applyFifo(existingLots, pending);
  const newIds = new Set(result.newLots.map((l) => l.buyTransactionId));

  const insertLot = db.prepare(`
    INSERT INTO lots (buy_transaction_id, character_id, type_id, date, original_qty, remaining_qty, unit_cost)
    VALUES (@buyTransactionId, @characterId, @typeId, @date, @originalQty, @remainingQty, @unitCost)
  `);
  const updateLot = db.prepare(`UPDATE lots SET remaining_qty = @remainingQty WHERE buy_transaction_id = @buyTransactionId`);
  const insertConsumption = db.prepare(`
    INSERT INTO lot_consumptions
      (character_id, sell_transaction_id, buy_transaction_id, type_id, date, quantity, unit_cost, unit_sell_price, unmatched)
    VALUES (@characterId, @sellTransactionId, @buyTransactionId, @typeId, @date, @quantity, @unitCost, @unitSellPrice, @unmatched)
  `);
  const markApplied = db.prepare(`UPDATE wallet_transactions SET fifo_applied = 1 WHERE transaction_id = ?`);

  db.transaction(() => {
    for (const lot of result.updatedLots) {
      if (newIds.has(lot.buyTransactionId)) {
        insertLot.run({
          buyTransactionId: lot.buyTransactionId,
          characterId,
          typeId: lot.typeId,
          date: lot.date,
          originalQty: lot.originalQty,
          remainingQty: lot.remainingQty,
          unitCost: lot.unitCost,
        });
      } else {
        updateLot.run({ buyTransactionId: lot.buyTransactionId, remainingQty: lot.remainingQty });
      }
    }
    for (const c of result.consumptions) {
      insertConsumption.run({
        characterId,
        sellTransactionId: c.sellTransactionId,
        buyTransactionId: c.buyTransactionId,
        typeId: c.typeId,
        date: c.date,
        quantity: c.quantity,
        unitCost: c.unitCost,
        unitSellPrice: c.unitSellPrice,
        unmatched: c.unmatched ? 1 : 0,
      });
    }
    for (const row of pendingRows) {
      markApplied.run(row.transaction_id);
    }
  })();

  return { transactionsApplied: pendingRows.length, consumptions: result.consumptions.length };
}

async function fetchBestBids(typeIds: number[]): Promise<Map<number, number>> {
  const bids = new Map<number, number>();
  await mapConcurrent(typeIds, MAX_CONCURRENT_ESI, async (typeId) => {
    try {
      const orders = await esiGetAll<EsiOrder>(
        `/markets/${THE_FORGE}/orders/?type_id=${typeId}&order_type=buy`,
        { public: true, cacheTtlMs: ESI_CACHE_TTL }
      );
      const atJita = orders.filter((o) => o.location_id === JITA_TRADE_HUB);
      const best = atJita.reduce<number | undefined>(
        (max, o) => (max === undefined || o.price > max ? o.price : max),
        undefined
      );
      if (best !== undefined) bids.set(typeId, best);
    } catch {
      // leave unset — computeUnrealized falls back to cost basis for missing prices
    }
  });
  return bids;
}

export interface DailyCloseReport {
  characterId: number;
  characterName: string;
  closeDate: string;
  isToday: boolean;
  openingWalletBalance: number | null;
  closingWalletBalance: number | null;
  realizedRevenue: number;
  realizedCogs: number;
  realizedPnlGross: number;
  salesTaxPaid: number;
  brokerFeesPaid: number;
  realizedPnlNet: number;
  unmatchedSellRevenue: number;
  unmatchedSellQty: number;
  unrealizedPnl: number | null;
  inventoryMarketValue: number | null;
  escrowCommitted: number | null;
  closingNav: number | null;
  openingNav: number | null;
  nonTradingCashflow: number;
  /** Net market_escrow journal movement for the day. Negative = capital newly committed to buy orders; positive = escrow released (cancellations/fills). Routine — not part of nonTradingCashflow and not flagged. */
  escrowMovement: number;
  reconciliationGap: number | null;
  flags: string[];
}

/**
 * Compute (and persist) the close for one UTC calendar day. Realized P&L,
 * fees, and tax are exact for any already-synced historical date. Unrealized
 * P&L / NAV require live market data, so they're only computed when
 * close_date is today — a past-dated close carries realized figures only,
 * with a flag explaining why unrealized is null.
 */
export async function runDailyClose(characterId: number | undefined, closeDate?: string): Promise<DailyCloseReport> {
  const char = await getActiveCharacter(characterId);
  await syncWalletLedger(char.characterId);
  applyPendingFifo(char.characterId);

  const date = closeDate ?? todayUtc();
  const isToday = date === todayUtc();
  const { start, end } = dayRange(date);
  const db = getLedgerDb();
  const flags: string[] = [];

  const consumptionRows = db
    .prepare(
      `SELECT sell_transaction_id, buy_transaction_id, type_id, date, quantity, unit_cost, unit_sell_price, unmatched
       FROM lot_consumptions WHERE character_id = ? AND date >= ? AND date < ?`
    )
    .all(char.characterId, start, end) as Array<{
    quantity: number;
    unit_cost: number | null;
    unit_sell_price: number;
    unmatched: number;
  }>;
  const realized = summarizeRealized(
    consumptionRows.map((r) => ({
      sellTransactionId: 0,
      buyTransactionId: null,
      typeId: 0,
      date: "",
      quantity: r.quantity,
      unitCost: r.unit_cost,
      unitSellPrice: r.unit_sell_price,
      unmatched: r.unmatched === 1,
    }))
  );
  if (realized.unmatchedQty > 0) {
    flags.push(
      `${realized.unmatchedQty} units sold with no known cost basis (revenue ${realized.unmatchedRevenue.toFixed(0)} ISK excluded from realized P&L) — likely predates the ledger or arrived via non-market means (loot, reward, contract, corp transfer).`
    );
  }

  const journalRows = db
    .prepare(`SELECT ref_type, amount FROM wallet_journal WHERE character_id = ? AND date >= ? AND date < ?`)
    .all(char.characterId, start, end) as Array<{ ref_type: string; amount: number | null }>;
  const { brokerFees, salesTax } = summarizeFeesAndTax(
    journalRows.map((r) => ({ refType: r.ref_type, amount: r.amount ?? 0 }))
  );

  const { escrowMovement: escrowMovementToday, nonTradingCashflow } = splitCashflow(
    journalRows.map((r) => ({ refType: r.ref_type, amount: r.amount ?? 0 }))
  );
  if (Math.abs(nonTradingCashflow) > 0) {
    flags.push(
      `${nonTradingCashflow.toFixed(0)} ISK moved via non-trading journal entries this day (transfers, contracts, insurance, etc.) — check get_wallet_journal for detail before trusting the NAV reconciliation.`
    );
  }
  // Deliberately not pushed to `flags` — routine order placement/reissue
  // shouldn't compete with genuine anomalies for attention. It's still
  // reported, just as a plain figure rather than something to investigate.

  const realizedPnlNet = realized.grossPnl - brokerFees - salesTax;

  const openingBalRow = db
    .prepare(
      `SELECT balance FROM wallet_journal WHERE character_id = ? AND date < ? AND balance IS NOT NULL
       ORDER BY date DESC LIMIT 1`
    )
    .get(char.characterId, start) as { balance: number } | undefined;
  const closingBalRow = db
    .prepare(
      `SELECT balance FROM wallet_journal WHERE character_id = ? AND date < ? AND balance IS NOT NULL
       ORDER BY date DESC LIMIT 1`
    )
    .get(char.characterId, end) as { balance: number } | undefined;

  let unrealizedPnl: number | null = null;
  let inventoryMarketValue: number | null = null;
  let escrowCommitted: number | null = null;
  let closingNav: number | null = null;

  if (isToday) {
    const lotRows = db
      .prepare(
        `SELECT buy_transaction_id, type_id, date, original_qty, remaining_qty, unit_cost
         FROM lots WHERE character_id = ? AND remaining_qty > 0`
      )
      .all(char.characterId) as Array<{
      buy_transaction_id: number;
      type_id: number;
      date: string;
      original_qty: number;
      remaining_qty: number;
      unit_cost: number;
    }>;
    const lots: LotState[] = lotRows.map((r) => ({
      buyTransactionId: r.buy_transaction_id,
      typeId: r.type_id,
      date: r.date,
      originalQty: r.original_qty,
      remainingQty: r.remaining_qty,
      unitCost: r.unit_cost,
    }));

    const typeIds = [...new Set(lots.map((l) => l.typeId))];
    const bids = await fetchBestBids(typeIds);
    const unrealized = computeUnrealized(lots, (typeId) => bids.get(typeId));
    unrealizedPnl = unrealized.unrealizedPnl;
    inventoryMarketValue = unrealized.totalMarketValue;

    const missingPrices = unrealized.perType.filter((p) => p.priceMissing);
    if (missingPrices.length > 0) {
      flags.push(
        `No live Jita buy-side price for ${missingPrices.length} held type(s) — valued at cost for this close, not true market value.`
      );
    }

    const orders = await esiGet<EsiOrder[]>(`/characters/${char.characterId}/orders/`, {
      characterId: char.characterId,
      cacheTtlMs: ESI_CACHE_TTL,
    });
    escrowCommitted = orders
      .filter((o) => o.is_buy_order)
      .reduce((sum, o) => sum + (o.escrow ?? 0), 0);

    const assets = await esiGetAll<EsiAsset>(`/characters/${char.characterId}/assets/`, {
      characterId: char.characterId,
      cacheTtlMs: ESI_CACHE_TTL,
    });
    const assetQtyByType = new Map<number, number>();
    for (const a of assets) {
      assetQtyByType.set(a.type_id, (assetQtyByType.get(a.type_id) ?? 0) + a.quantity);
    }
    const lotQtyByType = new Map<number, number>();
    for (const l of lots) lotQtyByType.set(l.typeId, (lotQtyByType.get(l.typeId) ?? 0) + l.remainingQty);
    const mismatchedTypes = new Set([...assetQtyByType.keys(), ...lotQtyByType.keys()]).size;
    let mismatches = 0;
    for (const typeId of new Set([...assetQtyByType.keys(), ...lotQtyByType.keys()])) {
      const assetQty = assetQtyByType.get(typeId) ?? 0;
      const lotQty = lotQtyByType.get(typeId) ?? 0;
      if (assetQty !== lotQty) mismatches++;
    }
    if (mismatches > 0) {
      flags.push(
        `${mismatches} of ${mismatchedTypes} held item type(s) have a live-asset quantity that doesn't match the FIFO ledger's remaining lots — reconcile manually (see get_character_assets vs lots) before trusting inventory value.`
      );
    }

    if (closingBalRow) {
      closingNav = closingBalRow.balance + escrowCommitted + inventoryMarketValue;
    }
  } else {
    flags.push("Past-dated close: unrealized P&L / NAV require live market data and are only computed for today's close.");
  }

  const prevClose = db
    .prepare(`SELECT closing_nav FROM daily_closes WHERE character_id = ? AND close_date < ? ORDER BY close_date DESC LIMIT 1`)
    .get(char.characterId, date) as { closing_nav: number | null } | undefined;
  const openingNav = prevClose?.closing_nav ?? null;

  let reconciliationGap: number | null = null;
  if (isToday && openingNav !== null && closingNav !== null) {
    const expectedChange = realizedPnlNet + nonTradingCashflow; // unrealized change vs prior close isn't isolated here since prior day's unrealized breakdown isn't retained per-type; NAV delta already includes it structurally.
    reconciliationGap = closingNav - openingNav - expectedChange - (unrealizedPnl ?? 0);
    if (Math.abs(reconciliationGap) > 1) {
      flags.push(
        `NAV reconciliation gap of ${reconciliationGap.toFixed(0)} ISK vs prior close — expected NAV change didn't fully match realized P&L + non-trading cashflow + unrealized P&L delta. Likely a mark-to-market shift on already-held lots between closes, not necessarily an error.`
      );
    }
  }

  db.prepare(
    `INSERT INTO daily_closes (
      character_id, close_date, opening_wallet_balance, closing_wallet_balance,
      realized_revenue, realized_cogs, realized_pnl_gross, sales_tax_paid, broker_fees_paid, realized_pnl_net,
      unmatched_sell_revenue, unmatched_sell_qty, unrealized_pnl, inventory_market_value, escrow_committed,
      opening_nav, closing_nav, non_trading_cashflow, escrow_movement, reconciliation_gap, flags, computed_at
    ) VALUES (
      @characterId, @closeDate, @openingWalletBalance, @closingWalletBalance,
      @realizedRevenue, @realizedCogs, @realizedPnlGross, @salesTaxPaid, @brokerFeesPaid, @realizedPnlNet,
      @unmatchedSellRevenue, @unmatchedSellQty, @unrealizedPnl, @inventoryMarketValue, @escrowCommitted,
      @openingNav, @closingNav, @nonTradingCashflow, @escrowMovement, @reconciliationGap, @flags, datetime('now')
    )
    ON CONFLICT(character_id, close_date) DO UPDATE SET
      opening_wallet_balance = excluded.opening_wallet_balance,
      closing_wallet_balance = excluded.closing_wallet_balance,
      realized_revenue = excluded.realized_revenue,
      realized_cogs = excluded.realized_cogs,
      realized_pnl_gross = excluded.realized_pnl_gross,
      sales_tax_paid = excluded.sales_tax_paid,
      broker_fees_paid = excluded.broker_fees_paid,
      realized_pnl_net = excluded.realized_pnl_net,
      unmatched_sell_revenue = excluded.unmatched_sell_revenue,
      unmatched_sell_qty = excluded.unmatched_sell_qty,
      unrealized_pnl = excluded.unrealized_pnl,
      inventory_market_value = excluded.inventory_market_value,
      escrow_committed = excluded.escrow_committed,
      opening_nav = excluded.opening_nav,
      closing_nav = excluded.closing_nav,
      non_trading_cashflow = excluded.non_trading_cashflow,
      escrow_movement = excluded.escrow_movement,
      reconciliation_gap = excluded.reconciliation_gap,
      flags = excluded.flags,
      computed_at = datetime('now')`
  ).run({
    characterId: char.characterId,
    closeDate: date,
    openingWalletBalance: openingBalRow?.balance ?? null,
    closingWalletBalance: closingBalRow?.balance ?? null,
    realizedRevenue: realized.revenue,
    realizedCogs: realized.cogs,
    realizedPnlGross: realized.grossPnl,
    salesTaxPaid: salesTax,
    brokerFeesPaid: brokerFees,
    realizedPnlNet,
    unmatchedSellRevenue: realized.unmatchedRevenue,
    unmatchedSellQty: realized.unmatchedQty,
    unrealizedPnl,
    inventoryMarketValue,
    escrowCommitted,
    openingNav,
    closingNav,
    nonTradingCashflow,
    escrowMovement: escrowMovementToday,
    reconciliationGap,
    flags: JSON.stringify(flags),
  });

  return {
    characterId: char.characterId,
    characterName: char.characterName,
    closeDate: date,
    isToday,
    openingWalletBalance: openingBalRow?.balance ?? null,
    closingWalletBalance: closingBalRow?.balance ?? null,
    realizedRevenue: realized.revenue,
    realizedCogs: realized.cogs,
    realizedPnlGross: realized.grossPnl,
    salesTaxPaid: salesTax,
    brokerFeesPaid: brokerFees,
    realizedPnlNet,
    unmatchedSellRevenue: realized.unmatchedRevenue,
    unmatchedSellQty: realized.unmatchedQty,
    unrealizedPnl,
    inventoryMarketValue,
    escrowCommitted,
    closingNav,
    openingNav,
    nonTradingCashflow,
    escrowMovement: escrowMovementToday,
    reconciliationGap,
    flags,
  };
}

export function getStoredClose(characterId: number, closeDate: string): Record<string, unknown> | undefined {
  return getLedgerDb()
    .prepare(`SELECT * FROM daily_closes WHERE character_id = ? AND close_date = ?`)
    .get(characterId, closeDate) as Record<string, unknown> | undefined;
}

export function getStoredCloseRange(
  characterId: number,
  fromDate: string,
  toDate: string
): Record<string, unknown>[] {
  return getLedgerDb()
    .prepare(`SELECT * FROM daily_closes WHERE character_id = ? AND close_date >= ? AND close_date <= ? ORDER BY close_date`)
    .all(characterId, fromDate, toDate) as Record<string, unknown>[];
}
