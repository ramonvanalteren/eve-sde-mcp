---
# eve-sde-mcp-ka45
title: 'eve skills: reprice cost and close surcharge, job skills check, standing cash buffer'
status: completed
type: task
created_at: 2026-11-25T23:52:59Z
updated_at: 2026-11-25T23:52:59Z
---

Three corrections the user approved on 2026-11-26.

## Summary of Changes

- Perimeter reprice cost corrected to 0.1% of the open order value plus 0.5% of added escrow, checked against the wallet journal; the daily close leaves the SCC surcharge out of realized net.
- Industry skill rule 7: check a job's activity skills with get_blueprint, not check_skill_requirements on the blueprint.
- The cash buffer is the user's standing figure, kept in a private note and confirmed monthly.
- Version 1.9.2.
