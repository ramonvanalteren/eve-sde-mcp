# Failure cases — the confirmed mistakes behind this skill's rules

Every rule in this skill that looks unusually specific exists because a real mistake was made. When a rule feels arbitrary, or a user disputes one, read the story behind it here before relaxing anything.

## Contents
- [Sell-only items reported as buy-side verdicts (twice)](#sell-only-items-reported-as-buy-side-verdicts-twice)
- [Full-history cost blend on partially-sold positions (Badger)](#full-history-cost-blend-on-partially-sold-positions-badger)
- [Held units counted from the sell order only (Federation Navy plates)](#held-units-counted-from-the-sell-order-only-federation-navy-plates)
- [Thin single-unit outlier dragged a margin (Corpus X-Type Nosferatu)](#thin-single-unit-outlier-dragged-a-margin-corpus-x-type-nosferatu)
- [Stale single-unit bestBuy / missed range-1 competitor (Medium Disintegrator)](#stale-single-unit-bestbuy--missed-range-1-competitor-medium-disintegrator)
- [Margins collapsed within a single session](#margins-collapsed-within-a-single-session)
- [Missing Units column in sizing tables](#missing-units-column-in-sizing-tables)
- [Pipeline cycles run longer than a week (Shadow Serpentis)](#pipeline-cycles-run-longer-than-a-week-shadow-serpentis)
- [Skill file reversion and missing scripts](#skill-file-reversion-and-missing-scripts)
- [Accidental default-price order crashed a margin (75mm Prototype Gauss Gun)](#accidental-default-price-order-crashed-a-margin-75mm-prototype-gauss-gun)
- [`issued` timestamp mistaken for position age (Coreli A-Type Thermal Coating)](#issued-timestamp-mistaken-for-position-age-coreli-a-type-thermal-coating)
- [Increase recommended without checking existing order capacity (Graviton Physics, Mechanical Engineering)](#increase-recommended-without-checking-existing-order-capacity-graviton-physics-mechanical-engineering)
- [Weekly seasonality not accounted for in fill-velocity reads](#weekly-seasonality-not-accounted-for-in-fill-velocity-reads)

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

## Missing Units column in sizing tables

*Rule it motivates: the required table template and `scripts/size_positions.py` (SKILL.md, sizing rule).*

Sizing tables were produced with the unit count folded into the cost figure instead of a visible separate Units column — repeatedly. `size_positions.py` exists to make the compliant format the default.

## Pipeline cycles run longer than a week (Shadow Serpentis)

*Rule it motivates: the ~14-day fill-activity lookback in Workflow 5 (workflow-portfolio-review.md).*

The Shadow Serpentis Explosive Armor Hardener experiment took well over a week end-to-end (buy → fill → list → sell). The old 5-7 day zero-fill kill window was too short to distinguish "slow but working" from "dead" — hence the widened window that still serves the kill signal.

## Skill file reversion and missing scripts

*Rule it motivates: the version canary in SKILL.md.*

This file has previously reverted to an earlier saved version between sessions (content frozen at initial-creation timestamp despite many later in-session edits), and the `scripts/` subfolder has separately gone missing at least once even when SKILL.md itself was intact. The skill is now version-controlled in the eve-sde-mcp repository — if anything looks truncated or stale, restore from git history rather than silently working from a broken copy.

## Accidental default-price order crashed a margin (75mm Prototype Gauss Gun)

*Rule it motivates: a sudden margin collapse gets the same spot-check as a suspiciously high one (margin-verification.md, "Thin single-unit outliers").*

A position verified at +43% collapsed to -5.4% within about an hour (bestBuy 656,200 / bestSell 656,300 — sell landing one tick over the opposing best) and was reported as a Kill without a spot-check, on the assumption the market had genuinely moved against it. The real cause: a single order submitted at the EVE client's pre-filled default price ("+1 over the current best opposing order") without being adjusted — a misclick, not competition. `get_region_orders` at the time would have shown it as a lone order sitting right at that signature price; by the next check it was gone and the position had recovered to +43.8%. A dramatic, fast swing is itself grounds for a spot-check — "surprising" isn't only "surprisingly good."

## Increase recommended without checking existing order capacity (Graviton Physics, Mechanical Engineering)

*Rule it motivates: check the existing order's remaining volume against its real fill velocity before recommending Increase (Workflow 2, Increase bullet) — a strong track record is necessary but not sufficient.*

Both items were recommended as Increase candidates on the strength of a long, proven fill history and healthy margin. Neither check considered that the *currently open* order already had most of its volume unfilled: Mechanical Engineering sat at 13/15 (87%) with a ~1.1-2.3 units/day pace (6-12 days of queued runway); Graviton Physics sat at 24/30 (80%) with a lumpy, unpredictable pace including a 13-day zero-fill stretch. In both cases the existing order already had ample capacity to keep converting — a second order would have parked fresh escrow behind capital that hadn't converted yet, with no capital-efficiency benefit. "This item converts well over time" answers whether to hold a position at all, not whether the specific open order needs more capital today.

## Weekly seasonality not accounted for in fill-velocity reads

*Rule it motivates: note the day(s) of week a fill-velocity or zero-fill read spans, and don't generalize a single weekday's window (Workflow 2, weekly seasonality note).*

A 13-day zero-fill gap on Graviton Physics (Sun 08-23 → Fri 09-04) was read as evidence real demand had dried up, and a same-day velocity estimate used to judge order runway was taken from a Tuesday. Neither accounted for EVE Online's confirmed weekly concurrency cycle — peak player population lands every week on Sunday around 1900 UTC, with weekends running substantially above weekdays (source: Imperium News Network login-number reporting, citing CCP-visible PCU data; https://imperium.news/eve-waiting-look-login-numbers/). The gap in question started and ended near weekends, and the fill bursts in the same item's history clustered on Saturdays/Sundays — suggestive of the same pattern, though this skill has no confirmed data quantifying how strongly the population cycle actually moves Jita/Perimeter trade volume specifically. Until that's measured, treat it as a real but unquantified confound on any read taken from a short or single-weekday window, not as a correction factor to apply numerically.

## `issued` timestamp mistaken for position age (Coreli A-Type Thermal Coating)

*Rule it motivates: don't use the current order's `issued` timestamp as position age — corroborate with `get_wallet_transactions` (Workflow 2's Kill note; Workflow 5, "Order age").*

26 of 30 open buy orders showed an `issued` timestamp from the same day, and this was reported as "almost the entire buy book is the aftermath of today's capital deployment." Wrong: Coreli A-Type Thermal Coating alone had wallet fills back to 2026-08-15 (48 transactions) and three prior *cancelled* orders in `get_order_history` (07-31, 09-04, 09-11) — a month-old, continuously-converting position that had simply been repriced that day, like several others in the same batch. `issued` resets on every relist because EVE's order modification cancels and recreates the order (new `order_id`, fresh timestamp) rather than editing price in place — it cannot distinguish "opened five minutes ago" from "open for a month, repriced five minutes ago" without checking fill history first.
