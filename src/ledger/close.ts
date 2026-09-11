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
import { matchBrokerFees, estimateBrokerFeePct, type BrokerFeeEntry, type OrderRecord } from "./fees.js";
import { buildPositionCloses, type PositionConsumption, type PositionClose } from "./positions.js";

const DEFAULT_BROKER_FEE_PCT = 1.0;
// Matches get_portfolio_margins's own default (Accounting V + no standings);
// pass explicitly for the character's actual rate, same rule as broker_fee_pct.
const DEFAULT_SALES_TAX_PCT = 3.6;

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

/**
 * Fetches net-realizable sell value per unit for mark-to-market: best sell
 * (ask) price at Jita, net of sales tax. Every lot in the ledger comes from
 * an actually-filled buy (see applyFifo) — i.e. already-owned inventory,
 * never an open/unfilled buy order — so the economically relevant price is
 * what selling it would realize, not the buy-side bid. (Bug: an earlier
 * version used bestBuy here, understating unrealized P&L by roughly the
 * full bid-ask spread on every held position — confirmed on Angel Brass Tag,
 * where bestBuy/bestSell differed by ~22%.) Broker fee is deliberately not
 * netted here: it's already a sunk cost once an item is listed (charged at
 * listing time, in brokerFeesPaid), and for not-yet-listed hangar stock this
 * is still a reasonable upper-bound estimate rather than a guess at listing
 * status per position.
 */
