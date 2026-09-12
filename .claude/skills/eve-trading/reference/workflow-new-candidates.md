# Workflow 1: New position selection (from the three saved A4E tier URLs)

Runs when new candidates are explicitly requested. Fetches its own A4E data — it does not need a pasted snapshot to run. Verify every candidate margin with the [two-call procedure in margin-verification.md](margin-verification.md) before recommending anything.

## Contents
- [Step 1 — fetch all three A4E snapshots](#step-1--fetch-all-three-a4e-margin-finder-snapshots-directly)
- [Steps 2–7 — filter, rank, verify, size](#step-2--7)

## Step 1 — fetch all three A4E margin-finder snapshots directly

Don't wait for the user to paste one, and don't substitute a generic/default-filter A4E page instead. Fetch each with WebFetch, prompting it to return *every row* in the results table in order (item, buy price, sell price, margin %, avg daily trades) — a truncated top-5 summary defeats the point of using saved filters instead of the tool's noisy unfiltered default page.

- **T1 (low price, high turnover)**: `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=500000%2C0&buyLT=5.000.000%2C0&tradesGT=30&tradesLT=&tradeIskGT=50.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=0.5&trackVolLT=2.5&trackNumGT=0.5&trackNumLT=2.5&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 500K–5M ISK, ≥30 trades/day, ≥50M ISK/day traded, track-volatility band 0.5–2.5, track-number band 0.5–2.5.
- **T2**: `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=5.000.000%2C0&buyLT=20000000%2C0&tradesGT=20&tradesLT=&tradeIskGT=100.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=0.3&trackVolLT=4.0&trackNumGT=0.3&trackNumLT=4.0&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 5M–20M ISK, ≥20 trades/day, ≥100M ISK/day traded, track-volatility band 0.3–4.0, track-number band 0.3–4.0.
- **T3**: `https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station=&buyGT=20.000.000%2C0&buyLT=50000000%2C0&tradesGT=10&tradesLT=&tradeIskGT=200.000.000&tradeIskLT=&supplyGT=&supplyLT=&trackVolGT=0.2&trackVolLT=5.0&trackNumGT=0.2&trackNumLT=5.0&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage=1`
  Filters: buy price 20M–50M ISK, ≥10 trades/day, ≥200M ISK/day traded, track-volatility band 0.2–5.0, track-number band 0.2–5.0.

All three already bake in the current hybrid fee profile (buyFee=0.5 matching Perimeter HQ, sellFee=1.5 and salesTax=3.4 matching Jita 4-4) — A4E doesn't model cross-station buy/sell splits natively, so this is the closest single-profile approximation of the real friction. Each returns up to 50 rows (`rows=50&cpage=1`); use `cpage=2` on a given tier if more depth is needed. **If the fee profile or either location ever changes again, these three URLs' `buyFee`/`sellFee`/`salesTax` params need updating to match — see [margin-verification.md](margin-verification.md) ("Fee numbers drift") — or they will silently drift out of sync with the live ESI numbers.**

## Step 2–7

2. Filter out rows already in the current portfolio (no point re-evaluating a held item as a "new" candidate — that's the portfolio review workflows).
3. For remaining rows, compute `nm()` using the A4E buy/sell prices as a first pass, and rank by margin.
4. For the top candidates (say top 5-10 by margin, adjusted for trade count and traded ISK/day — don't chase high-margin/low-liquidity junk), verify live via the two-call procedure in [margin-verification.md](margin-verification.md):
   - Confirm the sell price isn't a phantom order from an outlying station (the Jita 4-4 sell-side call already filters for this).
   - Confirm the buy price is achievable at Perimeter HQ — check `buyOrderCount` from the Perimeter-side call and, if a candidate looks thin (single-digit orders) or the margin is a wild outlier, follow up with a per-item `get_region_orders` to inspect order depth/duration before trusting it.
   - **Run the reframed Perimeter/jump-range check proactively here, before recommending** (see [margin-verification.md](margin-verification.md) — "The jump-range competition check") — confirm nothing at Jita 4-4 station-range or another nearby structure beats the bid that would need to be placed at Perimeter HQ. If this pattern shows up, either reject the candidate or size it as a small test only, and say so plainly rather than presenting the flawed margin as reliable.
5. Present candidates with: item name, live-verified margin % (from the combined two-call calculation), daily trade count, ISK/day, a one-line rationale, and a **suggested starting size** (units + ISK) per the sizing rule in SKILL.md.
6. Do NOT flag or comment on the character's existing open orders for the same item in this workflow — that's the portfolio review's job.
7. **Repeat-cancellation check — targeted, not blanket.** If a candidate is one the user has held and killed before (recognizable from conversation context/memory — e.g. it was in a kill list earlier in this session or a recent one), don't just re-add it on today's margin alone. Call `get_order_history(type_id=X, side="buy", state="cancelled")` for that item before recommending it again — this returns only that item's cancelled buy orders directly, no need to pull the full history and filter client-side. If it shows 2+ prior buy orders cancelled while less than half filled (`volumeRemain` close to `volumeTotal`), treat it as a weak candidate: say so plainly, and only recommend reopening if today's margin is meaningfully above threshold (not just barely over) — otherwise it's likely to repeat the same open-barely-fill-cancel cycle. This check only runs when reopening a known repeat offender, not as a standing step on every new-candidate scan.
