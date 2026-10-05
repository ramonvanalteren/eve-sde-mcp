/**
 * Compact views of an order book and of market history, free of ESI and
 * database imports so they can be unit-tested directly.
 *
 * get_region_orders returned ten full ESI order objects per call (about 3.4k
 * characters), and a depth check needed one call per item. The compact format
 * keeps what a margin check needs: price, units, where, how far it reaches, how
 * old it is, plus how many units sit within 1/3/5% of the best price on each
 * side.
 */

export interface BookOrder {
  order_id: number;
  price: number;
  volume_remain: number;
  volume_total: number;
  location_id: number;
  range?: string;
  issued: string;
  is_buy_order: boolean;
}

export interface CompactOrder {
  price: number;
  remain: number;
  total: number;
  loc: number;
  range: string | null;
  ageH: number;
}

export interface Depth {
  within1pct: number;
  within3pct: number;
  within5pct: number;
}

const HOUR_MS = 3_600_000;

export function compactOrder(o: BookOrder, nowMs: number): CompactOrder {
  const ageH = Math.max(0, (nowMs - new Date(o.issued).getTime()) / HOUR_MS);
  return {
    price: o.price,
    remain: o.volume_remain,
    total: o.volume_total,
    loc: o.location_id,
    range: o.range ?? null,
    ageH: Math.round(ageH * 10) / 10,
  };
}

/**
 * Units within 1%, 3% and 5% of the best price. `sorted` must be best-first
 * (highest price for buys, lowest for sells).
 */
export function depthWithin(sorted: Array<{ price: number; volume_remain: number }>, side: "buy" | "sell"): Depth {
  const best = sorted[0]?.price;
  const out: Depth = { within1pct: 0, within3pct: 0, within5pct: 0 };
  if (best === undefined) return out;

  const within = (pct: number) =>
    sorted
      .filter((o) => (side === "sell" ? o.price <= best * (1 + pct / 100) : o.price >= best * (1 - pct / 100)))
      .reduce((units, o) => units + o.volume_remain, 0);

  out.within1pct = within(1);
  out.within3pct = within(3);
  out.within5pct = within(5);
  return out;
}

export interface HistoryDay {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
}

export interface CompactHistory {
  columns: string[];
  rows: Array<Array<string | number>>;
}

/** Daily history as columns instead of one object per day. */
export function compactHistory(days: HistoryDay[]): CompactHistory {
  return {
    columns: ["date", "avg", "low", "high", "volume", "orders"],
    rows: days.map((d) => [d.date, Math.round(d.average * 100) / 100, d.lowest, d.highest, d.volume, d.order_count]),
  };
}
