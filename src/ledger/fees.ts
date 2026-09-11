/**
 * Correlates brokers_fee journal entries to the specific order that caused
 * them, and classifies each as a new listing vs. a relist.
 *
 * ESI gives no direct linkage here — brokers_fee journal entries carry no
 * order_id or type_id at all (confirmed: CCP excludes ref_type 46 from
 * context_id population entirely, and third-party devs' only known
 * workaround is timestamp correlation against order `issued` times). So
 * this is a heuristic match, not an exact join: timestamp proximity plus
 * expected-fee-amount consistency (price * volume * broker rate). Where a
 * fee can't be matched confidently — no candidate within tolerance, or two
 * candidates too close to call — it's left unmatched rather than guessed,
 * same philosophy as the FIFO engine's unmatched-cost-basis handling.
 *
 * Pure, no I/O — takes plain data in, returns plain data out.
 */

export interface BrokerFeeEntry {
  journalId: number;
  date: string;
  /** Raw journal amount (negative). */
  amount: number;
}

export type OrderState = "open" | "cancelled" | "expired" | "fulfilled";

export interface OrderRecord {
  orderId: number;
  typeId: number;
  isBuyOrder: boolean;
  price: number;
  volumeTotal: number;
  issued: string;
  state: OrderState;
}

export type FeeClassification = "new_listing" | "relist";

export interface MatchedFee {
  journalId: number;
  orderId: number;
  typeId: number;
  amount: number;
  classification: FeeClassification;
}

export interface UnmatchedFee {
  journalId: number;
  date: string;
  amount: number;
  reason: "no_candidate" | "ambiguous";
}

export interface FeeMatchResult {
  matched: MatchedFee[];
  unmatched: UnmatchedFee[];
  newListingTotal: number;
  relistTotal: number;
  unmatchedTotal: number;
}

// Broker fee posts within seconds of order placement in practice (per
// third-party dev consensus — "pretty reliable"). A generous 60s window
// still comfortably excludes unrelated orders placed minutes apart.
const TIME_TOLERANCE_MS = 60_000;
// Covers rounding and any small drift between the assumed broker_fee_pct
// and the character's actual effective rate at order time.
const AMOUNT_TOLERANCE_PCT = 0.02;
// If the best and second-best candidate scores are this close, treat the
// match as ambiguous rather than arbitrarily picking the marginally-better
// one.
const AMBIGUITY_MARGIN = 0.15;

/**
 * @param fees brokers_fee journal entries for the period being matched.
 * @param candidateOrders orders whose `issued` timestamp could plausibly
 *   match one of `fees` — in practice, orders issued on the same day.
 * @param priorOrdersForClassification a broader pool (any date) used only to
 *   tell whether a matched order is a relist of an earlier position — needs
 *   to include cancelled orders from before `candidateOrders`' date range.
 * @param brokerFeePct the character's actual effective broker fee rate — pass
 *   explicitly, same rule as the rest of this skill (don't rely on a generic
 *   default and silently mis-price every match).
 */
export function matchBrokerFees(
  fees: BrokerFeeEntry[],
  candidateOrders: OrderRecord[],
  priorOrdersForClassification: OrderRecord[],
  brokerFeePct: number
): FeeMatchResult {
  const priorIssuedByKey = new Map<string, string[]>();
  for (const o of priorOrdersForClassification) {
    if (o.state !== "cancelled") continue;
    const key = `${o.typeId}:${o.isBuyOrder}`;
    const arr = priorIssuedByKey.get(key) ?? [];
    arr.push(o.issued);
    priorIssuedByKey.set(key, arr);
  }
  for (const arr of priorIssuedByKey.values()) arr.sort();

  function classify(order: OrderRecord): FeeClassification {
    const priors = priorIssuedByKey.get(`${order.typeId}:${order.isBuyOrder}`);
    if (!priors) return "new_listing";
    return priors.some((issued) => issued < order.issued) ? "relist" : "new_listing";
  }

  const usedOrderIds = new Set<number>();
  const matched: MatchedFee[] = [];
  const unmatched: UnmatchedFee[] = [];

  const sortedFees = [...fees].sort((a, b) => a.date.localeCompare(b.date));

  for (const fee of sortedFees) {
    const feeTime = new Date(fee.date).getTime();
    const feeAbs = Math.abs(fee.amount);

    let best: { order: OrderRecord; score: number } | null = null;
    let secondBestScore: number | null = null;

    for (const order of candidateOrders) {
      if (usedOrderIds.has(order.orderId)) continue;

      const timeDeltaMs = Math.abs(feeTime - new Date(order.issued).getTime());
      if (timeDeltaMs > TIME_TOLERANCE_MS) continue;

      const expectedFee = order.price * order.volumeTotal * (brokerFeePct / 100);
      if (expectedFee <= 0) continue;
      const amountDeltaPct = Math.abs(expectedFee - feeAbs) / expectedFee;
      if (amountDeltaPct > AMOUNT_TOLERANCE_PCT) continue;

      const score = timeDeltaMs / 1000 + amountDeltaPct * 1000;
      if (!best || score < best.score) {
        secondBestScore = best?.score ?? null;
        best = { order, score };
      } else if (secondBestScore === null || score < secondBestScore) {
        secondBestScore = score;
      }
    }

    if (!best) {
      unmatched.push({ journalId: fee.journalId, date: fee.date, amount: feeAbs, reason: "no_candidate" });
      continue;
    }
    if (secondBestScore !== null && secondBestScore - best.score < AMBIGUITY_MARGIN * Math.max(best.score, 1)) {
      unmatched.push({ journalId: fee.journalId, date: fee.date, amount: feeAbs, reason: "ambiguous" });
      continue;
    }

    usedOrderIds.add(best.order.orderId);
    matched.push({
      journalId: fee.journalId,
      orderId: best.order.orderId,
      typeId: best.order.typeId,
      amount: feeAbs,
      classification: classify(best.order),
    });
  }

  const newListingTotal = matched
    .filter((m) => m.classification === "new_listing")
    .reduce((sum, m) => sum + m.amount, 0);
  const relistTotal = matched.filter((m) => m.classification === "relist").reduce((sum, m) => sum + m.amount, 0);
  const unmatchedTotal = unmatched.reduce((sum, u) => sum + u.amount, 0);

  return { matched, unmatched, newListingTotal, relistTotal, unmatchedTotal };
}

