/**
 * Shaping for get_order_history, free of ESI and database imports so it can be
 * unit-tested directly.
 *
 * An unfiltered history is hundreds of orders (one call returned 100k
 * characters). `limit` caps a list, and the per-type summary answers the
 * questions the trading skill actually asks in a few lines per item: how many
 * orders did this item go through, how many were cancelled before half
 * filled, and what was the last cancel.
 */

export interface HistoryOrder {
  order_id: number;
  type_id: number;
  is_buy_order: boolean;
  price: number;
  volume_total: number;
  volume_remain: number;
  state: string;
  issued: string;
}

export interface LastCancel {
  issued: string;
  price: number;
  filled: number;
  total: number;
}

export interface TypeHistorySummary {
  typeId: number;
  typeName: string;
  orders: number;
  fulfilled: number;
  cancelled: number;
  expired: number;
  /** Orders cancelled while less than half filled (the repeat-cancellation signal). */
  cancelledUnderHalfFilled: number;
  unitsOrdered: number;
  unitsFilled: number;
  lastIssued: string;
  lastCancel?: LastCancel;
}

export function filledUnits(o: Pick<HistoryOrder, "volume_total" | "volume_remain">): number {
  return o.volume_total - o.volume_remain;
}

/** The most recently issued `limit` orders, newest first. A missing or non-positive limit returns the input unchanged. */
export function limitRecent<T extends { issued: string }>(orders: T[], limit?: number): T[] {
  if (!limit || limit <= 0) return orders;
  return [...orders].sort((a, b) => (a.issued < b.issued ? 1 : a.issued > b.issued ? -1 : 0)).slice(0, limit);
}

/** One row per item type, most recently active first. */
export function summarizeOrderHistory(
  orders: HistoryOrder[],
  typeName: (typeId: number) => string
): TypeHistorySummary[] {
  const byType = new Map<number, TypeHistorySummary>();

  for (const o of orders) {
    let s = byType.get(o.type_id);
    if (!s) {
      s = {
        typeId: o.type_id,
        typeName: typeName(o.type_id),
        orders: 0,
        fulfilled: 0,
        cancelled: 0,
        expired: 0,
        cancelledUnderHalfFilled: 0,
        unitsOrdered: 0,
        unitsFilled: 0,
        lastIssued: o.issued,
      };
      byType.set(o.type_id, s);
    }

    s.orders++;
    s.unitsOrdered += o.volume_total;
    s.unitsFilled += filledUnits(o);
    if (o.issued > s.lastIssued) s.lastIssued = o.issued;

    if (o.state === "fulfilled") s.fulfilled++;
    else if (o.state === "expired") s.expired++;
    else if (o.state === "cancelled") {
      s.cancelled++;
      if (filledUnits(o) * 2 < o.volume_total) s.cancelledUnderHalfFilled++;
      if (!s.lastCancel || o.issued > s.lastCancel.issued) {
        s.lastCancel = { issued: o.issued, price: o.price, filled: filledUnits(o), total: o.volume_total };
      }
    }
  }

  return [...byType.values()].sort((a, b) => (a.lastIssued < b.lastIssued ? 1 : a.lastIssued > b.lastIssued ? -1 : 0));
}
