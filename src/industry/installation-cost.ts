// Manufacturing job installation-cost estimate — price_build's default when
// the caller doesn't pass the real in-client install number.
//
// Formula, verified 2026-09 against the EVE University wiki's Manufacturing
// page ("Total job cost = Estimated item value × ((System cost index ×
// Structure bonuses) + Facility tax + SCC surcharge + Alpha clone tax)")
// and eve-industry.org's community formulas PDF (Qoi), whose more granular
// treatment confirms EIV uses BASE (ME 0) material quantities, not the
// ME-adjusted per-job ones — EIV is CCP's own standardized valuation for
// job-cost/tax purposes and is unaffected by the blueprint's ME level:
//
//   EIV = sum(baseQuantityPerRun × material adjusted_price) × runs
//   installationCost = EIV × (systemCostIndex + sccSurchargePct/100 + facilityTaxPct/100)
//
// System cost index is the "manufacturing" activity's index at the pricing
// system (ESI /industry/systems/, already fetched by get_structure and
// get_industry_cost_indices — reused here, not duplicated). SCC surcharge
// is a flat rate on all industry jobs. Facility tax is fixed for NPC
// stations; a player structure's tax is owner-set and unknowable from ESI,
// so it's left out entirely rather than assumed — same "never guess" policy
// as structure ME/TE bonuses (see build-margin.ts).
//
// Not modelled: structure rig bonuses to system cost index (ESI exposes
// none — same gap as ME/TE structure bonuses).

/** Flat surcharge on all industry jobs, regardless of location. */
export const SCC_SURCHARGE_PCT = 4;

/** Facility tax at NPC stations. Player-structure tax is owner-set and unknowable — never assumed. */
export const NPC_STATION_FACILITY_TAX_PCT = 0.25;

export interface EivMaterial {
  /** Base (ME 0) quantity per run, straight from industryActivityMaterials — NOT the ME-adjusted job quantity. */
  qtyPerRun: number;
  /** ESI /markets/prices/ adjusted_price for this material; null if unavailable. */
  adjustedPrice: number | null;
}

export interface InstallationCostEstimate {
  /** Estimated Item Value: base material cost at adjusted prices, for the full run count. */
  eiv: number;
  systemCostIndex: number;
  facilityTaxPct: number;
  sccSurchargePct: number;
  totalCost: number;
  /** Materials with no adjusted_price available — EIV (and so the estimate) is understated by that much. */
  missingAdjustedPriceCount: number;
}

/**
 * Estimate a manufacturing job's installation cost. `isNpcStation` controls
 * whether the NPC facility-tax term is included — a player structure's tax
 * is owner-set and not modelled, so it's simply omitted (not assumed to be
 * zero in spirit, just absent from a number that's already an estimate).
 */
export function estimateInstallationCost(
  materials: EivMaterial[],
  runs: number,
  systemCostIndex: number,
  isNpcStation: boolean
): InstallationCostEstimate {
  let eivPerRun = 0;
  let missingAdjustedPriceCount = 0;
  for (const m of materials) {
    if (m.adjustedPrice === null) {
      missingAdjustedPriceCount++;
      continue;
    }
    eivPerRun += m.qtyPerRun * m.adjustedPrice;
  }
  const eiv = eivPerRun * runs;
  const facilityTaxPct = isNpcStation ? NPC_STATION_FACILITY_TAX_PCT : 0;
  const totalCost = eiv * (systemCostIndex + SCC_SURCHARGE_PCT / 100 + facilityTaxPct / 100);

  return {
    eiv,
    systemCostIndex,
    facilityTaxPct,
    sccSurchargePct: SCC_SURCHARGE_PCT,
    totalCost,
    missingAdjustedPriceCount,
  };
}
