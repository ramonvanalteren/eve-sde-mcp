/**
 * Pure FIFO cost-basis engine. No I/O, no database access — takes plain
 * data in, returns plain data out, so it can be unit-tested directly.
 */

export interface TransactionInput {
  transactionId: number;
  date: string;
  typeId: number;
  quantity: number;
  unitPrice: number;
  isBuy: boolean;
}

export interface LotState {
  buyTransactionId: number;
  typeId: number;
  date: string;
  originalQty: number;
  remainingQty: number;
  unitCost: number;
}

export interface ConsumptionEvent {
  sellTransactionId: number;
  buyTransactionId: number | null;
  typeId: number;
  date: string;
  quantity: number;
  unitCost: number | null;
  unitSellPrice: number;
  /** True when a sell outran available lots — cost basis predates the ledger
   *  or the units arrived via a non-market source (loot, reward, contract,
   *  manufacturing, corp transfer). Excluded from realized COGS by design;
   *  surfaced separately so the close report flags it instead of guessing. */
  unmatched: boolean;
}

export interface FifoResult {
  /** New or mutated lots only — what the caller needs to persist. */
  updatedLots: LotState[];
  newLots: LotState[];
  consumptions: ConsumptionEvent[];
}

/**
 * Apply a batch of new transactions on top of existing open lots, oldest
 * lot consumed first per type_id. Transactions are sorted internally by
 * (date, transactionId) so caller order doesn't matter.
 */
export function applyFifo(existingLots: LotState[], transactions: TransactionInput[]): FifoResult {
  const lotsById = new Map<number, LotState>();
  const queues = new Map<number, LotState[]>();

  for (const lot of existingLots) {
    const copy = { ...lot };
    lotsById.set(copy.buyTransactionId, copy);
    if (copy.remainingQty > 0) {
      const q = queues.get(copy.typeId) ?? [];
      q.push(copy);
      queues.set(copy.typeId, q);
    }
  }
  for (const q of queues.values()) {
    q.sort((a, b) => a.date.localeCompare(b.date) || a.buyTransactionId - b.buyTransactionId);
  }

  const sorted = [...transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.transactionId - b.transactionId
  );

  const newLots: LotState[] = [];
  const consumptions: ConsumptionEvent[] = [];
  const touchedIds = new Set<number>();

  for (const tx of sorted) {
    if (tx.isBuy) {
      const lot: LotState = {
        buyTransactionId: tx.transactionId,
        typeId: tx.typeId,
        date: tx.date,
        originalQty: tx.quantity,
        remainingQty: tx.quantity,
        unitCost: tx.unitPrice,
      };
      lotsById.set(lot.buyTransactionId, lot);
      const q = queues.get(tx.typeId) ?? [];
      q.push(lot);
      queues.set(tx.typeId, q);
      newLots.push(lot);
      continue;
    }

    let remaining = tx.quantity;
    const q = queues.get(tx.typeId) ?? [];
    while (remaining > 0 && q.length > 0) {
      const lot = q[0];
      const take = Math.min(remaining, lot.remainingQty);
      lot.remainingQty -= take;
      remaining -= take;
      touchedIds.add(lot.buyTransactionId);
      consumptions.push({
        sellTransactionId: tx.transactionId,
        buyTransactionId: lot.buyTransactionId,
        typeId: tx.typeId,
        date: tx.date,
        quantity: take,
        unitCost: lot.unitCost,
        unitSellPrice: tx.unitPrice,
        unmatched: false,
      });
      if (lot.remainingQty === 0) q.shift();
    }
    if (remaining > 0) {
      consumptions.push({
        sellTransactionId: tx.transactionId,
        buyTransactionId: null,
        typeId: tx.typeId,
        date: tx.date,
        quantity: remaining,
        unitCost: null,
        unitSellPrice: tx.unitPrice,
        unmatched: true,
      });
    }
  }

  const updatedExisting = existingLots
    .filter((l) => touchedIds.has(l.buyTransactionId))
    .map((l) => lotsById.get(l.buyTransactionId)!);

  return {
    updatedLots: [...newLots, ...updatedExisting],
    newLots,
    consumptions,
  };
}

export interface RealizedSummary {
  revenue: number;
  cogs: number;
  grossPnl: number;
  unmatchedRevenue: number;
  unmatchedQty: number;
}

