import { describe, it, expect } from "vitest";
import {
  applyMaterialEfficiency,
  computeBuildMargin,
  type BuildMarginInput,
  type PriceQuote,
} from "../src/industry/build-margin.js";

// Fixtures from the 2026-09 production audit of Helga's live jobs —
// Inertial Stabilizers I (the strongest line) and Damage Control I
// (the dead line that founded this tool).

function istributorInput(overrides: Partial<BuildMarginInput> = {}): BuildMarginInput {
  // Jita 4-4 prices as observed in the audit
  const prices = new Map<number, PriceQuote>([
    [34, { bestSell: 3.96, bestBuy: 3.85, sellOrderCount: 45, buyOrderCount: 37 }],   // Tritanium
    [35, { bestSell: 17.86, bestBuy: 17.11, sellOrderCount: 135, buyOrderCount: 31 }], // Pyerite
    [36, { bestSell: 51.47, bestBuy: 49.42, sellOrderCount: 107, buyOrderCount: 32 }], // Mexallon
    [1403, { bestSell: 23200, bestBuy: 12260, sellOrderCount: 28, buyOrderCount: 10 }], // Inertial Stabilizers I
  ]);
  return {
    product: { name: "Inertial Stabilizers I", typeId: 1403, quantityPerRun: 1 },
    materials: [
      { name: "Tritanium", typeId: 34, qtyPerRun: 1786 },
      { name: "Pyerite", typeId: 35, qtyPerRun: 304 },
      { name: "Mexallon", typeId: 36, qtyPerRun: 1 },
    ],
    runs: 200,
    meLevel: 0,
    prices,
    salesTaxPct: 3.4,
    brokerFeePct: 1.491,
    installationCostTotal: 168553,
    ...overrides,
  };
}

describe("applyMaterialEfficiency", () => {
  it("reduces quantities by ME% with per-material rounding, floor 1", () => {
    expect(applyMaterialEfficiency(1786, 0)).toBe(1786);
    expect(applyMaterialEfficiency(1786, 10)).toBe(1607); // 1786 × 0.9 = 1607.4
    expect(applyMaterialEfficiency(2, 10)).toBe(2); // 1.8 rounds to 2
    expect(applyMaterialEfficiency(1, 10)).toBe(1); // floor 1
    expect(applyMaterialEfficiency(100, 25)).toBe(90); // level clamped to 10 → ×0.9
  });
});

