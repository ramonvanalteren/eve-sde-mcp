import { describe, it, expect } from "vitest";
import { filledUnits, limitRecent, summarizeOrderHistory, type HistoryOrder } from "../src/order-history.js";

const order = (over: Partial<HistoryOrder>): HistoryOrder => ({
  order_id: 1,
  type_id: 100,
  is_buy_order: true,
  price: 1000,
  volume_total: 10,
  volume_remain: 10,
  state: "cancelled",
  issued: "2026-10-01T10:00:00Z",
  ...over,
});

const nameOf = (id: number) => ({ 100: "Gistum B EM Shield Amplifier", 200: "Tengu Fuel Catalyst" }[id] ?? `Unknown(${id})`);

describe("filledUnits", () => {
  it("is total minus remaining", () => {
    expect(filledUnits({ volume_total: 15, volume_remain: 4 })).toBe(11);
  });
});

describe("limitRecent", () => {
  const orders = [
    order({ order_id: 1, issued: "2026-09-01T00:00:00Z" }),
    order({ order_id: 2, issued: "2026-10-03T00:00:00Z" }),
    order({ order_id: 3, issued: "2026-10-01T00:00:00Z" }),
  ];

  it("returns the newest N, newest first", () => {
    expect(limitRecent(orders, 2).map((o) => o.order_id)).toEqual([2, 3]);
  });

  it("returns the input unchanged without a limit or with a non-positive one", () => {
    expect(limitRecent(orders)).toBe(orders);
    expect(limitRecent(orders, 0)).toBe(orders);
    expect(limitRecent(orders, -3)).toBe(orders);
  });

  it("does not mutate the input order", () => {
    limitRecent(orders, 2);
    expect(orders.map((o) => o.order_id)).toEqual([1, 2, 3]);
  });

  it("returns everything when the limit exceeds the count", () => {
    expect(limitRecent(orders, 50)).toHaveLength(3);
  });
});

describe("summarizeOrderHistory", () => {
  const orders = [
    order({ order_id: 1, type_id: 100, state: "cancelled", volume_total: 10, volume_remain: 10, issued: "2026-10-02T21:30:00Z", price: 18_900_000 }),
    order({ order_id: 2, type_id: 100, state: "cancelled", volume_total: 5, volume_remain: 4, issued: "2026-07-08T16:25:00Z", price: 24_020_000 }),
    order({ order_id: 3, type_id: 100, state: "fulfilled", volume_total: 6, volume_remain: 0, issued: "2026-09-01T00:00:00Z" }),
    order({ order_id: 4, type_id: 200, state: "cancelled", volume_total: 10, volume_remain: 5, issued: "2026-09-26T21:05:00Z" }),
    order({ order_id: 5, type_id: 200, state: "expired", volume_total: 20, volume_remain: 0, issued: "2026-09-10T00:00:00Z" }),
  ];
  const summary = summarizeOrderHistory(orders, nameOf);
  const gistum = summary.find((s) => s.typeId === 100)!;
  const tengu = summary.find((s) => s.typeId === 200)!;

  it("returns one row per item type", () => {
    expect(summary).toHaveLength(2);
  });

  it("counts orders by state", () => {
    expect([gistum.orders, gistum.fulfilled, gistum.cancelled, gistum.expired]).toEqual([3, 1, 2, 0]);
    expect([tengu.orders, tengu.fulfilled, tengu.cancelled, tengu.expired]).toEqual([2, 0, 1, 1]);
  });

  it("counts cancels under half filled: 0 of 10 and 1 of 5 are, exactly half is not", () => {
    expect(gistum.cancelledUnderHalfFilled).toBe(2);
    expect(tengu.cancelledUnderHalfFilled).toBe(0); // 5 of 10 filled is exactly half
  });

  it("sums units ordered and filled", () => {
    expect(gistum.unitsOrdered).toBe(21);
    expect(gistum.unitsFilled).toBe(0 + 1 + 6);
  });

  it("reports the most recent cancel with its fills", () => {
    expect(gistum.lastCancel).toEqual({ issued: "2026-10-02T21:30:00Z", price: 18_900_000, filled: 0, total: 10 });
  });

  it("has no lastCancel when nothing was cancelled", () => {
    const only = summarizeOrderHistory([order({ state: "fulfilled", volume_remain: 0 })], nameOf)[0];
    expect(only.lastCancel).toBeUndefined();
    expect(only.cancelled).toBe(0);
  });

  it("sorts most recently active first", () => {
    expect(summary.map((s) => s.typeId)).toEqual([100, 200]);
    expect(gistum.lastIssued).toBe("2026-10-02T21:30:00Z");
  });

  it("resolves type names and handles an empty history", () => {
    expect(gistum.typeName).toBe("Gistum B EM Shield Amplifier");
    expect(summarizeOrderHistory([], nameOf)).toEqual([]);
  });
});
