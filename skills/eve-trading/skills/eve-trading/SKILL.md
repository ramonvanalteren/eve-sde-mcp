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
6. **Combined capital allocation** (default, runs automatically whenever both Workflow 1 and a portfolio review ran in the same session) — merge Increase/Hold/New into one ranked, sized list against current wallet balance. Also the **kill-and-redeploy mode**, on request ("kill list and redeploy", "put all the cash to work", "refresh the plan"): assume the Kills are executed, add the freed escrow to the pool, and redeploy it — see [reference/capital-allocation.md](reference/capital-allocation.md).
7. **Daily close** (Workflow 6) — an accounting day-close: realized vs unrealized P&L, net of actual broker fees and sales tax, with a permanent local ledger. Separate from a portfolio review — runs only when explicitly asked for ("daily close", "close today", "P&L for [period]") or as a deliberate end-of-day routine, not bundled into the default Workflow 2-5 chain.

**Explicitly out of scope:** checking whether existing orders have been undercut/outbid and need repricing. That's faster to handle live in the client or with dedicated repricing tools. Do not spend ESI calls verifying top-of-book position for orders already open — only use live ESI to validate NEW candidates and to size/kill decisions on the portfolio (per the rules in the reference files).

## The two locations, in one paragraph

Buys go to **Perimeter - 0.0% Neutral States Market HQ** (`location_id 1044752365771`, 1 jump from Jita, placed with `range: "1"` so they still reach Jita 4-4 sellers); sells stay at **Jita 4-4 Caldari Navy Assembly Plant** (`location_id 60003760`) — a hybrid, not a relocation. Legacy buy orders may still sit at Jita 4-4: always check each order's own `locationId`. Fee rates, the margin formula, and the mandatory margin-verification procedure live in [reference/margin-verification.md](reference/margin-verification.md) — **read it before quoting any margin figure.**

## The strategy, in one paragraph

The book is run as **few, large, well-cycling positions sized to the market**: each position is 25–50% of the item's average daily trade count, candidates are ranked by M/1M/day, idle or thin positions are periodically killed and the freed capital redeployed (cash is not hoarded), the T1/T2/T3 mix of buy escrow is reported every time, and the strategy is judged on realized P&L over at least a week — not on net worth. The parameters, their status (user-set vs proposed default), and the evidence behind them are in [reference/strategy.md](reference/strategy.md) — **read it before proposing positions or judging the shape of the book.** The one soft limit (the profit-per-slot floor) and the reporting duties are described under "Slot discipline" below.

## Dispatch map — which reference files to read

| Request | Read |
|---|---|
| Any margin figure is about to be discussed | [reference/margin-verification.md](reference/margin-verification.md) — fees, `nm()`, the two-call ESI procedure, jump-range check |
| "New candidates" / A4E scan | [reference/workflow-new-candidates.md](reference/workflow-new-candidates.md) + margin-verification |
| "Portfolio review" (default = buy review, sell review, inventory risk, pipeline) | [reference/workflow-portfolio-review.md](reference/workflow-portfolio-review.md) + margin-verification |
| "Daily close" / "P&L for [period]" | [reference/workflow-daily-close.md](reference/workflow-daily-close.md) |
| Capital allocation after candidates + review / "invest it all" / "don't let it sit dormant" | [reference/capital-allocation.md](reference/capital-allocation.md) + [reference/strategy.md](reference/strategy.md) |
| "Kill list and redeploy" / "refresh this plan" / "put all the cash to work" | [reference/capital-allocation.md](reference/capital-allocation.md) (kill-and-redeploy mode) + [workflow-portfolio-review.md](reference/workflow-portfolio-review.md) + [workflow-new-candidates.md](reference/workflow-new-candidates.md) + margin-verification + [strategy.md](reference/strategy.md) |
| "Is the strategy working?" / tier distribution / how the book is shaped | [reference/strategy.md](reference/strategy.md) + the scorecard in [workflow-daily-close.md](reference/workflow-daily-close.md) |
| Why a rule exists / a rule is disputed / a past mistake is referenced | [reference/failure-cases.md](reference/failure-cases.md) |

