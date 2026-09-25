import { describe, it, expect } from "vitest";
import {
  estimateInstallationCost,
  SCC_SURCHARGE_PCT,
  NPC_STATION_FACILITY_TAX_PCT,
} from "../src/industry/installation-cost.js";

describe("estimateInstallationCost", () => {
  const materials = [
    { qtyPerRun: 10, adjustedPrice: 5 }, // 50/run
    { qtyPerRun: 2, adjustedPrice: 100 }, // 200/run
  ]; // eivPerRun = 250

  it("computes EIV from base (unadjusted) quantities, not ME-adjusted ones", () => {
    // EIV must not shrink even at a high ME — it's CCP's standardized
    // valuation, independent of the blueprint's own ME level. This
    // function never sees ME at all (callers pass base qtyPerRun), which
    // is itself the guard: there's no ME parameter to misuse.
    const r = estimateInstallationCost(materials, 100, 0.05, true);
    expect(r.eiv).toBe(250 * 100); // 25,000 — full base cost, no ME reduction
  });

  it("matches a hand-computed NPC-station estimate", () => {
    // EIV = 25,000; rate = 5% SCI + 4% SCC + 0.25% NPC facility tax = 9.25%
    const r = estimateInstallationCost(materials, 100, 0.05, true);
    expect(r.eiv).toBe(25000);
    expect(r.facilityTaxPct).toBe(NPC_STATION_FACILITY_TAX_PCT);
    expect(r.sccSurchargePct).toBe(SCC_SURCHARGE_PCT);
    expect(r.totalCost).toBeCloseTo(25000 * 0.0925, 6);
    expect(r.totalCost).toBeCloseTo(2312.5, 6);
  });

  it("omits facility tax entirely for a non-NPC (player structure) location, never assuming a value", () => {
    // rate = 5% SCI + 4% SCC + 0% (unknowable structure tax, not guessed)
    const r = estimateInstallationCost(materials, 100, 0.05, false);
    expect(r.facilityTaxPct).toBe(0);
    expect(r.totalCost).toBeCloseTo(25000 * 0.09, 6);
    expect(r.totalCost).toBeCloseTo(2250, 6);
  });

  it("scales linearly with system cost index", () => {
    const low = estimateInstallationCost(materials, 100, 0.01, true);
    const high = estimateInstallationCost(materials, 100, 0.19, true); // ~Jita-tier index
    expect(high.totalCost).toBeGreaterThan(low.totalCost);
    expect(low.eiv).toBe(high.eiv); // EIV doesn't depend on the index at all
  });

  it("flags and excludes materials with no adjusted_price, understating EIV honestly rather than guessing", () => {
    const withGap = [...materials, { qtyPerRun: 1000, adjustedPrice: null }];
    const r = estimateInstallationCost(withGap, 100, 0.05, true);
    expect(r.missingAdjustedPriceCount).toBe(1);
    expect(r.eiv).toBe(25000); // unchanged — the gapped material contributes nothing, isn't guessed
  });

  it("returns zero cost for a zero-run job", () => {
    const r = estimateInstallationCost(materials, 0, 0.05, true);
    expect(r.eiv).toBe(0);
    expect(r.totalCost).toBe(0);
  });

  it("returns zero EIV when every material is missing a price", () => {
    const r = estimateInstallationCost(
      [{ qtyPerRun: 10, adjustedPrice: null }],
      100,
      0.05,
      true
    );
    expect(r.eiv).toBe(0);
    expect(r.missingAdjustedPriceCount).toBe(1);
  });
});
