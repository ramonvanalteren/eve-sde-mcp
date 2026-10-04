# Strategy evidence — dated snapshots, not current state

**Every figure in this file comes from a fixed date.** It is not the current book. Never compare a live pull against it, quote it as "the last snapshot", or open a report with a mismatch warning because today's numbers differ. Use it only for the strategy scorecard ([workflow-daily-close.md](workflow-daily-close.md), step 8) and for tier-performance questions; the rules and parameters are in [strategy.md](strategy.md).

## Contents
- [Dated findings](#dated-findings--evidence-not-rules)
- [Baseline for judging the strategy](#baseline-for-judging-the-strategy)
- [Evidence behind the parameter decisions](#evidence-behind-the-parameter-decisions)

## Dated findings — evidence, not rules

Measured 2026-10-04 over 27 Sep – 3 Oct (7 daily closes, per-position realized P&L net of sales tax and matched broker fees). One week of data: re-measure before treating any of it as stable.

| Tier | Net profit | Net on cost sold | ISK/day per 1M deployed |
|---|---|---|---|
| T1 | 399M | 27.7% | about 95K |
| T2 | 414M | 15.3% | about 32K |
| T3 | 341M | 12.8% (9.9% without one Neutralizer trade) | about 24K |
| Micro (<500K) | 47M | | |

- T1 and T2 tie on absolute profit; T1 is best per ISK deployed.
- Capital turn: T1 about 0.35/day, T3 about 0.19/day. The T1–T3 gap splits roughly 56% margin, 44% turn.
- Velocity measured in units is largely a price artifact — cheap items trade more units. Within equal-velocity buckets, higher price bands earn less per unit.
- Capital held relative to market volume: T1 about 0.10 days, T2 0.18, T3 0.31. Four thin T3 items each held 1.3–3.2 days of the whole market's volume.
- Reading: the T3 shortfall is mostly oversized positions in thin markets plus a modest margin penalty — hence size by market volume, cut thin T3, keep deep T3 (Pithum A Thermal, Coreli, Pithum B EM Shield Amplifier were the deep ones), and don't push T1 beyond what its markets absorb.
- A4E's ISK/day figures swing several-fold between snapshots on T3 items (Dread Guristas Light Missile Launcher went from 141M to 1,225M ISK/day overnight), which is why sizing uses trades/day.
- The daily closes' totals for the same window sum to about 1.10B against 1.20B in this per-position view; the difference was not reconciled.

## Baseline for judging the strategy

The kill-and-redeploy plan went live around 19:00 UTC on 2026-10-04; the rule changes before it (1–2 Oct: the M/1M/day metric, the 25–50% band, yield ranking) are earlier. Fills from the redeployed positions first reach a close on 5 Oct, so the first fair test is the week of **5–11 Oct** against this baseline. Re-run it with the scorecard in [workflow-daily-close.md](workflow-daily-close.md).

| Metric | 20–26 Sep | 27 Sep – 3 Oct | Thu–Sat 24–26 Sep | Thu–Sat 1–3 Oct |
|---|---|---|---|---|
| Realized net P&L, total | 918M | 1,098M | 424M | 426M |
| Per day (median day) | 131M (138M) | 157M (140M) | 141M | 142M |
| Net as % of sales | 13.4% | 12.7% | | |
| Net as % of cost of goods sold | 16.7% | 15.6% | | |
| Inventory days (approx.) | 2.16 | 1.93 | | |

Book shape: 4 Oct 10:50 UTC (before the redeploy) 31 buys, 3,582M escrow, T1/T2/T3 11/31/58%. About 19:50 UTC (after) 39 buys, 3,928M escrow, T1/T2/T3 about 10/51/38%, average 101M per order, 15 of 39 orders under 50M escrow holding 8.9% of escrow, wallet 758M.

Two lessons already in the numbers: the week-over-week gain predates 1 Oct (the best days were 27 and 29 Sep), and the redeploy raised the order count rather than lowering it — which the user has said is fine, so slot quality (the profit floor) is what is policed.

## Evidence behind the parameter decisions

- **Order count.** On 2 Oct the book held about 40 buys against 15 sells (35 buys, 4.07B of escrow, many idle for days) and the user asked to cut the count; on 4 Oct they said no cap and that 40–60 is fine.
- **Profit-per-slot floor.** The floor was set at 5M, then raised to 10M the same day. In the 4 Oct redeploy plan three of the 16 rows are below 10M per cycle — Signal Amplifier II (8.4M), 720mm Howitzer Artillery II (7.5M) and Ice Harvester I (7.6M) — and none are below 5M.
- **Tier mix.** T3 was 58% of buy escrow on 4 Oct before the redeploy and returned about a quarter of T1's profit per ISK deployed (see the findings above). One deep T3 item, Coreli, filled 4 units in the first hour after the redeploy.
