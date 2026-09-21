// Build-margin math for price_build — the industry counterpart of the
// trading skill's margin-verification discipline. Born from the 2026-09
// production audit: 5 of 6 active lines healthy, but a 400-run Damage
// Control I job had been committed at +0.9% margin — a dead line that
// verification would have caught before the runs were scheduled.
//
// Pure functions only: SDE blueprint data and live market prices arrive
// as inputs, so every number here is testable offline.
//
// Two-sided discipline (mirrors eve-trading's two-call margin rule):
//   - SELL basis   = materials at their best SELL orders (instant acquisition)
//   - BUY basis    = materials at their best BUY orders (patient acquisition
//                    via your own buy orders)
// and revenue is always the product's best sell, net of sales tax + broker
// fee (the cost of listing on the sell side). Margins are reported on both
// acquisition bases; the sell basis is the conservative one.

export interface BuildMaterialInput {
  name: string;
  typeId: number;
  /** Base quantity per run (before ME). */
  qtyPerRun: number;
}

export interface PriceQuote {
  bestSell: number | null;
  bestBuy: number | null;
  sellOrderCount: number;
  buyOrderCount: number;
}

export interface BuildMarginInput {
  product: { name: string; typeId: number; quantityPerRun: number };
  materials: BuildMaterialInput[];
  runs: number;
  /** Blueprint ME level 0-10 (T1 BPO). 0 = base quantities. */
  meLevel: number;
  /** Live price quotes keyed by typeId, for product AND materials. */
  prices: Map<number, PriceQuote>;
  salesTaxPct: number;
  brokerFeePct: number;
  /** Total installation cost for ALL runs (the in-client install number), optional. */
  installationCostTotal?: number | null;
}

export interface BuildMarginReport {
  runs: number;
  meLevel: number;
  totalProducts: number;
  materials: Array<{
    name: string;
    typeId: number;
    qtyPerRunBase: number;
    /** totalQty / runs — the per-job total averaged per run (may be fractional). */
    qtyPerRunAdjusted: number;
    /** Units the whole job consumes (ME applied per job, not per run). */
    totalQty: number;
    bestSell: number | null;
    bestBuy: number | null;
    sellOrderCount: number;
    /** qty × best sell, summed over runs (null when no sell orders). */
    totalCostAtSell: number | null;
    totalCostAtBuy: number | null;
  }>;
  productQuote: PriceQuote;
  costs: {
    materialsAtSell: number | null;
    materialsAtBuy: number | null;
    installation: number;
    /** Per finished unit, sell basis (materials + install) — null when any material has no sell orders. */
    unitCostAtSell: number | null;
    unitCostAtBuy: number | null;
  };
  revenue: {
    grossPerUnit: number | null;
    /** Gross net of sales tax + broker fee — what a sell-side listing actually pays. */
    netPerUnit: number | null;
    netTotal: number | null;
  };
  margins: {
    atSellBasis: { profitPerUnit: number | null; profitTotal: number | null; marginPct: number | null };
    atBuyBasis: { profitPerUnit: number | null; profitTotal: number | null; marginPct: number | null };
  };
  warnings: string[];
}

/** Total units of one material a manufacturing JOB consumes. EVE applies ME
 *  per job, not per run: max(runs, ceil(round(runs × base × (1 − ME%), 2))) —
 *  rounded up once over the whole job, with a floor of 1 unit per run. The
 *  inner round(…, 2) strips float noise (400 × 0.92 = 368.00000000000006 in JS,
 *  which a bare ceil would push to 369). Structure/facility modifiers, which
 *  multiply into the same factor in-game, are not modelled (the SDE has none). */
export function jobMaterialQuantity(qtyPerRun: number, runs: number, meLevel: number): number {
  const factor = 1 - Math.min(Math.max(meLevel, 0), 10) / 100;
  const raw = Math.round(runs * qtyPerRun * factor * 100) / 100;
  return Math.max(runs, Math.ceil(raw));
}

