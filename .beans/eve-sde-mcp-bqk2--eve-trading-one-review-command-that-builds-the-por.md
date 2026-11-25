---
# eve-sde-mcp-bqk2
title: 'eve-trading: one review command that builds the portfolio report tables'
status: completed
type: feature
created_at: 2026-11-25T23:07:44Z
updated_at: 2026-11-25T23:07:44Z
---

Reviews took about 10 minutes, mostly analysis written by hand each run. Build the Workflow 2-5 tables in one command and leave verdicts and notes to the session.

- [x] review_portfolio.py report builds the report skeleton
- [x] Ages, fills, tier mix, Kill totals, unlisted stock, pipeline inputs, changes since the last snapshot
- [x] Docs and tests, version 1.9.0

Related to the epic eve-sde-mcp-3x8x (server-side compute), which this does not change.

## Summary of Changes

- New `review_report.py`, run as `review_portfolio.py report`: the Workflow 2-5 draft in the report skeleton.
- Reads transactions and first-seen order dates from the ledger; live prices from the saved orders result.
- `--save` / `--since` give the changes since the last review.
- Version 1.9.0. Skill tests: 129 pass. A live run on a book of about 50 orders takes about 20 seconds.
