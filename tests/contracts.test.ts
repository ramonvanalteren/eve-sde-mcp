import { describe, it, expect } from "vitest";
import { searchContracts, type PublicContract } from "../src/contracts.js";

function contract(overrides: Partial<PublicContract> & { contract_id: number }): PublicContract {
  return {
    type: "courier",
    title: "",
    price: 0,
    reward: 0,
    collateral: 0,
    volume: 0,
    days_to_complete: 1,
    start_location_id: 60003760,
    end_location_id: 60003760,
    date_issued: "2026-09-26T00:00:00Z",
    date_expired: "2026-10-01T00:00:00Z",
    issuer_id: 1,
    issuer_corporation_id: 1,
    ...overrides,
  };
}

describe("searchContracts", () => {
  it("filters by type", () => {
    const contracts = [
      contract({ contract_id: 1, type: "courier" }),
      contract({ contract_id: 2, type: "item_exchange" }),
      contract({ contract_id: 3, type: "auction" }),
    ];
    const r = searchContracts(contracts, { type: "courier" });
    expect(r.matchingCount).toBe(1);
    expect(r.contracts.map((c) => c.contract_id)).toEqual([1]);
  });

  it("filters by exact start and end location", () => {
    const contracts = [
      contract({ contract_id: 1, start_location_id: 60003754, end_location_id: 60003760 }), // Perimeter -> Jita
      contract({ contract_id: 2, start_location_id: 60003760, end_location_id: 60003754 }), // Jita -> Perimeter
      contract({ contract_id: 3, start_location_id: 60003754, end_location_id: 60011866 }), // Perimeter -> elsewhere
    ];
    const r = searchContracts(contracts, { startLocationId: 60003754, endLocationId: 60003760 });
    expect(r.matchingCount).toBe(1);
    expect(r.contracts[0].contract_id).toBe(1);
  });

  it("filters by reward+price range (the two are mutually exclusive per contract, safe to sum)", () => {
    const contracts = [
      contract({ contract_id: 1, reward: 1_000_000, price: 0 }),
      contract({ contract_id: 2, reward: 0, price: 15_000_000 }), // item_exchange uses price, not reward
      contract({ contract_id: 3, reward: 50_000_000, price: 0 }),
    ];
    const r = searchContracts(contracts, { minReward: 5_000_000, maxReward: 20_000_000 });
    expect(r.contracts.map((c) => c.contract_id)).toEqual([2]);
  });

  it("filters by volume range", () => {
    const contracts = [
      contract({ contract_id: 1, volume: 2_000 }),
      contract({ contract_id: 2, volume: 2_520_000 }),
      contract({ contract_id: 3, volume: 500_000 }),
    ];
    const r = searchContracts(contracts, { minVolume: 100_000 });
    expect(r.contracts.map((c) => c.contract_id).sort()).toEqual([2, 3]);
  });

  it("sorts by reward+price descending by default", () => {
    const contracts = [
      contract({ contract_id: 1, reward: 5_000_000 }),
      contract({ contract_id: 2, reward: 50_000_000 }),
      contract({ contract_id: 3, price: 20_000_000 }),
    ];
    const r = searchContracts(contracts, {});
    expect(r.contracts.map((c) => c.contract_id)).toEqual([2, 3, 1]);
  });

  it("reports matchingCount before limit is applied, and caps returned contracts to limit", () => {
    const contracts = Array.from({ length: 30 }, (_, i) => contract({ contract_id: i, reward: i }));
    const r = searchContracts(contracts, { limit: 5 });
    expect(r.matchingCount).toBe(30);
    expect(r.contracts).toHaveLength(5);
  });

  it("defaults to 20 and caps a caller-supplied limit at 100", () => {
    const contracts = Array.from({ length: 150 }, (_, i) => contract({ contract_id: i }));
    expect(searchContracts(contracts, {}).contracts).toHaveLength(20);
    expect(searchContracts(contracts, { limit: 500 }).contracts).toHaveLength(100);
    expect(searchContracts(contracts, { limit: 0 }).contracts).toHaveLength(1); // never zero results just from a bad limit
  });

  it("combines multiple filters (the exact Perimeter->Jita courier case)", () => {
    const contracts = [
      contract({ contract_id: 1, type: "courier", start_location_id: 60003754, end_location_id: 60003760, reward: 1_000_000 }),
      contract({ contract_id: 2, type: "item_exchange", start_location_id: 60003754, end_location_id: 60003760 }),
      contract({ contract_id: 3, type: "courier", start_location_id: 60003754, end_location_id: 60011866, reward: 1_000_000 }),
    ];
    const r = searchContracts(contracts, { type: "courier", startLocationId: 60003754, endLocationId: 60003760 });
    expect(r.matchingCount).toBe(1);
    expect(r.contracts[0].contract_id).toBe(1);
  });

  it("returns an empty result, not an error, when nothing matches", () => {
    const r = searchContracts([contract({ contract_id: 1 })], { type: "auction" });
    expect(r.matchingCount).toBe(0);
    expect(r.contracts).toEqual([]);
  });
});
