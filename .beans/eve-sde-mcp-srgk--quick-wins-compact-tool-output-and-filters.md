---
# eve-sde-mcp-srgk
title: 'Quick wins: compact tool output and filters'
status: in-progress
type: task
priority: high
tags:
    - trading
    - performance
created_at: 2026-10-05T07:57:25Z
updated_at: 2026-10-05T22:02:21Z
parent: eve-sde-mcp-3x8x
---

Every tool result is re-read on every later turn, so shrinking results pays back repeatedly. These changes are low-risk and help all workflows.

## Changes
- [x] `jsonResult` (src/utils.ts): compact JSON instead of indent 2 (-28% on a 292-record sample). Check no test or skill text depends on the pretty format.
- [x] Drop null fields from get_portfolio_margins items (a Perimeter call returns bestSell/spread/margin/profitPerUnit as null for every item).
- [x] get_character_assets: location names once in `locations`, not on every row (src/asset-rows.ts)
- [ ] get_character_assets: filters `type_ids` and `location_id`, a `group_by_type` aggregate (type, total quantity, per-location), skip singleton ships/blueprints on request (new parameters)
- [ ] get_order_history: `limit` and a per-type summary mode (count, filled share, last cancel) so one call cannot return 100k chars.
- [ ] get_region_orders: compact rows (price, remain/total, location code, range, age in hours), `top_n` parameter, and depth sums (units within 1/3/5% of the best price on each side).
- [ ] Batch name to type_id resolver (`resolve_types`, array of names) to replace one-at-a-time search_types (249 calls in the measured session).
- [ ] get_market_history: optional compact summary (avg/high/low/volume per day as columns).
- [x] Tests for the compaction changes (tests/margins.test.ts, tests/asset-rows.test.ts, jsonResult in tests/unit/utils.test.ts); eval fixtures margins_*.json and assets.json updated to the new shapes
- [ ] Tests for each remaining item, and update the eval mocks if a mocked tool's shape changes

## Acceptance
Re-measure the sample call sizes (assets, orders, region orders, order history) and record before/after in the epic.



## Progress 2026-10-06 (branch eve-trading-quick-wins-output)
Done: the items that change output size without adding behaviour or parameters.
- jsonResult is compact JSON (84 call sites, one helper).
- get_portfolio_margins omits null fields (computeMarginRow / compactMarginRow in src/margins.ts; the sort key still uses the nulls).
- get_character_assets rows carry locationId only; names are in `locations` (buildAssetRows in src/asset-rows.ts).
- Tests 296 -> 314, all passing; typecheck clean; five reintroduced regressions each failed a test.

Measured (modelled on real-shaped data): a 41-item Perimeter margins call 10,994 -> 4,935 chars (-55%); a 131-row asset list 39,431 -> 25,524 (-35%); the 292-record order-history sample -28% from compaction alone.

Output shape changes callers may notice: an absent side in a margins item is an absent key (not null); asset rows no longer have `locationName`.

Remaining items each add a parameter or a tool (filters, `limit`/summary, `top_n`/depth, resolve_types, compact history), so they were left for a functional change. Deploying the server (`npm run deploy`) is needed before a running session sees the new output.
