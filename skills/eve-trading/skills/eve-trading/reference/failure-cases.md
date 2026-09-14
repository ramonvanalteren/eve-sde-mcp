# Failure cases — the confirmed mistakes behind this skill's rules

Every rule in this skill that looks unusually specific exists because a real mistake was made. When a rule feels arbitrary, or a user disputes one, read the story behind it here before relaxing anything.

## Contents
- [Sell-only items reported as buy-side verdicts (twice)](#sell-only-items-reported-as-buy-side-verdicts-twice)
- [Full-history cost blend on partially-sold positions (Badger)](#full-history-cost-blend-on-partially-sold-positions-badger)
- [Held units counted from the sell order only (Federation Navy plates)](#held-units-counted-from-the-sell-order-only-federation-navy-plates)
- [Thin single-unit outlier dragged a margin (Corpus X-Type Nosferatu)](#thin-single-unit-outlier-dragged-a-margin-corpus-x-type-nosferatu)
- [Stale single-unit bestBuy / missed range-1 competitor (Medium Disintegrator)](#stale-single-unit-bestbuy--missed-range-1-competitor-medium-disintegrator)
- [Margins collapsed within a single session](#margins-collapsed-within-a-single-session)
- [Stale cached ESI read mistaken for a real market move (Valkyrie I)](#stale-cached-esi-read-mistaken-for-a-real-market-move-valkyrie-i)
- [Missing Units column in sizing tables](#missing-units-column-in-sizing-tables)
- [Pipeline cycles run longer than a week (Shadow Serpentis)](#pipeline-cycles-run-longer-than-a-week-shadow-serpentis)
- [Skill file reversion and missing scripts](#skill-file-reversion-and-missing-scripts)

## Sell-only items reported as buy-side verdicts (twice)

*Rule it motivates: confirm `isBuyOrder: true` and an `escrow` field before citing any margin as a buy-side position check — every time, not just full workflow passes.*

- **Round 1**: Badger, Centii A-Type Thermal Coating, and Dark Blood Explosive Armor Hardener were all reported as buy-side kill candidates with fabricated "escrow freed" figures — when every listed order for all three was actually a sell order.
- **Round 2 (same mistake recurring)**: a repriced True Sansha Reactor Control Unit order was treated as a fixed buy-side position and re-checked via `get_portfolio_margins`, when both listings were sell orders (no `isBuyOrder` field, no `escrow` field) — there was no buy order at all.

## Full-history cost blend on partially-sold positions (Badger)

*Rule it motivates: bounded weighted average over the most recent lots covering current holdings — never a full-history blend (Workflow 3, step 3).*

Badger: 73 units ever bought across a wide price range (705,600 to 1,631,000), but only 35 currently held. A full-history blend gave 1,043,260/unit (implying a -9.4% underwater position), while the correct bounded calculation — the 35 held units were covered entirely by the most recent 705,600 lot — gave 705,600/unit (+33.9%, genuinely profitable). A verdict-flipping difference. The bounded method assumes oldest-sold-first (FIFO), which matched the actually observed pattern: the older, pricier lots had already cleared in earlier sessions.

## Held units counted from the sell order only (Federation Navy plates)

*Rule it motivates: held units = sell-order `volumeRemain` + any unlisted hangar stock (Workflow 3, step 2; Workflow 4).*

Federation Navy 200mm Steel Plates was reported with held=1 (the sell order only) when inventory risk had already found 2 more unlisted units in the hangar. The per-unit margin was still right, but the total exposure/profit figure was understated by 3x.

## Thin single-unit outlier dragged a margin (Corpus X-Type Nosferatu)

*Rule it motivates: spot-check surprising margins with `get_region_orders` before trusting them (margin-verification.md, "Thin single-unit outliers").*

Corpus X-Type Heavy Energy Nosferatu: a 1-unit sell order dragged the reported margin down to 16%, when the real durable price — 7 units on a deep order — gave 33.5%.

## Stale single-unit bestBuy / missed range-1 competitor (Medium Disintegrator)

*Rule it motivates: the jump-range competition check in margin-verification.md.*

Medium Disintegrator Specialization was recommended off a stale single-unit `bestBuy`, while the real demand sat at a Perimeter structure with 1-jump range at a meaningfully higher price. A Jita-4-4-only order built on the stale figure would essentially never fill. (Recorded before the Perimeter move; the mechanism is the same now, just pointed the other way — the trader's own range-1 order is the one a Jita station-range order can outbid.)

## Margins collapsed within a single session

*Rule it motivates: margins are point-in-time — re-verify before execution, not just before recommending (SKILL.md).*

Two candidates verified live at 73.4% and 68.4% margin dropped to 27.4% and 6.0% respectively within the same session, purely from fresh competing orders (a 26% sell-side drop on one, a 35-unit dump crashing the other 37%). Normal market behavior, not a tool error — verified margin is a snapshot, not a guarantee.

## Stale cached ESI read mistaken for a real market move (Valkyrie I)

*Rule it motivates: the ESI cache-window table in margin-verification.md — a repeated, byte-identical result across calls is the tell that you're reading a cache, not the live book.*

`get_region_orders` reported a fresh 25-unit sell order on Valkyrie I dropping the best price ~20% (37,290 → 29,610 ISK), turning a verified +13.7% margin negative. Two consecutive calls, made minutes apart, returned the identical order ID, issue timestamp, and volume — the tell that should have been caught immediately but wasn't until the user, physically standing in the Jita station, reported seeing no such order and a lowest sell still at 37,290. The read was a stale cache (region market orders cache for up to 300s/5min), not a real undercut. Recorded in the industry skill's build-margin-verification.md since that's where it happened, but the mechanism (`get_region_orders`) is shared with this skill's own margin verification — the same failure mode applies here.

## Missing Units column in sizing tables

*Rule it motivates: the required table template and `scripts/size_positions.py` (SKILL.md, sizing rule).*

Sizing tables were produced with the unit count folded into the cost figure instead of a visible separate Units column — repeatedly. `size_positions.py` exists to make the compliant format the default.

## Pipeline cycles run longer than a week (Shadow Serpentis)

*Rule it motivates: the ~14-day fill-activity lookback in Workflow 5 (workflow-portfolio-review.md).*

The Shadow Serpentis Explosive Armor Hardener experiment took well over a week end-to-end (buy → fill → list → sell). The old 5-7 day zero-fill kill window was too short to distinguish "slow but working" from "dead" — hence the widened window that still serves the kill signal.

## Skill file reversion and missing scripts

*Rule it motivates: the version canary in SKILL.md.*

This file has previously reverted to an earlier saved version between sessions (content frozen at initial-creation timestamp despite many later in-session edits), and the `scripts/` subfolder has separately gone missing at least once even when SKILL.md itself was intact. The skill is now version-controlled in the eve-sde-mcp repository — if anything looks truncated or stale, restore from git history rather than silently working from a broken copy.
