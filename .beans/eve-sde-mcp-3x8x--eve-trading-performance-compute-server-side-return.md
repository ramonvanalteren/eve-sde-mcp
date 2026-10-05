---
# eve-sde-mcp-3x8x
title: 'eve-trading performance: compute server-side, return compact results'
status: todo
type: epic
priority: normal
tags:
    - trading
    - performance
created_at: 2026-10-05T07:56:52Z
updated_at: 2026-10-05T07:57:31Z
---

Cut the time and tokens an eve-trading run costs by moving data gathering and arithmetic from the model into the MCP server, and by making every tool result compact. Analysis done 2026-10-05; this epic holds the plan.

## Baseline (measured from one long session transcript, 2026-10-05)
The session also contained fitting, industry and eval work, so the trading share is not isolated; latency is tool_use to tool_result.

- 2,773 tool calls, ~12 MB of results (~3M tokens, re-read every turn).
- Biggest sinks: get_character_assets 75 calls x 30k chars; get_portfolio_margins 285 x 6k; get_character_orders 114 x 15k; get_region_orders 364 x 3.4k; WebFetch (A4E) 121 calls, median 25 s each; get_wallet_transactions 179 calls, median 3 s / p90 11 s, capped at 2,500 entries; get_market_history 139 x 3.8k; search_types 249 single lookups; one unfiltered get_order_history = 100k chars.
- One position-proposal round: 64 tool calls, 181k chars (~45k tokens), 10.3 min wall-clock. Dominated by per-item depth checks, history checks and scratch scripts to join the data.
- jsonResult pretty-prints (indent 2). On a 292-record sample: compact JSON is 28% smaller, columnar 64% smaller.
- Already available server-side: ledger.db with 8,292 wallet transactions since 2026-07-18 (no 2,500 cap), SDE jump table (mapSolarSystemJumps), station fees and sales tax in ~/.eve-sde/config.json, one cached region book per item (5 min) that serves both legs of a margin.

## Design principle
**Facts and objective flags in the server; judgement in the skill.** The server computes margins at the competitive bid, depth, age, traded-level evidence and fills. The skill keeps the floors, tiers, cushion, slot discipline and the verdicts. Strategy parameters stay single-sourced in skills/eve-trading/skills/eve-trading/reference/strategy.md; any server-side copy is guarded by a drift test (same repo).

## Order of work
1. Quick wins on tool output (task).
2. get_a4e_candidates (feature) — also fixes WebFetch misreading the trades/day column.
3. verify_candidates (feature) — also adds the "did the bid/ask level actually trade" check the skill lacks.
4. get_portfolio_snapshot from the ledger (feature).
5. size_positions as an MCP tool (task).
6. Skill slimming, call plans, retire prose the tools replace; update evals and mocks (task).

## Targets (estimates, to be re-measured)
- Proposal round: <= ~8 calls, <= ~10k tokens of results, a few minutes.
- Portfolio review: ~10k chars of tool results instead of ~60k.
- Re-measure with the same transcript method after each feature lands and record it in that bean.

## Open decision
Floors and tiers stay in the skill (recommended). Revisit only if the skill needs to stop owning them.

## Checklist
- [ ] Children 1-6 completed
- [ ] Re-measured against the baseline and the result recorded here



## Children
- eve-sde-mcp-srgk quick wins (ready first)
- eve-sde-mcp-q6cg get_a4e_candidates
- eve-sde-mcp-o75m verify_candidates (after srgk)
- eve-sde-mcp-ctcy get_portfolio_snapshot (after srgk)
- eve-sde-mcp-3cs6 size_positions tool (after o75m)
- eve-sde-mcp-v0yo skill slimming and evals (after all of the above)
