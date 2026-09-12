# Production Review — active jobs against live margins

Trigger: "how is production doing", "review my jobs", or a periodic check before relisting batches. Runs Workflow 1 (build-margin verification) per active line.

## Procedure

1. **`get_industry_jobs`** (include_completed if a batch just delivered) — every job with product, runs, cost (installation, already paid — it's sunk), end date, facility.
2. **Per manufacturing job: `price_build` at replacement basis** — the product's CURRENT margin, not the one at commit time. Materials at today's sell orders, product at today's net sell, `installation_cost` = the job's reported cost (it's sunk; include it so unit cost reflects the batch's all-in, but the *verdict* is about the next batch).
3. **Research jobs** (ME/TE) — see the knowledge reference's research section: value the research against the production volume it will actually serve, not in the abstract.

## Verdicts (every verdict carries both margin and slot economics)

- **Keep / relist** — margin clears threshold on the sell basis → repeat the batch. Consider scaling only within liquidity: the output must clear the book in days, not weeks (check product sell depth and daily volume; the thin-book rule from margin verification applies).
- **Don't relist** (the common kill) — margin below threshold → let committed runs finish (materials are sunk, installation is paid), sell the delivered output at whatever net is positive, and do not queue the next batch. Re-verify before ever restarting the line — margins move; a dead line today can be a healthy one after input prices shift.
- **Kill mid-job** — cancelling a manufacturing job returns materials but not the installation cost. Only worth it when the slot's opportunity is large (another line waiting on the slot at much better profit-per-time) — otherwise let it run and take the small positive net at delivery.

## Slot economics — the per-time view

A facility slot is the scarce resource (character skill caps concurrent jobs; the founding operation ran 8 jobs across 2 structures). Rank lines by **profit per job-duration**, not per run:

- Founding audit: the dead line was 53k per 2.5 days (~21k/day) while another line made 1.75M per day in the same facility — an ~80× difference per slot-time.
- Compute: job profit (from price_build totals) ÷ (end − start). TE research on a BPO reduces future durations — its value shows up here as slot-time savings across all future batches (see the knowledge reference).

## Delivered-output disposal

When a batch delivers:

- Verify the current margin again (staleness discipline) and list at the verified-clearing price.
- If the margin went negative between completion and listing: decide between holding the output (capital parked in inventory — usually wrong for a thin-margin item) and selling at the best positive net (usually right; recover capital into the next healthy line).
- Reprocessing the product back into minerals is almost never right for T1 modules (reprocessing yields < build cost at typical skills) — mentioned only because it gets asked.

## The ledger reminder

Do not pull production performance from the daily close — the ledger is blind to production (see the skill hub). The production review IS the production P&L: per-line margins, job profits, slot economics, all from price_build over live data.
