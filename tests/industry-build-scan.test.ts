import { describe, it, expect } from "vitest";
import { screenBuilds, averageDailyVolume, type ScanBlueprint } from "../src/industry/build-scan.js";

function bp(
  productTypeId: number,
  productName: string,
  productQty: number,
  materials: Array<[number, string, number]>,
  blueprintTypeId = productTypeId * 10
): ScanBlueprint {
  return {
    blueprintTypeId,
    blueprintName: `${productName} Blueprint`,
    productTypeId,
    productName,
    productQtyPerRun: productQty,
    materials: materials.map(([typeId, name, qty]) => ({ typeId, name, qtyPerRun: qty })),
  };
}

describe("screenBuilds", () => {
  const adjusted = new Map<number, number>([
    [34, 4],   // Tritanium
    [35, 18],  // Pyerite
    [36, 51],  // Mexallon
    [101, 10000], // healthy product
    [102, 5000],  // marginal product
    [103, 30000], // rich product
  ]);

  it("ranks candidates by adjusted-price screen margin and filters the threshold", () => {
    const blueprints = [
      // cost 1786×4 + 304×18 + 1×51 = 12,551 → net 10000×0.954 → margin ≈ -24%
      bp(101, "Bad Line Item", 1, [[34, "Tritanium", 1786], [35, "Pyerite", 304], [36, "Mexallon", 1]]),
      // cost 100×4 + 20×18 + 2×51 = 942 → net 5000×0.954 = 4770 → margin ≈ +407%
      bp(102, "Great Line Item", 1, [[34, "Tritanium", 100], [35, "Pyerite", 20], [36, "Mexallon", 2]]),
      // cost 800×4 = 3200 → net 30000×0.954 → margin ≈ +795%, two products per run
      bp(103, "Batch Item", 2, [[34, "Tritanium", 800]]),
    ];
    const r = screenBuilds({
      blueprints,
      adjustedPrices: adjusted,
      meLevel: 0,
      salesTaxPct: 3.6,
      brokerFeePct: 1.0,
      minMarginPct: 10,
      topN: 10,
    });
    expect(r.length).toBe(2); // the negative-margin line is filtered
    expect(r[0].productName).toBe("Batch Item"); // per-unit cost halves with 2 products/run
    expect(r[0].screenMarginPct).toBeGreaterThan(r[1].screenMarginPct!);
    // Batch Item: 3200 material / 2 products = 1600/unit; net 28620 → ~1688%
    expect(r[0].screenMarginPct).toBeGreaterThan(1000);
    expect(r[1].screenMarginPct).toBeGreaterThan(300);
  });

  it("marks candidates incomplete when prices are missing, and costShare ranks materials", () => {
    const r = screenBuilds({
      blueprints: [
        bp(102, "Missing Material Item", 1, [[34, "Tritanium", 100], [999, "Unobtanium", 5]]),
      ],
      adjustedPrices: adjusted,
      meLevel: 0,
      salesTaxPct: 3.6,
      brokerFeePct: 1.0,
      minMarginPct: 10,
      topN: 10,
    });
    expect(r.length).toBe(1);
    expect(r[0].incomplete).toBe(true);
    // Tritanium (400) vs Unobtanium (missing → excluded) → share 100%
    expect(r[0].costShare[0]).toEqual({ name: "Tritanium", pct: 100 });
  });

  it("applies ME to the screen cost", () => {
    const mk = (me: number) =>
      screenBuilds({
        blueprints: [bp(103, "Batch Item", 1, [[34, "Tritanium", 1000], [35, "Pyerite", 100]])],
        adjustedPrices: adjusted,
        meLevel: me,
        salesTaxPct: 3.6,
        brokerFeePct: 1.0,
        minMarginPct: 0,
        topN: 5,
      })[0];
    const me0 = mk(0);
    const me10 = mk(10);
    expect(me10.screenUnitCost!).toBeCloseTo((me0.screenUnitCost! * 0.9), 1);
  });

  it("respects topN", () => {
    const many = Array.from({ length: 12 }, (_, i) => bp(103, `Item ${i}`, 1, [[34, "Tritanium", 50 + i * 100]], 9000 + i));
    const r = screenBuilds({
      blueprints: many,
      adjustedPrices: adjusted,
      meLevel: 0,
      salesTaxPct: 3.6,
      brokerFeePct: 1.0,
      minMarginPct: 0,
      topN: 5,
    });
    expect(r.length).toBe(5);
    // cheapest materials (fewest Tritanium) → highest margin first
    expect(r[0].productName).toBe("Item 0");
  });
});

describe("averageDailyVolume", () => {
  it("averages volume over the most recent N entries", () => {
    const history = [
      { date: "2026-09-01", volume: 100 },
      { date: "2026-09-02", volume: 200 },
      { date: "2026-09-03", volume: 300 },
      { date: "2026-09-04", volume: 400 },
    ];
    expect(averageDailyVolume(history, 2)).toBe(350);
    expect(averageDailyVolume(history, 30)).toBe(250);
    expect(averageDailyVolume([], 30)).toBe(0);
  });
});
