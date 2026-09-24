---
# eve-sde-mcp-r2sc
title: BPO payback calculation wired into price_build/scan_builds
status: todo
type: feature
priority: normal
tags:
    - industry
created_at: 2026-09-24T16:49:16Z
updated_at: 2026-09-24T16:49:16Z
parent: eve-sde-mcp-vex4
---

skills/eve-trading/skills/eve-industry/reference/workflow-new-candidates.md spells out a precise BPO payback formula - '(batch profit - BPO cost) / total capital deployed', 'payback ceiling 1-2 batches' - with a named real mistake (a 9.4M BPO bought with no production plan, see the same file's failure-cases section). That's exactly the kind of repeatable arithmetic this server exists to take out of manual hands everywhere else, but here it's still a skill instruction executed by hand each time. Add an optional bpo_cost param to price_build (and/or scan_builds) implementing that same already-codified formula, so the payback-batch-count and first-batch-ROI numbers come from the tool instead of prose math.
