import { describe, it, expect } from "vitest";
import {
  applyFifo,
  summarizeRealized,
  summarizeFeesAndTax,
  splitCashflow,
  computeUnrealized,
  type LotState,
  type TransactionInput,
} from "../src/ledger/fifo.js";

function buy(transactionId: number, date: string, typeId: number, quantity: number, unitPrice: number): TransactionInput {
  return { transactionId, date, typeId, quantity, unitPrice, isBuy: true };
}
function sell(transactionId: number, date: string, typeId: number, quantity: number, unitPrice: number): TransactionInput {
  return { transactionId, date, typeId, quantity, unitPrice, isBuy: false };
}

describe("applyFifo", () => {
  it("consumes the oldest lot first", () => {
    const txs = [
      buy(1, "2026-08-01T00:00:00Z", 100, 10, 1000),
      buy(2, "2026-08-02T00:00:00Z", 100, 10, 1200),
      sell(3, "2026-08-03T00:00:00Z", 100, 5, 1500),
    ];
    const result = applyFifo([], txs);

    expect(result.consumptions).toHaveLength(1);
    expect(result.consumptions[0]).toMatchObject({
      buyTransactionId: 1,
      quantity: 5,
      unitCost: 1000,
      unitSellPrice: 1500,
      unmatched: false,
    });

    const lot1 = result.updatedLots.find((l) => l.buyTransactionId === 1)!;
    const lot2 = result.updatedLots.find((l) => l.buyTransactionId === 2)!;
    expect(lot1.remainingQty).toBe(5);
    expect(lot2.remainingQty).toBe(10);
  });

  it("spans multiple lots when a sell exceeds the oldest lot's remaining quantity", () => {
    const txs = [
      buy(1, "2026-08-01T00:00:00Z", 100, 10, 1000),
      buy(2, "2026-08-02T00:00:00Z", 100, 10, 1200),
      sell(3, "2026-08-03T00:00:00Z", 100, 15, 1500),
    ];
    const result = applyFifo([], txs);

    expect(result.consumptions).toHaveLength(2);
    expect(result.consumptions[0]).toMatchObject({ buyTransactionId: 1, quantity: 10, unitCost: 1000 });
    expect(result.consumptions[1]).toMatchObject({ buyTransactionId: 2, quantity: 5, unitCost: 1200 });

    const lot2 = result.updatedLots.find((l) => l.buyTransactionId === 2)!;
    expect(lot2.remainingQty).toBe(5);
  });

  it("flags a sell that outruns all available lots as unmatched, without fabricating a cost", () => {
    const txs = [
      buy(1, "2026-08-01T00:00:00Z", 100, 5, 1000),
      sell(2, "2026-08-02T00:00:00Z", 100, 8, 1500),
    ];
    const result = applyFifo([], txs);

    expect(result.consumptions).toHaveLength(2);
    expect(result.consumptions[0]).toMatchObject({ buyTransactionId: 1, quantity: 5, unmatched: false });
    expect(result.consumptions[1]).toMatchObject({ buyTransactionId: null, quantity: 3, unitCost: null, unmatched: true });
  });

  it("picks up existing open lots from a prior run and sorts transactions internally regardless of input order", () => {
    const existing: LotState[] = [
      { buyTransactionId: 1, typeId: 100, date: "2026-08-01T00:00:00Z", originalQty: 10, remainingQty: 10, unitCost: 1000 },
    ];
    const txs = [
      sell(3, "2026-08-05T00:00:00Z", 100, 4, 1500),
      buy(2, "2026-08-03T00:00:00Z", 100, 10, 1100), // out of order on purpose
    ];
    const result = applyFifo(existing, txs);

    expect(result.consumptions).toEqual([
      expect.objectContaining({ buyTransactionId: 1, quantity: 4, unitCost: 1000 }),
    ]);
    const lot1 = result.updatedLots.find((l) => l.buyTransactionId === 1)!;
    expect(lot1.remainingQty).toBe(6);
  });
});

describe("summarizeRealized", () => {
  it("excludes unmatched sells from revenue/cogs but reports them separately", () => {
    const summary = summarizeRealized([
      { sellTransactionId: 1, buyTransactionId: 10, typeId: 1, date: "", quantity: 5, unitCost: 1000, unitSellPrice: 1500, unmatched: false },
      { sellTransactionId: 2, buyTransactionId: null, typeId: 1, date: "", quantity: 3, unitCost: null, unitSellPrice: 1500, unmatched: true },
    ]);
    expect(summary.revenue).toBe(5 * 1500);
    expect(summary.cogs).toBe(5 * 1000);
    expect(summary.grossPnl).toBe(5 * 1500 - 5 * 1000);
    expect(summary.unmatchedRevenue).toBe(3 * 1500);
    expect(summary.unmatchedQty).toBe(3);
  });
});

