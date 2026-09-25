---
# eve-sde-mcp-5e5i
title: Automated deploy verification in deploy.mjs
status: completed
type: task
priority: high
tags:
    - reliability
    - deploy
created_at: 2026-09-24T16:49:16Z
updated_at: 2026-09-24T21:39:13Z
parent: eve-sde-mcp-vex4
blocked_by:
    - eve-sde-mcp-3kcy
---

After every 'npm run deploy' this session, verification meant hand-writing a throwaway script that booted the installed dist/ via createServer() in an in-memory MCP client and checked tool count / get_structure / the ME fix / reported version - done 4+ separate times manually. That exact check belongs in scripts/deploy.mjs as a real final step: boot the freshly-installed server, list its tools via a real MCP round trip, diff against what src/server.ts registers (or at minimum assert a sane non-zero count matching the source tree), and assert the reported version matches package.json. This is literally the check that would have caught the original get_structure bug (PR #16) at deploy time instead of via a later manual audit. Depends on the CI bean existing first so the same verification logic can potentially be shared/tested there too.
