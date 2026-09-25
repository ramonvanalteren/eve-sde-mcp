---
name: eve-industry
description: "Use this skill for EVE industry: verifying build margins before committing manufacturing runs (price_build — materials at live prices + installation vs product sell), reviewing active production jobs against live margins, selecting new BPO candidates (scan_builds screens every obtainable T1 BPO and live-verifies), and industry knowledge (ME/TE, facilities, cost indices, invention). Trigger on industry, manufacturing, blueprint, BPO, build cost, build margin, 'what should I build', or production review questions. Never commit runs on an unverified margin — the founding case was a 400-run job at +0.9% discovered only by post-hoc audit. Production is bill-of-materials linked in the daily close (materials consumed at delivery, product lots at all-in basis) — read production P&L from the close's production section and per-position realized numbers."
---

# EVE Industry Skill — Build-Margin Discipline

## Scope

This skill covers four workflows for a production operation that feeds an existing station-trading pipeline (vertical integration: products sold through the same sell station, materials sourced through the same buy patterns):

1. **Build-margin verification** (always first) — price a job BEFORE committing runs: `price_build` with materials at live prices, ME-adjusted, plus installation cost, against the product's net sell. The industry twin of the eve-trading skill's margin-verification rule.
2. **Production review** — re-verify every active manufacturing job (from `get_industry_jobs`) against live margins; keep / don't-relist / scale decisions, plus slot economics.
3. **New candidate selection** — including DISCOVERY when no candidate is in hand: `scan_builds` screens every market-obtainable T1 BPO in a category (or a specific product list) with bulk adjusted prices, then live-verifies the top candidates at a station with full order-book margins and 30-day traded volume. The closed SDE blueprint universe makes industry discovery self-sufficient — **no external tier feeds (A4E-style) are needed**, unlike trading discovery. Then: margin, liquidity, BPO amortization, index, and pipeline synergy.
4. **Industry knowledge** — ME/TE, facility types and rig bonuses, system cost indices, invention, and what the tools can and cannot verify.

**Explicitly out of scope:** the daily-close ledger as production P&L (see below), and live repricing of product sell orders (that's the trading skill's repricing exclusion — in-client).

## The founding failure case (why this skill exists)

A live T1 module production line, audited 2026-09: **5 of 6 lines healthy** (+13% to +68% margin, the best turning 1.75M ISK per job-day) — but one line, a **400-run Damage Control I job, was committed at +0.9% margin**: ~53k ISK profit for 2.5 days of a manufacturing slot. Nothing was catastrophically wrong — one dead line slipped in because nothing verified the margin before the runs were scheduled. That is precisely the class of error the eve-trading skill's margin-verification rules were written to prevent, reproduced on the production side. Every rule below exists because of that audit.

**Quantified at founding:** ~48M ISK of production capital (minerals, PI components, BPOs) plus ~60M of skill books sit in the ledger as positions that can never close.

## The ledger and production — how BOM linkage works

The daily close carries bill-of-materials linkage: when a manufacturing job is **DELIVERED**, its ME-adjusted materials are consumed from open FIFO buy lots (oldest-first), and a synthetic **product lot** is created at all-in unit basis (matched material cost + installation / units). Product sells then match that lot like any other — realized P&L on produced items is real, and the close reports a **production section** (units produced, material cost, installation, unit basis, missing-basis flags).

Rules and caveats:
- **ME is auto-resolved per job**: the job's own blueprint (by item id) is looked up in the character's synced ESI blueprints — the exact BPO's current ME. Fallbacks: config `blueprintME` (type-keyed) then ME 0 (base quantities, conservative). The blueprints scope (`esi-characters.read_blueprints.v1`) is in the default login set — re-auth once if the data predates it. Caveat: the synced ME is the BPO's CURRENT level; a job installed before mid-stream research completed is slightly overstated in efficiency.
- **Jobs count at DELIVERY.** Output sitting undelivered in the facility is unaccounted — deliver jobs for the close to see them.
- **Materials without buy-lot basis** (mined, refined, PI-sourced, pre-ledger buys) consume at cost 0 and are flagged in the close — basis understated, never guessed.
- **Research jobs** (ME/TE/copying) are not capitalized into the BPO — their installation cost stays journal cashflow; value them with the skill's research-payback framing, not the ledger.
- **BPOs still sit as open positions** at their purchase cost — capital assets, not inventory awaiting sale; the new-candidates workflow's amortization framing handles them.