/** Realized P&L before fees/tax — those are period expenses, summed separately from actual journal entries (see summarizeFeesAndTax). */
export function summarizeRealized(consumptions: ConsumptionEvent[]): RealizedSummary {
  let revenue = 0;
  let cogs = 0;
  let unmatchedRevenue = 0;
  let unmatchedQty = 0;

  for (const c of consumptions) {
    const rev = c.quantity * c.unitSellPrice;
    if (c.unmatched) {
      unmatchedRevenue += rev;
      unmatchedQty += c.quantity;
      continue;
    }
    revenue += rev;
    cogs += c.quantity * (c.unitCost ?? 0);
  }

  return { revenue, cogs, grossPnl: revenue - cogs, unmatchedRevenue, unmatchedQty };
}

export interface JournalEntryInput {
  refType: string;
  amount: number;
}

/** Sums actual ISK paid in fees/tax from journal entries — real amounts, not an estimated percentage, so relisting shows up honestly. */
export function summarizeFeesAndTax(entries: JournalEntryInput[]): { brokerFees: number; salesTax: number } {
  let brokerFees = 0;
  let salesTax = 0;
  for (const e of entries) {
    if (e.refType === "brokers_fee") brokerFees += Math.abs(e.amount);
    else if (e.refType === "transaction_tax") salesTax += Math.abs(e.amount);
  }
  return { brokerFees, salesTax };
}

/**
 * ref_types that represent ordinary station-trading activity, as opposed to
 * external cashflow (transfers, contracts, insurance, PLEX, etc). Notably
 * includes market_escrow: capital moving between available wallet balance
 * and an open buy order's escrow. That's a transfer within the trading
 * system (both sides are already counted in NAV separately), not a gain,
 * loss, or genuine external cashflow — so it must never land in
 * nonTradingCashflow just because it isn't a fee/tax/fill. (ESI also labels
 * every market_escrow entry "Market escrow release" regardless of
 * direction — the sign of `amount` is what actually distinguishes a capture
 * from a release, not the description text.)
 */
const TRADING_REF_TYPES = new Set(["market_transaction", "brokers_fee", "transaction_tax", "market_escrow"]);

export interface CashflowSplit {
  /** Net market_escrow movement: negative = capital newly committed to buy orders, positive = escrow released. Routine, not an anomaly. */
  escrowMovement: number;
  /** Everything outside ordinary trading activity — transfers, contracts, insurance, etc. Worth flagging when nonzero. */
  nonTradingCashflow: number;
}

export function splitCashflow(entries: JournalEntryInput[]): CashflowSplit {
  let escrowMovement = 0;
  let nonTradingCashflow = 0;
  for (const e of entries) {
    if (e.refType === "market_escrow") escrowMovement += e.amount;
    else if (!TRADING_REF_TYPES.has(e.refType)) nonTradingCashflow += e.amount;
  }
  return { escrowMovement, nonTradingCashflow };
}

export type MarketPriceLookup = (typeId: number) => number | undefined;

export interface UnrealizedPerType {
  typeId: number;
  qty: number;
  cost: number;
  marketValue: number;
  unrealizedPnl: number;
  priceMissing: boolean;
}

export interface UnrealizedResult {
  totalCost: number;
  totalMarketValue: number;
  unrealizedPnl: number;
  perType: UnrealizedPerType[];
}

/** Marks remaining open lots to market at current best bid (conservative — what you'd actually get selling now). Falls back to cost (0 P&L) when no live price is available, rather than fabricating a gain or loss. */
export function computeUnrealized(lots: LotState[], bestBid: MarketPriceLookup): UnrealizedResult {
  const byType = new Map<number, { qty: number; cost: number }>();
  for (const lot of lots) {
    if (lot.remainingQty <= 0) continue;
    const cur = byType.get(lot.typeId) ?? { qty: 0, cost: 0 };
    cur.qty += lot.remainingQty;
    cur.cost += lot.remainingQty * lot.unitCost;
    byType.set(lot.typeId, cur);
  }

  const perType: UnrealizedPerType[] = [];
  let totalCost = 0;
  let totalMarketValue = 0;

  for (const [typeId, { qty, cost }] of byType) {
    const bid = bestBid(typeId);
    const priceMissing = bid === undefined;
    const marketValue = priceMissing ? cost : qty * bid;
    totalCost += cost;
    totalMarketValue += marketValue;
    perType.push({ typeId, qty, cost, marketValue, unrealizedPnl: marketValue - cost, priceMissing });
  }

  return { totalCost, totalMarketValue, unrealizedPnl: totalMarketValue - totalCost, perType };
}
