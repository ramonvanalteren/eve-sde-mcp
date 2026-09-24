---
# eve-sde-mcp-f6o1
title: Server self-reports version/status
status: todo
type: task
priority: normal
tags:
    - observability
created_at: 2026-09-24T16:49:16Z
updated_at: 2026-09-24T16:49:16Z
parent: eve-sde-mcp-vex4
---

Confirming a redeploy actually reached this session needed a live price_build call and cross-referencing numbers by hand, or a raw MCP client script. get_sde_status (or a new get_server_status) could report the server's own package.json version, PID/uptime, and maybe the git commit it was built from - turns 'did the restart pick up the new build' into a one-line check instead of what this session did each time. Small, low-risk, high quality-of-life.
