import { describe, it, expect } from "vitest";
import { matchBrokerFees, type BrokerFeeEntry, type OrderRecord } from "../src/ledger/fees.js";

const BROKER_PCT = 1.5;

function order(
  orderId: number,
  typeId: number,
  issued: string,
  price: number,
  volumeTotal: number,
  state: OrderRecord["state"] = "open",
  isBuyOrder = true
): OrderRecord {
  return { orderId, typeId, isBuyOrder, price, volumeTotal, issued, state };
}

function fee(journalId: number, date: string, amount: number): BrokerFeeEntry {
  return { journalId, date, amount };
}

describe("matchBrokerFees", () => {
  it("matches a fee to its order by timestamp + expected-amount proximity, classified as a new listing", () => {
    const o = order(1, 100, "2026-08-18T12:00:00Z", 9_000_000, 5); // expected fee = 9M*5*1.5% = 675,000
    const result = matchBrokerFees([fee(10, "2026-08-18T12:00:02Z", -675_000)], [o], [], BROKER_PCT);

    expect(result.unmatched).toHaveLength(0);
    expect(result.matched).toEqual([
      { journalId: 10, orderId: 1, typeId: 100, amount: 675_000, classification: "new_listing" },
    ]);
    expect(result.newListingTotal).toBe(675_000);
    expect(result.relistTotal).toBe(0);
  });

  it("classifies as a relist when a prior cancelled order exists for the same type+side", () => {
    const prior = order(1, 100, "2026-08-17T09:00:00Z", 9_000_000, 5, "cancelled");
    const reissued = order(2, 100, "2026-08-18T12:00:00Z", 9_200_000, 5); // expected fee = 9.2M*5*1.5% = 690,000
    const result = matchBrokerFees(
      [fee(11, "2026-08-18T12:00:01Z", -690_000)],
      [reissued],
      [prior],
      BROKER_PCT
    );

    expect(result.matched).toEqual([
      { journalId: 11, orderId: 2, typeId: 100, amount: 690_000, classification: "relist" },
    ]);
    expect(result.relistTotal).toBe(690_000);
    expect(result.newListingTotal).toBe(0);
  });

  it("leaves a fee unmatched (no_candidate) when no order is close enough in time or amount", () => {
    const o = order(1, 100, "2026-08-18T08:00:00Z", 9_000_000, 5);
    const result = matchBrokerFees([fee(12, "2026-08-18T12:00:00Z", -675_000)], [o], [], BROKER_PCT);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toEqual([{ journalId: 12, date: "2026-08-18T12:00:00Z", amount: 675_000, reason: "no_candidate" }]);
  });

  it("leaves a fee unmatched (ambiguous) when two orders are equally plausible candidates", () => {
    // Two different items, same order size/price, issued at the exact same
    // instant — identical score under both the time and amount signals.
    // Should not arbitrarily pick one.
    const a = order(1, 100, "2026-08-18T12:00:00Z", 9_000_000, 5);
    const b = order(2, 200, "2026-08-18T12:00:00Z", 9_000_000, 5);
    const result = matchBrokerFees([fee(13, "2026-08-18T12:00:00Z", -675_000)], [a, b], [], BROKER_PCT);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched[0]).toMatchObject({ journalId: 13, reason: "ambiguous" });
  });

  it("does not double-assign one order to two fees", () => {
    const o = order(1, 100, "2026-08-18T12:00:00Z", 9_000_000, 5);
    const result = matchBrokerFees(
      [fee(14, "2026-08-18T12:00:00Z", -675_000), fee(15, "2026-08-18T12:00:01Z", -675_000)],
      [o],
      [],
      BROKER_PCT
    );

    // Only one fee can actually claim the single order; the other is left unmatched rather than reused.
    expect(result.matched).toHaveLength(1);
    expect(result.unmatched).toHaveLength(1);
  });

  it("matches multiple fees to their correct distinct orders in one pass", () => {
    const a = order(1, 100, "2026-08-18T09:00:00Z", 9_000_000, 5); // fee 675,000
    const b = order(2, 200, "2026-08-18T14:00:00Z", 3_000_000, 10); // fee 450,000
    const result = matchBrokerFees(
      [fee(16, "2026-08-18T14:00:00Z", -450_000), fee(17, "2026-08-18T09:00:00Z", -675_000)],
      [a, b],
      [],
      BROKER_PCT
    );

    expect(result.unmatched).toHaveLength(0);
    expect(result.matched).toHaveLength(2);
    expect(result.matched.find((m) => m.journalId === 16)).toMatchObject({ orderId: 2 });
    expect(result.matched.find((m) => m.journalId === 17)).toMatchObject({ orderId: 1 });
  });
});
