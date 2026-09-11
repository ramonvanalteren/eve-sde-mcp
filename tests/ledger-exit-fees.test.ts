import { describe, it, expect } from "vitest";
import {
  attributeExitFees,
  computeOpenChainSunkFees,
  type OrderRecord,
  type ExitFeeSale,
} from "../src/ledger/fees.js";

let orderSeq = 1;
function sellOrder(
  typeId: number,
  issued: string,
  state: OrderRecord["state"],
  volumeTotal = 100
): OrderRecord {
  return {
    orderId: orderSeq++,
    typeId,
    isBuyOrder: false,
    price: 1_000,
    volumeTotal,
    issued,
    state,
  };
}
function buyOrder(typeId: number, issued: string): OrderRecord {
  return { orderId: orderSeq++, typeId, isBuyOrder: true, price: 500, volumeTotal: 100, issued, state: "open" };
}
function sale(transactionId: number, typeId: number, date: string, quantity: number): ExitFeeSale {
  return { transactionId, date, typeId, quantity };
}

describe("attributeExitFees", () => {
  it("attributes the campaign fees of the listing the sale filled through, per unit sold", () => {
    // Campaign: initial listing O1 (cancelled, fee 1000) + relist O2 (open, fee 1000),
    // each listed for 100 units. A sale of 10 units during O2's life carries
    // (1000+1000)/100 per unit => 200 total, of which 100 is relisting churn.
    const o1 = sellOrder(100, "2026-09-01T10:00:00Z", "cancelled");
    const o2 = sellOrder(100, "2026-09-02T10:00:00Z", "open");
    const orderFees = new Map([
      [o1.orderId, 1000],
      [o2.orderId, 1000],
    ]);
    const result = attributeExitFees([o1, o2], orderFees, [
      sale(1, 100, "2026-09-03T12:00:00Z", 10),
    ]);
    expect(result.unattributed).toEqual([]);
    expect(result.perSale.get(1)).toEqual({ total: 200, relisting: 100 });
  });

  it("excludes relist fees placed AFTER the sale — they sold other units", () => {
    // Sale of 10 units while O1 was still the live listing: only O1's fee
    // (1000/100 per unit => 100 total) is attributed; the later relist O2's
    // fee is not charged to this sale.
    const o1 = sellOrder(100, "2026-09-01T10:00:00Z", "cancelled");
    const o2 = sellOrder(100, "2026-09-02T10:00:00Z", "open");
    const orderFees = new Map([
      [o1.orderId, 1000],
      [o2.orderId, 1000],
    ]);
    const result = attributeExitFees([o1, o2], orderFees, [
      sale(1, 100, "2026-09-01T15:00:00Z", 10),
    ]);
    expect(result.perSale.get(1)).toEqual({ total: 100, relisting: 0 });
  });

  it("a fulfilled order ends the previous position's campaign — later sales don't inherit its fees", () => {
    // F1 fully filled (fee 500) and closed out position #1. The new position's
    // campaign is C2 (relist fee 800) + O3 (fee 1000). A sale during O3 is
    // attributed (800+1000)/100 per unit, NOT including F1's fee.
    const f1 = sellOrder(100, "2026-09-01T10:00:00Z", "fulfilled");
    const c2 = sellOrder(100, "2026-09-02T10:00:00Z", "cancelled");
    const o3 = sellOrder(100, "2026-09-03T10:00:00Z", "open");
    const orderFees = new Map([
      [f1.orderId, 500],
      [c2.orderId, 800],
      [o3.orderId, 1000],
    ]);
    const result = attributeExitFees([f1, c2, o3], orderFees, [
      sale(1, 100, "2026-09-04T12:00:00Z", 10),
    ]);
    // campaign = [C2, O3]: total fee 1800/100 * 10 = 180, relisting = O3's 1000/100*10 = 100
    expect(result.perSale.get(1)).toEqual({ total: 180, relisting: 100 });
  });

  it("sales before any synced listing are reported as unattributed, not guessed", () => {
    const o1 = sellOrder(100, "2026-09-05T10:00:00Z", "open");
    const result = attributeExitFees([o1], new Map(), [
      sale(1, 100, "2026-09-01T00:00:00Z", 10),
      sale(2, 100, "2026-09-06T00:00:00Z", 10),
    ]);
    expect(result.unattributed).toEqual([
      { transactionId: 1, typeId: 100, reason: "no_listing_at_time" },
    ]);
    expect(result.perSale.has(2)).toBe(true); // the post-listing sale still attributes (0 fees)
    expect(result.perSale.get(2)).toEqual({ total: 0, relisting: 0 });
  });

  it("ignores buy orders entirely — only sell-listing campaigns carry exit fees", () => {
    const b1 = buyOrder(100, "2026-09-01T10:00:00Z");
    const result = attributeExitFees([b1], new Map(), [sale(1, 100, "2026-09-02T00:00:00Z", 10)]);
    expect(result.unattributed).toEqual([
      { transactionId: 1, typeId: 100, reason: "no_listing_at_time" },
    ]);
  });
});

describe("computeOpenChainSunkFees", () => {
  it("sums the trailing campaign since the last fulfilled order, relisting = everything after its first listing", () => {
    const f1 = sellOrder(100, "2026-09-01T10:00:00Z", "fulfilled", 200);
    const c2 = sellOrder(100, "2026-09-02T10:00:00Z", "cancelled", 100);
    const o3 = sellOrder(100, "2026-09-03T10:00:00Z", "open", 100);
    const orderFees = new Map([
      [f1.orderId, 500],
      [c2.orderId, 800],
      [o3.orderId, 1000],
    ]);
    const sunk = computeOpenChainSunkFees([f1, c2, o3], orderFees);
    const s = sunk.get(100)!;
    expect(s.total).toBe(1800); // C2 + O3 — F1's fee belonged to the sold-out position
    expect(s.relisting).toBe(1000); // O3 is the relist; C2 was this campaign's initial listing
    expect(s.perUnit).toBe(18);
    expect(s.perUnitRelisting).toBe(10);
    expect(s.liveOrderId).toBe(o3.orderId);
    expect(s.orderCount).toBe(2);
  });

  it("types whose last order fulfilled get no entry — nothing left to churn", () => {
    const f1 = sellOrder(200, "2026-09-01T10:00:00Z", "fulfilled");
    const sunk = computeOpenChainSunkFees([f1], new Map([[f1.orderId, 500]]));
    expect(sunk.has(200)).toBe(false);
  });

  it("a delisted position (trailing cancelled orders, nothing live) still carries its sunk churn", () => {
    const c1 = sellOrder(300, "2026-09-01T10:00:00Z", "cancelled");
    const c2 = sellOrder(300, "2026-09-02T10:00:00Z", "cancelled");
    const sunk = computeOpenChainSunkFees([c1, c2], new Map([[c1.orderId, 100], [c2.orderId, 200]]));
    const s = sunk.get(300)!;
    expect(s.total).toBe(300);
    expect(s.relisting).toBe(200);
    expect(s.liveOrderId).toBeNull(); // nothing currently listed
  });

  it("unmatched order fees contribute 0 — sunk figures are a floor, not an estimate", () => {
    const o1 = sellOrder(400, "2026-09-01T10:00:00Z", "open");
    const sunk = computeOpenChainSunkFees([o1], new Map()); // no fee match for o1
    const s = sunk.get(400)!;
    expect(s.total).toBe(0);
    expect(s.orderCount).toBe(1); // campaign still visible, fees unknown
  });
});
