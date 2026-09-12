import { describe, it, expect } from "vitest";
import {
  parseStationFeeSettings,
  resolveStationFeeModels,
  expectedFeeForOrder,
  expectedFeeResolver,
  expectedFeeFromModels,
  formatFeeModel,
} from "../src/ledger/station-fees.js";
import type { BrokerFeeEntry, OrderRecord } from "../src/ledger/fees.js";

function order(overrides: Partial<OrderRecord>): OrderRecord {
  return {
    orderId: 1,
    typeId: 42,
    isBuyOrder: true,
    price: 100,
    volumeTotal: 10,
    issued: "2026-09-12T10:00:00Z",
    state: "active",
    locationId: 60003760,
    ...overrides,
  };
}

describe("station fee models", () => {
  it("expectedFeeForOrder is additive: value × pct/100 + flat (Perimeter: SCC 0.5% + 100 ISK)", () => {
    // 100 ISK/unit × 10 units = 1000 ISK order value
    // 0.5% = 5 ISK + 100 ISK flat = 105 ISK expected placement fee
    expect(expectedFeeForOrder(order({}), { pct: 0.5, flat: 100 })).toBe(105);
    // pure percentage (Jita-style)
    expect(expectedFeeForOrder(order({}), { pct: 1.491, flat: 0 })).toBeCloseTo(14.91, 6);
    // pure flat
    expect(expectedFeeForOrder(order({}), { pct: 0, flat: 100 })).toBe(100);
  });

  it("formatFeeModel renders pct, flat, and combined forms", () => {
    expect(formatFeeModel({ pct: 1.491, flat: 0 })).toBe("1.49%");
    expect(formatFeeModel({ pct: 0, flat: 100 })).toBe("100 ISK flat");
    expect(formatFeeModel({ pct: 0.5, flat: 100 })).toBe("0.50% + 100 ISK flat");
  });

  it("resolves config stations first — including additive pct+flat entries", () => {
    const settings = {
      stationFees: {
        "60003760": { brokerFeePct: 1.491, label: "Jita 4-4 CNAP" },
        "1044752365771": { brokerFeePct: 0.5, brokerFeeFlat: 100, label: "Perimeter HQ" },
      },
      salesTaxPct: 3.4,
    };
    const resolution = resolveStationFeeModels([], [order({ locationId: 60003760 }), order({ orderId: 2, locationId: 1044752365771 })], settings);
    const jita = resolution.byStation.get("60003760");
    expect(jita?.provenance).toBe("config");
    expect(jita?.model).toEqual({ pct: 1.491, flat: 0 });
    const perimeter = resolution.byStation.get("1044752365771");
    expect(perimeter?.provenance).toBe("config");
    expect(perimeter?.model).toEqual({ pct: 0.5, flat: 100 });
  });

  it("falls back to derivation from unambiguous fee/order pairs for unconfigured stations (percentage only)", () => {
    // Three unambiguous order/fee pairs at 2% — derivation needs MIN_SAMPLES_FOR_ESTIMATE(3) pairs
    const orders = [1, 2, 3].map((i) =>
      order({ orderId: i, price: 50, volumeTotal: 10, locationId: 60003760, issued: `2026-09-12T10:0${i}:00Z` })
    );
    const fees: BrokerFeeEntry[] = [1, 2, 3].map((i) => ({
      journalId: i,
      date: `2026-09-12T10:0${i}:05Z`,
      amount: -10, // 500 ISK value × 2%
    }));
    const resolution = resolveStationFeeModels(fees, orders, { stationFees: {}, salesTaxPct: null });
    const derived = resolution.byStation.get("60003760");
    expect(derived?.provenance).toBe("derived");
    expect(derived?.model.pct).toBeCloseTo(2, 6);
    expect(derived?.model.flat).toBe(0);
    expect(derived?.sampleCount).toBe(3);
  });

  it("gives unconfigurable stations the default model and flags them for discovery", () => {
    const resolution = resolveStationFeeModels([], [order({ locationId: 999 })], { stationFees: {}, salesTaxPct: null });
    const m = resolution.byStation.get("999");
    expect(m?.provenance).toBe("default");
    expect(m?.model).toEqual({ pct: 1.0, flat: 0 });
  });

  it("expectedFeeResolver uses each order's own station model", () => {
    const settings = {
      stationFees: {
        "60003760": { brokerFeePct: 1.491 },
        "1044752365771": { brokerFeePct: 0.5, brokerFeeFlat: 100 },
      },
      salesTaxPct: null,
    };
    const resolution = resolveStationFeeModels(
      [],
      [order({ locationId: 60003760 }), order({ orderId: 2, locationId: 1044752365771 })],
      settings
    );
    const feeFor = expectedFeeResolver(resolution);
    // Jita: 1000 × 1.491% ≈ 14.91; Perimeter: 1000 × 0.5% + 100 = 105
    expect(feeFor(order({ locationId: 60003760 }))).toBeCloseTo(14.91, 6);
    expect(feeFor(order({ locationId: 1044752365771 }))).toBe(105);
    // Unknown station → fallback default pct
    expect(feeFor(order({ locationId: null }))).toBeCloseTo(10, 6);
  });

  it("expectedFeeResolver uniformPctOverride applies one rate everywhere (legacy broker_fee_pct param)", () => {
    const feeFor = expectedFeeResolver(
      resolveStationFeeModels([], [order({ locationId: 60003760 })], { stationFees: { "60003760": { brokerFeePct: 1.491 } }, salesTaxPct: null }),
      0.5
    );
    expect(feeFor(order({ locationId: 60003760 }))).toBeCloseTo(5, 6);
    expect(feeFor(order({ orderId: 2, locationId: 1044752365771 }))).toBeCloseTo(5, 6);
  });

  it("expectedFeeFromModels rebuilds a resolver from serialized report models", () => {
    const models = {
      "1044752365771": { key: "1044752365771", locationId: 1044752365771, model: { pct: 0.5, flat: 100 }, provenance: "config" as const },
    };
    const feeFor = expectedFeeFromModels(models, 1.0);
    expect(feeFor(order({ locationId: 1044752365771 }))).toBe(105);
    expect(feeFor(order({ locationId: 60003760 }))).toBeCloseTo(10, 6); // fallback pct
  });
});

