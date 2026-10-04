# Margin verification — two locations, two fee models

Everything about computing a trustworthy margin in this strategy: the fee profile, the margin formula, the mandatory two-call ESI verification, and the competition checks. **Read this before quoting any margin figure.**

## Contents
- [The two locations and their fees](#the-two-locations-and-their-fees)
- [Fee & margin math](#fee--margin-math)
- [Margin thresholds](#margin-thresholds)
- [The mandatory two-call ESI verification procedure](#the-mandatory-two-call-esi-verification-procedure)
- [The competitive bid](#the-competitive-bid)
- [The jump-range competition check](#the-jump-range-competition-check)
- [Thin single-unit outliers](#thin-single-unit-outliers)
- [Fee numbers drift — verify via get_station_fees](#fee-numbers-drift--verify-via-get_station_fees)

## The two locations and their fees

As of **2026-09-12**, this strategy trades out of two locations, not one:

- **Perimeter - 0.0% Neutral States Market HQ** — `location_id 1044752365771`, system 30000144 (Perimeter, 1 jump from Jita). **Buy-side.** New buy orders go here with `range: "1"`, so they still reach sellers at Jita 4-4.
  - Broker fee: **flat 100 ISK structure fee + 0.5% SCC surcharge**, additive — placing or relisting costs `0.5% × order value + 100 ISK`.
  - The flat 100 ISK is 0.02% or less at tier ticket sizes (≥500K ISK), so the margin formula below and the A4E URLs model the buy side as 0.5% alone. The ledger's fee/order matching needs the full additive model — see `get_station_fees`.
- **Jita 4-4 Caldari Navy Assembly Plant** — `location_id 60003760`, system 30000142 (Jita). **Sell-side, unchanged.** Sell orders stay here — this is where buyer foot-traffic actually is. Broker fee: **1.5%**. Sales tax: **3.4%** (charged on sell fill; sales tax is a sell-side-only cost, so it's unaffected by where the item was bought).

This is a **hybrid**, not a full relocation — don't assume sell-side fees dropped too. **Legacy buy orders placed before 2026-09-12 may still sit at Jita 4-4** (`locationId: 60003760` on that specific order, from `get_character_orders`) until they fill or get manually migrated — always check each order's own `locationId` rather than assuming everything moved.

Total round-trip friction is now ~5.4% (down from 6.4%), entirely from the buy-side broker fee dropping 1.5% → 0.5%.

## Fee & margin math

```
nm(buy, sell) = (sell×(1−0.015−0.034) − buy×(1+0.005)) / (buy×(1+0.005)) × 100
```
Fee profile: buy-side broker fee 0.5% (Perimeter HQ), sell-side broker fee 1.5% (Jita 4-4), sales tax 3.4% (Jita 4-4, sell-side only).

## Margin thresholds

As of **2026-09-23**, entry and hold use two different floors — they answer different questions and shouldn't be conflated. This is a deliberate, user-directed change from the prior flat-per-tier scheme (T1 ≥12.5% / T2 ≥13% / T3 ≥15%, used since the 2026-09-12 Perimeter move); don't loosen either floor further without asking first.

**Opening a new position (Workflow 1)** — tiered, and *not* in the same order the prices suggest. T3 carries the largest capital per unit, the thinnest order books, and the highest volatility of the three tiers (mutaplasmid/filament swings, single-order phantom spikes — see `failure-cases.md`), so by default it gets the *highest* bar, not the lowest:
- **T1: ≥10%**
- **T2: ≥11%**
- **T3: ≥13%**, or **≥10% if the candidate clears a liquidity bar**: ≥50 trades/day *and* a combined buy+sell order count that clears the thin-book depth check below (roughly 25+).
  - The carve-out exists so a genuinely liquid T3 item (e.g. a high-volume filament trading 150+/day) isn't held to the full 13% just for its price tier; a thin T3 item still needs 13% however good its headline margin looks.
  - Never grant it on trade count alone — a busy-looking average over a volatile week isn't a durably deep book. Check the actual order counts.

**Holding an existing position (Workflow 2 Kill/Hold, and the point-in-time re-verification rule in SKILL.md)** — one flat floor regardless of tier: **≥10%**. Once capital is already committed there's no broker-fee cost to simply continuing to hold it, unlike the opportunity cost of choosing to commit fresh capital to one candidate over another — so the bar for staying in is lower than the bar for getting in. A held position at or above 10% clears the Kill/Hold margin check, whatever tier it's in.
- **This is a floor, not a sufficient Hold signal by itself.** A position sitting above 10% but not actually converting (thin fill velocity, capital parked idle) still gets flagged through Workflow 5's capital-efficiency lens — that check is separate from and additional to this one. Margin says the trade is profitable; it says nothing about whether the capital is well used right now.
- **Corollary for a position re-verified right after opening** (SKILL.md's point-in-time rule): before the order is placed, hold it to the *entry* floor for its tier — a recommendation that's dropped below entry-floor before execution is stale, don't place it as sized. Once the order is actually open, it's a held position and the flat 10% hold floor applies going forward, not the (possibly higher) entry floor it was opened under. A freshly-opened T2 or T3 position that dips just under its entry bar but still clears 10% is a Hold, not an automatic Kill.

## The mandatory two-call ESI verification procedure

Because buy and sell orders sit at two different locations with two different broker fees, a single `get_portfolio_margins` call can no longer produce a trustworthy margin by itself — its `location_id` filters *both* bestBuy and bestSell to the same place, and its `broker_fee_pct` applies one rate to both sides. Neither matches the actual setup. Every kill/watch/candidate verdict now requires **two batch calls, combined manually**:

1. **Buy-side call**: `get_portfolio_margins(type_ids=[...], location_id=1044752365771, broker_fee_pct=0.5, sales_tax_pct=3.4)`. Use only `bestBuy` and `buyOrderCount` from this — it reflects what the character can actually achieve at Perimeter HQ. Ignore its `bestSell`/`margin`/`profitPerUnit` entirely; Perimeter's own sell-side isn't where the selling happens and is often thin or absent.
   - **Exception**: for any buy order that hasn't migrated and is still sitting at Jita 4-4 (check `locationId` on that specific order via `get_character_orders`), use a buy-side call at `location_id=60003760, broker_fee_pct=1.5` for that item instead — that's where the capital is actually committed right now.
2. **Sell-side call**: `get_portfolio_margins(type_ids=[...], location_id=60003760, broker_fee_pct=1.5, sales_tax_pct=3.4)`. Use only `bestSell` and `sellOrderCount` — unchanged from before the move, since sell orders stay at Jita 4-4.
3. **Combine manually per item** with the `nm()` formula above (`buy` = the buy-side call's `bestBuy` with its matching fee, `sell` = the sell-side call's `bestSell`). The tool's own single `margin` field is not valid for any item bought at Perimeter — don't cite it directly.

This doubles the ESI calls per review compared to before the move. That's an accepted cost of the hybrid setup, not something to optimize away by guessing at one side.

## The competitive bid

For any margin on an open or proposed buy, "the bid" is the **competitive bid**: the highest of
- (a) the best buy at Perimeter HQ (the buy-side call's `bestBuy`),
- (b) the best buy at Jita 4-4,
- (c) any range-1 bid at another nearby structure — e.g. structure 1042508032148, which appears in the ledger's station list.

Sellers at Jita 4-4 take the highest bid they can reach, so a Perimeter order priced below any of these queues behind it. The Perimeter-side batch call only reports (a); get (b) from a Jita-side buy call or `get_region_orders`, and (c) from `get_region_orders` unfiltered by location (the same pull as the jump-range check below).

Quote the **live margin at the competitive bid**, and the margin at the order's own price as well only when the two straddle the 10% floor. Housekeeping: structure 1042508032148 and a few other stations have no entry under `stationFees` in `~/.eve-sde/config.json`, so the daily close prices their broker fees at a generic 1% and flags it every run — pin the real fees with `get_station_fees` when they're known.

## The jump-range competition check

**The check is about the trader's own order, not a hidden competitor's.** Before the Perimeter move it caught a hidden range-1 Perimeter buyer outcompeting a Jita-4-4-only order. Now the trader *is* that range-1 buyer, so it inverts: the risk is a third party — a station-range order at Jita 4-4 itself, or another player at Perimeter or a nearby structure with enough range — outbidding the character's Perimeter order for the same Jita 4-4 sellers.

To check, pull `get_region_orders(region_id=10000002, type_id=X, order_type="all")` unfiltered by location and take the true competitive price as the MAX of
- any buy order physically at Jita 4-4 (`location_id: 60003760`, any range — being there always counts), and
- any order elsewhere whose `range` (in jumps) covers the distance to Jita 4-4 (Perimeter is 1 jump, so `range: "1"` or higher counts).

If anything beats the character's own bid, the character is the one being outcompeted for seller attention. (Why: Medium Disintegrator Specialization was recommended off a stale single-unit `bestBuy` while the real demand sat at a Perimeter structure at a higher price — [failure-cases.md](failure-cases.md#stale-single-unit-bestbuy--missed-range-1-competitor-medium-disintegrator).)

Fall back to per-item `get_region_orders(region_id=10000002, type_id=X, location_id=X, order_type="all")` (pass whichever location_id is relevant to the leg being checked) if `get_portfolio_margins` errors on a specific type_id, or if a deeper look at order-book depth/duration is needed — the batch tool returns counts but not the full order list.

## Thin single-unit outliers

**Watch for thin single-unit outliers skewing `bestSell` or `bestBuy`.** The batch tool takes the literal best price at the given location, which can occasionally be a single-unit, short-duration listing that isn't representative of the durable market (confirmed case: Corpus X-Type Heavy Energy Nosferatu — a 1-unit order dragged the reported margin down to 16% when the real durable price, 7 units on a deep order, gave 33.5%; see `failure-cases.md`). If a margin looks surprisingly off despite decent order counts, spot-check with `get_region_orders` before trusting it.

**A sudden margin collapse driving a Kill gets the same spot-check as a suspiciously good margin.** One mis-priced order crashes a margin as easily as it inflates one — a fast, dramatic swing (a healthy double-digit margin cratering to near-zero or negative within an hour) is itself the trigger to spot-check with `get_region_orders`.
- Watch for the sell price landing very close to the buy price, or at "buy price + a trivial increment": the signature of an order submitted at the client's pre-filled default ("+1 over the current best opposing order") without adjusting it, not genuine repricing.
- Why: 75mm Prototype Gauss Gun went from +43% to −5.4% within the hour on exactly this pattern (bestBuy 656,200 / bestSell 656,300), was reported as a Kill without a spot-check, and recovered to +43.8% once the stray order was gone ([failure-cases.md](failure-cases.md#accidental-default-price-order-crashed-a-margin-75mm-prototype-gauss-gun)).

## Fee numbers drift — verify via get_station_fees

The fee figures above are pinned in `~/.eve-sde/config.json` (`stationFees` + `salesTaxPct`) and surfaced by the `get_station_fees` tool — that config is the source of truth for the ledger's fee matching, and the same numbers feed every margin computed here. If the fee profile or either location ever changes, this file, the A4E tier URLs' `buyFee`/`sellFee`/`salesTax` params (see `workflow-new-candidates.md`), and the config all need updating together — they silently drift out of sync otherwise. When in doubt, read the current numbers with `get_station_fees` before quoting a margin.
