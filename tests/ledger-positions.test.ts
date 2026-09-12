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

  it("carries exit-fee attribution per position and nets it into realizedPnlNetAfterExitFees", () => {
    // Two types sold today; exit-fee attribution (from the listing campaigns
    // their sales filled through) is passed per type. Type 100 churned its
    // way to the sale (50 attributed, 20 of it relisting); type 200 sold
    // first-try (10 attributed, 0 relisting).
    const consumptions = [
      sell(100, 10, 900_000, 1_000_000),
      sell(200, 5, 500_000, 600_000),
    ];
    const matchedFees: PositionMatchedFee[] = [
      { typeId: 100, amount: 30, classification: "relist" },
      { typeId: 200, amount: 10, classification: "new_listing" },
    ];
    const exitFees = new Map([
      [100, { total: 50, relisting: 20 }],
      [200, { total: 10, relisting: 0 }],
    ]);
    const positions = buildPositionCloses(consumptions, matchedFees, 0, [], exitFees);

    const t100 = positions.find((p) => p.typeId === 100)!;
    expect(t100.exitFeesAttributed).toBe(50);
    expect(t100.exitFeesRelistingAttributed).toBe(20);
    // realizedPnlNet stays day-exact (gross 1M - tax 0 - day's matched fees 30)…
    expect(t100.realizedPnlNet).toBe(999_970);
    // …while realizedPnlNetAfterExitFees layers the campaign cost on top.
    expect(t100.realizedPnlNetAfterExitFees).toBe(t100.realizedPnlNet - 50);

    const t200 = positions.find((p) => p.typeId === 200)!;
    expect(t200.exitFeesAttributed).toBe(10);
    expect(t200.realizedPnlNetAfterExitFees).toBe(t200.realizedPnlNet - 10);
  });

  it("carries acquisition-fee attribution and nets both sides into realizedPnlNetAllIn", () => {
    // Type 100's position: 40 of exit churn and 60 of acquisition churn
    // spent acquiring the units that were sold today. The all-in view nets
    // both; the day-exact figures stay untouched.
    const consumptions = [sell(100, 10, 900_000, 1_000_000)];
    const exitFees = new Map([[100, { total: 40, relisting: 15 }]]);
    const acquisitionFees = new Map([[100, { total: 60, relisting: 25 }]]);
    const positions = buildPositionCloses(consumptions, [], 0, [], exitFees, acquisitionFees);

    const t100 = positions.find((p) => p.typeId === 100)!;
    expect(t100.acquisitionFeesAttributed).toBe(60);
    expect(t100.acquisitionFeesRelistingAttributed).toBe(25);
    expect(t100.exitFeesAttributed).toBe(40);
    expect(t100.realizedPnlNetAllIn).toBe(t100.realizedPnlNet - 40 - 60);
    // the exit-only view is unchanged by the acquisition overlay
    expect(t100.realizedPnlNetAfterExitFees).toBe(t100.realizedPnlNet - 40);
  });

  it("defaults both attribution layers to 0 when not provided", () => {
    const positions = buildPositionCloses([sell(100, 1, 100, 200)], [], 0, []);
    const t100 = positions.find((p) => p.typeId === 100)!;
    expect(t100.exitFeesAttributed).toBe(0);
    expect(t100.acquisitionFeesAttributed).toBe(0);
    expect(t100.realizedPnlNetAfterExitFees).toBe(t100.realizedPnlNet);
    expect(t100.realizedPnlNetAllIn).toBe(t100.realizedPnlNet);
  });
});
