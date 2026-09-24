---
# eve-sde-mcp-sbih
title: structureBonuses config entry for ME/TE facility bonuses
status: todo
type: feature
priority: low
tags:
    - industry
    - config
created_at: 2026-09-24T16:49:16Z
updated_at: 2026-09-24T16:49:16Z
parent: eve-sde-mcp-vex4
---

price_build's ME docs explicitly say structure/facility material bonuses are 'not modelled (the SDE has no facility data)'. Confirmed while researching the ME-per-job fix (PR #15) that ESI genuinely doesn't expose rig-level ME/TE bonuses either, so this can't be pulled live from anywhere. But the codebase already has the right shape for exactly this problem: blueprintME and stationFees in ~/.eve-sde/config.json are both 'config-first, ESI-second, conservative default' (see src/ledger/bom-close.ts's resolveJobMe and src/tools/industry-esi.ts's station fee resolution for the established pattern). A structureBonuses entry keyed by structure id, following the same pattern, would let the user pin a known rig bonus once instead of every bonused build silently overstating material cost forever. Lower priority - only worth it once structure-based (not NPC station) manufacturing is actually in use.
