# Workflow 1: New position selection (A4E tiers → live verification → fill-evidence gates → sizing)

Runs when new candidates are explicitly requested. Fetches its own A4E data — it does not need a pasted snapshot to run. Verify every candidate margin with the [two-call procedure in margin-verification.md](margin-verification.md) before recommending anything, and judge whether a bid will fill from [fill evidence](margin-verification.md#fill-evidence), never from margin alone.

The mechanical part is scripted (stdlib Python, run from this skill's folder; the session saves the character's tool results to JSON files first — formats in `scripts/portfolio.py`):

```bash
python scripts/a4e.py fetch a4e/                       # raw A4E pages: three saved tiers + the high-velocity pull
python scripts/scan_candidates.py --a4e-dir a4e/ --orders orders.json \
    --killed <ids> --exclude-prefix "<family>,<family>" --extra-held <ids>   # live verification + gates
python scripts/depth.py <type ids> --orders orders.json                      # depth checklist on the rows you will recommend
python scripts/size_positions.py plan.json                                   # sizing, ranking, buffer walk
```

Judgement stays with you: which rows to recommend, the depth read, the unit counts handed to the sizer.

## Contents
- [Step 1 — fetch the A4E pages](#step-1--fetch-the-a4e-pages)
- [Step 2 — what never enters the scan](#step-2--what-never-enters-the-scan)
- [Step 3 — scan: live margin and the gates](#step-3--scan-live-margin-and-the-gates)
- [Steps 4–8 — depth, size, present, repeat-cancels](#steps-48)

## Step 1 — fetch the A4E pages

Don't wait for the user to paste a snapshot, and don't substitute a generic/default-filter A4E page. Fetch the saved filters below with `scripts/a4e.py fetch` (it saves the raw HTML, three pages per tier and four for the high-velocity pull). Raw pages matter: the fill-evidence gates read the Sold2Buy columns and the 7-day price deltas, which a summarised WebFetch drops. If the script cannot run, WebFetch each URL asking for *every* row with those columns — a truncated top-5 summary defeats the point of saved filters.

- **T1 (low price, high turnover)**: `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=500000%2C0&buyLT=5.000.000%2C0&tradesGT=30&tradesLT=&tradeIskGT=50.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=0.5&trackVolLT=2.5&trackNumGT=0.5&trackNumLT=2.5&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 500K–5M ISK, ≥30 trades/day, ≥50M ISK/day traded, track-volatility band 0.5–2.5, track-number band 0.5–2.5.
- **T2**: `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=5.000.000%2C0&buyLT=20000000%2C0&tradesGT=20&tradesLT=&tradeIskGT=100.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=0.3&trackVolLT=4.0&trackNumGT=0.3&trackNumLT=4.0&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 5M–20M ISK, ≥20 trades/day, ≥100M ISK/day traded, track-volatility band 0.3–4.0, track-number band 0.3–4.0.
- **T3**: `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=20.000.000%2C0&buyLT=50000000%2C0&tradesGT=10&tradesLT=&tradeIskGT=200.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=0.2&trackVolLT=5.0&trackNumGT=0.2&trackNumLT=5.0&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 20M–50M ISK, ≥10 trades/day, ≥200M ISK/day traded, track-volatility band 0.2–5.0, track-number band 0.2–5.0.
- **High-velocity supplement** (added when the user allowed a lower margin floor for fast items): `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=500000%2C0&buyLT=50000000%2C0&tradesGT=100&tradesLT=&tradeIskGT=100.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=&trackVolLT=&trackNumGT=&trackNumLT=&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 500K–50M ISK, ≥100 trades/day, ≥100M ISK/day traded, and **no volatility bands** — the bands in the tier URLs drop the fast, thin-margin items this pull exists to find. Pages 1–4.

All already bake in the current hybrid fee profile (`buyFee=0.5` matching Perimeter HQ, `sellFee=1.5` and `salesTax=3.4` matching Jita 4-4). A4E doesn't model cross-station buy/sell splits natively, so this is the closest single-profile approximation of the real friction.
- Each page returns up to 50 rows (`rows=50`); the script fetches the extra pages. A page past the last one repeats an earlier page, which the loader de-duplicates.
- **If the fee profile or either location ever changes, update the `buyFee`/`sellFee`/`salesTax` params of all four URLs** here, in `scripts/a4e.py` (a test keeps the two identical), and in `scripts/market.py` — see [margin-verification.md](margin-verification.md) ("Fee numbers drift") — or they silently drift out of sync with the live ESI numbers.

## Step 2 — what never enters the scan

Drop these before any live call:
1. **Rows already in the portfolio** — open buy or sell orders, and stock held outside the order book (hold containers, hangar stock). Re-evaluating a held item is the portfolio review's job.
2. **Items the user has killed.** When the user says they killed items (typically after an impact analysis of a game event) and not to buy them back, they stay out of every scan, Increase and redeploy for the rest of the conversation unless the user says otherwise. Keep the list from the conversation; pass it as `--killed`.
3. **The killed items' families, as a conservative default.** The reasoning behind a kill usually applies to the whole family (the same name prefix: a faction, a meta line), so rows sharing a killed item's prefix are skipped (`--exclude-prefix`). The user only forbade the killed items themselves — name the excluded families in the report so they can overrule it.
4. **Weak repeat openings** — see step 8.

## Step 3 — scan: live margin and the gates

`scripts/scan_candidates.py` takes every remaining A4E row whose own margin is within reach of the floor, fetches the live Forge book and history for each (public ESI), computes the two-call margin at the competitive bid, applies the gates below, and prints the rows that pass ranked by M/1M/day (margin is only the floor test, not the rank key) plus every rejected row with its reason. Use A4E trades/day, not its ISK/day, which swings several-fold on T3.

**Floors.** The entry floor by tier, with the T3 carve-out, is in [margin-verification.md](margin-verification.md) ("Margin thresholds"). The **high-velocity relaxation** — the user's allowance of a lower floor for sufficiently fast items — applies to rows with A4E trades/day, 3-day volume and order counts above the bar defined there; a row that clears only through it is labelled "HV floor" in the output and must be labelled the same in the report. `--no-hv` turns it off.

**Hard gates — a row that trips any of these is rejected and listed with the reason:**

| Gate | Rejects when | Why it exists |
|---|---|---|
| Margin | live margin at the competitive bid, against the sell reference, is under the floor | the basic floor test; the sell reference is the top ask, or the median recent high when the ask has not traded |
| Fill, A4E | Sold2Buy under 20 units/day or under 15 trades/day | sellers are not reaching buy orders at a useful rate |
| Fill, live book | no young (under 24h) partly-filled bid within 2% of the top | nobody has sold into that price today |
| Swept bid | A4E 7dBuy under −5% | the best bid sits far below its own 7-day average: the top bids were just eaten and the screen margin is measured against a bid that will not last |
| Falling ask | A4E 7dSell under −12% | the sell side is dropping |
| Price spike | A4E 7dSell over +25%, or the average price jumped 15%+ in the last one or two days | an unproven price level that can revert |
| Thin | one unit increment already exceeds the top of the sizing band of daily trades | cannot be sized to the market |
| Stale | the top asks are over 14 days old | abandoned listings, not a real price |
| Repeat cancels | 2+ earlier buys cancelled under half filled (needs `--ledger`/`--character-id`) | step 8 |

The thresholds are working values from the 9–10 October 2026 sessions, set from the user's corrections ([failure-cases.md](failure-cases.md#fills-inferred-from-esi-daily-lows-instead-of-a4e-sold2buy-2026-10-09)) and one day's worth of rejected rows — they have not been back-tested. Change them in `scripts/scan_candidates.py` and here together.

**Soft flags** stay on the row for the caller to weigh: cushion under 2 points over the floor, thin top of the ask, ask 20–25% over its 7-day level, bids rising over 15% above their 7-day level, an 8-day average-price range over 25%, an 8–15% price step, the high-velocity relaxation, and "S2B-capped" (units limited by the next step).

## Steps 4–8

4. **Verify and depth-check the rows you intend to recommend** (the top 10-16 by yield — more when the user wants a full deployment; don't chase high-margin/low-liquidity junk). The scan already did the two-call margin; add what it cannot judge, with `scripts/depth.py`:
   - Confirm the sell price isn't a phantom order from an outlying station (the Jita 4-4 sell-side call already filters for this).
   - Confirm the buy price is achievable at Perimeter HQ — check `buyOrderCount` from the Perimeter-side call and, if a candidate looks thin (single-digit orders) or the margin is a wild outlier, inspect order depth/duration before trusting it.
   - **Run the reframed Perimeter/jump-range check proactively here, before recommending** (see [margin-verification.md](margin-verification.md) — "The jump-range competition check") — confirm nothing at Jita 4-4 station-range or another nearby structure beats the bid that would need to be placed at Perimeter HQ. If this pattern shows up, either reject the candidate or size it as a small test only, and say so plainly rather than presenting the flawed margin as reliable.
   - **Depth checklist — run on every row you intend to recommend.** The two-call margin only sees the best price on each side, and these are the ways that price misleads. `depth.py` prints the ask ladder with ages, the top bids, the fresh fills and the 8-day history; read:
     - **Fresh undercut vs durable ask.** If the best ask is a recent order undercutting a settled price (e.g. a fresh 20-unit order), compute the margin at the durable ask as well and say which one the recommendation rests on. Same signature as the "thin single-unit outlier" case in margin-verification.md, but with a bigger order.
     - **Stale asks.** Sell orders weeks old at the top (or an old stack holding the price up) can be abandoned listings that don't reflect where the item actually trades; treat the margin as unreliable and prefer to exclude.
     - **Thin top of the ask.** A few units at the top then a gap to a much higher price means the realistic sale price drops as soon as those clear — size smaller or exclude.
     - **A price that just stepped.** An average price that jumped in the last day or two (bids and asks both) may be a new level or a spike; the scan rejects 15%+ and flags 8–15%. Read the history before accepting a flagged row, and prefer rows whose bids followed the ask up (7dBuy at or above zero).
     - **Bids queued ahead.** If hundreds of units of bids sit at the top, the order would have to bid above them to be filled at all; recompute the margin at that bid.
     - **Bid far below ask.** A bid placed well below the ask (tens of percent) never meets a seller *if no seller reaches that price* — check the fill evidence (Sold2Buy, fresh fills, `depth.py --diff`) before concluding that, rather than inferring it from the gap.
     - **Margin cushion.** Note the cushion over the tier's entry floor. Under about 3 points on a volatile item (filaments, mutaplasmids) is a caution on the row, or an exclusion if the book is thin as well.
     - **Cancelled-at-zero-fills history.** Even a single recent cancel at zero fills is worth a one-line caution; step 8 below covers the 2+ repeat-offender case.
     - **Disputed fills.** If the A4E columns and the live book disagree, or the user questions a fill claim, run `depth.py --diff 340 <type ids>` (two buy-side snapshots about five minutes apart) and quote the units sold into each bid.
     Anything excluded here — or rejected by the scan — goes in an "excluded after checks" list with its reason, so the user sees what was rejected and why.
5. **Size.** Units are the sizing band of A4E trades/day in multiples of the unit increment (SKILL.md, sizing rule), **capped at one day of A4E Sold2Buy volume** — an order larger than a day of sellers sits for days, and the scan's `units` column already applies the cap. Hand the chosen unit counts to `scripts/size_positions.py` with the verified bid, margin at the ask and `profit_per_unit`; it ranks by M/1M/day, walks the buffer and flags SMALL-SLOT rows.
6. Present candidates with: item name, live-verified margin % (from the combined two-call calculation), daily trade count, the sized units as a share of daily trades, a one-line rationale, and a **suggested starting size** (units + ISK) per the sizing rule in SKILL.md. Label every row that relies on the high-velocity relaxation. Rows below the profit-per-slot floor are flagged, and the proposal reports the order count and tier mix before and after (SKILL.md, "Slot discipline"). Include the excluded-after-checks list and the families skipped under step 2. When the request is a full redeploy, follow [capital-allocation.md](capital-allocation.md).
7. Do NOT flag or comment on the character's existing open orders for the same item in this workflow — that's the portfolio review's job.
8. **Repeat-cancellation check — targeted, not blanket.** Runs only when reopening a candidate the user has held and killed before (recognizable from conversation context or memory, e.g. it was in a recent kill list), not on every scan. The scan applies it to every row when given the ledger; by hand:
   - Don't re-add it on today's margin alone. Call `get_order_history(type_id=X, side="buy", state="cancelled")` — it returns only that item's cancelled buys, so no client-side filtering.
   - If it shows 2+ prior buy orders cancelled while less than half filled (`volumeRemain` close to `volumeTotal`), treat it as weak: say so plainly, and recommend reopening only if today's margin is meaningfully above threshold, not barely over — otherwise expect the same open-barely-fill-cancel cycle.
