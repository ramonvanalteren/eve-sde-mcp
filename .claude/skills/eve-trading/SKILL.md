---
name: eve-trading
description: Use this skill for Helga Syrobne's Jita 4-4 station trading, covering five workflows — new position selection from A4E snapshots, buy portfolio review, sell portfolio review, inventory risk, and pipeline performance (how fast capital is actually cycling). Trigger whenever the user pastes an A4E snapshot, asks for a "portfolio review," "new candidates," or asks whether to kill or add to a position — a "portfolio review" runs buy review, sell review, inventory risk, and pipeline performance together by default. Always verify margins via live ESI (get_portfolio_margins, batch) filtered to Jita 4-4 (location_id=60003760) before giving a verdict — never trust A4E or region-wide prices alone. This skill isn't the right fit for checking whether existing orders are outbid/undercut and need repricing — that's a live/in-client task since it depends on real-time queue position, which is outside what this skill tracks.
---

# EVE Trading Skill — Helga Syrobne (Jita 4-4 Station Trading)

## Scope

This skill covers five workflows. A plain "portfolio review" request runs Workflows 2-5 together by default; Workflow 1 runs when A4E snapshots are provided or new candidates are explicitly requested.

1. **New position selection** (Workflow 1) — scan A4E tier snapshots for items worth opening a new buy/sell slot on.
2. **Buy portfolio review** (Workflow 2) — review existing open buy orders and decide: kill, increase investment, or leave as-is.
3. **Sell portfolio review** (Workflow 3) — review sell-only positions (inventory with no open buy order) against real acquisition cost, not generic market margin. Equal rigor to Workflow 2 — this has been a repeated source of errors when treated as an afterthought.
4. **Inventory risk** (Workflow 4) — hangar stock with no matching sell order at all; mandatory every review.
5. **Pipeline performance** (Workflow 5) — how fast capital is actually cycling through buy→fill→list→sell, synthesized from data already gathered in Workflows 2-4. This is the default closing step of every portfolio review: healthy margin on a slow-cycling position can still be worse than a thinner margin that turns over fast, and nothing else in this skill surfaces that trade-off.
6. **Combined capital allocation** (default, runs automatically whenever both Workflow 1 and a portfolio review ran in the same session) — merge Increase/Hold/New into one ranked, sized list against current wallet balance. See the dedicated section below.
7. **Daily close** (Workflow 6) — an accounting day-close: realized vs unrealized P&L, net of actual broker fees and sales tax, with a permanent local ledger. Separate from a portfolio review — runs only when explicitly asked for ("daily close", "close today", "P&L for [period]") or as a deliberate end-of-day routine, not bundled into the default Workflow 2-5 chain.

**Explicitly out of scope:** checking whether existing orders have been undercut/outbid and need repricing. That's faster to handle live in the client or with dedicated repricing tools. Do not spend ESI calls verifying top-of-book position for orders already open — only use live ESI to validate NEW candidates and to size/kill decisions on the portfolio (per the rules below).

## Fee & margin math

```
nm(buy, sell) = (sell×(1−0.015−0.034) − buy×(1+0.015)) / (buy×(1+0.015)) × 100
```
Fee profile: buyFee 1.5%, sellFee 1.5%, salesTax 3.4% (~6.4% total friction).

Margin thresholds:
- T1, sub-3 day supply: ≥12.5%
- T2, sub-4 day supply: ≥13%
- T3: ≥15%

## Mandatory ESI verification rule (applies to Workflows 1 and 2)

All kill/watch/candidate verdicts require live confirmation via the batch tool:
```
get_portfolio_margins(type_ids=[...], broker_fee_pct=1.5, sales_tax_pct=3.4)
```
Pass every type_id that needs checking in a single call rather than looping one-by-one — it fetches all items concurrently and already filters to the station (default `location_id=60003760`, Jita 4-4), so it handles the phantom-order problem automatically.

**Always pass `broker_fee_pct=1.5` and `sales_tax_pct=3.4` explicitly** — the tool's defaults (1% broker, 3.6% tax) assume different skill levels than Ramon's actual profile and will overstate every margin by roughly 1-1.5 points if left unset, which is enough to misjudge items sitting near the 12.5%/13% thresholds. That risk is the whole reason to set both parameters on every call rather than relying on defaults.

