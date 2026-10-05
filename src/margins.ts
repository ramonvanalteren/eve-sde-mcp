/**
 * Pure margin math for get_portfolio_margins, kept free of ESI and database
 * imports so it can be unit-tested directly.
 */

export interface MarketOrderLike {
  price: number;
  is_buy_order: boolean;
  location_id: number;
}

export interface MarginRow {
  typeId: number;
  typeName: string;
  bestBuy: number | null;
  bestSell: number | null;
  spread: number | null;
  margin: number | null;
  profitPerUnit: number | null;
  buyOrderCount: number;
  sellOrderCount: number;
}

/**
 * Best buy/sell at one location and the margin between them after broker fee
 * and sales tax. Fields that cannot be computed (no orders on a side) are null
 * here; use compactMarginRow for the shape sent to callers.
 */
export function computeMarginRow(
  typeId: number,
  typeName: string,
  allOrders: MarketOrderLike[],
  locationId: number,
  salesTaxPct: number,
  brokerFeePct: number
): MarginRow {
  const orders = allOrders.filter((o) => o.location_id === locationId);
  const buyOrders = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
  const sellOrders = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);

  const bestBuy = buyOrders[0]?.price ?? null;
  const bestSell = sellOrders[0]?.price ?? null;

  let margin: number | null = null;
  let profitPerUnit: number | null = null;
  if (bestBuy !== null && bestSell !== null) {
    const buyTotal = bestBuy * (1 + brokerFeePct / 100);
    const sellNet = bestSell * (1 - salesTaxPct / 100 - brokerFeePct / 100);
    profitPerUnit = sellNet - buyTotal;
    margin = (profitPerUnit / buyTotal) * 100;
  }

  return {
    typeId,
    typeName,
    bestBuy,
    bestSell,
    spread: bestBuy && bestSell ? ((bestSell - bestBuy) / bestSell) * 100 : null,
    margin,
    profitPerUnit,
    buyOrderCount: buyOrders.length,
    sellOrderCount: sellOrders.length,
  };
}

/** Copy of obj without keys whose value is null or undefined. */
export function omitNulls<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The shape returned to callers: an absent side is an absent key, not four
 * nulls. A buy-side call at a location with no sell orders returns just the
 * best buy and the order counts.
 */
export function compactMarginRow(row: MarginRow): Partial<MarginRow> {
  return omitNulls(row);
}
