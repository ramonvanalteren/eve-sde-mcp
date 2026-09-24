---
# eve-sde-mcp-rd1l
title: Validate A4E tier-URL fee params against live config
status: todo
type: task
priority: low
tags:
    - trading
    - reliability
created_at: 2026-09-24T16:49:17Z
updated_at: 2026-09-24T16:49:17Z
parent: eve-sde-mcp-vex4
---

skills/eve-trading/skills/eve-trading/reference/workflow-new-candidates.md: the three saved A4E tier URLs bake in fee assumptions (buyFee/sellFee/salesTax query params) as a static approximation of the real Perimeter/Jita 4-4 friction, and the same doc warns in bold that 'these three URLs need updating to match [config] or they will silently drift out of sync with the live ESI numbers.' A cheap validation - compare each URL's embedded buyFee/sellFee/salesTax against config.json's current stationFees/salesTaxPct at the point they're used, and warn on mismatch - would catch that automatically instead of relying on someone noticing. Mirrors the existing pattern where get_station_fees already flags unconfigured stations.
