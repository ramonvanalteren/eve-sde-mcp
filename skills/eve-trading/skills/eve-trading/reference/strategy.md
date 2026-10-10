# Strategy — larger positions on items that actually cycle, sized to the market

The standing strategy this skill runs for hybrid station trading. It was set by user direction over 30 Sep – 4 Oct 2026. This file is the **single source of truth for the strategy parameters** (the block under "Parameters", which `scripts/size_positions.py` reads) and holds the evidence behind them; other files refer to the parameters by name instead of repeating values. Read it when proposing positions, judging the book's shape, or answering "is the strategy working?".

## Contents
- [The strategy in six lines](#the-strategy-in-six-lines)
- [Parameters](#parameters)
- [Tier definitions](#tier-definitions)
- [Calibration notes from the user](#calibration-notes-from-the-user)
- [Evidence and baseline](#evidence-and-baseline)

## The strategy in six lines

1. **Larger positions on items that actually cycle** — not many small or idle ones. A slot has to earn its place: judge profit per slot (the profit-per-slot floor) and conversion, not margin alone. The order count itself is not capped; the comfortable order range is in the parameter block.
2. **Size to the market, not the wallet**: units = the sizing band of the item's average daily trade count (trades, not ISK/day).
3. **Rank by M/1M/day.** Margin is a floor test, total profit is a displayed column and a slot filter.
4. **Keep capital working.** Periodically kill idle or thin positions and redeploy the freed capital ([kill-and-redeploy mode](capital-allocation.md)). Don't hoard cash, least of all before a weekend.
5. **Report the tier mix** (T1/T2/T3 share of buy escrow) every time. T3 has been the weakest per ISK deployed, but the mix is report-only: no target, no flag.
6. **Judge the strategy on realized P&L** using the scorecard in [workflow-daily-close.md](workflow-daily-close.md) — not on net worth, and not on fewer than 7 days.

## Parameters

The block between the markers is machine-read: `size_positions.py` loads its defaults from it, and the tests in `skills/eve-trading/tests/` check that nothing else in the skill repeats these values. Change a value here and nowhere else. Tier boundaries are in ISK per unit; a `null` limit means "none". (The unit increment is also worded into SKILL.md's sizing rule — "multiples of 5" — so keep those two in step; the tests don't cover it.)

<!-- strategy-params:begin -->
```json
{
  "sizing_band_pct_of_daily_trades": [25, 50],
  "unit_increment": 5,
  "rank_by": "yield",
  "min_profit_per_slot_isk": 10000000,
  "comfortable_order_range": [40, 60],
  "max_open_orders": null,
  "t3_share_flag_pct": null,
  "fewer_orders_variant_profit_share": 0.67,
  "tiers_isk_per_unit": {
    "T1": [500000, 5000000],
    "T2": [5000000, 20000000],
    "T3": [20000000, 50000000]
  }
}
```
<!-- strategy-params:end -->

| Parameter | Meaning | Set by the user | Enforced by |
|---|---|---|---|
| `sizing_band_pct_of_daily_trades` | Units as a share of the item's average daily trade count. Above the ceiling a row is flagged OVER-BAND; if the minimum increment alone exceeds the ceiling the item is excluded as thin. | 2026-10-02 (raised from a lower band) | `size_positions.py` |
| `unit_increment` | Positions are sized in multiples of this many units. | Earlier | `size_positions.py` |
| `rank_by` | `yield` = M/1M/day, descending. Margin is only a floor test. | 2026-10-02 | `size_positions.py` |
| `min_profit_per_slot_isk` | Soft floor on total profit per full cycle at the live margin; rows below are flagged SMALL-SLOT, never dropped. | 2026-10-04 | `size_positions.py` |
| `comfortable_order_range` | The open-buy count the user is comfortable with. There is no cap: the count is reported, and the script adds a note only above the top of the range. | 2026-10-04 (supersedes the 2 Oct request to cut the count) | reported only |
| `max_open_orders` | A hard-ish cap if the user ever wants one; `null` = none. | 2026-10-04 (no cap) | `size_positions.py` |
| `t3_share_flag_pct` | Flag when T3's share of escrow exceeds this; `null` = report only. | 2026-10-04 (report only) | `size_positions.py` |
| `fewer_orders_variant_profit_share` | The fewer-orders variant keeps the shortest ranked prefix holding this share of the profit. Two thirds because on the 4 Oct plan the top 9 of 16 rows held 68% of the profit for 53% of the capital. | Skill default | `size_positions.py` |
| `tiers_isk_per_unit` | Tier boundaries by unit price (the price paid per unit at Perimeter), matching the three saved A4E URLs. Below the T1 floor is "micro", above the T3 ceiling is "T4+". | Earlier | `size_positions.py` |

Margin floors (entry by tier, flat hold floor) are not here — they live in [margin-verification.md](margin-verification.md). The buffer is not a parameter: it is the figure the user most recently stated, in ISK, for the request at hand (250M on 2026-10-02, 400M on 2026-10-04); if none was stated, ask.

"Soft" means flag it and name the rows — never silently block, drop or resize. The profit-per-slot floor is the only limit left: there is no order cap and no tier flag.

**Decisions and context** (provenance, so they can be revisited; the supporting numbers are dated snapshots in [strategy-evidence.md](strategy-evidence.md)):
- **No order cap.** On 2 Oct the user asked to cut the order count; on 4 Oct, asked about a cap, they said no cap and that the comfortable range is fine. The skill therefore polices slot *quality* — the profit floor, and Workflow 2's zero-fill and thin-position reporting — rather than slot count. The count is still reported in every snapshot and proposal.
- **Profit-per-slot floor.** Set at one value, then raised the same day. It is a flag only, and per cycle on purpose: M/1M/day already rewards fast cheap items, so the user decides whether a fast cheap slot is worth keeping.
- **Fill evidence over inference; fast items allowed a lower floor.** On 9 Oct the user corrected a claim that fast, high-margin items never fill (it rested on ESI daily lows) and, in the same request, allowed a lower entry floor for sufficiently high-velocity items. The skill therefore gates candidates on A4E Sold2Buy and the live book ([margin-verification.md](margin-verification.md), "Fill evidence" and "Margin thresholds"), and treats the relaxed floor as the user's allowance, labelled wherever it is used.
- **Tier mix report-only.** T3 has returned a fraction of T1's profit per ISK deployed, but the evidence is one week and one outlier trade, and some deep T3 items convert well. The mix is shown every time so the user can see it; the skill does not steer it.

## Tier definitions

Tiers are by **unit cost** — the boundaries are `tiers_isk_per_unit` in the parameter block, matching the three saved A4E URLs. The mix is each tier's share of open **buy escrow**; `size_positions.py` computes it from unit prices.

## Calibration notes from the user

The strategy is meant to be assertive, not cautious. The user has pushed back on over-cautious output three times:
- 19 Sep: asked why only 10 units of a deep item when its daily trade count supported far more.
- 20 Sep: declined a skill change, saying it "makes you too cautious in selecting positions".
- 26 Sep: challenged a 1.7B cash buffer going into the weekend, historically the biggest selling days.

So: use the top of the band on deep books, keep buffers at what the user stated, and when the volume caps leave cash over, report the leftover honestly rather than inflating a position past 50% of daily trades or inventing weak candidates to fill it.

## Evidence and baseline

Dated findings, the tier analysis and the baseline for judging the strategy live in [strategy-evidence.md](strategy-evidence.md). They are snapshots from fixed dates, **not the current state of the book**: read that file only for the strategy scorecard or a tier-performance question, and never compare a live pull against it.
