---
name: eve-trading
description: "Use this skill for hybrid station trading — buy orders at a low-fee Perimeter structure with range 1 into Jita 4-4, sell orders at Jita 4-4 — covering new position selection from three saved A4E tier URLs, buy/sell portfolio review, inventory risk, pipeline performance, and daily close against the eve-sde-mcp ledger. Trigger on \"portfolio review,\" \"new candidates,\" A4E, or kill/add-to-position questions. Always verify margins by combining a buy-station call and a Jita-4-4-side sell call — a single-location margin field is not valid for buy-side items. Not for repricing/undercut checks — that's live/in-client."
---

# EVE Trading Skill — Hybrid Station Trading (Perimeter Buy / Jita 4-4 Sell)

## Scope

This skill covers five workflows. A plain "portfolio review" request runs Workflows 2-5 together by default; Workflow 1 runs when new candidates are explicitly requested (it fetches its own A4E data — see below — so it no longer needs a pasted snapshot to run).

1. **New position selection** (Workflow 1) — fetch the three saved A4E tier URLs (T1/T2/T3) and scan for items worth opening a new buy slot on, sized for execution at Perimeter HQ.
2. **Buy portfolio review** (Workflow 2) — review existing open buy orders and decide: kill, increase investment, or leave as-is.
3. **Sell portfolio review** (Workflow 3) — review sell-only positions (inventory with no open buy order) against real acquisition cost, not generic market margin. Equal rigor to Workflow 2 — this has been a repeated source of errors when treated as an afterthought.
4. **Inventory risk** (Workflow 4) — hangar stock with no matching sell order at all; mandatory every review.
5. **Pipeline performance** (Workflow 5) — how fast capital is actually cycling through buy→fill→list→sell, synthesized from data already gathered in Workflows 2-4. This is the default closing step of every portfolio review: healthy margin on a slow-cycling position can still be worse than a thinner margin that turns over fast, and nothing else in this skill surfaces that trade-off.
6. **Combined capital allocation** (default, runs automatically whenever both Workflow 1 and a portfolio review ran in the same session) — merge Increase/Hold/New into one ranked, sized list against current wallet balance.
7. **Daily close** (Workflow 6) — an accounting day-close: realized vs unrealized P&L, net of actual broker fees and sales tax, with a permanent local ledger. Separate from a portfolio review — runs only when explicitly asked for ("daily close", "close today", "P&L for [period]") or as a deliberate end-of-day routine, not bundled into the default Workflow 2-5 chain.

**Explicitly out of scope:** checking whether existing orders have been undercut/outbid and need repricing. That's faster to handle live in the client or with dedicated repricing tools. Do not spend ESI calls verifying top-of-book position for orders already open — only use live ESI to validate NEW candidates and to size/kill decisions on the portfolio (per the rules in the reference files).

## The two locations, in one paragraph

Buys go to **Perimeter - 0.0% Neutral States Market HQ** (`location_id 1044752365771`, 1 jump from Jita, placed with `range: "1"` so they still reach Jita 4-4 sellers); sells stay at **Jita 4-4 Caldari Navy Assembly Plant** (`location_id 60003760`) — a hybrid, not a relocation. Legacy buy orders may still sit at Jita 4-4: always check each order's own `locationId`. Fee rates, the margin formula, and the mandatory margin-verification procedure live in [reference/margin-verification.md](reference/margin-verification.md) — **read it before quoting any margin figure.**

## Dispatch map — which reference files to read

| Request | Read |
|---|---|
| Any margin figure is about to be discussed | [reference/margin-verification.md](reference/margin-verification.md) — fees, `nm()`, the two-call ESI procedure, jump-range check |
| "New candidates" / A4E scan | [reference/workflow-new-candidates.md](reference/workflow-new-candidates.md) + margin-verification |
| "Portfolio review" (default = buy review, sell review, inventory risk, pipeline) | [reference/workflow-portfolio-review.md](reference/workflow-portfolio-review.md) + margin-verification |
| "Daily close" / "P&L for [period]" | [reference/workflow-daily-close.md](reference/workflow-daily-close.md) |
| Capital allocation after candidates + review / "invest it all" / "don't let it sit dormant" | [reference/capital-allocation.md](reference/capital-allocation.md) |
| Why a rule exists / a rule is disputed / a past mistake is referenced | [reference/failure-cases.md](reference/failure-cases.md) |

References are one level deep: read exactly what the table says for the current request — a portfolio review does not need the A4E URLs, and a daily close does not need the margin procedure.

## Mandatory sizing rule (applies to Workflows 1, 2, and 3)

Every verdict that isn't a plain "Hold" — every new candidate, every Kill, every Increase — must come with a suggested **unit quantity and ISK amount, shown as separate, explicit values**, not just a margin percentage. Cost-only tables are incomplete: a units column must be visibly present, not buried in prose or implied by the cost figure alone.

