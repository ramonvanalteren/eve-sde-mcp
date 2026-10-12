---
# eve-sde-mcp-muts
title: Resolve npm audit findings in production dependencies
status: todo
type: task
priority: low
tags:
    - security
    - dependencies
created_at: 2026-10-06T05:33:59Z
updated_at: 2026-10-06T05:33:59Z
parent: eve-sde-mcp-vex4
---

`npm ci --omit=dev` during the 2026-10-06 deploy reported 7 vulnerabilities in the production tree (1 critical, 2 high, 3 moderate, 1 low). `npm audit` says a fix is available for each.

## What
All are transitive, through @modelcontextprotocol/sdk 1.29.0's HTTP-transport dependencies:
- critical: proxy-addr (IP spoofing via IPv4-mapped IPv6 trust subnet)
- high: fast-uri (host confusion), ip-address (leading-zero octets decoded as decimal)
- moderate: @hono/node-server, hono, qs
- low: body-parser

## Why it is low urgency
The server only uses StdioServerTransport (src/index.ts) and never starts an HTTP listener, so the express/hono request paths these advisories concern are not exercised.

## To do
- [ ] Try `npm audit fix` (or bump @modelcontextprotocol/sdk) in the dev checkout; run the suite
- [ ] Redeploy (`npm run deploy -- --no-config`) and confirm `npm audit --omit=dev` is clean
- [ ] If the SDK bump changes behaviour, note it here
