---
# eve-sde-mcp-o75m
title: 'verify_candidates: one-call margin, depth and history verification'
status: todo
type: feature
priority: high
tags:
    - trading
    - performance
created_at: 2026-10-05T07:57:25Z
updated_at: 2026-10-05T08:06:57Z
parent: eve-sde-mcp-3x8x
blocked_by:
    - eve-sde-mcp-srgk
---

Replace the two-call margin procedure, the per-item depth checklist and the history check with one call. In the measured session a proposal round took 64 calls / ~45k tokens; the per-item get_region_orders (15 calls) and get_market_history (13 calls) were the bulk.

## Design
Tool `verify_candidates(type_ids, units?)`. One cached region book per item serves both legs. Fees and locations from ~/.eve-sde/config.json. **Facts and objective flags only; no verdicts** (floors, tiers and cushion stay in the skill).

Per item, return compact:
- Perimeter best bid, Jita best bid, range-valid third-party bids (Jita station any range, others whose range covers the jump distance to Jita via mapSolarSystemJumps); the competitive bid and where it is.
- Jita best ask, a durable ask (price after absorbing `units`, or after skipping asks younger than a threshold), top-of-book depth within 1/3/5%.
- nm at the competitive bid and at the durable ask; bid-to-ask gap.
- Flags: thin top (few units then a gap), stale top asks (age), fresh undercut, single-unit top, bids queued ahead (units at or above the bid), zero-liquidity side.
- History: last 3 and 14 days avg/high/low/volume; **days the bid level traded** (daily low <= bid x 1.02) and **days the ask level traded** (daily high >= ask x 0.98) over the last 3 days; spike indicator (3-day average vs prior average) and falling-volume indicator.
- Own history (authenticated): earlier cancelled buys for the type with fill share, so the repeat-cancel check needs no extra call.

## Checklist
- [ ] Shared market-book helper (reuse across get_portfolio_margins, get_region_orders, this tool).
- [ ] Jump-range logic with tests (station, system, region, numeric ranges).
- [ ] Durable-ask and depth calculations with tests (fixture books).
- [ ] History flags with tests (the Large Ice Compressor / Corpum A Nosferatu cases from 2026-10-04 as fixtures).
- [ ] Cancel history joined from the ledger orders table.
- [ ] Skill: margin-verification.md and the depth checklist point at the tool; delete the prose it replaces; add the "did the level trade" rule.
- [ ] Evals: add mocks for the tool; keep the existing margin traps passing.

## Acceptance
Verifying 16 candidates is one call returning ~10k chars; a margin from the tool matches the hand-computed two-call figure on the 2026-10-04 fixtures.



## 2026-10-05 fixtures from a live run (history flags earned their keep)
Of 13 new A4E rows verified, 10 failed the traded-level history test: Packrat MTU (bid 20.0M, trades 26.6-30M daily), Chaotic Gamma Filament (bid 14.95M, trades 19-22M), Arbalest Heavy Missile Launcher (ask 650k, never traded above 534k), Covert Cyno Field Gen I (pinned 6.8M, ask 7.76M), Unstable Gyrostabilizer Muta. Also held positions: Pithum A Kinetic SA (ask 42.85M, 25-day high 30.5M), Polarized Neutron Blaster (ask 18.8M vs 14.9M), Prototype Arbalest RLML (ask 798k vs 718k). Use these as test fixtures; A4E `buy price` is often a stale low bid.
