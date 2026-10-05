import { describe, it, expect } from "vitest";
import { computeMarginRow, compactMarginRow, omitNulls } from "../src/margins.js";

const JITA = 60003760;
const PERIMETER = 1044752365771;

const buy = (price: number, location_id = JITA) => ({ price, is_buy_order: true, location_id });
const sell = (price: number, location_id = JITA) => ({ price, is_buy_order: false, location_id });

describe("computeMarginRow", () => {
  it("takes the best price on each side at the requested location only", () => {
    const row = computeMarginRow(
      1,
      "Thing",
      [buy(90), buy(100), sell(150), sell(140), buy(999, PERIMETER), sell(1, PERIMETER)],
      JITA,
      3.4,
      1.5
    );
    expect(row.bestBuy).toBe(100);
    expect(row.bestSell).toBe(140);
    expect(row.buyOrderCount).toBe(2);
    expect(row.sellOrderCount).toBe(2);
  });

  it("applies broker fee on both sides and sales tax on the sell", () => {
    const row = computeMarginRow(1, "Thing", [buy(100), sell(150)], JITA, 3.4, 1.5);
    const buyTotal = 100 * 1.015;
    const sellNet = 150 * (1 - 0.034 - 0.015);
    expect(row.profitPerUnit).toBeCloseTo(sellNet - buyTotal, 6);
    expect(row.margin).toBeCloseTo(((sellNet - buyTotal) / buyTotal) * 100, 6);
    expect(row.spread).toBeCloseTo(((150 - 100) / 150) * 100, 6);
  });

  it("leaves margin fields null when a side is missing", () => {
    const row = computeMarginRow(1, "Thing", [buy(100)], JITA, 3.4, 0.5);
    expect(row.bestBuy).toBe(100);
    expect(row.bestSell).toBeNull();
    expect(row.spread).toBeNull();
    expect(row.margin).toBeNull();
    expect(row.profitPerUnit).toBeNull();
    expect(row.sellOrderCount).toBe(0);
  });

  it("handles an empty book", () => {
    const row = computeMarginRow(1, "Thing", [], JITA, 3.4, 0.5);
    expect(row.bestBuy).toBeNull();
    expect(row.bestSell).toBeNull();
    expect(row.buyOrderCount).toBe(0);
  });
});

describe("compactMarginRow", () => {
  it("drops the four null fields of a buy-side-only row", () => {
    const row = computeMarginRow(1, "Thing", [buy(100), buy(90)], JITA, 3.4, 0.5);
    const compact = compactMarginRow(row);
    expect(Object.keys(compact).sort()).toEqual(
      ["bestBuy", "buyOrderCount", "sellOrderCount", "typeId", "typeName"].sort()
    );
  });

  it("keeps every field when both sides exist", () => {
    const compact = compactMarginRow(computeMarginRow(1, "Thing", [buy(100), sell(150)], JITA, 3.4, 1.5));
    expect(Object.keys(compact).sort()).toEqual(
      [
        "bestBuy",
        "bestSell",
        "buyOrderCount",
        "margin",
        "profitPerUnit",
        "sellOrderCount",
        "spread",
        "typeId",
        "typeName",
      ].sort()
    );
  });

  it("keeps zero values (a margin of 0 is not absent)", () => {
    const compact = compactMarginRow({
      typeId: 1,
      typeName: "Thing",
      bestBuy: 100,
      bestSell: 100,
      spread: 0,
      margin: 0,
      profitPerUnit: 0,
      buyOrderCount: 0,
      sellOrderCount: 0,
    });
    expect(compact.spread).toBe(0);
    expect(compact.margin).toBe(0);
    expect(compact.profitPerUnit).toBe(0);
    expect(compact.buyOrderCount).toBe(0);
  });
});

describe("omitNulls", () => {
  it("drops null and undefined but keeps false, 0 and empty string", () => {
    expect(omitNulls({ a: null, b: undefined, c: false, d: 0, e: "", f: "x" })).toEqual({
      c: false,
      d: 0,
      e: "",
      f: "x",
    });
  });
});
