// Bill-of-materials linkage: when a manufacturing job is DELIVERED, its
// materials (ME-adjusted) are consumed from FIFO buy lots oldest-first and
// a synthetic PRODUCT lot is created at the all-in unit basis (matched
// material cost + installation cost). Product sells then match against that
// lot like any other, so realized P&L on produced items is correct — the
// 2026-09 audit found product sells booking at zero basis and ~48M ISK of
// materials sitting as never-closing "trading positions".
//
// Conventions (shared with the ledger persistence layer):
//   - a product lot uses buy_transaction_id = -job_id (ESI transaction ids
//     are positive; the negative space never collides)
//   - material consumption rows are marked is_production=1 and carry
//     unit_sell_price = 0 — they are inventory transformation, NOT sales,
//     and the realized-P&L queries exclude them
//   - materials with no buy lot basis (mined, refined, PI-sourced) are
//     consumed at cost 0 and flagged — basis understated, never guessed
//
// ME level comes from config-first `blueprintME` (keyed by blueprint type
// id, default 0 = base quantities = conservative basis). ESI exposes no
// per-BPO ME, so the user pins the real levels; default overstates material
// use and thus understates production profit.

import { applyMaterialEfficiency } from "./build-margin.js";

export interface BomMaterial {
  typeId: number;
  name: string;
  /** Base quantity per run, straight from industryActivityMaterials. */
  qtyPerRun: number;
}

export interface JobBom {
  /** ME-adjusted quantity per run per material. */
  materials: Array<{ typeId: number; name: string; qtyPerRunAdjusted: number }>;
  /** Total units produced per run (industryActivityProducts.quantity). */
  productQtyPerRun: number;
}

/** ME-adjust a blueprint's manufacturing materials. */
export function buildJobBom(materials: BomMaterial[], productQtyPerRun: number, meLevel: number): JobBom {
  return {
    materials: materials.map((m) => ({
      typeId: m.typeId,
      name: m.name,
      qtyPerRunAdjusted: applyMaterialEfficiency(m.qtyPerRun, meLevel),
    })),
    productQtyPerRun,
  };
}

/** Minimal lot shape the BOM engine needs (mirrors the ledger's lots table). */
export interface BomLot {
  id: number;
  typeId: number;
  date: string;
  remainingQty: number;
  unitCost: number;
}

export interface BomConsumptionRow {
  /** -job_id: production consumptions share the lot_consumptions table. */
  productionJobId: number;
  materialTypeId: number;
  quantity: number;
  /** Matched cost per unit from the consumed lot; null when basis is missing. */
  unitCost: number | null;
  date: string;
  unmatched: boolean;
}

export interface AppliedJob {
  jobId: number;
  productTypeId: number;
  productQty: number;
  /** All-in cost per produced unit (matched materials + installation / units). */
  productUnitCost: number;
  materialsCostMatched: number;
  materialsCostMissing: { typeId: number; quantity: number }[];
  installationCost: number;
  /** Updated material lots (drawn down, zero-qty lots retained for audit). */
  updatedLots: BomLot[];
  /** The synthetic product lot to persist (id = -jobId). */
  productLot: BomLot;
  consumptions: BomConsumptionRow[];
}

/**
 * Consume a delivered manufacturing job's materials from open lots and
 * produce the synthetic product lot. `materialLots` must be the character's
 * open lots for the job's material types, oldest-first per type (the ledger
 * loads them that way).
 */
export function applyJobToLots(input: {
  jobId: number;
  productTypeId: number;
  completedDate: string;
  runs: number;
  bom: JobBom;
  installationCost: number;
  materialLots: BomLot[];
}): AppliedJob {
  const lots = input.materialLots.map((l) => ({ ...l }));
  const consumptions: BomConsumptionRow[] = [];
  const materialsCostMissing: { typeId: number; quantity: number }[] = [];
  let materialsCostMatched = 0;

  for (const m of input.bom.materials) {
    let remaining = m.qtyPerRunAdjusted * input.runs;
    if (remaining <= 0) continue;

    for (const lot of lots) {
      if (lot.typeId !== m.typeId || remaining <= 0) continue;
      if (lot.remainingQty <= 0) continue;
      const take = Math.min(remaining, lot.remainingQty);
      lot.remainingQty -= take;
      remaining -= take;
      materialsCostMatched += take * lot.unitCost;
      consumptions.push({
        productionJobId: input.jobId,
        materialTypeId: m.typeId,
        quantity: take,
        unitCost: lot.unitCost,
        date: input.completedDate,
        unmatched: false,
      });
    }
    if (remaining > 0) {
      // No buy basis for these units — mined, refined, or predating the
      // ledger. Consumed at cost 0, flagged, never guessed.
      materialsCostMissing.push({ typeId: m.typeId, quantity: remaining });
      consumptions.push({
        productionJobId: input.jobId,
        materialTypeId: m.typeId,
        quantity: remaining,
        unitCost: null,
        date: input.completedDate,
        unmatched: true,
      });
    }
  }

  const productQty = input.bom.productQtyPerRun * input.runs;
  const productUnitCost =
    productQty > 0 ? (materialsCostMatched + input.installationCost) / productQty : 0;

  return {
    jobId: input.jobId,
    productTypeId: input.productTypeId,
    productQty,
    productUnitCost,
    materialsCostMatched,
    materialsCostMissing,
    installationCost: input.installationCost,
    updatedLots: lots,
    productLot: {
      id: -input.jobId,
      typeId: input.productTypeId,
      date: input.completedDate,
      remainingQty: productQty,
      unitCost: productUnitCost,
    },
    consumptions,
  };
}
