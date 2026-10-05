---
# eve-sde-mcp-3cs6
title: size_positions as an MCP tool, with a strategy-params drift test
status: todo
type: task
priority: normal
tags:
    - trading
    - performance
created_at: 2026-10-05T07:57:25Z
updated_at: 2026-10-05T07:57:25Z
parent: eve-sde-mcp-3x8x
blocked_by:
    - eve-sde-mcp-o75m
---

size_positions.py needs Bash and a hand-built plan.json (12 Bash calls / 30k chars in the measured proposal round). Bash was refused in the eval harness and may not exist where the plugin is installed from a desktop upload.

## Checklist
- [ ] MCP tool `size_positions` taking candidate rows (units chosen, or taken from `verify_candidates` output) and reading wallet and current orders itself; same output as the script (ranked table, order count, tier mix, fewer-orders variant, flags).
- [ ] Strategy parameters: one source. Either the server reads the JSON block from strategy.md at start-up, or it keeps constants guarded by a test that compares them to the block (same repo).
- [ ] Keep size_positions.py as the reference and test oracle until the tool matches it on the 2026-10-04 fixture.
- [ ] Skill: sizing step 6 uses the tool; keep the script only if still useful.

## Acceptance
Ranked, sized table produced in one call from verified candidates, identical to the script on the fixtures.
