/**
 * Groups a day's already-computed realized consumptions, matched broker
 * fees, and (when available) unrealized mark-to-market by type_id, to
 * produce a per-position view of a day-close instead of one portfolio-wide
 * total. Pure, no I/O — the caller (close.ts) is responsible for gathering
 * the inputs from the ledger and ESI.
 */

export interface PositionConsumption {
  typeId: number;
  quantity: number;
  unitCost: number | null;
  unitSellPrice: number;
  unmatched: boolean;
}

export interface PositionUnrealized {
  typeId: number;
  qty: number;
  cost: number;
  marketValue: number;
  unrealizedPnl: number;
  priceMissing: boolean;
}

export interface PositionMatchedFee {
  typeId: number;
  amount: number;
  classification: "new_listing" | "relist";
}

export interface PositionClose {
  typeId: number;
  realizedRevenue: number;
  realizedCogs: number;
  realizedGrossPnl: number;
  /** Revenue from sells with no known cost basis for this type — excluded from realizedGrossPnl/realizedPnlNet, same philosophy as the portfolio-level figure. */
  unmatchedRevenue: number;
  unmatchedQty: number;
  /** Exact, not estimated: sales tax is a flat % of sell value (Accounting skill + standings), not item-specific, so allocating the day's total tax by this position's share of matched revenue reconstructs the real per-position amount. */
  allocatedSalesTax: number;
  /** Only fees matchBrokerFees could confidently attribute to an order of this type — see fees.ts. Portfolio-level brokerFeesUnmatched isn't distributed here since we don't know which type it belongs to. */
  brokerFeesNewListing: number;
  brokerFeesRelisting: number;
  realizedPnlNet: number;
  unrealizedPnl: number | null;
  remainingQty: number | null;
  costBasis: number | null;
  marketValue: number | null;
  priceMissing: boolean;
}

export function buildPositionCloses(
  consumptions: PositionConsumption[],
  matchedFees: PositionMatchedFee[],
  totalSalesTax: number,
  unrealizedByType: PositionUnrealized[]
): PositionClose[] {
  const byType = new Map<number, PositionClose>();

  function get(typeId: number): PositionClose {
    let p = byType.get(typeId);
    if (!p) {
      p = {
        typeId,
        realizedRevenue: 0,
        realizedCogs: 0,
        realizedGrossPnl: 0,
        unmatchedRevenue: 0,
        unmatchedQty: 0,
        allocatedSalesTax: 0,
        brokerFeesNewListing: 0,
        brokerFeesRelisting: 0,
        realizedPnlNet: 0,
        unrealizedPnl: null,
        remainingQty: null,
        costBasis: null,
        marketValue: null,
        priceMissing: false,
      };
      byType.set(typeId, p);
    }
    return p;
  }

  // Tax is charged on every sell regardless of whether we know its cost
  // basis, so the rate's denominator has to include unmatched revenue too —
  // excluding it would overstate the effective rate and misallocate tax
  // onto positions whose cost basis we do know.
  let totalRevenueAllSells = 0;
  for (const c of consumptions) {
    const p = get(c.typeId);
    const revenue = c.quantity * c.unitSellPrice;
    totalRevenueAllSells += revenue;
    if (c.unmatched) {
      p.unmatchedRevenue += revenue;
      p.unmatchedQty += c.quantity;
    } else {
      p.realizedRevenue += revenue;
      p.realizedCogs += c.quantity * (c.unitCost ?? 0);
    }
  }
  for (const p of byType.values()) {
    p.realizedGrossPnl = p.realizedRevenue - p.realizedCogs;
  }

  const taxRate = totalRevenueAllSells > 0 ? totalSalesTax / totalRevenueAllSells : 0;
  for (const p of byType.values()) {
    // Only the matched-revenue share feeds realizedPnlNet, kept internally
    // consistent with realizedGrossPnl (also matched-only).
    p.allocatedSalesTax = p.realizedRevenue * taxRate;
  }

  for (const f of matchedFees) {
    const p = get(f.typeId);
    if (f.classification === "new_listing") p.brokerFeesNewListing += f.amount;
    else p.brokerFeesRelisting += f.amount;
  }

  for (const u of unrealizedByType) {
    const p = get(u.typeId);
    p.unrealizedPnl = u.unrealizedPnl;
    p.remainingQty = u.qty;
    p.costBasis = u.cost;
    p.marketValue = u.marketValue;
    p.priceMissing = u.priceMissing;
  }

  for (const p of byType.values()) {
    p.realizedPnlNet = p.realizedGrossPnl - p.allocatedSalesTax - p.brokerFeesNewListing - p.brokerFeesRelisting;
  }

  return [...byType.values()].sort((a, b) => a.typeId - b.typeId);
}