Sizing method:
1. Pull current wallet balance (`get_wallet_balance`) to know available capital. If any meaningful time has passed since it was last pulled in the conversation, refresh it again rather than reusing a stale figure — balances move fast when the user is actively executing on prior recommendations.
2. Cap any single position at a sensible share of daily liquidity — don't suggest a buy volume that exceeds roughly 15-25% of the item's daily trade count, or the order will sit unfilled for days and tie up escrow pointlessly. Thin items (under ~20 trades/day) get small, conservative sizes; deep items (100+ trades/day) can support larger ones.
3. For **Kill**, state the ISK recovered: unit count × price × (freed escrow), so the user knows exactly what capital comes back.
4. For **Increase**, suggest an incremental unit count and its ISK cost, sized against both remaining wallet capacity and the liquidity cap above — don't suggest doubling a position that only trades 12 units/day. New increments go to Perimeter HQ per the Workflow 2 execution note.
5. For **new candidates**, suggest a starting position size (units + ISK) at Perimeter HQ, scaled down for thinner items and up for deep/liquid ones, and note if slot capacity is a constraint.
6. Once you've picked unit counts per candidate (that judgment call — liquidity caps, thin-book caution, priority order — stays with you, not the script), hand the list to `scripts/size_positions.py` in this skill folder to do the arithmetic and print the table. It takes pre-computed unit_price/units/margin_pct per candidate and has no fee assumptions baked in, so it's unaffected by the two-location fee split — all fee handling happens upstream, in the margin numbers you feed it. Read the script's docstring for the exact interface (library form: `size_positions(candidates, wallet=..., buffer_target_pct=...)`; it also has a CLI entry point). If the script isn't reachable for some reason, fall back to computing inline, but reach for it first.

**Required table template.** The script above already outputs this format, so following the sizing method naturally produces a compliant table:

| Item | Unit price | Units | Cost | Margin | (Running total, if part of a ranked list) |
|---|---|---|---|---|---|

If building a table by hand instead of via the script, double check the rendered result actually has a separate Units column with a number in it, not a unit count folded into the Cost figure — this has been missed before, which is the whole reason the script exists now.

## Margins are point-in-time — re-verify before execution, not just before recommending

A margin verified live can still be wrecked within hours by a single large order landing. Observed in practice: two candidates verified at 73,4% and 68,4% margin dropped to 27,4% and 6,0% respectively within the same session, purely from fresh competing orders. This is normal market behavior, not a tool error — but it means:

- Verified margin is a snapshot, not a guarantee. Say so plainly when presenting candidates, especially ones with thinner books (under ~25 buy+sell orders combined) where a single order can move the market a lot.
- If the user reports a margin looks wrong after having already acted on a recommendation, re-verify live immediately rather than defending the earlier snapshot — the earlier number was correct *at the time*, but markets move.
- **Before the order is placed**, hold it to the *entry* floor for its tier ([margin-verification.md](reference/margin-verification.md) — "Margin thresholds"); if re-verification shows it's dropped below that, the recommendation is stale — don't place it as sized. **Once the order is actually open**, it's a held position and the flat 10% hold floor applies going forward, not the (possibly higher) entry floor it was opened under — a freshly-opened T2 or T3 position that dips just under its entry bar but still clears 10% is a Hold, not an automatic Kill. Only Kill an open position when it drops below the flat 10% floor.

## Notes

- Escrow and wallet balance are useful context for sizing "increase investment" calls (how much dry powder is available) but are not themselves a trigger for action.
- Slot count is a real constraint — when recommending new candidates, note how many free trading slots would be needed and flag if the character's skill-based slot cap might be a limiting factor.
- If a wallet balance change doesn't reconcile against orders and `get_wallet_transactions` (e.g. a drop with no matching buy/escrow change — this has happened before, once turning out to be a corp slush fund transfer), use `get_wallet_journal(since=..., ref_type=...)` to check for non-trading entries before treating it as a mystery. Useful `ref_type` values: `market_transaction`, `brokers_fee`, `transaction_tax`, plus non-trading ones for transfers.
- **Sizable realized profit ≠ sizable realized cash.** When asked to analyze recent transactions, don't equate gross sell revenue with profit — a big cash inflow from selling out a large position is mostly return of the original cost basis, not margin. Compute per-item real profit (sell revenue net of fees minus real acquisition cost, per the portfolio review's Workflow 3 method) before characterizing a period as more or less profitable than it looks from the wallet delta alone.
- **Version canary.** This skill is version-controlled in the eve-sde-mcp repository. If a review shows it missing sections referenced above (the dispatch map, the sizing rule, the two-location summary) or `scripts/size_positions.py` is unreachable, say so plainly before proceeding rather than silently working from a stale version — restore from git history.
