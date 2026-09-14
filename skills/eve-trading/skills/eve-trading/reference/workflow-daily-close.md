# Workflow 6: Daily close (accounting)

This is a distinct deliverable from a portfolio review — a real day-close, in the sense a daytrading desk would run one: realized P&L (booked, cash-true) separated from unrealized P&L (mark-to-market on what's still held), with fees and tax as their own expense line rather than folded into a margin percentage. It runs on its own ledger (`~/.eve-sde/ledger.db`), not just live ESI calls, because **ESI's wallet journal and transaction history only cover a rolling ~30 days** — anything not synced before it ages out is gone permanently, with no way to recover it later, even from CCP support. Trigger this workflow explicitly ("daily close", "close today", "P&L for this week/month") — don't run it as part of a default portfolio review.

**Since the Perimeter move, expect more variance in per-order `brokers_fee` journal entries** (some at 0.5% + flat from Perimeter HQ, some at 1.5% from legacy Jita 4-4 orders) — that's expected during and after the transition, not a data error, since this workflow pulls the *actual* fee paid per the wallet journal rather than assuming a single flat rate. The per-station models behind that matching are visible via `get_station_fees`.

Tools: `sync_wallet_ledger`, `run_daily_close`, `get_daily_close`, `get_close_range`, `get_open_lots`.

## Contents
- [Run the close](#1-run-the-close)
- [Cost basis is strict FIFO](#2-cost-basis-is-strict-fifo-here-not-the-bounded-weighted-average-used-in-the-live-portfolio-review)
- [Present the report as an actual close](#3-present-the-report-as-an-actual-close-top-to-bottom)
- [Flags are the point](#4-flags-are-the-point--dont-bury-them-in-the-numbers)
- [Backfilling](#5-backfilling)
- [Period review](#6-period-review)
- [Relationship to portfolio reviews](#7-this-workflow-does-not-replace-live-verification)

1. **Run the close**: call `run_daily_close` (defaults to the most recently completed UTC day — yesterday). This syncs the ledger first, so it's always safe to run even after a gap — but the longer the gap, the more likely something aged out of ESI's 30-day window before ever being synced (check `get_close_range` for missing dates and say so plainly if there's a hole).
2. **Cost basis is strict FIFO here, not the bounded-weighted-average used in the live portfolio review.** The portfolio review reconstructs cost basis on demand from whatever `get_wallet_transactions` returns that day (necessarily approximate, since ESI's window is short — and the endpoint itself caches for up to 3600s/1 hour, same as `get_wallet_journal`, so a transaction from the last hour may simply not be visible yet regardless of the 30-day window; see margin-verification.md's ESI cache table). The ledger instead records every synced transaction permanently and consumes lots oldest-first as sells happen — more precise, and it's what makes a real day-close possible at all. Don't be confused seeing two different cost-basis methods in the same skill; they're solving different problems (a quick live check vs. a persistent accounting record).
3. **Present the report as an actual close, top to bottom**:
   - Opening NAV → Realized P&L (revenue − COGS = gross; minus **actual** broker fees and sales tax pulled from the wallet journal, not an estimated percentage — this is what makes relisting costs visible, since every relist is its own real `brokers_fee` entry) → Unrealized P&L (mark-to-market on current open lots at Jita best bid, **only computed for today** — a backfilled past date gets realized figures only, say so explicitly) → Closing NAV.
   - NAV = wallet balance + buy-order escrow (across both locations) + inventory marked to market.
4. **Flags are the point — don't bury them in the numbers.** `run_daily_close` surfaces, as an explicit list:
   - Sells with no matching lot (**unmatched cost basis** — pre-dates the ledger, or arrived via loot/reward/contract/corp transfer rather than a market buy). These are excluded from realized P&L rather than costed at a guess; report the revenue separately and say plainly it's not included in P&L.
   - Live-asset quantity vs. ledger lot quantity mismatches per item — the ledger's view of "what's held" can drift from reality (manufacturing, contracts, item movement), and this is where that shows up.
   - Non-trading cashflow (anything in the journal that isn't `market_transaction`/`brokers_fee`/`transaction_tax` — transfers, insurance, contracts) — same caveat as the wallet-reconciliation note in SKILL.md: check it before trusting NAV.
   - A reconciliation gap between expected and actual NAV change since the prior close, when one can be computed.
5. **Backfilling**: `run_daily_close` accepts `close_date` for a past date to compute realized P&L retroactively from already-synced ledger data (useful if days were missed) — but it will not have unrealized/NAV for that date, since mark-to-market needs live prices.
6. **Period review**: use `get_close_range` for a week/month of already-computed closes rather than re-deriving trend numbers by hand — it also returns summed totals (net realized P&L, fees, tax) across the range.
7. **This workflow does not replace the live verification** in the portfolio review before acting on a position — it's the accounting record of what already happened, not a tool for deciding what to do next. Point the user back to a portfolio review for that.
