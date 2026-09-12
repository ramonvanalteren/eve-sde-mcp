// Candidate screening for scan_builds — the discovery half of the industry
// tooling. Verification (price_build / computeBuildMargin) decides; this
// module only RANKS candidates cheaply so the live verification can spend
// its order-book calls on the plausible few.
//
// Screening basis: ESI /markets/prices "adjusted" prices — blended,
// system-wide, deliberately coarse. A screen hit is a candidate, never a
// verdict; scan_builds live-verifies its top output before reporting it.

import { applyMaterialEfficiency } from "./build-margin.js";

export interface ScanBlueprint {
  blueprintTypeId: number;
  blueprintName: string;
  productTypeId: number;
  productName: string;
  productQtyPerRun: number;
  materials: Array<{ typeId: number; name: string; qtyPerRun: number }>;
}

export interface ScreenedCandidate {
  blueprintTypeId: number;
  blueprintName: string;
  productTypeId: number;
  productName: string;
  /** Materials-only unit cost at adjusted prices (no installation). */
  screenUnitCost: number | null;
  /** Product adjusted price net of tax + broker. */
  screenNet: number | null;
  screenMarginPct: number | null;
  /** Cost concentration — top materials by share of screen cost. */
  costShare: Array<{ name: string; pct: number }>;
  /** True when any material or the product lacks an adjusted price — screen numbers are partial. */
  incomplete: boolean;
}

export interface ScreenInput {
  blueprints: ScanBlueprint[];
  /** ESI /markets/prices adjusted_price keyed by typeId. */
  adjustedPrices: Map<number, number>;
  meLevel: number;
  salesTaxPct: number;
  brokerFeePct: number;
  minMarginPct: number;
  topN: number;
}

export function screenBuilds(input: ScreenInput): ScreenedCandidate[] {
  const netFraction = 1 - input.salesTaxPct / 100 - input.brokerFeePct / 100;

  const candidates: ScreenedCandidate[] = [];
  for (const bp of input.blueprints) {
    const productPrice = input.adjustedPrices.get(bp.productTypeId);
    let incomplete = productPrice === undefined;

    const lineItems: Array<{ name: string; cost: number | null }> = [];
    let materialCostPerRun = 0;
    for (const m of bp.materials) {
      const price = input.adjustedPrices.get(m.typeId);
      if (price === undefined) {
        incomplete = true;
        lineItems.push({ name: m.name, cost: null });
        continue;
      }
      const qty = applyMaterialEfficiency(m.qtyPerRun, input.meLevel);
      const cost = qty * price;
      materialCostPerRun += cost;
      lineItems.push({ name: m.name, cost });
    }

    const screenUnitCost =
      bp.productQtyPerRun > 0 ? materialCostPerRun / bp.productQtyPerRun : null;
    const screenNet = productPrice !== undefined ? productPrice * netFraction : null;

    const screenMarginPct =
      screenUnitCost !== null && screenNet !== null && screenUnitCost > 0
        ? ((screenNet - screenUnitCost) / screenUnitCost) * 100
        : null;

    const costShare = lineItems
      .filter((li) => li.cost !== null && materialCostPerRun > 0)
      .map((li) => ({ name: li.name, pct: ((li.cost as number) / materialCostPerRun) * 100 }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 3);

    candidates.push({
      blueprintTypeId: bp.blueprintTypeId,
      blueprintName: bp.blueprintName,
      productTypeId: bp.productTypeId,
      productName: bp.productName,
      screenUnitCost,
      screenNet,
      screenMarginPct,
      costShare,
      incomplete,
    });
  }

  return candidates
    .filter((c) => c.screenMarginPct !== null && c.screenMarginPct >= input.minMarginPct)
    .sort((a, b) => (b.screenMarginPct as number) - (a.screenMarginPct as number))
    .slice(0, input.topN);
}

/** Average daily traded volume over the most recent `days` history entries. */
export function averageDailyVolume(
  history: Array<{ date: string; volume: number }>,
  days = 30
): number {
  if (history.length === 0) return 0;
  const recent = history.slice(-days);
  return recent.reduce((s, h) => s + h.volume, 0) / recent.length;
}
