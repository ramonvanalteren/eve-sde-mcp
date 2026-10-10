# Workflows 2–5: Portfolio review (buy review → sell review → inventory risk → pipeline performance)

A plain "portfolio review" request runs Workflows 2–5 together in this order by default. Equal rigor throughout — Workflow 3 in particular has been a repeated source of real errors when treated as an afterthought. Verify every margin figure with the [two-call procedure in margin-verification.md](margin-verification.md).

The live-margin tables are scripted — `scripts/review_portfolio.py buys|sells|extend` (inputs: the saved `get_character_orders`, `get_wallet_transactions` and `get_character_assets` results; formats in `scripts/portfolio.py`). Its `hint` column (KILL? / EDGE / ok) is a prompt for the spot-checks below, never the verdict.

## Contents
- [Report skeleton and pre-send checklist](#report-skeleton-and-pre-send-checklist)
- [Workflow 2 — Buy portfolio review (kill / increase / hold)](#workflow-2--buy-portfolio-review-kill--increase--hold)
- [Workflow 3 — Sell portfolio review (real cost basis, not generic margin)](#workflow-3--sell-portfolio-review-real-cost-basis-not-generic-margin)
- [Workflow 4 — Inventory risk — mandatory on every portfolio review](#workflow-4--inventory-risk--mandatory-on-every-portfolio-review)
- [Workflow 5 — Pipeline performance (default synthesis step)](#workflow-5--pipeline-performance-default-synthesis-step)
- [Repricing rule of thumb](#repricing-rule-of-thumb-for-the-users-own-reference--not-a-claude-monitoring-task)
- [Broker fee churn vs. legitimate growth](#broker-fee-churn-vs-legitimate-growth--dont-conflate-them)

## Report skeleton and pre-send checklist

The review has drifted from the agreed format more than once. Start from this skeleton, fill every section in order, and run the checklist before sending. A section with nothing to report still appears, with one line saying so — Workflow 4 in particular is mandatory.

```
Portfolio review — <date, UTC time>
Snapshot: wallet <…> | buys <n> / sells <n> | buy escrow <…> (avg <…> per order) | tier mix T1 <%> / T2 <%> / T3 <%>
          | escrow in orders with no fills <…> | since last review: <…>

Workflow 2 — Buy portfolio
  Kill                    Item | Order price | Left/total | Live margin | Why | ISK freed
  Increase                Item | Left/total | Live margin | Suggested add (units × price) | Velocity basis
  Hold, converting        Item | Price | Left/total | Live margin | Fills in window        (sorted by fills)
  Hold, no or few fills   Item | Price | Left/total | Live margin | Escrow | Note           (sorted by escrow)
  Hold, too early         Item | Price | Units | Margin | Escrow
  Consolidation candidates: one line, labelled user-directed (above the floor, not a breach)

Workflow 3 — Sell portfolio      Item | Held units | Bounded avg cost | Achievable net sell | Real margin | Verdict
Workflow 4 — Inventory risk      Item | Uncovered units | Rough ISK value | Recommendation
Workflow 5 — Pipeline            the 2-3 clearest outliers with the capital-efficiency read, or one line saying none stand out
```

```
Pre-send checklist:
- [ ] Every margin is the two-call figure at the competitive bid — never the tool's own `margin` field
- [ ] Every Kill rests on the live margin at the competitive bid and the character's own recent sells — never on a margin rebuilt from ESI history
- [ ] `isBuyOrder` and `escrow` confirmed before any buy-side verdict; sell-only items went to Workflow 3
- [ ] Buy orders grouped by their own `locationId`
- [ ] Every zero-fill Kill checked for order age against fill history (not `issued`) and for jump-range competition
- [ ] Every Increase passed the runway check
- [ ] Every Kill and Increase shows units and ISK
- [ ] Hold tables sorted as specified; too-early orders kept out of the no-fills table
- [ ] Workflow 3 held units include unlisted hangar stock; cost basis is the bounded average
- [ ] Workflow 4 section present
- [ ] Snapshot line includes the order count, tier mix and the no-fill escrow share
```

## Workflow 2 — Buy portfolio review (kill / increase / hold)

1. Pull open orders via `get_character_orders`.
2. **Split the type_ids by `isBuyOrder` before anything else.** Items with a genuine open buy order go through this workflow; sell-only items go to Workflow 3.
   - `get_portfolio_margins` returns a margin for *any* type_id, buy order or not — running it on a sell-only item and reporting a buy-side verdict is a category error.
   - The check applies every time a margin is about to be discussed for a specific item, including one-off questions ("did the reprice fix X", "how's item Y doing").
   - Confirm `isBuyOrder: true` and an `escrow` field before citing `get_portfolio_margins` as a position check; if neither is present, go to Workflow 3. (Why: [failure-cases.md](failure-cases.md#sell-only-items-reported-as-buy-side-verdicts-twice).)
3. **Group the buy-order type_ids by each order's own `locationId`** (60003760 = legacy, still at Jita 4-4; 1044752365771 = migrated, at Perimeter HQ) — don't assume every buy sits in one place.
   - Per group, run the two-call verification ([margin-verification.md](margin-verification.md)): a buy-side `get_portfolio_margins` call with the group's own `location_id` and matching `broker_fee_pct` (0.5 Perimeter, 1.5 Jita 4-4), plus one sell-side call at `location_id=60003760, broker_fee_pct=1.5` covering every type_id.
   - Combine per item via `nm()`. The question is whether the trade is still profitable and liquid enough to deserve capital — not whether the order is top-of-book.
4. Decide per item:
   - **Kill** when any of:
     - margin has compressed below the **flat 10% hold floor** — one floor across tiers for *held* positions, not the tiered entry floor ([margin-verification.md](margin-verification.md), "Margin thresholds");
     - daily trade volume has dried up;
     - the sell side has moved sharply against the position (e.g. a >15-20% drop in achievable margin since it was opened);
     - zero fills over the lookback window, regardless of margin. A common cause is a bid far below the ask, so sellers never reach it — name that cause in the "why" instead of calling it "no demand".
   - **Kill on live evidence, not on history.** The figure is the live two-call margin at the competitive bid, set beside the character's own sells of that item over the last few days (realized price, `get_wallet_transactions`). Do not Kill on a margin rebuilt from ESI market history (a "traded-level" median of recent daily highs): it lags one to two days and understates a rising market, and that is how a review once called three healthy positions Kills ([failure-cases.md](failure-cases.md#kill-verdicts-built-on-lagging-history-margins-2026-10-08)). That guard belongs to Workflow 1.
     - If live and history disagree, report the exit-price scenarios and the break-even sell price for the hold floor, and call it uncertain — not a Kill.
     - If the live ask that causes the breach is a few units at the top of a thicker ladder, run the stray-order spot check ([margin-verification.md](margin-verification.md), "Thin single-unit outliers") and show the margin at the next durable tier as well.
     - If the position sits just under the floor (within about a point) only because the user raised their own bid, offer the reprice that restores the floor instead of a Kill. When the margin at the order's own price and at the competitive bid straddle the floor, it is a Hold with both figures shown.
   - **Before finalizing a zero-fill Kill, check order age and diagnose the cause:**
     - A brand-new order (minutes to a couple of hours old) shows zero fills whatever its margin — that is "too early to judge", not stalled.
     - For orders old enough that zero fills is a real signal, run the jump-range check ([margin-verification.md](margin-verification.md)) before concluding "no demand": a Jita 4-4 station-range order or a nearby structure may be outbidding it. If so, say so — it is still a Kill (only these two locations are traded), but "outcompeted" is the more useful reason. The same check runs proactively in Workflow 1; this is its reactive counterpart for positions that went quiet.
   - **Weekly seasonality can confound a short fill-velocity or zero-fill read.** Concurrency peaks every Sunday around 1900 UTC and weekends run well above weekdays (source and caveats: [failure-cases.md](failure-cases.md#weekly-seasonality-not-accounted-for-in-fill-velocity-reads)). The skill has no data quantifying the effect on Jita/Perimeter volume, so treat it as a real but unquantified confound, not a correction factor.
     - Don't read much into a fill gap or burst from a single weekday, and state which day(s) of the week a velocity estimate spans.
   - **`issued` on an open order is not evidence of true position age — "issued today" is not "brand-new capital".** Changing an order's price keeps its `order_id` and resets `issued`, so a repriced order looks new. Only an explicit cancel-and-replace (or a replacement after the order completes) creates a new `order_id`.
     - **`volumeTotal − volumeRemain` is the cheapest age check.** It counts the fills since the order was first placed and survives repricing, because the total is not reset. An order issued today with fills already is a converting position that was repriced, not new capital. One with no fills is ambiguous: new, or old and never filled.
     - To tell those two apart, compare `order_id` with orders you know were placed today (earlier in the session, or the plan being executed): IDs ascend with creation time, so an ID well below them means the order is older than its `issued`. This is an observed pattern, not documented ESI behaviour — treat it as a hint and say so.
     - Before calling a batch of same-day orders fresh deployment (individually or in aggregate), corroborate with `get_wallet_transactions(type_id=X, side="buy")`. Unlike `volumeTotal − volumeRemain`, it dates the fills.
     - Fills dated well before the current `issued` mean an ongoing, previously converting position that was repriced today. Its zero-fill count on the *current* order carries no signal — don't relabel it "too early to judge" either; judge it on its real history. (Why: [failure-cases.md](failure-cases.md#issued-timestamp-mistaken-for-position-age-coreli-a-type-thermal-coating).)
   - **Increase investment** when margin is healthy, volume is strong, there is room to add without oversaturating (check volume/trades ratio if available), **and the position is actually converting** — fill history, not just margin; don't strengthen something that isn't moving. Depth (`buyOrderCount`/`sellOrderCount`) is a reasonable proxy for expecting fills; thin books stall.
     - **Runway check — a proven converter is not automatically an Increase.** A strong historical fill rate says the item is worth holding, not that *this order* needs more capital.
       - Runway = current `volumeRemain` ÷ recent fill velocity (units/day from `get_wallet_transactions`, last 3-7 days). If runway is already more than a few days, a second order just parks escrow behind capital that hasn't converted.
       - Recommend Increase only when the existing order's remaining volume is thin relative to its pace (likely to run dry and force a relist soon). (Why: [failure-cases.md](failure-cases.md#increase-recommended-without-checking-existing-order-capacity-graviton-physics-mechanical-engineering).)
     - **Fill evidence applies here too.** `review_portfolio.py extend` ranks held types by days of cover and shows A4E Sold2Buy next to the live margin; an Increase on something whose Sold2Buy is thin is parked escrow ([margin-verification.md](margin-verification.md#fill-evidence)).
     - **Execution:** there is no "add units to an existing order". Either (a) place a second order for just the increment — broker fee only on the new capital — or (b) cancel and reissue larger — fee on the *entire* new value. Default to (a); use (b) only when the existing price is stale and needs correcting anyway. A second order goes to Perimeter HQ (0.5% fee) even if the original still sits at Jita 4-4.
   - **Hold**: no material change, leave as-is.
5. Do NOT evaluate or report on whether individual orders are currently outbid/at top-of-book — this is about capital allocation and profitability, not queue position. If the user wants queue-position checks, that's a separate live/client-side task outside this skill.
6. **Present as separate verdict sections, in this order — not one flat table** (the report skeleton at the top of this file shows the layout).
   - **Snapshot line first:** wallet; buy/sell order counts; total buy escrow and average escrow per order; the T1/T2/T3 share of buy escrow (tiers by unit price — [strategy.md](strategy.md)); the share of escrow in orders with no fills (age corroborated against fill history, per the `issued` note above); what changed since the last review.
   - State once that all buys sit at Perimeter HQ; call out an order's location only when it is a legacy Jita 4-4 buy.
   - "Live margin" everywhere below is the two-call figure at the competitive bid — the highest of the Perimeter bid, the Jita-station bid and any range-1 structure bid ([margin-verification.md](margin-verification.md), "The competitive bid"). Quote the margin at the order's own price as well only when the two straddle the 10% floor.
   1. **Kill** — item | order price | left/total | live margin | why | ISK freed (units remaining × price). Only positions that meet the Kill criteria in step 4. Name the cause plainly: floor breach, a regime change confirmed by region-order depth, or zero fills with the step-4 diagnosis.
   2. **Increase** — item | left/total | live margin | suggested add (units × price = ISK, as a second Perimeter order) and the fill-velocity basis (units/day). Only items that pass the runway check above; if none qualifies, say so in one line instead of padding the table.
   3. **Hold, converting** — positions with fills in the lookback window: item | price | left/total | live margin | fills in the window. Sort by fills, most first. Flag a slow converter in the table itself (e.g. 4 fills in 6 days against 22 A4E trades/day).
   4. **Hold, no or few fills** — 0-1 fills in the lookback window, or remaining volume that would take more than about a week at the observed fill pace: item | price | left/total | live margin | escrow | note. Sort by escrow, largest first. The note says why the slot is weak: how many days of the whole market's volume the order represents (units ÷ A4E trades/day), thin A4E trades/day, or the jump-range result from step 4.
   5. **Hold, too early to judge** — a short table (item | price | units | margin | escrow) for orders placed or repriced in roughly the last 24h with no fills yet. Keep them out of table 4: a brand-new order with zero fills is not a signal. `issued` resets on every reprice, so check `volumeTotal − volumeRemain` and fill history, and compare against earlier snapshots (the same `order_id` means the same order), before placing an order in table 4 or here.

   After the tables, if table 4 holds weak slots that still clear the 10% floor, add one **Consolidation candidates** line naming the worst profit-per-slot orders and the escrow they would free.
   - Label it user-directed consolidation (above the floor, not a breach), in line with the user's preference for larger positions on items that cycle; never fold it into the Kill table.
   - Also name any orders under the profit-per-slot floor (SKILL.md, "Slot discipline"). Order count alone is not a reason to cut — the user has said the comfortable order range is fine (strategy.md).
   - To turn the cut list into a full rebalance, see kill-and-redeploy mode in [capital-allocation.md](capital-allocation.md). Size every Kill and Increase per the sizing rule in SKILL.md.

## Workflow 3 — Sell portfolio review (real cost basis, not generic margin)

This workflow gets the same rigor as Workflow 2 — treating it as an afterthought has caused repeated real mistakes. Sell orders are unaffected by the Perimeter move (they stay at Jita 4-4, same fees). The buy location only changes the broker fee paid to acquire a lot, and that is a separate wallet-journal entry, not part of the per-unit price `get_wallet_transactions` returns — so the cost-basis method below is unaffected by where a lot was bought.

1. Take the sell-only type_ids identified in Workflow 2, step 2 (no `isBuyOrder`/`escrow` field on any of that item's open orders).
2. **Determine held units first, from both sources — not just the sell order.** (`review_portfolio.py sells --assets …` does this and separates stock at Jita 4-4 from stock elsewhere; stock sitting at another station or in a container cannot be listed at Jita 4-4 until it is moved — name where it is.) Sum the `volumeRemain` across all open sell orders for the item, *plus* any uncovered units Workflow 4 found sitting in the hangar with no sell order at all. Confirmed failure case: Federation Navy 200mm Steel Plates was reported with held=1 (the sell order only) when Workflow 4 had already found 2 more unlisted units — the per-unit margin was still right, but the total exposure/profit figure was understated by 3x. See [failure-cases.md](failure-cases.md).
3. **Do not use `get_portfolio_margins` as the verdict for these.** Pull `get_wallet_transactions(side="buy", type_id=X)` and compute cost basis as the **bounded weighted average**, not a full-history blend:
   - sort buy transactions newest-first and sum quantities from the top until they cover the held-units figure from step 2; use only those lots and discard older ones entirely;
   - this matters whenever held units < total units ever bought — a full-history blend dilutes the average with lots that have very likely already sold, mispricing the result in whichever direction the price trend moved;
   - the method assumes oldest-sold-first (FIFO), which matches standard inventory accounting for fungible goods and the observed pattern. (Why: Badger flipped from −9.4% to +33.9% — [failure-cases.md](failure-cases.md#full-history-cost-blend-on-partially-sold-positions-badger).)
4. **Watch specifically for a recent price jump in acquisition cost even within the bounded method** — if the lots covering current holdings span a genuine price jump (not just one uniform recent lot), break out the most-recent-lot's own margin separately in addition to the bounded blend, since a mixed bounded average can still mask one sub-lot being underwater while another isn't.
5. Decide per item:
   - **Profitable, list/hold**: achievable net sell (at Jita 4-4, 1.5% broker + 3.4% tax) clears real cost basis by a healthy margin — recommend listing (if unlisted, see Workflow 4) or holding the current listing.
   - **Marginal**: real margin is thin (under ~15-20%) — flag it, but selling existing inventory at a thin profit is still usually better than holding dead stock; don't apply the same "don't bother" logic used for repricing decisions on live buy orders.
   - **Underwater**: achievable net sell is below cost basis — say so plainly. This is a real-loss situation, not a kill/hold framing; the decision is whether to accept the loss now or hold and hope for recovery, and that call belongs to the user, not this skill.
6. Report as its own table (item, held units, bounded avg cost, achievable net sell, real margin, verdict) — separate from the Workflow 2 buy-order table, since it's a fundamentally different kind of decision.

## Workflow 4 — Inventory risk — mandatory on every portfolio review

Fills convert escrow into hangar stock, and that stock is real financial exposure sitting outside the buy/sell order book where margin checks won't catch it — it's already been paid for but isn't cash until a sell order exists and actually clears.

1. Pull `get_character_assets` and cross-reference against open sell orders: any item sitting in the hangar with no matching sell order (or a sell order covering fewer units than are actually held) is uncovered exposure.
2. Report this explicitly as its own section in every review, not folded into either margin table — name the item, the uncovered unit count, and (where a live sell price is available, from the Jita 4-4 sell-side call) the rough ISK value sitting exposed, and recommend listing it.
3. Treat this with the same "always check" weight as the Workflow 2/3 margin pulls — not a nice-to-have, not periodic.

## Workflow 5 — Pipeline performance (default synthesis step)

**This is where the actual money is made or left on the table.** A healthy margin on a slow-cycling position can earn less than a thinner margin that turns over fast — nothing else in this skill surfaces that trade-off, so this workflow exists to make it visible every time, by default, as the closing step of any portfolio review.

**This is a synthesis step, not new data-gathering.** It reads timestamps already collected in Workflows 2-4, with one adjustment: widen the fill-activity lookback from the old 5-7 days to **~14 days**, because full pipeline cycles (buy → fill → list → sell) routinely run longer than a week (why: [failure-cases.md](failure-cases.md#pipeline-cycles-run-longer-than-a-week-shadow-serpentis)). The wider window also serves the Workflow 2 zero-fill kill signal — zero fills in 14 days is even clearer than in 5-7 — and is not a separate call.

1. For every current position (buy-side from Workflow 2, sell-side from Workflow 3), compute from data already in hand:
   - **Order age**: **not** simply the current order's `issued` timestamp — a price change resets it, and so does a cancel-and-replace (see the Workflow 2 Kill note above). Use the earliest relevant `get_wallet_transactions` entry for that type_id as the real starting point when one exists; fall back to `issued` only for a position with no fill history yet (genuinely new).
   - **Time to first fill** (buy-side): first `get_wallet_transactions` buy entry for that type_id minus order `issued`. Report "unfilled after Xd" if still pending.
   - **Time spent as unlisted inventory**: sell order `issued` minus the last relevant buy-fill timestamp, for items that moved from Workflow 2 into Workflow 4's inventory-risk list before eventually getting listed. Report "still unlisted after Xd" if flagged in Workflow 4 and still uncovered.
   - **Time to sell** (sell-side): `get_wallet_transactions` sell entry timestamp minus sell order `issued`. Report "unsold after Xd" if still pending.
2. **This is a distinct axis from margin, not a replacement for it — report both.** Margin tells you whether a trade *would* be profitable; it says nothing about whether it's actually happening. Observed in practice: the highest-margin positions in the portfolio (several above 30-80%) were disproportionately the ones with zero fills, while several much lower-margin positions (15-25%) were cycling constantly.
3. **Buy-side zero-fill diagnosis (order age, jump-range competition) already happened in Workflow 2, before the Kill/Hold verdict was decided — don't redo it here.** By the time this workflow runs, any buy-side item worth flagging as a slow-mover has already been through that check. This step is about surfacing the *pattern across the whole portfolio*, not re-diagnosing individual items.
4. **Don't present a full table for every item every time** — that's noise, not insight. Rank by slowest stage *relative to that item's typical liquidity* (a thin item sitting unsold for 3 days isn't news; a deep 80-order-book item sitting unsold for 3 days is a real signal) and surface only the 2-3 clearest outliers.
5. For each outlier, state the actionable read directly: is the margin good enough to justify the wait, or would that capital earn more cycling through something faster even at a lower headline margin? This is a judgment call to present, not a hard rule — but always frame it in terms of capital efficiency (ISK/day), not margin alone.
6. If nothing stands out as a clear outlier this review, say so briefly rather than manufacturing a table — this step should feel like a genuine insight when it fires, not routine filler.

## Repricing rule of thumb (for the user's own reference — not a Claude monitoring task)

Repricing/undercut-checking stays out of scope for this skill (per Scope in SKILL.md) — Claude doesn't track queue position. But margin data already surfaced during a review is useful for the user's own call on whether a reprice is worth it, so here's the rule of thumb to mention if relevant. **This now splits by leg, since the buy and sell sides run different fee rates:**

- **Buy-side reprices (Perimeter HQ, 0.5% fee)**: cost ≈ 0.5/margin as a fraction of the edge. On a 15% margin item, one reprice now costs only ≈3.3% of the edge — much cheaper than before the move. Reprice buy-side positions freely down to roughly ~8-10% margin; below that, the reprice cost starts eating a real chunk of a thin edge. This lines up with the flat 10% hold floor above — a position near the floor is also close to where reprice economics stop being cheap, which is worth mentioning together if both come up.
- **Sell-side reprices (Jita 4-4, 1.5% fee, unchanged)**: the original logic still applies as-is — don't reprice a position sitting below ~20-25% margin; above ~40-50%, reprice freely; 25-40% is a judgment call (liquidity, distance off top-of-book, recent reprice frequency).

This asymmetry is new since the 2026-09-12 Perimeter move — the two legs of the same trade now have meaningfully different reprice economics, worth remembering when comparing "should I reprice this" across a mixed buy/sell portfolio.

This pairs with the repeat-cancellation and broker-fee-churn notes: cheap, thin, low-margin items (e.g. 'Wetu' Mobile Depot, High Energy Physics historically) are exactly where repeated repricing does the most proportional damage — though the buy-side threshold for "proportional damage" is now lower given the cheaper Perimeter fee.

## Broker fee churn vs. legitimate growth — don't conflate them

The repeat-cancellation problem (Workflow 1, step 7) is the *same order* cancelled and recreated at the *same size* repeatedly with no net increase — pure fee waste from chasing competition. Deliberately placing a second order to grow a healthy position is different and not to be discouraged (see the Increase execution note in Workflow 2).
- Don't recommend "adding to an existing order" (not possible in EVE) as if it avoids fees. The real choice is a second order (fee only on the increment) vs cancel-and-reissue larger (fee on the whole new value).
- For how the buy/sell fee split changes *reprice* cost, see the [repricing rule of thumb](#repricing-rule-of-thumb-for-the-users-own-reference--not-a-claude-monitoring-task) above.