describe("computeBuildMargin (audit fixtures)", () => {
  it("reproduces the audit's Inertial Stabilizers I numbers at sell basis", () => {
    const r = computeBuildMargin(istributorInput());
    expect(r.totalProducts).toBe(200);
    // materials at sell basis: 1786×3.96 + 304×17.86 + 1×51.47 = 12,553.47/run
    expect(r.costs.materialsAtSell).toBeCloseTo(200 * 12553.47, -1);
    expect(r.costs.unitCostAtSell).toBeCloseTo((200 * 12553.47 + 168553) / 200, -1); // ≈ 13,396
    // net sell: 23200 × (1 − 0.034 − 0.01491) ≈ 22,063
    expect(r.revenue.netPerUnit).toBeCloseTo(22063, -1);
    expect(r.margins.atSellBasis.profitPerUnit).toBeGreaterThan(8000);
    expect(r.margins.atSellBasis.marginPct).toBeGreaterThan(60);
  });

  it("buy-basis margins are computed from buy-order material prices", () => {
    const r = computeBuildMargin(istributorInput());
    expect(r.costs.materialsAtBuy).toBeCloseTo(200 * (1786 * 3.85 + 304 * 17.11 + 1 * 49.42), -1);
    expect(r.margins.atBuyBasis.marginPct).toBeGreaterThan(r.margins.atSellBasis.marginPct!);
  });

  it("reproduces the audit's dead line: Damage Control I at +~1% margin", () => {
    const prices = new Map<number, PriceQuote>([
      [34, { bestSell: 3.96, bestBuy: 3.85, sellOrderCount: 45, buyOrderCount: 37 }],
      [35, { bestSell: 17.86, bestBuy: 17.11, sellOrderCount: 135, buyOrderCount: 31 }],
      [36, { bestSell: 51.47, bestBuy: 49.42, sellOrderCount: 107, buyOrderCount: 32 }],
      [2046, { bestSell: 7877, bestBuy: 6060, sellOrderCount: 57, buyOrderCount: 12 }],
    ]);
    const r = computeBuildMargin({
      product: { name: "Damage Control I", typeId: 2046, quantityPerRun: 1 },
      materials: [
        { name: "Tritanium", typeId: 34, qtyPerRun: 1062 },
        { name: "Pyerite", typeId: 35, qtyPerRun: 2 },
        { name: "Mexallon", typeId: 36, qtyPerRun: 53 },
      ],
      runs: 400,
      meLevel: 0,
      prices,
      salesTaxPct: 3.4,
      brokerFeePct: 1.491,
      installationCostTotal: 182576,
    });
    // unit cost ≈ 7,425; net sell ≈ 7,491 → ~+1%
    expect(r.costs.unitCostAtSell).toBeCloseTo(7425, -1);
    expect(r.margins.atSellBasis.marginPct!).toBeGreaterThan(0);
    expect(r.margins.atSellBasis.marginPct!).toBeLessThan(3);
    expect(r.margins.atSellBasis.profitTotal!).toBeLessThan(60000); // 400 runs, ~53k — the dead line
  });

  it("ME 10 improves unit cost", () => {
    const r = computeBuildMargin(istributorInput({ meLevel: 10 }));
    const base = computeBuildMargin(istributorInput());
    expect(r.costs.materialsAtSell!).toBeLessThan(base.costs.materialsAtSell!);
    expect(r.margins.atSellBasis.profitPerUnit!).toBeGreaterThan(base.margins.atSellBasis.profitPerUnit!);
  });

  it("warns when installation cost is absent and on thin product books", () => {
    const r = computeBuildMargin(istributorInput({ installationCostTotal: null }));
    expect(r.warnings.join(" ")).toContain("Installation cost not provided");
    const thin = computeBuildMargin(
      istributorInput({
        prices: new Map<number, PriceQuote>([
          [34, { bestSell: 3.96, bestBuy: 3.85, sellOrderCount: 45, buyOrderCount: 37 }],
          [35, { bestSell: 17.86, bestBuy: 17.11, sellOrderCount: 135, buyOrderCount: 31 }],
          [36, { bestSell: 51.47, bestBuy: 49.42, sellOrderCount: 107, buyOrderCount: 32 }],
          [1403, { bestSell: 23200, bestBuy: 12260, sellOrderCount: 2, buyOrderCount: 10 }],
        ]),
      })
    );
    expect(thin.warnings.join(" ")).toContain("Thin product book");
  });

  it("degrades to nulls with warnings when a material has no sell orders", () => {
    const r = computeBuildMargin(
      istributorInput({
        prices: new Map<number, PriceQuote>([
          [34, { bestSell: null, bestBuy: 3.85, sellOrderCount: 0, buyOrderCount: 37 }],
          [35, { bestSell: 17.86, bestBuy: 17.11, sellOrderCount: 135, buyOrderCount: 31 }],
          [36, { bestSell: 51.47, bestBuy: 49.42, sellOrderCount: 107, buyOrderCount: 32 }],
          [1403, { bestSell: 23200, bestBuy: 12260, sellOrderCount: 28, buyOrderCount: 10 }],
        ]),
      })
    );
    expect(r.costs.materialsAtSell).toBeNull();
    expect(r.costs.unitCostAtSell).toBeNull();
    expect(r.margins.atSellBasis.marginPct).toBeNull();
    expect(r.warnings.join(" ")).toContain("Tritanium");
  });
});
