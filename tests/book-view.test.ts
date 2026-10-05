import { describe, it, expect } from "vitest";
import { compactHistory, compactOrder, depthWithin, type BookOrder } from "../src/book-view.js";

const NOW = Date.parse("2026-10-05T12:00:00Z");

const order = (over: Partial<BookOrder>): BookOrder => ({
  order_id: 1,
  price: 1000,
  volume_remain: 5,
  volume_total: 10,
  location_id: 60003760,
  range: "region",
  issued: "2026-10-05T10:30:00Z",
  is_buy_order: false,
  ...over,
});

describe("compactOrder", () => {
  it("keeps price, units, location and range, and reports age in hours to one decimal", () => {
    expect(compactOrder(order({}), NOW)).toEqual({
      price: 1000,
      remain: 5,
      total: 10,
      loc: 60003760,
      range: "region",
      ageH: 1.5,
    });
  });

  it("uses null for a missing range", () => {
    expect(compactOrder(order({ range: undefined }), NOW).range).toBeNull();
  });

  it("never reports a negative age (clock skew)", () => {
    expect(compactOrder(order({ issued: "2026-10-05T13:00:00Z" }), NOW).ageH).toBe(0);
  });

  it("drops the order id and the buy flag", () => {
    const compact = compactOrder(order({}), NOW);
    expect(compact).not.toHaveProperty("order_id");
    expect(compact).not.toHaveProperty("is_buy_order");
  });
});

describe("depthWithin", () => {
  // asks best-first: 100.0 (2), 100.9 (3), 102.5 (4), 104.9 (5), 106 (6)
  const asks = [100, 100.9, 102.5, 104.9, 106].map((price, i) => ({ price, volume_remain: [2, 3, 4, 5, 6][i] }));
  // bids best-first: 100.0 (2), 99.1 (3), 97.5 (4), 95.1 (5), 94 (6)
  const bids = [100, 99.1, 97.5, 95.1, 94].map((price, i) => ({ price, volume_remain: [2, 3, 4, 5, 6][i] }));

  it("sums units within 1%, 3% and 5% of the best ask", () => {
    expect(depthWithin(asks, "sell")).toEqual({ within1pct: 5, within3pct: 9, within5pct: 14 });
  });

  it("sums units within 1%, 3% and 5% of the best bid", () => {
    expect(depthWithin(bids, "buy")).toEqual({ within1pct: 5, within3pct: 9, within5pct: 14 });
  });

  it("treats the boundary as inclusive", () => {
    const exact = [{ price: 100, volume_remain: 1 }, { price: 101, volume_remain: 10 }];
    expect(depthWithin(exact, "sell").within1pct).toBe(11);
  });

  it("returns zeros for an empty side", () => {
    expect(depthWithin([], "sell")).toEqual({ within1pct: 0, within3pct: 0, within5pct: 0 });
  });

  it("a single order counts toward every band", () => {
    expect(depthWithin([{ price: 50, volume_remain: 7 }], "buy")).toEqual({
      within1pct: 7,
      within3pct: 7,
      within5pct: 7,
    });
  });
});

describe("compactHistory", () => {
  const days = [
    { date: "2026-10-03", average: 31715000.123, highest: 36350000, lowest: 20470000, order_count: 9, volume: 10 },
    { date: "2026-10-04", average: 29179230.77, highest: 37190000, lowest: 19880000, order_count: 12, volume: 13 },
  ];

  it("returns named columns and one array per day in that order", () => {
    const c = compactHistory(days);
    expect(c.columns).toEqual(["date", "avg", "low", "high", "volume", "orders"]);
    expect(c.rows[0]).toEqual(["2026-10-03", 31715000.12, 20470000, 36350000, 10, 9]);
    expect(c.rows).toHaveLength(2);
  });

  it("rounds the average to two decimals, which keeps cheap items distinguishable", () => {
    expect(compactHistory([{ ...days[0], average: 26.984 }]).rows[0][1]).toBe(26.98);
  });

  it("handles no days", () => {
    expect(compactHistory([]).rows).toEqual([]);
  });

  it("is smaller than the object-per-day form", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...days[0], date: `2026-09-${String(i + 1).padStart(2, "0")}` }));
    expect(JSON.stringify(compactHistory(many)).length).toBeLessThan(JSON.stringify(many).length * 0.7);
  });
});
