import { describe, it, expect } from "vitest";
import { buildPositionCloses, type PositionConsumption, type PositionMatchedFee, type PositionUnrealized } from "../src/ledger/positions.js";

function sell(typeId: number, quantity: number, unitCost: number | null, unitSellPrice: number, unmatched = false): PositionConsumption {
  return { typeId, quantity, unitCost, unitSellPrice, unmatched };
}

describe("buildPositionCloses", () => {
  it("splits revenue/cogs/gross P&L per type and allocates tax proportionally to matched revenue share", () => {
    // Type 100: 10 units, cost 900k, sold 1,000,000 -> revenue 10M, cogs 9M, gross 1M
    // Type 200: 5 units, cost 500k, sold 600,000 -> revenue 3M, cogs 2.5M, gross 0.5M
    // Total matched revenue = 13M, total tax paid (from journal) = 442,000 -> rate = 3.4%
    const consumptions = [sell(100, 10, 900_000, 1_000_000), sell(200, 5, 500_000, 600_000)];
    const positions = buildPositionCloses(consumptions, [], 442_000, []);

    const t100 = positions.find((p) => p.typeId === 100)!;
    const t200 = positions.find((p) => p.typeId === 200)!;

    expect(t100.realizedRevenue).toBe(10_000_000);
    expect(t100.realizedCogs).toBe(9_000_000);
    expect(t100.realizedGrossPnl).toBe(1_000_000);
    expect(t100.allocatedSalesTax).toBeCloseTo(10_000_000 * (442_000 / 13_000_000), 5);

    expect(t200.realizedGrossPnl).toBe(500_000);
    expect(t200.allocatedSalesTax).toBeCloseTo(3_000_000 * (442_000 / 13_000_000), 5);

    // Allocated tax across matched positions should sum back to the exact total (revenue-weighted reconstruction).
    expect(t100.allocatedSalesTax + t200.allocatedSalesTax).toBeCloseTo(442_000, 5);
  });

  it("counts unmatched-cost-basis revenue toward the tax-rate denominator without polluting gross/net P&L", () => {
    // One matched sell (type 100) and one unmatched sell (type 200, no cost basis known).
    // Tax was genuinely paid on both, so the rate must be derived from combined revenue.
    const consumptions = [
      sell(100, 10, 900_000, 1_000_000), // matched: revenue 10M
      sell(200, 3, null, 500_000, true), // unmatched: revenue 1.5M
    ];
    const totalRevenue = 10_000_000 + 1_500_000;
    const totalTax = 391_000; // arbitrary, ~3.4% of totalRevenue
    const positions = buildPositionCloses(consumptions, [], totalTax, []);

    const t100 = positions.find((p) => p.typeId === 100)!;
    const t200 = positions.find((p) => p.typeId === 200)!;

    // Rate derived from combined revenue, but only applied to type 100's matched revenue.
    const expectedRate = totalTax / totalRevenue;
    expect(t100.allocatedSalesTax).toBeCloseTo(10_000_000 * expectedRate, 5);

    // Unmatched position carries its revenue/qty but no gross/net P&L and no tax allocation of its own.
    expect(t200.unmatchedRevenue).toBe(1_500_000);
    expect(t200.unmatchedQty).toBe(3);
    expect(t200.realizedGrossPnl).toBe(0);
    expect(t200.allocatedSalesTax).toBe(0);
    expect(t200.realizedPnlNet).toBe(0);
  });

  it("attributes matched broker fees by type and classification into realizedPnlNet", () => {
    const consumptions = [sell(100, 10, 900_000, 1_000_000)]; // gross 1,000,000
    const fees: PositionMatchedFee[] = [
      { typeId: 100, amount: 150_000, classification: "new_listing" },
      { typeId: 100, amount: 90_000, classification: "relist" },
    ];
    const positions = buildPositionCloses(consumptions, fees, 0, []);
    const t100 = positions.find((p) => p.typeId === 100)!;

    expect(t100.brokerFeesNewListing).toBe(150_000);
    expect(t100.brokerFeesRelisting).toBe(90_000);
    expect(t100.realizedPnlNet).toBe(1_000_000 - 150_000 - 90_000);
  });

  it("creates a position row from unrealized-only or fee-only activity even with zero sells today", () => {
    const unrealized: PositionUnrealized[] = [
      { typeId: 300, qty: 4, cost: 4_000_000, marketValue: 4_400_000, unrealizedPnl: 400_000, priceMissing: false },
    ];
    const fees: PositionMatchedFee[] = [{ typeId: 400, amount: 50_000, classification: "new_listing" }];

    const positions = buildPositionCloses([], fees, 0, unrealized);

    const t300 = positions.find((p) => p.typeId === 300)!;
    expect(t300.remainingQty).toBe(4);
    expect(t300.unrealizedPnl).toBe(400_000);
    expect(t300.realizedRevenue).toBe(0);

    const t400 = positions.find((p) => p.typeId === 400)!;
    expect(t400.brokerFeesNewListing).toBe(50_000);
    expect(t400.realizedPnlNet).toBe(-50_000);
  });

  it("sorts results deterministically by type_id", () => {
    const positions = buildPositionCloses(
      [sell(300, 1, 100, 200), sell(100, 1, 100, 200), sell(200, 1, 100, 200)],
      [],
      0,
      []
    );
    expect(positions.map((p) => p.typeId)).toEqual([100, 200, 300]);
  });
});