describe("summarizeFeesAndTax", () => {
  it("sums brokers_fee and transaction_tax as positive expense totals, ignoring other ref_types", () => {
    const result = summarizeFeesAndTax([
      { refType: "brokers_fee", amount: -1500 },
      { refType: "brokers_fee", amount: -800 }, // e.g. a relist — shows up as a second real fee, not estimated
      { refType: "transaction_tax", amount: -3400 },
      { refType: "market_transaction", amount: 50000 },
      { refType: "player_donation", amount: 100000 },
    ]);
    expect(result.brokerFees).toBe(2300);
    expect(result.salesTax).toBe(3400);
  });
});

describe("splitCashflow", () => {
  // Regression test for the run_daily_close bug report: new/reissued buy
  // orders produce market_escrow entries that were incorrectly landing in
  // nonTradingCashflow and triggering a false "investigate this" flag.
  it("classifies market_escrow as routine trading activity, not non-trading cashflow", () => {
    const result = splitCashflow([
      { refType: "market_escrow", amount: -245_850_000 }, // Scythe order captured
      { refType: "market_escrow", amount: -381_000_000 }, // Medium Industrial Core II captured
      { refType: "market_escrow", amount: -175_200_000 }, // Imperial Navy 400mm Steel Plates captured
      { refType: "market_transaction", amount: 50_000_000 },
      { refType: "brokers_fee", amount: -1_500_000 },
      { refType: "transaction_tax", amount: -1_700_000 },
    ]);
    expect(result.nonTradingCashflow).toBe(0);
    expect(result.escrowMovement).toBe(-245_850_000 - 381_000_000 - 175_200_000);
  });

  it("still flags genuine non-trading movement (transfers, contracts, insurance) separately from escrow", () => {
    const result = splitCashflow([
      { refType: "market_escrow", amount: -100_000_000 },
      { refType: "player_donation", amount: -500_000_000 },
      { refType: "insurance", amount: 20_000_000 },
    ]);
    expect(result.escrowMovement).toBe(-100_000_000);
    expect(result.nonTradingCashflow).toBe(-500_000_000 + 20_000_000);
  });

  it("treats escrow release (positive amount, order cancelled) the same as capture — still routine", () => {
    const result = splitCashflow([{ refType: "market_escrow", amount: 245_850_000 }]);
    expect(result.escrowMovement).toBe(245_850_000);
    expect(result.nonTradingCashflow).toBe(0);
  });
});

describe("computeUnrealized", () => {
  it("marks held lots to the current best bid", () => {
    const lots: LotState[] = [
      { buyTransactionId: 1, typeId: 100, date: "2026-08-01T00:00:00Z", originalQty: 10, remainingQty: 6, unitCost: 1000 },
      { buyTransactionId: 2, typeId: 200, date: "2026-08-01T00:00:00Z", originalQty: 4, remainingQty: 4, unitCost: 500 },
    ];
    const result = computeUnrealized(lots, (typeId) => (typeId === 100 ? 1200 : undefined));

    const t100 = result.perType.find((p) => p.typeId === 100)!;
    expect(t100.marketValue).toBe(6 * 1200);
    expect(t100.unrealizedPnl).toBe(6 * 1200 - 6 * 1000);
    expect(t100.priceMissing).toBe(false);

    const t200 = result.perType.find((p) => p.typeId === 200)!;
    expect(t200.priceMissing).toBe(true);
    expect(t200.marketValue).toBe(t200.cost); // falls back to cost, not a fabricated gain/loss
    expect(t200.unrealizedPnl).toBe(0);
  });

  it("ignores fully-consumed lots", () => {
    const lots: LotState[] = [
      { buyTransactionId: 1, typeId: 100, date: "2026-08-01T00:00:00Z", originalQty: 10, remainingQty: 0, unitCost: 1000 },
    ];
    const result = computeUnrealized(lots, () => 1200);
    expect(result.perType).toHaveLength(0);
    expect(result.totalMarketValue).toBe(0);
  });
});
