---
# eve-sde-mcp-q6cg
title: 'get_a4e_candidates: parse the saved A4E tiers server-side'
status: todo
type: feature
priority: high
tags:
    - trading
    - performance
created_at: 2026-10-05T07:57:25Z
updated_at: 2026-10-05T07:57:25Z
parent: eve-sde-mcp-3x8x
---

WebFetch on the saved A4E tier URLs takes ~25 s per fetch and its small model misread the trades/day column (Fuel Catalyst reported 14.5 instead of the real 57), which silently breaks unit sizing. Parse the raw HTML on the server instead.

## Design
Tool `get_a4e_candidates(tiers?, exclude_held?)`. Fetch the three saved tier URLs (kept in config / one place), parse the table **by header name** (the real column is "Avg. trades"; money columns use '.' thousands and ',' decimals), cache ~15 min.

## Checklist
- [ ] Parse by header names and fail loudly (clear error) if an expected header is missing or moves.
- [ ] Return per row: name, type_id (via SDE name map), tier, A4E buy/sell, A4E margin, trades/day, ISK/day, and the margin recomputed with the fee profile from config.
- [ ] Validate the URLs' buyFee/sellFee/salesTax against ~/.eve-sde/config.json and warn on mismatch (absorbs eve-sde-mcp-rd1l; close that bean when this lands). Note config has Jita 4-4 at 1.491 while the URLs use 1.5.
- [ ] `exclude_held`: mark rows already in open orders or hangar.
- [ ] Rank by yield (nm x trades/day) as a convenience column; the strategy parameter stays in the skill.
- [ ] Tests against a saved HTML fixture, including a header-change case.
- [ ] Skill: Workflow 1 step 1 uses the tool instead of WebFetch.

## Acceptance
Three tier fetches in a few seconds in one call; type IDs resolved; trades/day matches the A4E page.