/**
 * Estimates the character's actual effective broker fee rate from their own
 * paid-fee history, instead of requiring it to be known/passed in. No game-
 * mechanics formula involved (base%, Broker Relations skill, standings) —
 * those can drift with balance patches and need their own ESI scope
 * (standings) this server doesn't currently request. Instead: find fee/order
 * pairs that are unambiguous on their own terms (exactly one order near the
 * fee, and that order isn't itself competing for another nearby fee), derive
 * the observed rate for each, and take the median — self-correcting if
 * skills or standings ever change, with no formula to keep in sync.
 */

// Tighter than the general matching window in matchBrokerFees — here we only
// want near-certain 1:1 pairs to trust as ground truth, not merely plausible ones.
const RATE_ESTIMATION_TIME_TOLERANCE_MS = 5_000;
const MIN_SAMPLES_FOR_ESTIMATE = 3;

export interface FeeRateObservation {
  orderId: number;
  observedPct: number;
}

export interface FeeRateEstimate {
  estimatedPct: number | null;
  sampleCount: number;
  observations: FeeRateObservation[];
}

export function estimateBrokerFeePct(fees: BrokerFeeEntry[], orders: OrderRecord[]): FeeRateEstimate {
  const observations: FeeRateObservation[] = [];

  for (const fee of fees) {
    const feeTime = new Date(fee.date).getTime();
    const nearbyOrders = orders.filter(
      (o) => Math.abs(feeTime - new Date(o.issued).getTime()) <= RATE_ESTIMATION_TIME_TOLERANCE_MS
    );
    if (nearbyOrders.length !== 1) continue;

    const order = nearbyOrders[0];
    const orderTime = new Date(order.issued).getTime();
    const nearbyFees = fees.filter(
      (f) => Math.abs(new Date(f.date).getTime() - orderTime) <= RATE_ESTIMATION_TIME_TOLERANCE_MS
    );
    if (nearbyFees.length !== 1) continue;

    const orderValue = order.price * order.volumeTotal;
    if (orderValue <= 0) continue;

    observations.push({ orderId: order.orderId, observedPct: (Math.abs(fee.amount) / orderValue) * 100 });
  }

  if (observations.length < MIN_SAMPLES_FOR_ESTIMATE) {
    return { estimatedPct: null, sampleCount: observations.length, observations };
  }

  const sorted = [...observations].sort((a, b) => a.observedPct - b.observedPct);
  const mid = Math.floor(sorted.length / 2);
  const estimatedPct =
    sorted.length % 2 === 0 ? (sorted[mid - 1].observedPct + sorted[mid].observedPct) / 2 : sorted[mid].observedPct;

  return { estimatedPct, sampleCount: observations.length, observations };
}

// ---------------------------------------------------------------------------
// Exit-fee attribution: the listing/relisting fees a sale (or a still-open
// lot) actually incurred, attributed to the position it was spent to sell.
// ---------------------------------------------------------------------------

// ESI exposes no direct link between a market transaction and the order that
// filled it (journal context_id for market_transaction rows is the type_id,
// not the order id), so attribution is a timestamp heuristic: a station
// trader runs one live sell listing per type at a time, so the sell order of
// that type with the latest `issued` <= the transaction's date is the
// listing it filled through. Multiple simultaneous same-type listings
// (split inventory) would degrade this — flagged as a known approximation.

export interface ExitFeeSale {
  transactionId: number;
  date: string;
  typeId: number;
  quantity: number;
}

export interface ExitFeeAttribution {
  /** Listing fees of the position's campaign up to and including the listing
   *  this sale filled through, allocated per unit sold. Fees from listings
   *  placed AFTER the sale are deliberately excluded — they sold other units. */
  total: number;
  /** The relisting portion of `total` — everything except the campaign's
   *  initial listing fee. This is the churn cost of getting this position sold. */
  relisting: number;
}

