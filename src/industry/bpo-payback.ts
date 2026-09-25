// BPO payback economics — turns workflow-new-candidates.md's prose formula
// into a computed number instead of arithmetic done by hand each time:
//   - payback batch count: "at 1.4M per batch, a 9.4M BPO pays back in 7
//     batches" -> ceil(bpoCost / batchProfit)
//   - first-batch ROI: "(batch profit - BPO cost) / total capital deployed
//     (materials + installation + BPO)" — NOT gross profit vs. BPO price,
//     which flatters expensive BPOs (see the doc's Valkyrie I case: 1.72M
//     profit vs. a 1.61M BPO looked like clean payback, but first-batch ROI
//     on the 14.1M actually deployed was under 1%)
//   - payback ceiling: the doc flags 3+ batches to amortize as real
//     multi-cycle exposure ("1-2 batches" is the stated ceiling)
// Pure function over numbers a price_build report already computes
// (materials cost, installation cost, batch profit) plus the BPO's price —
// no new ESI calls needed.

export interface BpoPaybackReport {
  bpoCost: number;
  /** materialsCost + installationCost + bpoCost — capital actually deployed for one batch, BPO included. */
  totalCapitalDeployed: number;
  /** (batchProfit - bpoCost) / totalCapitalDeployed, as a percentage. Null when nothing was deployed to measure a return on. */
  firstBatchRoiPct: number | null;
  /** ceil(bpoCost / batchProfit). Null when the batch doesn't turn a profit at all — the BPO never pays back at this batch size, a materially different case from "many batches," never conflated with a large number. */
  paybackBatches: number | null;
  /** paybackBatches exceeds paybackCeilingBatches, OR never pays back (paybackBatches null) — both are the doc's "flag this plainly, don't bury it" caution case. */
  exceedsPaybackCeiling: boolean;
  /** The threshold checked against — doc default is 2 ("1-2 batches" is fine, 3+ is the caution). */
  paybackCeilingBatches: number;
}

export function computeBpoPayback(
  batchProfit: number,
  materialsCost: number,
  installationCost: number,
  bpoCost: number,
  paybackCeilingBatches = 2
): BpoPaybackReport {
  const totalCapitalDeployed = materialsCost + installationCost + bpoCost;
  const firstBatchRoiPct = totalCapitalDeployed > 0 ? ((batchProfit - bpoCost) / totalCapitalDeployed) * 100 : null;
  const paybackBatches = batchProfit > 0 ? Math.ceil(bpoCost / batchProfit) : null;
  const exceedsPaybackCeiling = paybackBatches === null || paybackBatches > paybackCeilingBatches;

  return {
    bpoCost,
    totalCapitalDeployed,
    firstBatchRoiPct,
    paybackBatches,
    exceedsPaybackCeiling,
    paybackCeilingBatches,
  };
}
