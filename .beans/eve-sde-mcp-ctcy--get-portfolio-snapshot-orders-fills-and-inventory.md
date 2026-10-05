---
# eve-sde-mcp-ctcy
title: 'get_portfolio_snapshot: orders, fills and inventory from the ledger'
status: todo
type: feature
priority: normal
tags:
    - trading
    - performance
created_at: 2026-10-05T07:57:25Z
updated_at: 2026-10-05T08:06:57Z
parent: eve-sde-mcp-3x8x
blocked_by:
    - eve-sde-mcp-srgk
---

Workflows 2-5 need orders, fills, assets, cost basis and wallet in one coherent view. Today that is get_character_orders x2 + get_character_assets + get_wallet_transactions (3-11 s, capped at 2,500 entries) + get_open_lots + per-item calls, plus scratch scripts to join them. The local ledger already holds the full history.

## Design
Tool `get_portfolio_snapshot()`. Reads the ledger (sync first) plus live orders; compact output.

## Checklist
- [ ] Open buy orders: price, remain/total, **fills since placement (volumeTotal - volumeRemain)**, fills in the last 3/7/14 days from ledger.db (no ESI cap), last fill time, units/day, runway days, escrow, unit-price tier, location.
- [ ] Open sell orders: same fields plus cost basis from open lots and margin against it.
- [ ] Inventory at trade hubs with no sell order (aggregated by type, with cost basis) for Workflow 4.
- [ ] Totals: wallet, escrow, order counts, tier mix by escrow, share of escrow in orders with no fills.
- [ ] Repriced-order awareness: same order_id with a later `issued` than its first sighting (ledger orders table) is flagged as repriced.
- [ ] Tests on the ledger fixtures used by the existing ledger tests.
- [ ] Skill: portfolio review starts from the snapshot; shrink the data-gathering prose.

## Acceptance
A full review's data gathering is one or two calls, ~10k chars, covering the full ledger history.



## 2026-10-05 finding from a live run
The ledger `orders` table keeps an order's price and `issued` as first sighted; a reprice (same order_id) is NOT written back. Example: Caldari Navy Co-Processor shows 46.71M / issued 09:10 in the ledger against 48.10M / 22:13 live. So the snapshot must take current price, remain and issued from live ESI and use the ledger only for fills and as the first-sighting (true placement) age. The first-sighting issued is a better age signal than ESI `issued`.
