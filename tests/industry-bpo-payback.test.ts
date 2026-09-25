import { describe, it, expect } from "vitest";
import { computeBpoPayback } from "../src/industry/bpo-payback.js";

describe("computeBpoPayback", () => {
  it("matches the skill doc's worked example: 1.4M/batch profit, 9.4M BPO pays back in 7 batches", () => {
    const r = computeBpoPayback(1_400_000, 5_000_000, 500_000, 9_400_000);
    expect(r.paybackBatches).toBe(7); // ceil(9.4M / 1.4M) = ceil(6.714...) = 7
  });

  it("uses ceil, not round — payback is 'batches until cumulative profit clears the cost', not the nearest batch", () => {
    // 9.4M / 4M = 2.35 -> 2 batches only clears 8M (short of 9.4M); needs a 3rd.
    // round(2.35) would wrongly say 2 — ceil is the only correct operation here.
    const r = computeBpoPayback(4_000_000, 1_000_000, 0, 9_400_000);
    expect(r.paybackBatches).toBe(3);
  });

  it("computes first-batch ROI on total capital deployed, not gross profit vs. BPO price (the Valkyrie I case)", () => {
    // Doc: 1.72M batch profit, 1.61M BPO, 14.1M total capital -> ~0.76-0.78% ROI,
    // NOT "profit > BPO cost so payback looks clean" — the whole point of this
    // metric is to not be flattered by that gross comparison.
    const materialsPlusInstall = 14_100_000 - 1_610_000; // reconstruct from the doc's total
    const r = computeBpoPayback(1_720_000, materialsPlusInstall, 0, 1_610_000);
    expect(r.totalCapitalDeployed).toBeCloseTo(14_100_000, 0);
    expect(r.firstBatchRoiPct).toBeCloseTo(0.78, 1);
    expect(r.firstBatchRoiPct).toBeLessThan(1); // "under 1%" per the doc, despite profit > BPO cost
  });

  it("flags exceedsPaybackCeiling for 3+ batches (the doc's stated threshold), not for 1-2", () => {
    const two = computeBpoPayback(5_000_000, 1_000_000, 0, 10_000_000); // ceil(10M/5M)=2
    expect(two.paybackBatches).toBe(2);
    expect(two.exceedsPaybackCeiling).toBe(false);

    const three = computeBpoPayback(3_000_000, 1_000_000, 0, 9_000_000); // ceil(9M/3M)=3
    expect(three.paybackBatches).toBe(3);
    expect(three.exceedsPaybackCeiling).toBe(true);
  });

  it("reports paybackBatches as null (never conflated with a large number) when the batch doesn't turn a profit", () => {
    const zero = computeBpoPayback(0, 1_000_000, 0, 5_000_000);
    expect(zero.paybackBatches).toBeNull();
    expect(zero.exceedsPaybackCeiling).toBe(true); // never paying back is always the caution case

    const negative = computeBpoPayback(-50_000, 1_000_000, 0, 5_000_000);
    expect(negative.paybackBatches).toBeNull();
    expect(negative.exceedsPaybackCeiling).toBe(true);
  });

  it("returns a null ROI rather than dividing by zero when nothing was deployed", () => {
    const r = computeBpoPayback(0, 0, 0, 0);
    expect(r.firstBatchRoiPct).toBeNull();
  });

  it("respects a custom payback ceiling", () => {
    const r = computeBpoPayback(2_000_000, 1_000_000, 0, 8_000_000, 5); // ceil(8M/2M)=4
    expect(r.paybackBatches).toBe(4);
    expect(r.exceedsPaybackCeiling).toBe(false); // 4 <= custom ceiling of 5
  });
});