FIFO basis can differ from the blend a price_build verification used — the close consumes your *oldest* lots first (the founding dead line verified at +0.9% blended, but realized −16/unit against her actual oldest Mexallon lot). The close is the truth of what a line actually earned; price_build is the truth of whether to commit the next batch.

## Dispatch map — which reference files to read

| Request | Read |
|---|---|
| About to commit runs / any build margin is discussed | [reference/build-margin-verification.md](reference/build-margin-verification.md) — the price_build procedure, both acquisition bases, ME rounding, thin books |
| "Production review" / how are my jobs doing | [reference/workflow-production-review.md](reference/workflow-production-review.md) + build-margin-verification |
| "What should I build" / new BPO / next production line | [reference/workflow-new-candidates.md](reference/workflow-new-candidates.md) + build-margin-verification — includes the discovery step (scan_builds) |
| ME/TE, facilities, rig bonuses, cost indices, invention, research jobs | [reference/industry-knowledge.md](reference/industry-knowledge.md) |

References are one level deep: read exactly what the table says for the current request.

## Mandatory rules

1. **No runs are committed on an unverified margin.** `price_build` first (or documented hand-math with the same two-sided discipline if tools are unavailable). The margin that matters is the **sell basis** — materials at their best sell orders (instant acquisition), product net of sales tax and broker fee. The buy basis (materials via patient buy orders) is reported alongside as the upside case; a candidate must clear threshold on the sell basis.
2. **Margins are point-in-time.** Re-verify before executing, and again if execution is delayed — the founding trading skill watched verified 73% margins collapse to 27% within a single session. Production adds lag: a job runs for hours-to-days before the product lists, so the margin you verified is the market's past, not its future. Prefer liquid, thick-booked products where single orders can't move the price.
3. **Thin books cap your volume.** Under ~5-6 sell orders on the product, the top-of-book price will not hold for your production volume — price_build warns on this; respect it by cutting the run count or skipping the candidate.
4. **Installation cost is part of the margin.** price_build estimates it by default from live cost indices when you don't pass the in-client number (`installationSource`/`installationEstimate` in the report show which); the estimate doesn't account for structure rig bonuses, so pass the real number when you have it, especially near a margin threshold.
5. **Sunk materials never justify a marginal line.** "I already own the Tritanium" is not a margin argument — the decision basis is replacement cost (what the minerals would sell/be worth today), not what was paid. Let committed runs finish (materials are sunk), sell the output at any positive net, but don't relist the line without a fresh verification clearing the threshold.
6. **Slot economics accompany every verdict.** A line's value is profit per job-duration, not per run — the founding audit's dead line was 53k per 2.5 days while another line made 1.75M per day in the same facility. Report both the margin and the profit-per-slot-time when recommending keep/kill/scale.

## Notes

- Materials you already hold carry real acquisition costs in the ledger's open lots (the audit found e.g. minerals bought above and below current market). That history is context for P&L questions, never the decision basis (rule 5).
- Prefer candidates that already flow through your trade pipeline (products you already sell, materials you already buy) — the vertical-integration default. The knowledge reference covers when to leave that comfort zone.
- **Version canary.** This skill is version-controlled in the eve-sde-mcp repository. If a review shows it missing the dispatch map, the mandatory rules, or the ledger-blindness section, say so plainly before proceeding rather than working from a stale version — restore from git history.
