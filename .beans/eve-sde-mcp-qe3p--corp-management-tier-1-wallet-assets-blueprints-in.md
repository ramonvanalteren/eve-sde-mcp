---
# eve-sde-mcp-qe3p
title: 'Corp management Tier 1: wallet, assets, blueprints, industry jobs, contracts'
status: completed
type: feature
priority: high
tags:
    - corp
    - esi
created_at: 2026-09-26T11:43:51Z
updated_at: 2026-09-26T17:03:53Z
parent: eve-sde-mcp-vex4
---

Tier 1 of a broader corp-management proposal, scoped to the user's actual
corp: "kairos collective" (98820079), 2 members, Kyo Nomar as CEO (so no
internal role-assignment friction). 7 new corp-scoped ESI tools mirroring
existing character-scoped ones:

- get_corporation_wallets / get_corporation_wallet_journal / get_corporation_wallet_transactions
- get_corporation_assets (with hangar-division name enrichment)
- get_corporation_blueprints
- get_corporation_industry_jobs
- get_corporation_contracts

Deliberately NOT wired into the ledger/daily-close yet -- that's a separate
design decision (does corp data merge into the existing character-scoped
ledger, or stay parallel?) deferred until Tier 1 reveals whether there's
actually corp-level wallet/assets/jobs data worth merging.

Needs 6 new ESI scopes added to the default login set (esi-wallet.read_corporation_wallets.v1,
esi-assets.read_corporation_assets.v1, esi-corporations.read_blueprints.v1,
esi-industry.read_corporation_jobs.v1, esi-contracts.read_corporation_contracts.v1,
esi-corporations.read_divisions.v1) -- re-auth required before any of this
actually returns data; verified live that every tool degrades gracefully
(clean 401 naming the missing scope) rather than crashing, but full
corp-data verification is pending that re-auth.

Tier 2 (corp structures -- could unblock the low-priority structureBonuses
config item if the corp builds in its own Upwell structure) and Tier 3
(members/roles/titles, starbases, corp killmails -- low value for a
2-person corp) are explicitly out of scope here.
