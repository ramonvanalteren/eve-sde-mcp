# Strategy — few large, well-cycling positions, sized to the market

The standing strategy this skill runs for hybrid station trading. It was set by user direction over 30 Sep – 4 Oct 2026, and this file is the single place its parameters and the evidence behind them live — other files point here instead of repeating numbers. Read it when proposing positions, judging the book's shape, or answering "is the strategy working?".

## Contents
- [The strategy in six lines](#the-strategy-in-six-lines)
- [Parameters](#parameters)
- [Tier definitions](#tier-definitions)
- [Dated findings — evidence, not rules](#dated-findings--evidence-not-rules)
- [Calibration notes from the user](#calibration-notes-from-the-user)
- [Baseline for judging the strategy](#baseline-for-judging-the-strategy)

## The strategy in six lines

1. **Larger positions on items that actually cycle** — not many small or idle ones. A slot has to earn its place: judge profit per slot (floor 10M per cycle) and conversion, not margin alone. The order count itself is not capped; 40–60 open buys is fine.
2. **Size to the market, not the wallet**: units = 25–50% of the item's average daily trade count (trades, not ISK/day).
3. **Rank by M/1M/day.** Margin is a floor test, total profit is a displayed column and a slot filter.
4. **Keep capital working.** Periodically kill idle or thin positions and redeploy the freed capital ([kill-and-redeploy mode](capital-allocation.md)). Don't hoard cash, least of all before a weekend.
5. **Report the tier mix** (T1/T2/T3 share of buy escrow) every time. T3 has been the weakest per ISK deployed, but the mix is report-only: no target, no flag.
6. **Judge the strategy on realized P&L** using the scorecard in [workflow-daily-close.md](workflow-daily-close.md) — not on net worth, and not on fewer than 7 days.

## Parameters

| Parameter | Value | Status | Enforced by |
|---|---|---|---|
| Sizing band | 25–50% of daily trades | User-set 2026-10-02 (was 15–25%) | `size_positions.py` `trade_share_band` |
| Rank key | M/1M/day, descending | User-set 2026-10-02 | `rank_by="yield"` |
| Unit increment | multiples of 5 | User-set | `unit_increment` |
| Thin-item exclusion | if the minimum 5 units exceeds 50% of daily trades (under ~10 trades/day), don't open it | Follows from the band | `size_positions.py` |
| Entry floors | T1 10% / T2 11% / T3 13% (T3 10% with the liquidity carve-out) | User-set 2026-09-23 | [margin-verification.md](margin-verification.md) |
| Hold floor | 10% flat, all tiers | User-set 2026-09-23 | margin-verification.md |
| Buffer | The user's most recently stated figure (250M on 2026-10-02, 400M on 2026-10-04). If none was stated, ask. | Per request | `buffer_target_isk` |
| Open-buy-order count | **No cap**; 40–60 open buys is fine | User-set 2026-10-04 (supersedes the 2 Oct request to cut ~40 orders) | Reported, not enforced: `max_open_orders=None`; the script adds a note only above 60 |
| Minimum profit per slot | **10M per full cycle** at the live margin, soft flag | User-set 2026-10-04 (set at 5M, raised to 10M later the same day) | `min_profit_per_slot` |
| Tier mix | **Report only** — no target, no flag | User-set 2026-10-04 | `current_tier_escrow` (printed, not flagged) |

"Soft" means flag it and name the rows — never silently block, drop or resize. The profit-per-slot floor is the only limit left: there is no order cap and no tier flag. All values above are user-set; if the user changes one, update this table and the matching default in `size_positions.py` together.

**Decisions and context** (so they can be revisited):
- **No order cap.** On 2 Oct the book held about 40 buys against 15 sells (35 buys, 4.07B of escrow, many idle for days) and the user asked to cut the count. On 4 Oct, asked about a cap, the user said no cap and that 40–60 is fine. The skill therefore polices slot *quality* — the profit floor, and Workflow 2's zero-fill and thin-position reporting — rather than slot count. The count is still reported in every snapshot and proposal.
- **10M per cycle.** Set at 5M, then raised to 10M the same day. In the 4 Oct redeploy plan three of the 16 rows would be flagged at 10M — Signal Amplifier II (8.4M), 720mm Howitzer Artillery II (7.5M) and Ice Harvester I (7.6M) — and none at 5M. It is a flag only, and per cycle on purpose: M/1M/day already rewards fast cheap items, so the user decides whether a fast cheap slot is worth keeping.
- **Tier mix report-only.** T3 was 58% of escrow on 4 Oct and returned about a quarter of T1's profit per ISK deployed, but the evidence is one week and one outlier trade, and some deep T3 items convert well (Coreli filled 4 units in the first hour after the redeploy). The mix is shown every time so the user can see it; the skill does not steer it.

## Tier definitions

By **unit cost** (the price paid per unit at Perimeter), matching the three saved A4E URLs: **T1** 0.5–5M, **T2** 5–20M, **T3** 20–50M. Below 0.5M is "micro", above 50M is "T4+". The mix is each tier's share of open **buy escrow**. `size_positions.py` computes it from unit prices.

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

## Calibration notes from the user

The strategy is meant to be assertive, not cautious. The user has pushed back on over-cautious output three times:
- 19 Sep: asked why only 10 units of a deep item when its daily trade count supported far more.
- 20 Sep: declined a skill change, saying it "makes you too cautious in selecting positions".
- 26 Sep: challenged a 1.7B cash buffer going into the weekend, historically the biggest selling days.

So: use the top of the band on deep books, keep buffers at what the user stated, and when the volume caps leave cash over, report the leftover honestly rather than inflating a position past 50% of daily trades or inventing weak candidates to fill it.

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
