---
# eve-sde-mcp-3kcy
title: CI via GitHub Actions
status: completed
type: task
priority: high
tags:
    - ci
    - reliability
created_at: 2026-09-24T16:48:50Z
updated_at: 2026-09-24T21:32:19Z
parent: eve-sde-mcp-vex4
---

Every PR merged in this session (#15-#18) had statusCheckRollup: [] — zero automated checks. Only manual `npx tsc --noEmit && npx vitest run` before each merge stood between a broken change and main.

## Proposal (proposed 2026-09-24, not yet built)

File: `.github/workflows/ci.yml`

Triggers: `pull_request` targeting `main`, and `push` to `main` (safety net for anything landing outside the PR flow).

Single job, `ubuntu-latest` (cheaper/faster than macOS; better-sqlite3 ships prebuilt Linux x64 binaries so `npm ci`'s postinstall binding-check should pass without compiling - confirm on first real run):

1. actions/checkout
2. actions/setup-node with `node-version-file: .node-version` - same pin the repo already enforces locally (fnm use, deploy.mjs refuses a mismatched Node).
3. `npm ci` (also exercises postinstall's binding check on a clean machine - a real check nothing currently does outside a developer's own laptop).
4. Restore or fetch the SDE database. IMPORTANT DISCOVERY: 11 of 30 test files (database.test.ts, eft-parser.test.ts, fittings.test.ts, groups.test.ts, industry.test.ts, killmails.test.ts, market.test.ts, meta.test.ts, skills.test.ts, types.test.ts, universe.test.ts) call getDatabase() which throws unless ~/.eve-sde/eve.db exists - there's no fixture/mock DB. Use actions/cache keyed on Fuzzwork's Last-Modified header (one `curl -sI https://www.fuzzwork.co.uk/dump/latest-sqlite.db.gz` step to read it, cache key `sde-${date}`). Cache hit = instant; cache miss (new SDE published, or first run) = download+gunzip once (~146MB compressed, confirmed via curl -sI on 2026-09-24; decompresses to ~463MB), then cached until Fuzzwork republishes. Write to ~/.eve-sde/eve.db (database.ts's hardcoded path).
5. `npm run build` (this is just `tsc`, no separate --noEmit needed - it both type-checks and proves dist/ actually builds, which deploy.mjs depends on).
6. `npm test` - full suite unchanged, all tests (261 as of 2026-09-24), no subset/split. Considered running only the SDE-independent tests on every push and gating the rest behind cache availability, but that's a second thing to maintain and exactly the "quietly stops covering what it used to" risk that caused the get_structure bug (see eve-sde-mcp PR #16) in the first place.

Not in scope for the first PR:
- Branch protection (requiring this check before merge) is a repo admin setting (Settings > Branches), not a workflow-file change - turn on manually after CI's been green a few times, don't have an agent force it.
- This is the foundation for the "automated deploy verification" bean (blocks it) - that would be a second job or follow-up workflow, kept separate so a flaky deploy step can't block a plain code-correctness PR.

## Open questions for whoever picks this up
- Confirm ubuntu-latest actually avoids compiling better-sqlite3 (check the postinstall step's output on the first real CI run).
- Decide the actual cache-key mechanics for step 4 (Last-Modified header vs a simpler weekly-bucket key).
