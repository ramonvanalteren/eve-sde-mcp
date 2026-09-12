# New Candidate Selection — evaluating the next production line / BPO

Trigger: "what should I build", "is X worth producing", a BPO acquisition question, or capital looking for a production home. Runs build-margin verification first; this file is everything around it.

## The evaluation sequence

1. **Margin** — `price_build` the product at the intended batch size, ME 0 (unresearched BPO basis) and, if researching first is plausible, also at ME 10. Threshold on the sell basis; the buy basis is upside context.
2. **Liquidity** — the product must clear your output in days, not weeks:
   - Product sell-order depth at your sell station (price_build reports it; get_region_orders shows the full stack).
   - Daily traded volume (get_market_history — 30-day average; prefer ≥ several× your batch volume per day).
   - Batch size caps: thin books (≤5-6 sell orders) or thin volume mean small batches or pass.
3. **BPO amortization** — a BPO is a capital asset: fold its cost into the line's economics explicitly. `BPO cost ÷ expected units over the line's life` is a per-unit surcharge until paid back; state the payback batch count ("at 1.4M per batch, a 9.4M BPO pays back in 7 batches"). A healthy margin that never amortizes the BPO is a bad investment; a thin margin on a cheap BPO with heavy volume can still win.
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
