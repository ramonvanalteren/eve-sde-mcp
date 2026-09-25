---
# eve-sde-mcp-crme
title: 'price_build: auto-estimate installation cost from cost indices'
status: in-progress
type: feature
priority: high
tags:
    - industry
    - price_build
created_at: 2026-09-24T16:49:16Z
updated_at: 2026-09-25T08:01:46Z
parent: eve-sde-mcp-vex4
---

price_build's installation_cost is entirely manual today - it just warns 'materials-only' when omitted. But the pieces to fix this already exist separately: get_industry_cost_indices is its own tool, and get_structure already resolves a facility to its solar system AND reports that system's cost indices (see src/tools/structures.ts's resolveLocations + cost-index lookup). Wiring cost-index-based estimation into price_build as a default (still overridable with the real in-client number) closes exactly the gap that produced the founding audit story: a build that looks fine materials-only can be a loser once install cost is added, and today nothing catches that unless the user remembers to look it up separately in a second tool call. Reuse the existing resolveLocations/cost-index code rather than duplicating it.
