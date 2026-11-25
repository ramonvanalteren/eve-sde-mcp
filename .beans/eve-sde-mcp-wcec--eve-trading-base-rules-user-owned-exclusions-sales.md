---
# eve-sde-mcp-wcec
title: 'eve-trading: base rules, user-owned exclusions, sales cap, report option, pair sizing'
status: completed
type: feature
created_at: 2026-11-25T23:02:36Z
updated_at: 2026-11-25T23:02:36Z
---

Agreed with the user on 2026-11-26 after a candidate review went wrong (self-invented exclusions, unrequested scans).

- [x] Five base rules in SKILL.md
- [x] Exclusions: user-owned JSON file, killed items may return, no family default
- [x] Scan rejects rows with no room under the sales cap
- [x] scan_candidates --report prints the standard table and counts
- [x] size_positions sizes T3 and up in pairs
- [x] Docs, tests, version 1.8.0

## Summary of Changes

- SKILL.md opens with the five base rules.
- Standing exclusions come only from `~/.eve-sde/trading-exclusions.json` (starts empty: no file). `--killed` is replaced by
  `--exclude` for the current run; no family default.
- The scan rejects rows whose sales cap leaves no room for one unit increment (it used to size them at the minimum).
- `scan_candidates.py --report` prints the standard markdown report.
- `size_positions.py` sizes rows from the T3 floor in pairs (`expensive_unit_increment`).
- Version 1.8.0. Skill tests: 115 pass.
