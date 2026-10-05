---
# eve-sde-mcp-v0yo
title: 'Skill: slim SKILL.md, call plans, retire prose the tools replace, update evals'
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
    - eve-sde-mcp-q6cg
    - eve-sde-mcp-o75m
    - eve-sde-mcp-ctcy
    - eve-sde-mcp-3cs6
---

Skill-side changes, done progressively as each server tool lands.

## Checklist
- [ ] Trim SKILL.md (19.5 KB -> ~8 KB): move sizing detail and the long Notes into the reference files that use them (~3k tokens saved per run).
- [ ] Add an explicit call plan to each workflow (which calls go in one parallel block), since the measured proposal round was mostly sequential turns.
- [ ] After get_a4e_candidates, verify_candidates and get_portfolio_snapshot exist: shrink the two-call procedure, the depth checklist and the data-gathering prose (~10 KB).
- [ ] Add the "did the bid and ask level actually trade" rule and the repeat-cancel evidence to the verdict rules (the tool supplies the facts).
- [ ] Update evals: mocks and fixtures for the new tools, graders that name old tool calls (e.g. get_wallet_transactions), re-run the suite locally; add a routing case for each new tool.
- [ ] Update the tests (drift, links, anchors) and bump the plugin version.
- [ ] Re-measure with the transcript method and record the result in the epic.
