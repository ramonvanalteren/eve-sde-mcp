# Build-Margin Verification — the price_build procedure

The rule: **no manufacturing runs are committed on an unverified margin.** This file is the exact procedure.

## The call

`price_build` with:

- `blueprint_type_id` or `product_name` (the manufacturing blueprint that makes it — the tool resolves it)
- `runs` — the batch being considered
- `me_level` — the BPO's actual ME (0 if unresearched); materials scale by (1 − ME/10... per level ×1%)
- `installation_cost` — the total the in-client install dialog shows, if known; omit it to get a live cost-index estimate instead (see `installationEstimate` in the report)
- `region_id` / `location_id` — where materials are bought and the product is sold (default: The Forge / Jita 4-4)
- `sales_tax_pct` / `broker_fee_pct` — your real rates (default 3.6 / 1.0; override with the character's actuals, e.g. 3.4 / 1.49 with max skills and station standing)

## Reading the report

- **`costs.unitCostAtSell`** — the conservative unit cost: every material at its best SELL order (instant acquisition) plus installation, divided by units produced. **This is the number a verdict is made on.**
- **`margins.atSellBasis`** — profit per unit, total, and % against that cost. A candidate must clear the threshold here.
- **`margins.atBuyBasis`** — the same against materials priced at their best BUY orders (acquisition via your own patient buy orders, the standard sourcing pattern for a trading operation). This is the realistic upside, not the basis for the verdict — buy orders don't fill instantly and can be undercut.
- **`materials[]`** — per-material quantities (ME-adjusted), prices, and order counts. Scan for a single material dominating the cost (the founding audit: one PI component was 68% of a rig line's cost — input-price risk concentrates there).
- **`warnings[]`** — missing orders, thin product books, and (when installation cost was estimated rather than provided) the estimate's own breakdown. Each is load-bearing: a missing material sell order makes the sell-basis cost understated; a thin book (≤5-6 sell orders) means your volume will undercut deeply; an estimated install cost ignores structure rig bonuses.

## The ME adjustment (and its honesty note)

Materials scale by ME per **job**, as EVE does: `max(runs, ceil(base × runs × (1 − ME%)))` per material, so `totalQty` in the report is exact for the run count you pass (`qtyPerRunAdjusted` is just `totalQty / runs`). Structure/facility material bonuses are not modelled (the SDE has no facility data) — a bonused structure will need slightly less than the report shows. ME 10 (the T1 practical cap) typically saves ~10% of material cost — meaningful on thin lines, noise on healthy ones; run price_build twice (ME 0 vs ME 10) when deciding whether a research investment is worth it.

## Net proceeds

Product revenue is the best sell order × (1 − sales tax − broker fee) — a sell-side listing pays both. Gross prices are reported alongside; never quote gross as what you'll receive.

## Point-in-time discipline (production's amplified version)

A verified margin is a snapshot. Production amplifies the staleness problem relative to station trading: the job runs for hours-to-days, then the output must clear the book. The trading skill's founding observation (73.4% → 27.4% within one session from fresh competing orders) applies with a delay fuse:

- Re-verify immediately before committing runs.
- If the product's margin moved below threshold between verification and listing, treat the output disposal like the kill case in the production review: sell at whatever net is positive, don't relist the line, re-verify before the next batch.
- Prefer thick, liquid product books where single orders can't move the price — check `sellOrderCount` in the report and the product's daily volume (get_market_history) when sizing runs.
- **But "re-verify" can itself lie — ESI data is cached, not always live.** `get_region_orders`/`price_build`'s pricing caches for up to 300s (5 min, confirmed via ESI's own response headers); `get_character_blueprints`/`get_character_assets`/`get_industry_jobs` cache longer (~1hr or unconfirmed — treat as possibly stale). A repeated, byte-identical order (same ID/timestamp) across calls minutes apart means you're reading a cache, not the live book — trust the user's direct in-client observation over the tool when that happens, don't re-run the same call expecting a different answer inside the cache window.

## The founding audit (reference numbers, 2026-09)

Method: blueprint materials at live Jita prices + installation (from job data) vs product net sell, on the sell basis:

| Line | Runs | Unit cost | Net sell | Margin | Job profit | Verdict |
|---|---|---|---|---|---|---|
| Inertial Stabilizers I | 200 | 13,396 | 22,063 | +64.7% | 1.75M | strongest line |
| Signal Amplifier I | 80 | 19,775 | 33,289 | +68.3% | 1.08M | thin book (16 orders) |
| Co-Processor I | 150 | 32,059 | 41,606 | +29.8% | 1.43M | thin book (14 orders) |
| Small Thermal Armor Reinforcer I | 20 | 265,438 | 331,838 | +25.0% | 1.33M | one PI input = 68% of cost |
| Salvager I | 250 | 44,493 | 50,112 | +12.6% | 1.40M | modest |
| **Damage Control I** | **400** | **7,426** | **7,492** | **+0.9%** | **0.03M** | **dead line — the founding case** |

Five lines healthy, one dead — committed without verification. The same audit, run at the character's actual paid material costs rather than replacement, read +1.8% on the dead line: **sunk-cost pricing hides dead lines; replacement pricing exposes them.** Always decide on replacement (sell-basis) cost.

## Fallback when tools are unavailable

Hand-math with the same discipline: blueprint materials (get_blueprint) × live sell orders (get_region_orders) per material + installation, vs product net sell — and say plainly that it's hand-math. The numbers in the founding audit were hand-computed this way before the tool existed; the tool exists so that never has to happen again.