The response's `margin` field is already net of fees at the parameters given — use it directly rather than re-deriving with the `nm()` formula below (that formula is for manual sanity checks or when only raw buy/sell prices are available, e.g. from an A4E snapshot before the type_id is known).

**This tool only means something for items with a genuine open buy order.** See Workflow 3 for why running it on a sell-only item and reporting the result as a position check is a category error, and has caused repeated real mistakes.

Fall back to per-item `get_region_orders(region_id=10000002, type_id=X, location_id=60003760, order_type="all")` only if `get_portfolio_margins` errors on a specific type_id, or if a deeper look at order-book depth/duration is needed (e.g. judging whether a thin sell order is a fluke, or a headline margin looks like an outlier worth double-checking) — the batch tool returns counts but not the full order list. `get_region_orders` takes `location_id` directly, so pass it rather than pulling the region-wide list and manually checking each order's location.

**Watch for thin single-unit outliers skewing `bestSell`.** The batch tool takes the literal best price at the station, which can occasionally be a single-unit, short-duration listing that isn't representative of the durable market (seen with Corpus X-Type Heavy Energy Nosferatu: a 1-unit order dragged the reported margin down to 16% when the real durable price — 7 units, deep order — gave 33.5%). If a margin looks surprisingly low despite decent order counts, spot-check with `get_region_orders` before trusting it.

## Repricing rule of thumb (for Ramon's own reference — not a Claude monitoring task)

Repricing/undercut-checking stays out of scope for this skill (per Scope above) — Claude doesn't track queue position. But margin data already surfaced during a review is useful for Ramon's own call on whether a reprice is worth it, so here's the rule of thumb to mention if relevant:

Broker's fee is **percentage-based** (1.5% of order value per the fee profile above), not a flat ISK cost — so its real bite is what fraction of the item's *margin* that 1.5% eats, not the ISK amount. On a 15% margin item, one reprice costs ≈1.5/15 = 10% of the entire edge; on a 50% margin item, the same reprice costs only ≈3% of the edge. Same fee, very different relative damage.

**Rule: don't reprice a position sitting below ~20-25% margin — let it drift a few ticks off top-of-book instead.** Above ~40-50% margin, reprice freely; the fee is noise relative to the edge. Between 25-40%, judge case by case (liquidity, how far off top-of-book, how often it's already been repriced recently).

This pairs with the repeat-cancellation and broker-fee-churn notes elsewhere: cheap, thin, low-margin items (e.g. 'Wetu' Mobile Depot, High Energy Physics historically) are exactly where repeated repricing does the most proportional damage, independent of their small ISK size.

## Workflow 1: New position selection (from A4E snapshots)

