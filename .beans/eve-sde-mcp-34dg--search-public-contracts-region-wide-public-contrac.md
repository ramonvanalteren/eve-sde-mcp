---
# eve-sde-mcp-34dg
title: 'search_public_contracts: region-wide public contract search'
status: completed
type: feature
priority: high
tags:
    - contracts
    - market
created_at: 2026-09-26T07:55:40Z
updated_at: 2026-09-26T11:16:07Z
parent: eve-sde-mcp-vex4
---

New tool: search ESI's public contracts (/contracts/public/{region_id}/) — courier, item_exchange, and auction — filtered by type/location/reward/volume. Born from a real request: pricing a 10-Drake Perimeter->Jita courier contract for a stranger, which needed comparable real market data the server couldn't provide (only get_character_contracts existed, scoped to the authenticated character's own contracts).

Verified live against ESI before building (2026-09-26):
- All 3 contract types share one flat schema: contract_id, type, title, price, reward, collateral, volume, days_to_complete, start_location_id, end_location_id, date_issued, date_expired, issuer_id, issuer_corporation_id, plus optional buyout (auctions only). No type-conditional parsing needed — irrelevant fields just zero out.
- Pagination: X-Pages header, ?page=N — esiGetAll (src/auth/esi-client.ts) already handles this exactly, no new pagination code needed.
- The Forge (region 10000002) alone is 35 pages / ~34k contracts, no server-side filtering by type/location at all — every call fetches everything and filters client-side.
- ESI's own Expires header gives a 30-minute cache window for this endpoint — use that as cacheTtlMs, matching the "respect ESI's own cache window" convention already documented elsewhere in this repo.

Design:
- Pure filter/sort/limit module at src/contracts.ts (top-level, not industry-specific) - unit tested directly (type filter, location filter, reward/volume ranges, limit behavior) without touching ESI.
- Tool handler (industry-esi.ts, alongside the existing get_character_contracts) does the thin part: esiGetAll the region (cached 30 min, public, no auth) -> pure filter function -> resolve start/end location names for just the returned (post-limit) rows via resolveLocations (structures.ts, already proven in price_build) -> return matchingCount (post-filter, pre-limit) plus the (possibly truncated) results.
- Not resolving issuer character/corp names - separate ESI calls for low marginal value here.

Verification plan: unit tests for the pure filter module, then a live check against The Forge for the actual Perimeter->Jita case that prompted this before calling it done.