References are one level deep: read exactly what the table says for the current request — a portfolio review does not need the A4E URLs, and a daily close does not need the margin procedure.

## Mandatory sizing rule (applies to Workflows 1, 2, and 3)

Every verdict that isn't a plain "Hold" — every new candidate, every Kill, every Increase — must come with a suggested **unit quantity and ISK amount, shown as separate, explicit values**, not just a margin percentage. Cost-only tables are incomplete: a units column must be visibly present, not buried in prose or implied by the cost figure alone.

Sizing method:
1. Pull current wallet balance (`get_wallet_balance`) to know available capital. If any meaningful time has passed since it was last pulled in the conversation, refresh it again rather than reusing a stale figure — balances move fast when the user is actively executing on prior recommendations.
2. **Size each position to the market, not to the wallet: units = 25-50% of the item's average daily trade count** (A4E "avg daily trades", or `get_market_history`). Count trades, not ISK/day — A4E's ISK/day swings several-fold between snapshots on T3 items. Use the top of the band for deep, durable books (100+ trades/day, 20+ orders on both sides) and the bottom for thinner ones; above 50% the order parks escrow behind fills that won't come for days. **Thin-item exclusion:** if even the minimum 5 units would exceed 50% of daily trades (roughly under 10 trades/day), don't open it — that is the test that cut the thin T3 items. The band was raised from 15-25% by the user on 2026-10-02; don't drift back to the old cap, and don't hoard cash either — if the pool is bigger than the band can absorb, say so and report the leftover as buffer rather than inflating a position past 50% (see [reference/strategy.md](reference/strategy.md)).
3. **Size in increments of 5 or 10 units — never an odd one-off count like 3 or 7.** A position small enough to need an awkward unit count usually isn't worth the broker-fee overhead of opening and relisting it. There is generally enough capital available to round up to the next clean increment rather than shrink to fit a budget — prefer rounding up over sizing something oddly. `scripts/size_positions.py` (see step 7) now enforces this automatically by rounding whatever unit count you pass to the nearest multiple of 5, so lean on it rather than hand-picking an exact number.
4. For **Kill**, state the ISK recovered: unit count × price × (freed escrow), so the user knows exactly what capital comes back.
5. For **Increase**, suggest an incremental unit count and its ISK cost, sized against both remaining wallet capacity and the liquidity cap above — don't suggest doubling a position that only trades 12 units/day. New increments go to Perimeter HQ per the Workflow 2 execution note.
6. For **new candidates**, suggest a starting position size (units + ISK) at Perimeter HQ, scaled down for thinner items and up for deep/liquid ones, and note if slot capacity is a constraint.
7. Once you've picked unit counts per candidate (that judgment call — depth, thin-book caution — stays with you, not the script), hand the list to `scripts/size_positions.py` in this skill folder to do the arithmetic and print the table. Pass it each candidate's verified `profitPerUnit` (from `get_portfolio_margins`, or computed by hand) alongside unit_price/units/margin_pct/trades_per_day — the script rounds units to the nearest multiple of 5 per the rule above, computes each position's total profit from the *rounded* units, **ranks candidates by M/1M/day** (see "Rank by M/1M/day" below), and runs the buffer walk. In a redeploy pass `freed=` (escrow from the assumed Kills) and `buffer_target_isk=` (the user states buffers in ISK); pass `current_open_orders=` and `current_tier_escrow=` (both after the assumed Kills) so it prints the order count and tier mix before/after. It also flags rows over the 50% band, excludes thin items, flags rows under the profit-per-slot floor, and prints the fewer-orders variant. It has no fee assumptions baked in, so it's unaffected by the two-location fee split — all fee handling happens upstream, in the margin/profit numbers you feed it. Read the script's docstring for the exact interface (library form: `size_positions(candidates, wallet=..., ...)`; the module's `__main__` is a runnable example). If the script isn't reachable for some reason, fall back to computing inline, but reach for it first.

**Required table template.** The script above already outputs this format, so following the sizing method naturally produces a compliant table:

