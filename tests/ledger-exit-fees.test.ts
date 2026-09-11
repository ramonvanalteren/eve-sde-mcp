import { describe, it, expect } from "vitest";
import {
  attributeExitFees,
  attributeAcquisitionFees,
  computeOpenChainSunkFees,
  computeOpenBuySunkFees,
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
function buyOrder(typeId: number, issued: string, state: OrderRecord["state"]): OrderRecord {
  return { orderId: orderSeq++, typeId, isBuyOrder: true, price: 500, volumeTotal: 100, issued, state };
}
function sale(transactionId: number, typeId: number, date: string, quantity: number): ExitFeeSale {
  return { transactionId, date, typeId, quantity };
}
const purchase = sale;

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
    const b1 = buyOrder(100, "2026-09-01T10:00:00Z", "open");
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

describe("attributeAcquisitionFees", () => {
  it("attributes the buy campaign's fees to the units acquired, per lot", () => {
    // Buy campaign: initial order B1 (cancelled after being outbid, fee 1000)
    // + re-placed B2 (fills the position, fee 1000). A lot of 10 units acquired
    // through B2 carries (1000+1000)/10-per-unit... acquired qty is 10, so
    // the whole campaign cost lands on those units: 2000 total, 1000 relisting.
    const b1 = buyOrder(100, "2026-09-01T10:00:00Z", "cancelled");
    const b2 = buyOrder(100, "2026-09-02T10:00:00Z", "fulfilled");
    const orderFees = new Map([
      [b1.orderId, 1000],
      [b2.orderId, 1000],
    ]);
    const result = attributeAcquisitionFees([b1, b2], orderFees, [
      purchase(1, 100, "2026-09-03T12:00:00Z", 10),
    ]);
    expect(result.unattributed).toEqual([]);
    expect(result.perPurchase.get(1)).toEqual({ total: 2000, relisting: 1000 });
  });

  it("spreads campaign fees across all fills of the same order, proportionally", () => {
    // One order filling in two partial fills = two lots; the campaign fees
    // (the initial placement at 800 — cancelled after being outbid — plus
    // the re-place at 1200 that filled) split 30/70 across the lots,
    // converging on exactly the full campaign cost. The re-place is the
    // relisting churn, same rule as the sell side.
    const b1 = buyOrder(200, "2026-09-01T10:00:00Z", "cancelled");
    const b2 = buyOrder(200, "2026-09-02T10:00:00Z", "fulfilled");
    const orderFees = new Map([
      [b1.orderId, 800],
      [b2.orderId, 1200],
    ]);
    const result = attributeAcquisitionFees([b1, b2], orderFees, [
      purchase(1, 200, "2026-09-03T12:00:00Z", 30),
      purchase(2, 200, "2026-09-04T12:00:00Z", 70),
    ]);
    const lot1 = result.perPurchase.get(1)!;
    const lot2 = result.perPurchase.get(2)!;
    expect(lot1.total).toBe(600); // 2000/100 * 30
    expect(lot2.total).toBe(1400); // 2000/100 * 70
    expect(lot1.total + lot2.total).toBe(2000); // converges on the full campaign cost
    expect(lot1.relisting + lot2.relisting).toBe(1200); // the re-place that filled
  });

  it("a fulfilled buy order closes its campaign — later lots don't inherit its fees", () => {
    // B1 fully filled (fee 500) and closed that acquisition. The next
    // campaign is B2 (cancelled re-place, fee 800) + B3 (fills, fee 1000).
    // A lot acquired through B3 carries 800+1000, not B1's fee.
    const b1 = buyOrder(300, "2026-09-01T10:00:00Z", "fulfilled");
    const b2 = buyOrder(300, "2026-09-02T10:00:00Z", "cancelled");
    const b3 = buyOrder(300, "2026-09-03T10:00:00Z", "fulfilled");
    const orderFees = new Map([
      [b1.orderId, 500],
      [b2.orderId, 800],
      [b3.orderId, 1000],
    ]);
    const result = attributeAcquisitionFees([b1, b2, b3], orderFees, [
      purchase(1, 300, "2026-09-04T12:00:00Z", 10),
    ]);
    expect(result.perPurchase.get(1)).toEqual({ total: 1800, relisting: 1000 });
  });

  it("excludes fees of buy orders placed after the purchase", () => {
    // Lot filled through B1 at 09-01 15:00; the later re-place B2 (placed
    // 09-02, filling later) is the NEXT acquisition's cost, not this lot's.
    const b1 = buyOrder(400, "2026-09-01T10:00:00Z", "fulfilled");
    const b2 = buyOrder(400, "2026-09-02T10:00:00Z", "cancelled");
    const orderFees = new Map([
      [b1.orderId, 1000],
      [b2.orderId, 700],
    ]);
    const result = attributeAcquisitionFees([b1, b2], orderFees, [
      purchase(1, 400, "2026-09-01T15:00:00Z", 50),
    ]);
    expect(result.perPurchase.get(1)).toEqual({ total: 1000, relisting: 0 });
  });

  it("purchases before any synced buy order are unattributed, not guessed", () => {
    const b1 = buyOrder(500, "2026-09-05T10:00:00Z", "open");
    const result = attributeAcquisitionFees([b1], new Map(), [
      purchase(1, 500, "2026-09-01T00:00:00Z", 10),
      purchase(2, 500, "2026-09-06T00:00:00Z", 10),
    ]);
    expect(result.unattributed).toEqual([
      { transactionId: 1, typeId: 500, reason: "no_order_at_time" },
    ]);
    expect(result.perPurchase.get(2)).toEqual({ total: 0, relisting: 0 });
  });

  it("ignores sell orders entirely", () => {
    const s1 = sellOrder(600, "2026-09-01T10:00:00Z", "open");
    const result = attributeAcquisitionFees([s1], new Map(), [
      purchase(1, 600, "2026-09-02T00:00:00Z", 10),
    ]);
    expect(result.unattributed).toEqual([
      { transactionId: 1, typeId: 600, reason: "no_order_at_time" },
    ]);
  });
});

describe("computeOpenBuySunkFees", () => {
  it("sums the trailing buy campaign after the last fulfilled order", () => {
    const b1 = buyOrder(700, "2026-09-01T10:00:00Z", "fulfilled");
    const b2 = buyOrder(700, "2026-09-02T10:00:00Z", "cancelled");
    const b3 = buyOrder(700, "2026-09-03T10:00:00Z", "open");
    const orderFees = new Map([
      [b1.orderId, 500],
      [b2.orderId, 800],
      [b3.orderId, 1000],
    ]);
    const sunk = computeOpenBuySunkFees([b1, b2, b3], orderFees);
    const s = sunk.get(700)!;
    expect(s.total).toBe(1800); // b2 + b3 — b1's fee belonged to the completed acquisition
    expect(s.relisting).toBe(1000); // b3 is the re-place; b2 was this campaign's initial order
    expect(s.liveOrderId).toBe(b3.orderId);
    expect(s.orderCount).toBe(2);
  });

  it("types whose last buy order fulfilled get no entry — nothing being acquired", () => {
    const b1 = buyOrder(800, "2026-09-01T10:00:00Z", "fulfilled");
    const sunk = computeOpenBuySunkFees([b1], new Map([[b1.orderId, 500]]));
    expect(sunk.has(800)).toBe(false);
  });

  it("a delisted buy attempt still carries its sunk churn, with no live order", () => {
    const b1 = buyOrder(900, "2026-09-01T10:00:00Z", "cancelled");
    const b2 = buyOrder(900, "2026-09-02T10:00:00Z", "cancelled");
    const sunk = computeOpenBuySunkFees([b1, b2], new Map([[b1.orderId, 100], [b2.orderId, 200]]));
    const s = sunk.get(900)!;
    expect(s.total).toBe(300);
    expect(s.relisting).toBe(200);
    expect(s.liveOrderId).toBeNull();
  });

  it("ignores sell orders", () => {
    const s1 = sellOrder(950, "2026-09-01T10:00:00Z", "open");
    expect(computeOpenBuySunkFees([s1], new Map([[s1.orderId, 100]])).size).toBe(0);
  });
});
