# Capital allocation — combined ranking, full-deployment mode, and kill-and-redeploy

Strategy parameters (sizing band, slot floor, order cap, tier flag, buffer rule) are in [strategy.md](strategy.md); the sizing rules are in SKILL.md.

## Contents
- [Combined capital allocation — default final step after new candidates + a portfolio review](#combined-capital-allocation--default-final-step-after-new-candidates--a-portfolio-review)
- [Full-deployment mode — when the user wants most of the wallet actively invested](#full-deployment-mode--when-the-user-wants-most-of-the-wallet-actively-invested)
- [Kill-and-redeploy mode — cut the weak slots, put the freed capital to work](#kill-and-redeploy-mode--cut-the-weak-slots-put-the-freed-capital-to-work)

## Combined capital allocation — default final step after new candidates + a portfolio review

Run this automatically at the end of any session that touches both new-candidate selection and a portfolio review (i.e. new candidates plus existing-position triage) — don't wait for the user to ask for prioritization separately. If only one side ran (e.g. just a candidate scan with no portfolio pulled), skip this step, since there's nothing to combine yet.

Don't just carry forward whatever was already labeled Increase or New candidate — that under-counts good options.

1. Pull **all** the pools into one list: Kill-freed capital, Increase-tagged existing positions, Hold-tagged existing positions, and New candidates. In this default mode Kill-freed capital is informational only — the user hasn't said the Kills will be executed, so it isn't a spend target. When the user says to assume the Kills are executed (or asks for kill-and-redeploy mode below), it counts as cash.
2. Re-scan the **Hold** bucket specifically — some Hold items will have margin and liquidity as good as or better than items already tagged Increase or New. Don't assume "Hold" means "closed to more capital." Pull them into the ranking too if they'd rank competitively.
3. **Rank the combined pool by M/1M/day** (see SKILL.md, "Rank by M/1M/day"). Margin is a floor test, not the rank key. Adjust for liquidity confidence — deprioritize thin-book items even when the yield looks high, per the phantom/thin-liquidity cautions in [margin-verification.md](margin-verification.md) — and, per Workflow 5 in [workflow-portfolio-review.md](workflow-portfolio-review.md), deprioritize slow-cycling items even at a strong margin if faster capital rotation is available elsewhere.
4. Refresh wallet balance immediately before doing the fill (per the sizing rule in SKILL.md), then greedily fill the ranked list against that balance — sized within the sizing band of daily trades, in clean unit increments, thin items excluded — until the budget is spent down to the buffer. `scripts/size_positions.py` does this walk.
5. **Buffer: the figure the user most recently stated** (250M on 2026-10-02, 400M on 2026-10-04 — they state it in ISK). If none has been stated this session, ask; failing that, use ~10% of total available capital. Don't default back to a much larger (e.g. 40%+) buffer without a reason tied to genuine liquidity risk (several thin-book positions in the mix, volatility just observed) — state that reason explicitly if applying one. A large idle buffer going into a weekend, historically the biggest selling days, has drawn pushback.
6. Show the running total after each item so the user can see exactly where the cutoff falls, call out what got excluded and why (didn't fit budget vs. deprioritized for thin liquidity), and report the open-order count and the T1/T2/T3 escrow mix before and after (SKILL.md, "Slot discipline").

## Full-deployment mode — when the user wants most of the wallet actively invested

Trigger: the user says something like "invest this back into the market" / "don't want it sitting dormant" / explicitly asks to deploy most or all of the wallet, as opposed to the default conservative buffer-preserving mode.

1. Full deployment usually needs more positions than a normal "a few candidates" review, because per-item volume caps mean any single item can only absorb a limited slice of a large wallet. There is no cap on order count — the user has said the comfortable order range ([strategy.md](strategy.md)) is fine — so don't ask about slots unless the plan would go well beyond that range.
2. Scan a wider net of A4E candidates than usual (10+ verified live, across all three saved tier URLs — see [workflow-new-candidates.md](workflow-new-candidates.md)) to have enough slots to spread capital across.
3. Scale unit counts toward the top of the band (up to 50% of daily trades) on deep-book items (both sides showing 20+ orders); thin items stay at the bottom of the band or are excluded under the thin-item rule regardless of how much capital is left. Don't inflate a thin position just because there's budget room — if the caps run out before the cash does, say so and report the leftover.
4. Target buffer in this mode: the user's stated figure, as above — the point of this mode is to get *most* of it working, not to default back to an oversized buffer.

## Kill-and-redeploy mode — cut the weak slots, put the freed capital to work

Trigger: "draft a kill list and redeploy all capital", "assume the kills are executed", "put everything to work, keep ~400M as buffer", or a request to **refresh** such a plan. This is the user's standard way of rebalancing the book; it combines Workflow 2, Workflow 1 and the allocation above into one plan. It only drafts — **nothing is cancelled or placed by this skill**; say so at the end.

1. **Snapshot**: fresh wallet; open buy orders with escrow, order count and the T1/T2/T3 escrow mix; fills per order, with position age corroborated against fill history, not `issued` (Workflow 2).
2. **Cut list, in two labelled parts that are never merged:**
   - **Kills** — Workflow 2's criteria: below the 10% hold floor, volume dried up, or zero fills after the order-age and jump-range diagnosis.
   - **User-directed consolidation** — above the floor but weak slots: zero or one fill, remaining volume that would take more than about a week at the observed pace, units that are a large multiple of daily trades, or a bid sitting far below the ask so sellers never reach it. Say explicitly these are not floor breaches. Escrow comes back in full; the broker fee already paid is not refunded — state that sunk amount.
   - **Watch list** — positions at or just above the floor that are kept, each with the trigger for cutting it ("cut if under 10%") and the cash cutting would add that the volume caps could not absorb.
3. **Pool** = fresh wallet + freed escrow. **Buffer** = the user's stated figure.
4. **Candidates**: Workflow 1 on fresh A4E data for all three tiers, plus existing converters that pass the Workflow 2 runway check for Increase. Verify margins with the two-call procedure, then **depth-check the top rows** with the checklist in workflow-new-candidates.md. List what was excluded after checks, each with its reason.
5. **Size** per SKILL.md with `scripts/size_positions.py`, passing `freed=`, `buffer_target_isk=`, `current_open_orders=` and `current_tier_escrow=` (the last two after the assumed Kills).
6. **If the volume caps run out before the pool does**, stop there. The buffer lands above target; report by how much. Don't inflate positions past the band or add weak candidates to use the cash up.
7. **Present**: the Kill table (Workflow 2 format, with ISK freed), the consolidation and watch lists, the redeploy table (required template, ranked by M/1M/day), the cash math (cash now + freed = pool, deployed, buffer vs target), order count and tier mix before and after, the per-pick cautions, the excluded-after-checks list, and — if asked, or if the order count lands above the comfortable range — the fewer-orders variant. Close with the reminder that margins are point-in-time and the top picks should be re-verified right before placing.

**Plan skeleton and pre-send checklist.** Start from this skeleton, fill every section in order, and run the checklist before sending.

```
Plan — <date, UTC time>        (nothing has been cancelled or placed)
Snapshot: wallet <…> | open buys <n> | buy escrow <…> | tier mix T1 <%> / T2 <%> / T3 <%>

Cut list
  Kills (floor breach / volume dried up / zero fills after diagnosis)   Item | Order price | Units | Live margin | Why | ISK freed
  User-directed consolidation (above the floor, weak slots)             same columns
  Watch list (kept, with the trigger for cutting)                       Item | Escrow | Live margin | Cut if …
Redeploy        Item | Unit price | Units | Cost | Margin | Trades/day | Total profit | M/1M/day | Running   (+ % of day and flags)
Cash math       wallet + freed escrow = pool | deployed | buffer vs the buffer the user stated
Book shape      open orders before → after | tier mix before → after
Per-pick cautions · Excluded after checks (with reasons) · What moved since the last plan (refresh only) · Fewer-orders variant (if asked)
Closing line    margins are point-in-time — re-verify the top picks before placing
```

```
Pre-send checklist:
- [ ] Wallet re-pulled just before building the plan
- [ ] Cut list split into Kills / consolidation / watch list, never merged
- [ ] Freed escrow counted in the pool; buffer = the figure the user stated
- [ ] Fresh A4E data for all three tiers; two-call margins on every row; depth checklist on every row recommended
- [ ] Sizing and ranking done by `scripts/size_positions.py`, not by hand
- [ ] Leftover cash reported if the volume caps ran out first
- [ ] Order count and tier mix reported before and after
- [ ] On a refresh: executed or changed orders dropped and named; "what moved" table; said whether depth checks were repeated
- [ ] Said that nothing has been cancelled or placed
```

**Refreshing a plan** ("refresh this plan against current prices"): re-pull the wallet and open orders first. Anything that has filled or disappeared since the last plan drops off the cut list — say what changed (an order that filled is a conversion, not a kill). Re-run the two-call margins on every cut and every redeploy row and re-run the sizing. Present a short "what moved since the last plan" table (item, before, now), including any row that crossed a floor. State whether the depth checks were repeated; if they weren't, say so and tell the user to re-verify before placing. ESI caches orders, assets and transactions, so a fill can be invisible for several minutes — report what is visible rather than assert where units went.