async function fetchNetSellPrices(typeIds: number[], salesTaxPct: number): Promise<Map<number, number>> {
  const prices = new Map<number, number>();
  await mapConcurrent(typeIds, MAX_CONCURRENT_ESI, async (typeId) => {
    try {
      const orders = await esiGetAll<EsiOrder>(
        `/markets/${THE_FORGE}/orders/?type_id=${typeId}&order_type=sell`,
        { public: true, cacheTtlMs: ESI_CACHE_TTL }
      );
      const atJita = orders.filter((o) => o.location_id === JITA_TRADE_HUB);
      const bestSell = atJita.reduce<number | undefined>(
        (min, o) => (min === undefined || o.price < min ? o.price : min),
        undefined
      );
      if (bestSell !== undefined) prices.set(typeId, bestSell * (1 - salesTaxPct / 100));
    } catch {
      // leave unset — computeUnrealized falls back to cost basis for missing prices
    }
  });
  return prices;
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
  /** Best-effort split of brokerFeesPaid by cause — see fees.ts for the matching caveats. Adds up to less than brokerFeesPaid when some fees couldn't be confidently matched (brokerFeesUnmatched covers the gap). */
  brokerFeesNewListings: number;
  brokerFeesRelisting: number;
  brokerFeesUnmatched: number;
  /** The rate actually used for order/fee correlation — either what was passed, or derived from history (see flags for which). */
  brokerFeePctUsed: number;
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
export async function runDailyClose(
  characterId: number | undefined,
  closeDate?: string,
  brokerFeePct?: number,
  salesTaxPct: number = DEFAULT_SALES_TAX_PCT
): Promise<DailyCloseReport> {
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
    .prepare(`SELECT id, date, ref_type, amount FROM wallet_journal WHERE character_id = ? AND date >= ? AND date < ?`)
    .all(char.characterId, start, end) as Array<{ id: number; date: string; ref_type: string; amount: number | null }>;
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

  // Correlate brokers_fee entries to the order that caused them (heuristic —
  // see fees.ts for why ESI leaves us no direct linkage) to split new-listing
  // fees from relisting fees.
  const feeEntries: BrokerFeeEntry[] = journalRows
    .filter((r) => r.ref_type === "brokers_fee")
    .map((r) => ({ journalId: r.id, date: r.date, amount: r.amount ?? 0 }));

  const candidateOrderRows = db
    .prepare(
      `SELECT order_id, type_id, is_buy_order, price, volume_total, issued, state
       FROM orders WHERE character_id = ? AND issued >= ? AND issued < ?`
    )
    .all(char.characterId, start, end) as Array<{
    order_id: number;
    type_id: number;
    is_buy_order: number;
    price: number;
    volume_total: number;
    issued: string;
    state: OrderRecord["state"];
  }>;
  const priorOrderRows = db
    .prepare(
      `SELECT order_id, type_id, is_buy_order, price, volume_total, issued, state
       FROM orders WHERE character_id = ? AND state = 'cancelled' AND issued < ?`
    )
    .all(char.characterId, end) as typeof candidateOrderRows;

  const toOrderRecord = (r: (typeof candidateOrderRows)[number]): OrderRecord => ({
    orderId: r.order_id,
    typeId: r.type_id,
    isBuyOrder: r.is_buy_order === 1,
    price: r.price,
    volumeTotal: r.volume_total,
    issued: r.issued,
    state: r.state,
  });

  let resolvedBrokerFeePct = brokerFeePct;
  if (resolvedBrokerFeePct === undefined) {
    const allFeeRows = db
      .prepare(`SELECT id, date, amount FROM wallet_journal WHERE character_id = ? AND ref_type = 'brokers_fee'`)
      .all(char.characterId) as Array<{ id: number; date: string; amount: number | null }>;
    const allOrderRows = db
      .prepare(`SELECT order_id, type_id, is_buy_order, price, volume_total, issued, state FROM orders WHERE character_id = ?`)
      .all(char.characterId) as typeof candidateOrderRows;

    const estimate = estimateBrokerFeePct(
      allFeeRows.map((r) => ({ journalId: r.id, date: r.date, amount: r.amount ?? 0 })),
      allOrderRows.map(toOrderRecord)
    );
    if (estimate.estimatedPct !== null) {
      resolvedBrokerFeePct = estimate.estimatedPct;
      flags.push(
        `broker_fee_pct not provided — derived ${estimate.estimatedPct.toFixed(2)}% from ${estimate.sampleCount} unambiguous historical fee/order pairs. Pass broker_fee_pct explicitly if this looks wrong (e.g. standings or skills recently changed).`
      );
    } else {
      resolvedBrokerFeePct = DEFAULT_BROKER_FEE_PCT;
      flags.push(
        `broker_fee_pct not provided and not enough unambiguous fee history yet to derive it (have ${estimate.sampleCount} sample(s)) — using generic default ${DEFAULT_BROKER_FEE_PCT}%, which may misclassify new-listing/relist matches. Pass it explicitly for a reliable split, or re-run once more history is synced.`
      );
    }
  }

  const feeMatch = matchBrokerFees(
    feeEntries,
    candidateOrderRows.map(toOrderRecord),
    priorOrderRows.map(toOrderRecord),
    resolvedBrokerFeePct
  );
  if (feeMatch.unmatchedTotal > 0 && brokerFees > 0 && feeMatch.unmatchedTotal / brokerFees > 0.2) {
    flags.push(
      `${feeMatch.unmatchedTotal.toFixed(0)} of ${brokerFees.toFixed(0)} ISK in broker fees today couldn't be confidently matched to a specific order (no close-enough candidate, or two orders too close to call) — new-listing/relist split below is incomplete; the total broker_fees_paid figure is still exact.`
    );
  }

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
    const netSellPrices = await fetchNetSellPrices(typeIds, salesTaxPct);
    const unrealized = computeUnrealized(lots, (typeId) => netSellPrices.get(typeId));
    unrealizedPnl = unrealized.unrealizedPnl;
    inventoryMarketValue = unrealized.totalMarketValue;

    const missingPrices = unrealized.perType.filter((p) => p.priceMissing);
    if (missingPrices.length > 0) {
      flags.push(
        `No live Jita sell order for ${missingPrices.length} held type(s) — valued at cost for this close, not true market value.`
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
      opening_nav, closing_nav, non_trading_cashflow, escrow_movement,
      broker_fees_new_listings, broker_fees_relisting, broker_fees_unmatched, broker_fee_pct_used,
      reconciliation_gap, flags, computed_at
    ) VALUES (
      @characterId, @closeDate, @openingWalletBalance, @closingWalletBalance,
      @realizedRevenue, @realizedCogs, @realizedPnlGross, @salesTaxPaid, @brokerFeesPaid, @realizedPnlNet,
      @unmatchedSellRevenue, @unmatchedSellQty, @unrealizedPnl, @inventoryMarketValue, @escrowCommitted,
      @openingNav, @closingNav, @nonTradingCashflow, @escrowMovement,
      @brokerFeesNewListings, @brokerFeesRelisting, @brokerFeesUnmatched, @brokerFeePctUsed,
      @reconciliationGap, @flags, datetime('now')
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
      broker_fees_new_listings = excluded.broker_fees_new_listings,
      broker_fees_relisting = excluded.broker_fees_relisting,
      broker_fees_unmatched = excluded.broker_fees_unmatched,
      broker_fee_pct_used = excluded.broker_fee_pct_used,
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
    brokerFeesNewListings: feeMatch.newListingTotal,
    brokerFeesRelisting: feeMatch.relistTotal,
    brokerFeesUnmatched: feeMatch.unmatchedTotal,
    brokerFeePctUsed: resolvedBrokerFeePct,
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
    brokerFeesNewListings: feeMatch.newListingTotal,
    brokerFeesRelisting: feeMatch.relistTotal,
    brokerFeesUnmatched: feeMatch.unmatchedTotal,
    brokerFeePctUsed: resolvedBrokerFeePct,
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

export interface PerPositionCloseReport {
  characterId: number;
  characterName: string;
  closeDate: string;
  isToday: boolean;
  brokerFeePctUsed: number;
  positions: PositionClose[];
  flags: string[];
}

/**
 * Per-position breakdown of a day-close: realized P&L, allocated sales tax,
 * and matched broker fees grouped by type_id, plus unrealized mark-to-market
 * for currently-held positions (today only, same limitation as the
 * portfolio-level close). Not separately persisted — it's a deterministic
 * view recomputed on demand from the same permanently-stored ledger data
 * (lot_consumptions, orders, wallet_journal) the aggregate close uses, so
 * there's nothing to gain from storing it twice.
 *
 * Always runs the aggregate close first (same sync + FIFO application, and
 * to resolve brokerFeePctUsed consistently) — calling this alone is
 * sufficient, no need to call run_daily_close separately first.
 */
export async function runDailyClosePerPosition(
  characterId: number | undefined,
  closeDate?: string,
  brokerFeePct?: number,
  salesTaxPct: number = DEFAULT_SALES_TAX_PCT
): Promise<PerPositionCloseReport> {
  const aggregate = await runDailyClose(characterId, closeDate, brokerFeePct, salesTaxPct);
  const db = getLedgerDb();
  const { start, end } = dayRange(aggregate.closeDate);

  const consumptionRows = db
    .prepare(
      `SELECT type_id, quantity, unit_cost, unit_sell_price, unmatched
       FROM lot_consumptions WHERE character_id = ? AND date >= ? AND date < ?`
    )
    .all(aggregate.characterId, start, end) as Array<{
    type_id: number;
    quantity: number;
    unit_cost: number | null;
    unit_sell_price: number;
    unmatched: number;
  }>;
  const consumptions: PositionConsumption[] = consumptionRows.map((r) => ({
    typeId: r.type_id,
    quantity: r.quantity,
    unitCost: r.unit_cost,
    unitSellPrice: r.unit_sell_price,
    unmatched: r.unmatched === 1,
  }));

  const feeEntries: BrokerFeeEntry[] = (
    db
      .prepare(
        `SELECT id, date, amount FROM wallet_journal
         WHERE character_id = ? AND ref_type = 'brokers_fee' AND date >= ? AND date < ?`
      )
      .all(aggregate.characterId, start, end) as Array<{ id: number; date: string; amount: number | null }>
  ).map((r) => ({ journalId: r.id, date: r.date, amount: r.amount ?? 0 }));

  const candidateOrderRows = db
    .prepare(
      `SELECT order_id, type_id, is_buy_order, price, volume_total, issued, state
       FROM orders WHERE character_id = ? AND issued >= ? AND issued < ?`
    )
    .all(aggregate.characterId, start, end) as Array<{
    order_id: number;
    type_id: number;
    is_buy_order: number;
    price: number;
    volume_total: number;
    issued: string;
    state: OrderRecord["state"];
  }>;
  const priorOrderRows = db
    .prepare(
      `SELECT order_id, type_id, is_buy_order, price, volume_total, issued, state
       FROM orders WHERE character_id = ? AND state = 'cancelled' AND issued < ?`
    )
    .all(aggregate.characterId, end) as typeof candidateOrderRows;

  const toOrderRecord = (r: (typeof candidateOrderRows)[number]): OrderRecord => ({
    orderId: r.order_id,
    typeId: r.type_id,
    isBuyOrder: r.is_buy_order === 1,
    price: r.price,
    volumeTotal: r.volume_total,
    issued: r.issued,
    state: r.state,
  });

  const feeMatch = matchBrokerFees(
    feeEntries,
    candidateOrderRows.map(toOrderRecord),
    priorOrderRows.map(toOrderRecord),
    aggregate.brokerFeePctUsed
  );

  let unrealizedByType: ReturnType<typeof computeUnrealized>["perType"] = [];
  if (aggregate.isToday) {
    const lotRows = db
      .prepare(
        `SELECT buy_transaction_id, type_id, date, original_qty, remaining_qty, unit_cost
         FROM lots WHERE character_id = ? AND remaining_qty > 0`
      )
      .all(aggregate.characterId) as Array<{
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
    // Same ESI calls the aggregate close just made for the same type_ids —
    // effectively free, they hit the response cache (ESI_CACHE_TTL) rather
    // than round-tripping again.
    const netSellPrices = await fetchNetSellPrices(typeIds, salesTaxPct);
    unrealizedByType = computeUnrealized(lots, (typeId) => netSellPrices.get(typeId)).perType;
  }

  const positions = buildPositionCloses(consumptions, feeMatch.matched, aggregate.salesTaxPaid, unrealizedByType);

  return {
    characterId: aggregate.characterId,
    characterName: aggregate.characterName,
    closeDate: aggregate.closeDate,
    isToday: aggregate.isToday,
    brokerFeePctUsed: aggregate.brokerFeePctUsed,
    positions,
    flags: aggregate.flags,
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