export function computeBuildMargin(input: BuildMarginInput): BuildMarginReport {
  const warnings: string[] = [];

  const totalProducts = input.product.quantityPerRun * input.runs;

  const materials = input.materials.map((m) => {
    const quote = input.prices.get(m.typeId);
    const totalQty = jobMaterialQuantity(m.qtyPerRun, input.runs, input.meLevel);
    // Effective per-run average of the per-job total — can be fractional.
    const qtyPerRunAdjusted = input.runs > 0 ? totalQty / input.runs : m.qtyPerRun;
    const bestSell = quote?.bestSell ?? null;
    const bestBuy = quote?.bestBuy ?? null;
    return {
      name: m.name,
      typeId: m.typeId,
      qtyPerRunBase: m.qtyPerRun,
      qtyPerRunAdjusted,
      totalQty,
      bestSell,
      bestBuy,
      sellOrderCount: quote?.sellOrderCount ?? 0,
      totalCostAtSell: bestSell !== null ? totalQty * bestSell : null,
      totalCostAtBuy: bestBuy !== null ? totalQty * bestBuy : null,
    };
  });

  for (const m of materials) {
    if (m.bestSell === null) {
      warnings.push(`Material "${m.name}" has no sell orders at the pricing location — sell-basis cost is understated (missing).`);
    }
    if (m.bestBuy === null) {
      warnings.push(`Material "${m.name}" has no buy orders at the pricing location — buy-basis cost is understated (missing).`);
    }
  }

  const materialsAtSell = materials.every((m) => m.totalCostAtSell !== null)
    ? (materials.reduce((s, m) => s + (m.totalCostAtSell ?? 0), 0))
    : null;
  const materialsAtBuy = materials.every((m) => m.totalCostAtBuy !== null)
    ? (materials.reduce((s, m) => s + (m.totalCostAtBuy ?? 0), 0))
    : null;

  const installation = input.installationCostTotal ?? 0;
  if (input.installationCostTotal == null) {
    warnings.push(
      "Installation cost not provided — margins are materials-only. Index + facility tax typically adds low-single-digit % of material value; pass the in-client install number for exact figures."
    );
  }

  const productQuote = input.prices.get(input.product.typeId) ?? {
    bestSell: null,
    bestBuy: null,
    sellOrderCount: 0,
    buyOrderCount: 0,
  };
  if (productQuote.bestSell === null) {
    warnings.push("Product has no sell orders at the pricing location — sell-side revenue unavailable.");
  }
  if (productQuote.sellOrderCount > 0 && productQuote.sellOrderCount <= 5 && totalProducts > 0) {
    warnings.push(
      `Thin product book (${productQuote.sellOrderCount} sell orders) — placing ${totalProducts} units may undercut deeply; verify against the full order stack before trusting the top-of-book price.`
    );
  }

  const netFraction = 1 - input.salesTaxPct / 100 - input.brokerFeePct / 100;

  const grossPerUnit = productQuote.bestSell;
  const netPerUnit = grossPerUnit !== null ? grossPerUnit * netFraction : null;
  const netTotal = netPerUnit !== null ? netPerUnit * totalProducts : null;

  const unitCostAtSell =
    materialsAtSell !== null && totalProducts > 0 ? (materialsAtSell + installation) / totalProducts : null;
  const unitCostAtBuy =
    materialsAtBuy !== null && totalProducts > 0 ? (materialsAtBuy + installation) / totalProducts : null;

  const marginFor = (unitCost: number | null) => {
    if (unitCost === null || netPerUnit === null) {
      return { profitPerUnit: null, profitTotal: null, marginPct: null };
    }
    const profitPerUnit = netPerUnit - unitCost;
    return {
      profitPerUnit,
      profitTotal: profitPerUnit * totalProducts,
      marginPct: unitCost > 0 ? (profitPerUnit / unitCost) * 100 : null,
    };
  };

  return {
    runs: input.runs,
    meLevel: input.meLevel,
    totalProducts,
    materials,
    productQuote,
    costs: { materialsAtSell, materialsAtBuy, installation, unitCostAtSell, unitCostAtBuy },
    revenue: { grossPerUnit, netPerUnit, netTotal },
    margins: {
      atSellBasis: marginFor(unitCostAtSell),
      atBuyBasis: marginFor(unitCostAtBuy),
    },
    warnings,
  };
}
