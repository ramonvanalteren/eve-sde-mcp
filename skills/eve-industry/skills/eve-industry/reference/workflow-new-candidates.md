# New Candidate Selection — discovering and evaluating the next production line / BPO

Trigger: "what should I build", "is X worth producing", a BPO acquisition question, capital looking for a production home, or open-ended candidate hunting. Runs build-margin verification first; this file is everything around it.

## Step 0 — Discovery (when no candidate is in hand)

**Synergy first.** The vertical-integration default: scan the products already flowing through your trade pipeline before scanning the universe. Pull your sell-side trade items (get_character_orders, sell side — or your open sell positions), and run `scan_builds` with `product_type_ids` = that list. Items you already sell carry book knowledge, a listing pipeline, and repricing habits.

**Then the general scan.** `scan_builds` by category (module is the vertical-integration default product class):

- **Only market-obtainable BPOs are scanned** — the SDE contains unobtainable artifact "blueprints" (faction items) with fantasy margins; the scanner excludes them by requiring the blueprint itself to be a market item. T2 is excluded too (invention-only, a later extension).
- **Read the output by VERIFIED margin, never screen margin.** The screen stage uses ESI adjusted prices — blended, system-wide, coarse. The founding scan watched a screen +80,464% candidate live-verify at **−35.3%** (adjusted prices wildly mislead on salvage-input, low-volume items). Screen margin ranks candidates; live margin decides.
- **Liquidity gate on `avgDailyVolume`**: your batch output must clear in days — prefer candidates trading ≥ several× your intended batch volume per day. The founding scan's best verified shape: +55.9% live, 64 sell orders deep, 1,730 units/day — liquid enough to scale; a +10,000% margin at 2 sell orders and 40/day is a curiosity, not a line.
- **`costShare` flags input concentration** — the input-price risk check below starts here.
- Scan margins are materials-only with no installation cost — a scan shortlist is a shortlist, not a verdict.

Finalists from the scan enter the full evaluation sequence below (price_build with the in-client installation cost, skill checks, BPO amortization).

## The evaluation sequence

1. **Margin** — `price_build` the product at the intended batch size, ME 0 (unresearched BPO basis) and, if researching first is plausible, also at ME 10. Threshold on the sell basis; the buy basis is upside context.
2. **Liquidity** — the product must clear your output in days, not weeks:
   - Product sell-order depth at your sell station (price_build reports it; get_region_orders shows the full stack).
   - Daily traded volume (get_market_history — 30-day average; prefer ≥ several× your batch volume per day).
   - Batch size caps: thin books (≤5-6 sell orders) or thin volume mean small batches or pass.
3. **BPO amortization** — a BPO is a capital asset: fold its cost into the line's economics explicitly. `BPO cost ÷ expected units over the line's life` is a per-unit surcharge until paid back; state the payback batch count ("at 1.4M per batch, a 9.4M BPO pays back in 7 batches"). A healthy margin that never amortizes the BPO is a bad investment; a thin margin on a cheap BPO with heavy volume can still win.
   - **Payback ceiling: 1-2 batches at the sized batch quantity.** A BPO that needs 3+ full batches to amortize carries real exposure across multiple margin-verification cycles before it's ever proven out — flag this plainly as a caution in the verdict, don't bury it in the payback-batch-count line. Prefer a cheaper BPO, or a smaller probe batch on an expensive one, over committing capital across several batches just to break even.
   - **Compute payback on first-batch ROI, not gross profit vs. BPO price.** `(batch profit − BPO cost) ÷ total capital deployed (materials + installation + BPO)` — not "does batch profit exceed the BPO cost." The gross comparison flatters expensive BPOs: a candidate can show batch profit comfortably above the BPO price and still return under 1% on the capital actually deployed for that first batch, because the BPO consumes most of the margin. (Real case: Valkyrie I, 400-run batch — 1.72M profit vs. a 1.61M BPO looked like clean payback at a glance; first-batch ROI on the 14.1M actually deployed was 0.76%. Still a reasonable buy given steady-state ROI (13.7%, BPO sunk after batch one) and the best liquidity of anything scanned that day — but the verdict should say the first batch is close to break-even, not imply it, so the payback ceiling above judges what it's actually measuring.)
4. **Facility + index** — check the build system's cost indices (get_industry_cost_indices) before committing large batches: the installation cost is index-driven and varies by system and activity; on a thin-margin line the index IS the margin. Structure bonuses (rigs, tax) are in-game data the SDE cannot verify — see the knowledge reference.
5. **Pipeline synergy** — prefer products already flowing through the trade operation:
   - Products you already sell: existing book knowledge, sell pipeline, and repricing habits.
   - Materials you already source: existing buy patterns and haul routes.
   - The vertical-integration default is a genuine edge (the founding operation's healthy lines were exactly its traded modules) — leave it only for a candidate with clearly better standalone economics.

## Sizing the first batch

Conservative: small enough that the output clears in a few days at the observed daily volume (rule of thumb from the trading skill: ≤15-25% of daily traded count). A first batch is a probe — it buys information about fill patterns, index reality, and output listing friction at that specific station. Scale after two or three healthy cycles.

## Input-price risk (the concentrated-material check)

Scan price_build's material table for concentration: when one input is >50% of cost (the founding audit's PI-component rig line: one input was 68%), the line's margin is really a bet on that input's price. Options: buy the input's volume forward when cheap (capital + price risk trade-off — the production twin of the trading skill's inventory-risk rule), or size the line small. A concentrated input also means input-price moves can flip the line — re-verify more often than usual.

## Research-first vs build-now

For a candidate that's marginal at ME 0 but healthy at ME 10: research cost + research slot-time vs the savings across the expected batch volume. The knowledge reference covers ME/TE valuation; the short version — ME research pays on high-volume lines, TE pays on slot-constrained operations. Don't research a BPO for a line that hasn't proven itself at ME 0 economics... unless ME 10 is what makes it clear the threshold, in which case the research cost is part of the BPO amortization (step 3).

## Anti-patterns

- **Verifying one line and assuming the class** — "modules are profitable" is not a margin; every product verifies on its own numbers.
- **BPO-collection drift** — acquiring BPOs because they're cheap and blueprints are fun (the founding operation's BPO folder included a 9.4M hull BPO with no production plan behind it at audit time). A BPO without a candidate evaluation is inventory, not capability. State the plan or the payback for every BPO acquisition.
- **Sunk-cost relisting** — covered by the hub's rule 5; the review workflow catches it at the line level, this workflow catches it at the acquisition level.
- **Expensive BPO, thin payback margin of safety** — a BPO priced such that amortizing it takes more than 1-2 batches at the sized batch quantity. Compare batches, not ISK-vs-ISK: if two batches of runs don't clear the BPO cost, the line is carrying multi-cycle capital risk before it's proven itself even once. Cheap BPOs (the common case — most T1 originals are NPC-seeded at low six figures) rarely trigger this; it's the expensive market-listed BPOs (millions to tens of millions) worth checking explicitly before buying.
