# Capital allocation — combined ranking and full-deployment mode

## Contents
- [Combined capital allocation — default final step after new candidates + a portfolio review](#combined-capital-allocation--default-final-step-after-new-candidates--a-portfolio-review)
- [Full-deployment mode — when the user wants most of the wallet actively invested](#full-deployment-mode--when-the-user-wants-most-of-the-wallet-actively-invested)

## Combined capital allocation — default final step after new candidates + a portfolio review

Run this automatically at the end of any session that touches both new-candidate selection and a portfolio review (i.e. new candidates plus existing-position triage) — don't wait for the user to ask for prioritization separately. If only one side ran (e.g. just a candidate scan with no portfolio pulled), skip this step, since there's nothing to combine yet.

Don't just carry forward whatever was already labeled Increase or New candidate — that under-counts good options.

1. Pull **all** the pools into one list: Kill-freed capital (informational only, not a spend target), Increase-tagged existing positions, Hold-tagged existing positions, and New candidates.
2. Re-scan the **Hold** bucket specifically — some Hold items will have margin and liquidity as good as or better than items already tagged Increase or New. Don't assume "Hold" means "closed to more capital." Pull them into the ranking too if they'd rank competitively.
3. Rank the combined pool by margin (adjusted for liquidity confidence — deprioritize thin-book items even if margin is high, per the phantom/thin-liquidity cautions in [margin-verification.md](margin-verification.md) — and, per Workflow 5 in [workflow-portfolio-review.md](workflow-portfolio-review.md), deprioritize slow-cycling items even at a strong margin if faster capital rotation is available elsewhere).
4. Refresh wallet balance immediately before doing the fill (per the sizing rule in SKILL.md), then greedily fill the ranked list against that balance, respecting per-item liquidity caps, until the budget is spent down to a sensible buffer.
5. **Default buffer target: ~10% of total available capital, or ~300M ISK on a portfolio around the 3B scale — whichever the user has most recently specified.** This is more aggressive than earlier defaults; ask if unspecified and the portfolio scale has changed materially, but don't default back to a much larger (e.g. 40%+) buffer without a reason tied to genuine liquidity risk (several thin-book positions in the mix, market volatility just observed, etc.) — state that reason explicitly if applying a bigger buffer than the target.
6. Show the running total after each item so the user can see exactly where the cutoff falls, and call out what got excluded and why (didn't fit budget vs. deprioritized for thin liquidity).

## Full-deployment mode — when the user wants most of the wallet actively invested

Trigger: the user says something like "invest this back into the market" / "don't want it sitting dormant" / explicitly asks to deploy most or all of the wallet, as opposed to the default conservative buffer-preserving mode.

1. Ask (via clarifying question) how many new slots the user is comfortable with if it isn't already stated — full deployment usually requires far more positions than a normal "a few candidates" review, because per-item liquidity caps mean any single item can only absorb a limited slice of a large wallet without oversaturating.
2. Scan a wider net of A4E candidates than usual (10+ verified live, across all three saved tier URLs — see [workflow-new-candidates.md](workflow-new-candidates.md)) to have enough slots to spread capital across.
3. Scale unit counts per candidate up from the normal conservative default, but keep the same liquidity-based ceiling logic — deep-book items (both sides showing 20+ orders) can take meaningfully larger sizes; thin-book items stay capped small regardless of how much capital is left to deploy. Don't inflate a thin position just because there's budget room.
4. Target buffer in this mode: same as the default combined-allocation target above (~10% / ~300M) unless the user specifies otherwise — the point of this mode is to get *most* of it working, not to default back to an oversized buffer.
