# Workflow 1: New position selection (from the three saved A4E tier URLs)

Runs when new candidates are explicitly requested. Fetches its own A4E data — it does not need a pasted snapshot to run. Verify every candidate margin with the [two-call procedure in margin-verification.md](margin-verification.md) before recommending anything.

## Contents
- [Step 1 — fetch all three A4E snapshots](#step-1--fetch-all-three-a4e-margin-finder-snapshots-directly)
- [Steps 2–7 — filter, rank, verify, size](#step-27)

## Step 1 — fetch all three A4E margin-finder snapshots directly

Don't wait for the user to paste one, and don't substitute a generic/default-filter A4E page instead. Fetch each with WebFetch, prompting it to return *every row* in the results table in order (item, buy price, sell price, margin %, avg daily trades) — a truncated top-5 summary defeats the point of using saved filters instead of the tool's noisy unfiltered default page.

- **T1 (low price, high turnover)**: `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=500000%2C0&buyLT=5.000.000%2C0&tradesGT=30&tradesLT=&tradeIskGT=50.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=0.5&trackVolLT=2.5&trackNumGT=0.5&trackNumLT=2.5&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 500K–5M ISK, ≥30 trades/day, ≥50M ISK/day traded, track-volatility band 0.5–2.5, track-number band 0.5–2.5.
- **T2**: `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=5.000.000%2C0&buyLT=20000000%2C0&tradesGT=20&tradesLT=&tradeIskGT=100.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=0.3&trackVolLT=4.0&trackNumGT=0.3&trackNumLT=4.0&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 5M–20M ISK, ≥20 trades/day, ≥100M ISK/day traded, track-volatility band 0.3–4.0, track-number band 0.3–4.0.
- **T3**: `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=20.000.000%2C0&buyLT=50000000%2C0&tradesGT=10&tradesLT=&tradeIskGT=200.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=0.2&trackVolLT=5.0&trackNumGT=0.2&trackNumLT=5.0&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 20M–50M ISK, ≥10 trades/day, ≥200M ISK/day traded, track-volatility band 0.2–5.0, track-number band 0.2–5.0.

All three already bake in the current hybrid fee profile (`buyFee=0.5` matching Perimeter HQ, `sellFee=1.5` and `salesTax=3.4` matching Jita 4-4). A4E doesn't model cross-station buy/sell splits natively, so this is the closest single-profile approximation of the real friction.
- Each returns up to 50 rows (`rows=50&cpage=1`); use `cpage=2` on a given tier if more depth is needed.
- **If the fee profile or either location ever changes, update the `buyFee`/`sellFee`/`salesTax` params of all three URLs** — see [margin-verification.md](margin-verification.md) ("Fee numbers drift") — or they silently drift out of sync with the live ESI numbers.

## Step 2–7

2. Filter out rows already in the current portfolio (no point re-evaluating a held item as a "new" candidate — that's the portfolio review workflows).
3. For remaining rows, compute `nm()` using the A4E buy/sell prices as a first pass. Drop anything under its tier's entry floor, then **rank what's left by M/1M/day** (`nm`-derived profit per unit ÷ unit price × A4E trades/day) — margin is only the floor test here, not the rank key. Drop thin items up front: if even the minimum increment would exceed the band ceiling of the item's daily trades, it can't be sized to the band (see SKILL.md, sizing step 2). Use A4E's trades/day, not its ISK/day, which swings several-fold on T3.
4. For the top candidates (the top 10-16 by yield — more when the user wants a full deployment; don't chase high-margin/low-liquidity junk), verify live via the two-call procedure in [margin-verification.md](margin-verification.md):
   - Confirm the sell price isn't a phantom order from an outlying station (the Jita 4-4 sell-side call already filters for this).
   - Confirm the buy price is achievable at Perimeter HQ — check `buyOrderCount` from the Perimeter-side call and, if a candidate looks thin (single-digit orders) or the margin is a wild outlier, follow up with a per-item `get_region_orders` to inspect order depth/duration before trusting it.
   - **Run the reframed Perimeter/jump-range check proactively here, before recommending** (see [margin-verification.md](margin-verification.md) — "The jump-range competition check") — confirm nothing at Jita 4-4 station-range or another nearby structure beats the bid that would need to be placed at Perimeter HQ. If this pattern shows up, either reject the candidate or size it as a small test only, and say so plainly rather than presenting the flawed margin as reliable.
   - **Depth checklist — run on every row you intend to recommend.** The two-call margin only sees the best price on each side, and these are the ways that price misleads. Pull `get_region_orders(region_id=10000002, type_id=X, order_type="all")` and check:
     - **Fresh undercut vs durable ask.** If the best ask is a recent order undercutting a settled price (e.g. a fresh 20-unit order), compute the margin at the durable ask as well and say which one the recommendation rests on. Same signature as the "thin single-unit outlier" case in margin-verification.md, but with a bigger order.
     - **Stale asks.** Sell orders weeks old at the top (or an old stack holding the price up) can be abandoned listings that don't reflect where the item actually trades; treat the margin as unreliable and prefer to exclude.
     - **Thin top of the ask.** A few units at the top then a gap to a much higher price means the realistic sale price drops as soon as those clear — size smaller or exclude.
     - **Bids queued ahead.** If hundreds of units of bids sit at the top, the order would have to bid above them to be filled at all; recompute the margin at that bid.
     - **Bid far below ask.** A bid placed well below the ask (tens of percent) never meets a seller; the position will sit at zero fills however good the nominal margin looks.
     - **Margin cushion.** Note the cushion over the tier's entry floor. Under about 3 points on a volatile item (filaments, mutaplasmids) is a caution on the row, or an exclusion if the book is thin as well.
     - **Cancelled-at-zero-fills history.** Even a single recent cancel at zero fills is worth a one-line caution; step 7 below covers the 2+ repeat-offender case.
     Anything excluded here goes in an "excluded after checks" list with its reason, so the user sees what was rejected and why.
5. Present candidates with: item name, live-verified margin % (from the combined two-call calculation), daily trade count, the sized units as a share of daily trades, a one-line rationale, and a **suggested starting size** (units + ISK) per the sizing rule in SKILL.md. Rows below the profit-per-slot floor are flagged, and the proposal reports the order count and tier mix before and after (SKILL.md, "Slot discipline"). When the request is a full redeploy, follow [capital-allocation.md](capital-allocation.md).
6. Do NOT flag or comment on the character's existing open orders for the same item in this workflow — that's the portfolio review's job.
7. **Repeat-cancellation check — targeted, not blanket.** Runs only when reopening a candidate the user has held and killed before (recognizable from conversation context or memory, e.g. it was in a recent kill list), not on every scan.
   - Don't re-add it on today's margin alone. Call `get_order_history(type_id=X, side="buy", state="cancelled")` — it returns only that item's cancelled buys, so no client-side filtering.
   - If it shows 2+ prior buy orders cancelled while less than half filled (`volumeRemain` close to `volumeTotal`), treat it as weak: say so plainly, and recommend reopening only if today's margin is meaningfully above threshold, not barely over — otherwise expect the same open-barely-fill-cancel cycle.
