import { describe, it, expect } from "vitest";
import { computeReconciliationGap } from "../src/ledger/fifo.js";

describe("computeReconciliationGap", () => {
  it("returns 0 when NAV change exactly equals realized + non-trading + change in unrealized", () => {
    // NAV 100 -> 110 (change 10). Realized net 5, non-trading 0,
    // unrealized went 3 -> 8 (change 5). 5 + 0 + 5 = 10.
    const gap = computeReconciliationGap({
      closingNav: 110,
      openingNav: 100,
      realizedPnlNet: 5,
      nonTradingCashflow: 0,
      unrealizedPnl: 8,
      priorUnrealizedPnl: 3,
    });
    expect(gap).toBe(0);
  });

  it("does NOT create a false break from the prior day's unrealized P&L (regression: old formula subtracted today's total unrealized, making the gap equal minus yesterday's paper P&L)", () => {
    // Nothing happened today: NAV flat, no trading, unrealized unchanged at 10
    // (e.g. inventory still held, marks unchanged). Old (buggy) formula:
    //   100 - 100 - 0 - 0 - 10 = -10  <- false break every holding day.
    // Correct: the CHANGE is 0, so the gap is 0.
    const gap = computeReconciliationGap({
      closingNav: 100,
      openingNav: 100,
      realizedPnlNet: 0,
      nonTradingCashflow: 0,
      unrealizedPnl: 10,
      priorUnrealizedPnl: 10,
    });
    expect(gap).toBe(0);
  });

  it("only counts the CHANGE in unrealized, not the total, when marks moved", () => {
    // NAV 100 -> 103 (change 3). No realized, no non-trading. Unrealized
    // went 4 -> 7 (change 3). Gap must be 0 — the NAV move is fully the
    // mark-to-market shift.
    const gap = computeReconciliationGap({
      closingNav: 103,
      openingNav: 100,
      realizedPnlNet: 0,
      nonTradingCashflow: 0,
      unrealizedPnl: 7,
      priorUnrealizedPnl: 4,
    });
    expect(gap).toBe(0);
  });

  it("surfaces a genuine break", () => {
    // NAV moved 5 but nothing explains it: realized 0, non-trading 0,
    // unrealized unchanged. Gap = 5 — investigate.
    const gap = computeReconciliationGap({
      closingNav: 105,
      openingNav: 100,
      realizedPnlNet: 0,
      nonTradingCashflow: 0,
      unrealizedPnl: 5,
      priorUnrealizedPnl: 5,
    });
    expect(gap).toBe(5);
  });

  it("treats an unknown prior unrealized as 0 (first close with marks, or pre-migration row)", () => {
    const gap = computeReconciliationGap({
      closingNav: 110,
      openingNav: 100,
      realizedPnlNet: 10,
      nonTradingCashflow: 0,
      unrealizedPnl: 0,
      priorUnrealizedPnl: null,
    });
    expect(gap).toBe(0);
  });

  it("accounts for non-trading cashflow (deposits/withdrawals are not P&L)", () => {
    // 1,000 ISK deposited (non-trading), NAV rose by exactly that, no P&L.
    const gap = computeReconciliationGap({
      closingNav: 101_000,
      openingNav: 100_000,
      realizedPnlNet: 0,
      nonTradingCashflow: 1_000,
      unrealizedPnl: 0,
      priorUnrealizedPnl: 0,
    });
    expect(gap).toBe(0);
  });

  it("returns null when NAV or this close's unrealized figure is unavailable", () => {
    const base = {
      openingNav: 100,
      realizedPnlNet: 5,
      nonTradingCashflow: 0,
      unrealizedPnl: 8,
      priorUnrealizedPnl: 3,
    } as const;
    expect(computeReconciliationGap({ ...base, closingNav: null })).toBeNull();
    expect(
      computeReconciliationGap({ ...base, closingNav: 110, openingNav: null })
    ).toBeNull();
    expect(
      computeReconciliationGap({ ...base, closingNav: 110, unrealizedPnl: null })
    ).toBeNull();
  });
});