1. Take the A4E tier snapshot(s) provided (T1/T2/T3, whatever price band).
2. Filter out rows already in the current portfolio (no point re-evaluating a held item as a "new" candidate — that's Workflow 2/3).
3. For remaining rows, compute `nm()` using the A4E buy/sell prices as a first pass, and rank by margin.
4. For the top candidates (say top 5-10 by margin, adjusted for trade count and traded ISK/day — don't chase high-margin/low-liquidity junk), verify live in one batch call via `get_portfolio_margins` (per the mandatory verification rule above):
   - Confirm the sell price isn't a phantom order from an outlying station (the tool already filters for this).
   - Confirm the buy price is achievable (i.e., there's room to place a buy order above current competition without collapsing the margin below threshold) — check `buyOrderCount` and, if a candidate looks thin (single-digit orders) or the margin is a wild outlier, follow up with a per-item `get_region_orders` to inspect order depth/duration before trusting it.
   - **Run the Perimeter/jump-range check proactively here, before recommending — not only after a position later shows zero fills.** `get_portfolio_margins`'s `bestBuy` is filtered to Jita 4-4 station only, which can be a single thin, stale, or near-empty order while the *real* competition sits at a nearby structure (see the dedicated Perimeter section below) with `range` covering Jita 4-4. A low `buyOrderCount` at Jita 4-4 (single digits) combined with a strong margin is exactly the pattern to check: pull unfiltered `get_region_orders(region_id=10000002, type_id=X, order_type="all")` and look at `topBuyOrders` for entries at other `location_id`s with `range` of `"1"` or more priced meaningfully above the Jita 4-4 figure. Confirmed failure case: Medium Disintegrator Specialization was recommended off a `bestBuy` of 760.700 (a single stale 1-unit Jita 4-4 order), while the real market had 129 units of demand at ~1.020.000-1.022.000 sitting at a Perimeter structure with 1-jump range — a Jita 4-4 buy order built on the 760.700 figure would essentially never fill, since any seller had a far better offer one jump away. If this pattern shows up, either reject the candidate or size it as a small test only, and say so plainly rather than presenting the flawed margin as reliable.
5. Present candidates with: item name, live-verified margin %, daily trade count, ISK/day, a one-line rationale, and a **suggested starting size** (units + ISK) per the sizing rule below.
6. Do NOT flag or comment on Helga's existing open orders for the same item in this workflow — that's Workflow 2/3's job.
7. **Repeat-cancellation check — targeted, not blanket.** If a candidate is one Ramon has held and killed before (recognizable from conversation context/memory — e.g. it was in a kill list earlier in this session or a recent one), don't just re-add it on today's margin alone. Call `get_order_history(type_id=X, side="buy", state="cancelled")` for that item before recommending it again — this returns only that item's cancelled buy orders directly, no need to pull the full history and filter client-side. If it shows 2+ prior buy orders cancelled while less than half filled (`volumeRemain` close to `volumeTotal`), treat it as a weak candidate: say so plainly, and only recommend reopening if today's margin is meaningfully above threshold (not just barely over) — otherwise it's likely to repeat the same open-barely-fill-cancel cycle. This check only runs when reopening a known repeat offender, not as a standing step on every new-candidate scan.

## Workflow 2: Buy portfolio review (kill / increase / hold)

1. Pull open orders via `get_character_orders`.
2. **Split the type_ids by each item's `isBuyOrder` field before doing anything else** — items with a genuine open buy order go through this workflow; items that only have sell orders go to Workflow 3 instead. `get_portfolio_margins` will happily return a margin for *any* type_id passed to it, regardless of whether Ramon actually holds a buy order there — running it on a sell-only item and reporting the result as a buy-side verdict is a category error. Confirmed failure case (round 1): Badger, Centii A-Type Thermal Coating, and Dark Blood Explosive Armor Hardener were all reported as buy-side kill candidates with fabricated "escrow freed" figures, when every listed order for all three was actually a sell order. Confirmed failure case (round 2, same mistake recurring): a repriced True Sansha Reactor Control Unit order was treated as a fixed buy-side position and re-checked via `get_portfolio_margins`, when both listings were sell orders (no `isBuyOrder` field, no `escrow` field) — there was no buy order at all.
   **This check applies every single time a margin figure is about to be discussed for a specific item, not just full workflow passes** — including one-off questions like "did the reprice fix X" or "how's item Y doing." Confirm `isBuyOrder: true` and an `escrow` field are present before citing `get_portfolio_margins` as a position check; if neither is present, go to Workflow 3 instead.
3. Collect every unique type_id from the genuine-buy-order group and check them in a single `get_portfolio_margins` call (per the mandatory verification rule above) — not whether the order is top-of-book, but whether the underlying trade is still profitable and liquid enough to be worth capital.
4. Decide per item:
   - **Kill**: margin has compressed below threshold for its tier, OR daily trade volume has dried up, OR sell-side has moved sharply against the position (e.g. a >15-20% drop in achievable margin since it was opened), OR zero fills over the lookback window regardless of how good the margin looks.
     **Before finalizing a zero-fill Kill, check order age and diagnose the real cause — don't kill on a stale assumption.** A brand-new order (issued minutes to a couple hours ago) will show zero fills no matter how good the margin is — that's not stalled, it's just too early to tell; note it as "too early to judge" instead. For orders old enough that zero fills is a real signal, don't stop at "demand must be thin" — check whether a nearby structure is invisibly outbidding you before killing: Perimeter (system 30000144) is one jump from Jita (30000142) and hosts player-owned structures with much lower fees than the Jita 4-4 NPC station. Traders commonly place buy orders there with `range: "1"` (jump range), which lets them buy from sellers at Jita 4-4 just as easily as Ramon's own Jita-4-4-station-only order can — and often at a meaningfully higher price, since the lower structure fees leave room to bid more and still profit. Confirmed directly on Veles Light Entropic Disintegrator: Ramon's order was "top of book" at Jita 4-4 (27.210.000), but the real top buy in the region was 39.340.000 at a Perimeter structure with 1-jump range — a seller at Jita 4-4 could get 44,6% more by selling there instead, making Ramon's order effectively invisible to sellers despite looking competitive under the station filter. This is asymmetric — it only affects the buy side; sell-side checks (bestSell filtered to Jita 4-4) stay reliable as-is, since sellers genuinely cluster at the NPC station. To check, pull `get_region_orders(region_id=10000002, type_id=X, order_type="all")` **without** the `location_id` filter, and look for buy orders at other `location_id`s with `range` of `"1"` or higher priced meaningfully above Ramon's. If found, say so plainly — this changes the verdict from "no demand, kill" to "outcompeted by a structure, still Kill (Ramon only trades Jita 4-4) but for a different, more useful reason to tell her" — the same check also runs proactively in Workflow 1 before a candidate is ever recommended, so this is the reactive counterpart for positions that were fine when opened and later went quiet.
   - **Increase investment**: margin is healthy/improved, volume is strong, and there's room to add more buy slots or larger volume without oversaturating (check volume ratio / trades ratio if available). **Execution note:** there's no "add units to an existing order" — increasing a position means either (a) placing a second order for just the incremental units, or (b) cancelling the existing order and reissuing a larger one. (a) only charges broker fee on the new incremental capital; (b) re-charges fee on the *entire* new order value, including capital that was already committed. Default to (a) — recommend a second order sized to the increment — unless the existing order's price is itself stale and needs correcting anyway, in which case (b) is unavoidable regardless of size change. **Before recommending Increase, confirm the position is actually converting (fill history, not just margin) — don't strengthen something that isn't moving.** Order-book depth (`buyOrderCount`/`sellOrderCount`) on a candidate is a reasonable proxy for expecting fills; thin books are more likely to stall.
   - **Hold**: no material change, leave as-is.
5. Do NOT evaluate or report on whether individual orders are currently outbid/at top-of-book — this is about capital allocation and profitability, not queue position. If Ramon wants queue-position checks, that's a separate live/client-side task outside this skill.
6. Present as a table: item, current price paid, live achievable margin, verdict (Kill/Increase/Hold), one-line reason, and — for every Kill or Increase — the suggested size per the sizing rule below (ISK recovered for Kill, incremental units/ISK for Increase).

## Workflow 3: Sell portfolio review (real cost basis, not generic margin)

This workflow gets the same rigor as Workflow 2, not a footnote inside it — it has caused repeated real mistakes when treated as an afterthought (see the confirmed failure cases in Workflow 2, step 2).

1. Take the sell-only type_ids identified in Workflow 2, step 2 (no `isBuyOrder`/`escrow` field on any of that item's open orders).
2. **Determine held units first, from both sources — not just the sell order.** Sum the `volumeRemain` across all open sell orders for the item, *plus* any uncovered units Workflow 4 found sitting in the hangar with no sell order at all. Confirmed failure case: Federation Navy 200mm Steel Plates was reported with held=1 (the sell order only) when Workflow 4 had already found 2 more unlisted units — the per-unit margin was still right, but the total exposure/profit figure was understated by 3x.
3. **Do not use `get_portfolio_margins`'s output as the verdict for these.** Instead pull `get_wallet_transactions(side="buy", type_id=X)` and compute cost basis using the **bounded weighted average**, not a full-history blend: sort buy transactions newest-first, and sum quantities from the top until they cover the held-units figure from step 2 — use only *those* lots for the weighted average, discarding older lots beyond that point entirely. This matters whenever held units < total units ever bought (i.e. some have already sold): a full-history blend dilutes the average with lots that are very plausibly already gone, systematically mispricing the result in whichever direction the price trend moved. Confirmed failure case: Badger had 73 units ever bought across a wide price range (705.600 to 1.631.000) but only 35 currently held — a full-history blend gave 1.043.260/unit (implying a -9,4% underwater position), while the correct bounded calculation (the 35 held units are covered entirely by the most recent 705.600 lot) gave 705.600/unit (+33,9%, genuinely profitable) — a verdict-flipping difference. The bounded method assumes oldest-sold-first (FIFO), which matches both standard inventory accounting for fungible goods and the actual observed pattern here (the older, pricier Badger lots had already cleared in earlier sessions).
4. **Watch specifically for a recent price jump in acquisition cost even within the bounded method** — if the lots covering current holdings span a genuine price jump (not just one uniform recent lot), break out the most-recent-lot's own margin separately in addition to the bounded blend, since a mixed bounded average can still mask one sub-lot being underwater while another isn't.
5. Decide per item:
   - **Profitable, list/hold**: achievable net sell clears real cost basis by a healthy margin — recommend listing (if unlisted, see Workflow 4) or holding the current listing.
   - **Marginal**: real margin is thin (under ~15-20%) — flag it, but selling existing inventory at a thin profit is still usually better than holding dead stock; don't apply the same "don't bother" logic used for repricing decisions on live buy orders.
   - **Underwater**: achievable net sell is below cost basis — say so plainly. This is a real-loss situation, not a kill/hold framing; the decision is whether to accept the loss now or hold and hope for recovery, and that call belongs to Ramon, not this skill.
6. Report as its own table (item, held units, bounded avg cost, achievable net sell, real margin, verdict) — separate from the Workflow 2 buy-order table, since it's a fundamentally different kind of decision.

## Workflow 4: Inventory risk — mandatory on every portfolio review

Fills convert escrow into hangar stock, and that stock is real financial exposure sitting outside the buy/sell order book where margin checks won't catch it — it's already been paid for but isn't cash until a sell order exists and actually clears.

1. Pull `get_character_assets` and cross-reference against open sell orders: any item sitting in the hangar with no matching sell order (or a sell order covering fewer units than are actually held) is uncovered exposure.
2. Report this explicitly as its own section in every review, not folded into either margin table — name the item, the uncovered unit count, and (where a live sell price is available) the rough ISK value sitting exposed, and recommend listing it.
3. Treat this with the same "always check" weight as the Workflow 2/3 margin pulls — not a nice-to-have, not periodic.

## Workflow 5: Pipeline performance — default synthesis step, runs after Workflows 2-4

**This is where the actual money is made or left on the table.** A healthy margin on a slow-cycling position can earn less than a thinner margin that turns over fast — nothing else in this skill surfaces that trade-off, so this workflow exists to make it visible every time, by default, as the closing step of any portfolio review.

**This is a synthesis step, not a new data-gathering one.** It reads timestamps already collected in Workflows 2-4 rather than requiring new tool calls, with one adjustment: widen the fill-activity lookback from the old 5-7 day kill-signal window to **~14 days**, since full pipeline cycles (buy → fill → list → sell) routinely run longer than a week — the Shadow Serpentis Explosive Armor Hardener experiment took well over a week end-to-end. The wider window still serves the Workflow 2 zero-fill kill signal (a position with zero fills in 14 days is even more clearly dead than one with zero fills in 5-7); it isn't a separate call.

1. For every current position (buy-side from Workflow 2, sell-side from Workflow 3), compute from data already in hand:
   - **Order age**: from the order's `issued` timestamp.
   - **Time to first fill** (buy-side): first `get_wallet_transactions` buy entry for that type_id minus order `issued`. Report "unfilled after Xd" if still pending.
   - **Time spent as unlisted inventory**: sell order `issued` minus the last relevant buy-fill timestamp, for items that moved from Workflow 2 into Workflow 4's inventory-risk list before eventually getting listed. Report "still unlisted after Xd" if flagged in Workflow 4 and still uncovered.
   - **Time to sell** (sell-side): `get_wallet_transactions` sell entry timestamp minus sell order `issued`. Report "unsold after Xd" if still pending.
2. **This is a distinct axis from margin, not a replacement for it — report both.** Margin tells you whether a trade *would* be profitable; it says nothing about whether it's actually happening. Observed in practice: the highest-margin positions in the portfolio (several above 30-80%) were disproportionately the ones with zero fills, while several much lower-margin positions (15-25%) were cycling constantly.
3. **Buy-side zero-fill diagnosis (order age, Perimeter competition) already happened in Workflow 2, before the Kill/Hold verdict was decided — don't redo it here.** By the time this workflow runs, any buy-side item worth flagging as a slow-mover has already been through that check. This step is about surfacing the *pattern across the whole portfolio*, not re-diagnosing individual items.
4. **Don't present a full table for every item every time** — that's noise, not insight. Rank by slowest stage *relative to that item's typical liquidity* (a thin item sitting unsold for 3 days isn't news; a deep 80-order-book item sitting unsold for 3 days is a real signal) and surface only the 2-3 clearest outliers.
5. For each outlier, state the actionable read directly: is the margin good enough to justify the wait, or would that capital earn more cycling through something faster even at a lower headline margin? This is a judgment call to present, not a hard rule — but always frame it in terms of capital efficiency (ISK/day), not margin alone.
6. If nothing stands out as a clear outlier this review, say so briefly rather than manufacturing a table — this step should feel like a genuine insight when it fires, not routine filler.

## Workflow 6: Daily close (accounting)

This is a distinct deliverable from a portfolio review — a real day-close, in the sense a daytrading desk would run one: realized P&L (booked, cash-true) separated from unrealized P&L (mark-to-market on what's still held), with fees and tax as their own expense line rather than folded into a margin percentage. It runs on its own ledger (`~/.eve-sde/ledger.db`), not just live ESI calls, because **ESI's wallet journal and transaction history only cover a rolling ~30 days** — anything not synced before it ages out is gone permanently, with no way to recover it later, even from CCP support. Trigger this workflow explicitly ("daily close", "close today", "P&L for this week/month") — don't run it as part of a default portfolio review.

Tools: `sync_wallet_ledger`, `run_daily_close`, `get_daily_close`, `get_close_range`, `get_open_lots`.

1. **Run the close**: call `run_daily_close` (defaults to today, UTC). This syncs the ledger first, so it's always safe to run even after a gap — but the longer the gap, the more likely something aged out of ESI's 30-day window before ever being synced (check `get_close_range` for missing dates and say so plainly if there's a hole).
2. **Cost basis is strict FIFO here, not the bounded-weighted-average used in Workflow 3.** Workflow 3 reconstructs cost basis on demand from whatever `get_wallet_transactions` returns that day (necessarily approximate, since ESI's window is short). The ledger instead records every synced transaction permanently and consumes lots oldest-first as sells happen — more precise, and it's what makes a real day-close possible at all. Don't be confused seeing two different cost-basis methods in the same skill; they're solving different problems (a quick live check vs. a persistent accounting record).
3. **Present the report as an actual close, top to bottom**:
   - Opening NAV → Realized P&L (revenue − COGS = gross; minus **actual** broker fees and sales tax pulled from the wallet journal, not an estimated percentage — this is what makes relisting costs visible, since every relist is its own real `brokers_fee` entry) → Unrealized P&L (mark-to-market on current open lots at Jita best bid, **only computed for today** — a backfilled past date gets realized figures only, say so explicitly) → Closing NAV.
   - NAV = wallet balance + buy-order escrow + inventory marked to market.
4. **Flags are the point — don't bury them in the numbers.** `run_daily_close` surfaces, as an explicit list:
   - Sells with no matching lot (**unmatched cost basis** — pre-dates the ledger, or arrived via loot/reward/contract/corp transfer rather than a market buy). These are excluded from realized P&L rather than costed at a guess; report the revenue separately and say plainly it's not included in P&L.
   - Live-asset quantity vs. ledger lot quantity mismatches per item — the ledger's view of "what's held" can drift from reality (manufacturing, contracts, item movement), and this is where that shows up.
   - Non-trading cashflow (anything in the journal that isn't `market_transaction`/`brokers_fee`/`transaction_tax` — transfers, insurance, contracts) — same caveat as the wallet-reconciliation note elsewhere in this skill: check it before trusting NAV.
   - A reconciliation gap between expected and actual NAV change since the prior close, when one can be computed.
5. **Backfilling**: `run_daily_close` accepts `close_date` for a past date to compute realized P&L retroactively from already-synced ledger data (useful if Ramon missed a few days) — but it will not have unrealized/NAV for that date, since mark-to-market needs live prices.
6. **Period review**: use `get_close_range` for a week/month of already-computed closes rather than re-deriving trend numbers by hand — it also returns summed totals (net realized P&L, fees, tax) across the range.
7. This workflow does not replace Workflows 2/3's live verification before acting on a position — it's the accounting record of what already happened, not a tool for deciding what to do next. Point Ramon back to a portfolio review for that.

## Mandatory sizing rule (applies to Workflows 1, 2, and 3)

Every verdict that isn't a plain "Hold" — every new candidate, every Kill, every Increase — must come with a suggested **unit quantity and ISK amount, shown as separate, explicit values**, not just a margin percentage. Cost-only tables are incomplete: a units column must be visibly present, not buried in prose or implied by the cost figure alone.

Sizing method:
1. Pull current wallet balance (`get_wallet_balance`) to know available capital. If any meaningful time has passed since it was last pulled in the conversation, refresh it again rather than reusing a stale figure — balances move fast when Ramon is actively executing on prior recommendations.
2. Cap any single position at a sensible share of daily liquidity — don't suggest a buy volume that exceeds roughly 15-25% of the item's daily trade count, or the order will sit unfilled for days and tie up escrow pointlessly. Thin items (under ~20 trades/day) get small, conservative sizes; deep items (100+ trades/day) can support larger ones.
3. For **Kill**, state the ISK recovered: unit count × price × (freed escrow), so Ramon knows exactly what capital comes back.
4. For **Increase**, suggest an incremental unit count and its ISK cost, sized against both remaining wallet capacity and the liquidity cap above — don't suggest doubling a position that only trades 12 units/day.
5. For **new candidates**, suggest a starting position size (units + ISK), scaled down for thinner items and up for deep/liquid ones, and note if slot capacity is a constraint.
6. Once you've picked unit counts per candidate (that judgment call — liquidity caps, thin-book caution, priority order — stays with you, not the script), hand the list to `scripts/size_positions.py` in this skill folder to do the arithmetic and print the table: `from size_positions import size_positions; size_positions(candidates, wallet=..., buffer_target_pct=...)`. This exists because the running-total-and-buffer-check math has been hand-rewritten many times across sessions — using the script removes that repetition and the chance of an arithmetic slip landing in front of Ramon. If the script isn't reachable for some reason, fall back to computing inline, but reach for it first.

**Required table template.** The script above already outputs this format, so following the sizing method naturally produces a compliant table:

| Item | Unit price | Units | Cost | Margin | (Running total, if part of a ranked list) |
|---|---|---|---|---|---|

If building a table by hand instead of via the script, double check the rendered result actually has a separate Units column with a number in it, not a unit count folded into the Cost figure — this has been missed before, which is the whole reason the script exists now.

## Margins are point-in-time — re-verify before execution, not just before recommending

A margin verified live can still be wrecked within hours by a single large order landing. Observed in practice: two candidates verified at 73,4% and 68,4% margin dropped to 27,4% and 6,0% respectively within the same session, purely from fresh competing orders (a 26% sell-side drop on one, a 35-unit dump crashing the other 37%). This is normal market behavior, not a tool error — but it means:

- Verified margin is a snapshot, not a guarantee. Say so plainly when presenting candidates, especially ones with thinner books (under ~25 buy+sell orders combined) where a single order can move the market a lot.
- If Ramon reports a margin looks wrong after having already acted on a recommendation, re-verify live immediately rather than defending the earlier snapshot — the earlier number was correct *at the time*, but markets move.
- When re-verification shows a margin has dropped below threshold for its tier, treat it exactly like a Kill/reconsider case in Workflow 2, even if the position was only just opened.

## Combined capital allocation — default final step after Workflow 1 + a portfolio review

Run this automatically at the end of any session that touches both Workflow 1 and a portfolio review (i.e. new candidates plus existing-position triage) — don't wait for Ramon to ask for prioritization separately. If only one side ran (e.g. just a candidate scan with no portfolio pulled), skip this step, since there's nothing to combine yet.

Don't just carry forward whatever was already labeled Increase or New candidate — that under-counts good options.

1. Pull **all three** pools into one list: Kill-freed capital (informational only, not a spend target), Increase-tagged existing positions, Hold-tagged existing positions, and New candidates.
2. Re-scan the **Hold** bucket specifically — some Hold items will have margin and liquidity as good as or better than items already tagged Increase or New. Don't assume "Hold" means "closed to more capital." Pull them into the ranking too if they'd rank competitively.
3. Rank the combined pool by margin (adjusted for liquidity confidence — deprioritize thin-book items even if margin is high, per the phantom/thin-liquidity cautions above — and, per Workflow 5, deprioritize slow-cycling items even at a strong margin if faster capital rotation is available elsewhere).
4. Refresh wallet balance immediately before doing the fill (per the sizing rule above), then greedily fill the ranked list against that balance, respecting per-item liquidity caps, until the budget is spent down to a sensible buffer.
5. **Default buffer target: ~10% of total available capital, or ~300M ISK on a portfolio around the 3B scale — whichever Ramon has most recently specified.** This is more aggressive than earlier defaults; ask if unspecified and the portfolio scale has changed materially, but don't default back to a much larger (e.g. 40%+) buffer without a reason tied to genuine liquidity risk (several thin-book positions in the mix, market volatility just observed, etc.) — state that reason explicitly if applying a bigger buffer than the target.
6. Show the running total after each item so Ramon can see exactly where the cutoff falls, and call out what got excluded and why (didn't fit budget vs. deprioritized for thin liquidity).

## Full-deployment mode — when Ramon wants most of the wallet actively invested

Trigger: Ramon says something like "invest this back into the market" / "don't want it sitting dormant" / explicitly asks to deploy most or all of the wallet, as opposed to the default conservative buffer-preserving mode.

1. Ask (via clarifying question) how many new slots Ramon is comfortable with if it isn't already stated — full deployment usually requires far more positions than a normal "a few candidates" review, because per-item liquidity caps mean any single item can only absorb a limited slice of a large wallet without oversaturating.
2. Scan a wider net of A4E candidates than usual (10+ verified live) to have enough slots to spread capital across.
3. Scale unit counts per candidate up from the normal conservative default, but keep the same liquidity-based ceiling logic — deep-book items (both sides showing 20+ orders) can take meaningfully larger sizes; thin-book items stay capped small regardless of how much capital is left to deploy. Don't inflate a thin position just because there's budget room.
4. Target buffer in this mode: same as the default combined-allocation target above (~10% / ~300M) unless Ramon specifies otherwise — the point of this mode is to get *most* of it working, not to default back to an oversized buffer.

## Notes

- Escrow and wallet balance are useful context for sizing "increase investment" calls (how much dry powder is available) but are not themselves a trigger for action.
- Slot count is a real constraint — when recommending new candidates, note how many free trading slots would be needed and flag if Helga's skill-based slot cap might be a limiting factor.
- If a wallet balance change doesn't reconcile against orders and `get_wallet_transactions` (e.g. a drop with no matching buy/escrow change — this has happened before, once turning out to be a corp slush fund transfer), use `get_wallet_journal(since=..., ref_type=...)` to check for non-trading entries before treating it as a mystery. Useful `ref_type` values: `market_transaction`, `brokers_fee`, `transaction_tax`, plus non-trading ones for transfers.
- **Broker fee churn vs. legitimate growth — don't conflate them.** The repeat-cancellation problem (§ Workflow 1 item 7) is about the *same order* getting cancelled and recreated at the *same size* repeatedly with no net increase — that's pure fee waste from chasing competition. Deliberately placing a second order to grow a healthy position is not the same thing and is not something to discourage — see the Increase execution note in Workflow 2. Don't recommend "adding to an existing order" (not possible in EVE) as if it avoids fees; the real choice is second order (fee only on the increment) vs. cancel-and-reissue larger (fee on the whole new value).
- **Sizable realized profit ≠ sizable realized cash.** When asked to analyze recent transactions, don't equate gross sell revenue with profit — a big cash inflow from selling out a large position is mostly return of the original cost basis, not margin. Compute per-item real profit (sell revenue net of fees minus real acquisition cost, per Workflow 3's method) before characterizing a period as more or less profitable than it looks from the wallet delta alone.
- **Skill persistence risk.** This file has previously reverted to an earlier saved version between sessions (observed: content frozen at initial-creation timestamp despite many later in-session edits), and the `scripts/` subfolder has separately gone missing at least once even when SKILL.md itself was intact. If a review of this file shows it missing sections referenced above (batch tool usage, sizing template, Workflow 3, Workflow 5, repeat-cancellation check, Perimeter check, buffer target) or `scripts/size_positions.py` is unreachable, say so plainly before proceeding rather than silently working from a stale version — flag it and offer to restore from conversation history or the outputs backup.