export interface ExitFeeAttributionResult {
  perSale: Map<number, ExitFeeAttribution>;
  unattributed: Array<{ transactionId: number; typeId: number; reason: "no_listing_at_time" }>;
}

export function attributeExitFees(
  orders: OrderRecord[],
  orderFees: Map<number, number>,
  sales: ExitFeeSale[]
): ExitFeeAttributionResult {
  const sellOrdersByType = new Map<number, OrderRecord[]>();
  for (const o of orders) {
    if (o.isBuyOrder) continue;
    const arr = sellOrdersByType.get(o.typeId) ?? [];
    arr.push(o);
    sellOrdersByType.set(o.typeId, arr);
  }
  for (const arr of sellOrdersByType.values()) {
    arr.sort((a, b) => a.issued.localeCompare(b.issued) || a.orderId - b.orderId);
  }

  const perSale = new Map<number, ExitFeeAttribution>();
  const unattributed: ExitFeeAttributionResult["unattributed"] = [];

  for (const sale of sales) {
    const chain = sellOrdersByType.get(sale.typeId) ?? [];

    // The listing live at sale time: latest order issued at/before the sale.
    let liveIdx = -1;
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].issued <= sale.date) liveIdx = i;
      else break;
    }
    if (liveIdx === -1) {
      unattributed.push({ transactionId: sale.transactionId, typeId: sale.typeId, reason: "no_listing_at_time" });
      continue;
    }

    // The campaign this sale belongs to starts after the last order that
    // fully filled before it (a fulfilled order closed out the previous
    // position; cancelled/expired relists after it are this campaign).
    let campaignStart = 0;
    for (let i = liveIdx - 1; i >= 0; i--) {
      if (chain[i].state === "fulfilled") {
        campaignStart = i + 1;
        break;
      }
    }

    // Cumulative fees of the campaign up to and including the live listing,
    // split into the initial listing fee vs the relisting churn after it.
    let campaignFees = 0;
    let relistingFees = 0;
    for (let i = campaignStart; i <= liveIdx; i++) {
      const fee = orderFees.get(chain[i].orderId) ?? 0;
      campaignFees += fee;
      if (i > campaignStart) relistingFees += fee;
    }

    // The fees were paid to move the live listing's volume; allocate per unit.
    const volume = Math.max(chain[liveIdx].volumeTotal, 1);
    perSale.set(sale.transactionId, {
      total: (campaignFees / volume) * sale.quantity,
      relisting: (relistingFees / volume) * sale.quantity,
    });
  }

  return { perSale, unattributed };
}

export interface OpenChainSunkFees {
  typeId: number;
  /** The currently-live listing this churn is attached to. */
  liveOrderId: number | null;
  /** Listing + relisting fees sunk so far into getting this position sold. */
  total: number;
  /** The relisting portion of `total`. */
  relisting: number;
  /** Sunk fees per unit of the live listing's volume — the per-lot exit cost. */
  perUnit: number;
  perUnitRelisting: number;
  orderCount: number;
}

/**
 * For each type with an unsold position still being worked: the fees sunk
 * into its listing campaign so far (initial listing + every relist). A
 * "campaign" is the run of cancelled/expired/open sell orders since the
 * type's last fully-filled order — each relist in that run was paid to move
 * the same still-unsold inventory. Types whose last orders all fulfilled
 * (nothing left to churn) get no entry.
 */
export function computeOpenChainSunkFees(
  orders: OrderRecord[],
  orderFees: Map<number, number>
): Map<number, OpenChainSunkFees> {
  const sellOrdersByType = new Map<number, OrderRecord[]>();
  for (const o of orders) {
    if (o.isBuyOrder) continue;
    const arr = sellOrdersByType.get(o.typeId) ?? [];
    arr.push(o);
    sellOrdersByType.set(o.typeId, arr);
  }

  const result = new Map<number, OpenChainSunkFees>();
  for (const [typeId, chain] of sellOrdersByType) {
    chain.sort((a, b) => a.issued.localeCompare(b.issued) || a.orderId - b.orderId);

    // Trailing campaign: everything after the last fulfilled order.
    let lastFulfilled = -1;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].state === "fulfilled") {
        lastFulfilled = i;
        break;
      }
    }
    const campaign = chain.slice(lastFulfilled + 1);
    if (campaign.length === 0) continue; // position sold out — no churn to carry

    let total = 0;
    let relisting = 0;
    for (let i = 0; i < campaign.length; i++) {
      const fee = orderFees.get(campaign[i].orderId) ?? 0;
      total += fee;
      if (i > 0) relisting += fee;
    }
    const live = campaign[campaign.length - 1];
    const volume = Math.max(live.volumeTotal, 1);
    result.set(typeId, {
      typeId,
      liveOrderId: live.state === "open" ? live.orderId : null,
      total,
      relisting,
      perUnit: total / volume,
      perUnitRelisting: relisting / volume,
      orderCount: campaign.length,
    });
  }
  return result;
}