| Item | Unit price | Units | Cost | Margin | Trades/day | Total profit | M/1M/day | (Running total, if part of a ranked list) |
|---|---|---|---|---|---|---|---|---|

The script appends a trailing annotation to each row — the share of daily trades the sized units represent (`[43% of day]`) and any flags (`OVER-BAND`, `SMALL-SLOT`); carry those through into the presented table (a "% of day" or "Note" column is fine) rather than dropping them.

**Trades/day, Total profit, and M/1M/day are all required columns, not optional notes** — they're what the reader needs to judge whether the sizing in the Units column is achievable and worth it, so they belong next to the numbers they justify rather than buried in prose. If building a table by hand instead of via the script, double check the rendered result actually has all of these as separate columns with numbers in them, not folded into prose or the Cost figure — this has been missed before, which is the whole reason the script exists now.

- **Trades/day**: the transaction count over the lookback period, from A4E's "avg daily trades" column or `get_market_history`.
- **Total profit**: `profit_per_unit × rounded units` — the ISK profit for the position as actually sized.
- **M/1M/day**: `(profit_per_unit / unit_price) × trades_per_day`, read as "M ISK of profit per day, per 1M ISK committed" — e.g. a value of 8.2 means 8.2M ISK/day of profit-earning-potential for every 1M ISK tied up. Deliberately kept in the same unit base (millions) on both sides rather than expressed as a percentage — "820%/day" reads like a literal compounding return and invites the wrong conclusion that the position doubles your money twice a day; "8.2M/1M/day" doesn't carry that implication. It's a velocity-adjusted capital-efficiency score, deliberately scale-independent (same value regardless of sized units) so it ranks *opportunities* rather than restating the sized position. This is **not** the same thing as plain profit ÷ capital invested — that ratio is just margin % wearing a different hat and adds nothing new. M/1M/day is what gives the Workflow 5 "a slow-cycling margin can be worse than a fast-cycling thinner one" observation an actual number. Treat it as a comparative ranking aid, not a literal forecast of daily return.

**Rank by M/1M/day, descending — not by margin %, and not by total profit.** The user's ranking key since 2026-10-02 (it replaced "rank by absolute profit", which an earlier version of this section prescribed). Margin tells you whether a position clears its entry/hold floor; it is not a ranking key. Total profit is a displayed column and a slot filter (below), not the rank key. `scripts/size_positions.py` re-sorts by M/1M/day automatically — don't pre-sort and expect the order to hold; the printed table's row order is the actual priority, and the buffer walk fills in that order. (`rank_by="profit"` exists for the rare case where the user asks for a profit ranking.)

Yield-ranking alone favours cheap, fast items whose slots earn very little per cycle — on 2026-10-04 Signal Amplifier II, 720mm Howitzer Artillery II and Ice Harvester I each earned under 10M per cycle yet ranked in the top 13. That fills slots that earn very little, so it is always paired with the slot floor below.

## Slot discipline — every slot earns its place

Applies to every workflow that proposes or reviews buys. The profit floor is **soft**: flag it and name the rows, never silently block, drop or resize. Values and their status are in [reference/strategy.md](reference/strategy.md); `size_positions.py` computes all of it.

- **Profit per slot.** Each row's total profit per full cycle at the live margin should clear the floor (10M). Rows below it are flagged SMALL-SLOT and named in the proposal. It is per cycle on purpose — M/1M/day already rewards velocity.
- **Order count: no cap.** The user has said 40-60 open buys is fine. Report the current count and the count after the proposal, but don't trim a proposal or recommend cuts just to lower the count. Slot quality is policed by the profit floor and by the zero-fill and thin-position reporting in Workflow 2.
- **Tier mix: report only.** Report the T1/T2/T3 share of buy escrow (tiers by unit price: T1 0.5-5M, T2 5-20M, T3 20-50M) before and after. There is no target and no flag.
- **Fewer-orders variant.** Optional: offer the shorter list that keeps roughly two thirds of the profit when the user asks for fewer orders or the count lands above 60. The script prints it.

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