describe("parseStationFeeSettings config validation", () => {
  it("drops entries with no usable fee component (neither pct nor flat) and keeps the rest", () => {
    const settings = parseStationFeeSettings({
      salesTaxPct: 3.4,
      stationFees: {
        "60003760": { brokerFeePct: 1.491, label: "Jita 4-4 CNAP" },
        "1044752365771": { brokerFeePct: 0.5, brokerFeeFlat: 100, label: "Perimeter HQ" },
        "123": { label: "entry with only a label — unusable" },
        "456": { brokerFeePct: -2, label: "negative pct — invalid" },
        "789": "not an object",
      },
    });
    expect(Object.keys(settings.stationFees).sort()).toEqual(["1044752365771", "60003760"]);
    expect(settings.stationFees["1044752365771"]).toEqual({ brokerFeePct: 0.5, brokerFeeFlat: 100, salesTaxPct: undefined, label: "Perimeter HQ" });
    expect(settings.salesTaxPct).toBe(3.4);
    // downstream: the dropped station falls through to default in resolution
    const resolution = resolveStationFeeModels([], [order({ locationId: 123 })], settings);
    expect(resolution.byStation.get("123")?.provenance).toBe("default");
  });

  it("never throws on garbage input — yields empty settings", () => {
    expect(parseStationFeeSettings(null)).toEqual({ stationFees: {}, salesTaxPct: null });
    expect(parseStationFeeSettings("junk")).toEqual({ stationFees: {}, salesTaxPct: null });
    expect(parseStationFeeSettings({ stationFees: 7 })).toEqual({ stationFees: {}, salesTaxPct: null });
  });
});
