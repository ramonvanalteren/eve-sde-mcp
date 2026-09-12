# Margin verification — two locations, two fee models

Everything about computing a trustworthy margin in this strategy: the fee profile, the margin formula, the mandatory two-call ESI verification, and the competition checks. **Read this before quoting any margin figure.**

## Contents
- [The two locations and their fees](#the-two-locations-and-their-fees)
- [Fee & margin math](#fee--margin-math)
- [The mandatory two-call ESI verification procedure](#the-mandatory-two-call-esi-verification-procedure)
- [The jump-range competition check](#the-jump-range-competition-check)
- [Thin single-unit outliers](#thin-single-unit-outliers)
- [Fee numbers drift — verify via get_station_fees](#fee-numbers-drift--verify-via-get_station_fees)

## The two locations and their fees

As of **2026-09-12**, this strategy trades out of two locations, not one:

- **Perimeter - 0.0% Neutral States Market HQ** — `location_id 1044752365771`, system 30000144 (Perimeter, 1 jump from Jita). **Buy-side.** New buy orders go here, placed with `range: "1"` so they still reach sellers sitting at Jita 4-4. Broker fee: **flat 100 ISK structure fee + 0.5% SCC surcharge**, additive — placing or relisting an order costs `0.5% × order value + 100 ISK`. (The flat 100 ISK is negligible at tier ticket sizes ≥500K ISK — 0.02% or less — which is why the margin formula below and the A4E URLs model the buy side as 0.5% alone; but the ledger's fee/order matching needs the full additive model — see `get_station_fees`.)
- **Jita 4-4 Caldari Navy Assembly Plant** — `location_id 60003760`, system 30000142 (Jita). **Sell-side, unchanged.** Sell orders stay here — this is where buyer foot-traffic actually is. Broker fee: **1.5%**. Sales tax: **3.4%** (charged on sell fill; sales tax is a sell-side-only cost, so it's unaffected by where the item was bought).

This is a **hybrid**, not a full relocation — don't assume sell-side fees dropped too. **Legacy buy orders placed before 2026-09-12 may still sit at Jita 4-4** (`locationId: 60003760` on that specific order, from `get_character_orders`) until they fill or get manually migrated — always check each order's own `locationId` rather than assuming everything moved.

Total round-trip friction is now ~5.4% (down from 6.4%), entirely from the buy-side broker fee dropping 1.5% → 0.5%.

## Fee & margin math

```
nm(buy, sell) = (sell×(1−0.015−0.034) − buy×(1+0.005)) / (buy×(1+0.005)) × 100
```
Fee profile: buy-side broker fee 0.5% (Perimeter HQ), sell-side broker fee 1.5% (Jita 4-4), sales tax 3.4% (Jita 4-4, sell-side only).

Margin thresholds (unchanged from before the move — these were calibrated against the old 6.4% total friction, so they're probably slightly conservative now that it's ~5.4%, but haven't been explicitly revisited; don't loosen them unilaterally, ask the user first):
- T1, sub-3 day supply: ≥12.5%
- T2, sub-4 day supply: ≥13%
- T3: ≥15%

## The mandatory two-call ESI verification procedure

Because buy and sell orders sit at two different locations with two different broker fees, a single `get_portfolio_margins` call can no longer produce a trustworthy margin by itself — its `location_id` filters *both* bestBuy and bestSell to the same place, and its `broker_fee_pct` applies one rate to both sides. Neither matches the actual setup. Every kill/watch/candidate verdict now requires **two batch calls, combined manually**:

1. **Buy-side call**: `get_portfolio_margins(type_ids=[...], location_id=1044752365771, broker_fee_pct=0.5, sales_tax_pct=3.4)`. Use only `bestBuy` and `buyOrderCount` from this — it reflects what the character can actually achieve at Perimeter HQ. Ignore its `bestSell`/`margin`/`profitPerUnit` entirely; Perimeter's own sell-side isn't where the selling happens and is often thin or absent.
   - **Exception**: for any buy order that hasn't migrated and is still sitting at Jita 4-4 (check `locationId` on that specific order via `get_character_orders`), use a buy-side call at `location_id=60003760, broker_fee_pct=1.5` for that item instead — that's where the capital is actually committed right now.
2. **Sell-side call**: `get_portfolio_margins(type_ids=[...], location_id=60003760, broker_fee_pct=1.5, sales_tax_pct=3.4)`. Use only `bestSell` and `sellOrderCount` — unchanged from before the move, since sell orders stay at Jita 4-4.
3. **Combine manually per item** with the `nm()` formula above (`buy` = the buy-side call's `bestBuy` with its matching fee, `sell` = the sell-side call's `bestSell`). The tool's own single `margin` field is not valid for any item bought at Perimeter — don't cite it directly.

This doubles the ESI calls per review compared to before the move. That's an accepted cost of the hybrid setup, not something to optimize away by guessing at one side.

## The jump-range competition check

**This check is now about the trader's own order, not a hidden competitor's — reframe it, don't drop it.** Before the move, this check existed to catch a hidden Perimeter buyer with `range: "1"` outcompeting a Jita-4-4-only order. Now the trader *is* that range-1 Perimeter buyer, so the check inverts: the risk is a third party — a station-range order sitting at Jita 4-4 itself, or another player at Perimeter or a different nearby structure with sufficient range — outbidding the character's own Perimeter order for the same Jita 4-4 sellers' attention. To check: pull `get_region_orders(region_id=10000002, type_id=X, order_type="all")` unfiltered by location, and take the true competitive price as the MAX of (a) any buy order physically at Jita 4-4 (`location_id: 60003760`, any range — being there always counts) and (b) any order at another location whose `range` (in jumps) covers the distance from that location to Jita 4-4 (Perimeter is 1 jump, so `range: "1"` or higher there counts). Compare that max against the character's own bid — if something beats it, the character is the one being outcompeted for seller attention now, not the other way around. Confirmed historical failure case (from before the move, same underlying mechanism, now just pointed the other way — see `failure-cases.md`): Medium Disintegrator Specialization was recommended off a stale single-unit `bestBuy`, while the real demand sat at a Perimeter structure with 1-jump range at a meaningfully higher price — a Jita-only order built on the stale figure would essentially never fill.

Fall back to per-item `get_region_orders(region_id=10000002, type_id=X, location_id=X, order_type="all")` (pass whichever location_id is relevant to the leg being checked) if `get_portfolio_margins` errors on a specific type_id, or if a deeper look at order-book depth/duration is needed — the batch tool returns counts but not the full order list.

## Thin single-unit outliers

**Watch for thin single-unit outliers skewing `bestSell` or `bestBuy`.** The batch tool takes the literal best price at the given location, which can occasionally be a single-unit, short-duration listing that isn't representative of the durable market (confirmed case: Corpus X-Type Heavy Energy Nosferatu — a 1-unit order dragged the reported margin down to 16% when the real durable price, 7 units on a deep order, gave 33.5%; see `failure-cases.md`). If a margin looks surprisingly off despite decent order counts, spot-check with `get_region_orders` before trusting it.

## Fee numbers drift — verify via get_station_fees

The fee figures above are pinned in `~/.eve-sde/config.json` (`stationFees` + `salesTaxPct`) and surfaced by the `get_station_fees` tool — that config is the source of truth for the ledger's fee matching, and the same numbers feed every margin computed here. If the fee profile or either location ever changes, this file, the A4E tier URLs' `buyFee`/`sellFee`/`salesTax` params (see `workflow-new-candidates.md`), and the config all need updating together — they silently drift out of sync otherwise. When in doubt, read the current numbers with `get_station_fees` before quoting a margin.
