// Bill-of-materials linkage for the daily close (see src/industry/bom.ts
// for the pure engine). When a manufacturing job is DELIVERED:
//   - its ME-adjusted materials are consumed from open FIFO buy lots,
//     oldest-first, recorded as is_production=1 consumption rows (NOT sales)
//   - a synthetic product lot is created at all-in unit basis
//     (matched material cost + installation / units)
// so product sells match a real cost basis and the close's realized P&L
// includes production correctly instead of excluding zero-basis revenue.
//
// ME levels are config-first (~/.eve-sde/config.json "blueprintME", keyed by
// blueprint type id): ESI exposes no per-BPO ME, so the user pins the real
// levels. Default ME 0 = base quantities = conservative basis (overstated
// material use, understated production profit) — never guessed upward.
//
// Jobs are only processed once (industry_jobs.bom_applied). Research jobs
// (ME/TE/copying) are synced but not BOM'd — their installation costs stay
// journal cashflow; the industry skill's research-payback framing handles
// the judgment.

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import path from "path";
import { homedir } from "os";
import { getDatabase } from "../database.js";
import { getLedgerDb } from "./db.js";
import { buildJobBom, applyJobToLots, type AppliedJob, type BomMaterial } from "../industry/bom.js";

export interface MeResolution {
  meLevel: number;
  source: "esi-blueprints" | "config" | "default-zero";
}

/**
 * Resolve the ME a job ran with, best source first:
 *   1. esi-blueprints — the exact BPO (job's blueprint item id) from the
 *      synced character_blueprints table. Caveat: that's the CURRENT ME of
 *      the BPO; a job installed before mid-stream research completed is
 *      slightly overstated in efficiency.
 *   2. config blueprintME (type-keyed) — the pinned level.
 *   3. 0 (base quantities, conservative basis).
 */
function resolveJobMe(
  db: Database.Database,
  blueprintItemId: number | null,
  blueprintTypeId: number
): MeResolution {
  if (blueprintItemId != null) {
    const bp = db
      .prepare(`SELECT material_efficiency FROM character_blueprints WHERE item_id = ?`)
      .get(blueprintItemId) as { material_efficiency: number } | undefined;
    if (bp) {
      return { meLevel: Math.max(0, Math.min(10, Math.round(bp.material_efficiency))), source: "esi-blueprints" };
    }
  }
  const configMe = loadBlueprintMeSettings().get(blueprintTypeId);
  if (configMe !== undefined) {
    return { meLevel: configMe, source: "config" };
  }
  return { meLevel: 0, source: "default-zero" };
}

let cachedBlueprintMe: Map<number, number> | null = null;

/** blueprintME from ~/.eve-sde/config.json — { "2047": 10, "1404": 8 }. */
export function loadBlueprintMeSettings(): Map<number, number> {
  if (cachedBlueprintMe) return cachedBlueprintMe;
  const map = new Map<number, number>();
  try {
    const configPath = path.join(homedir(), ".eve-sde", "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { blueprintME?: Record<string, number> };
    for (const [key, level] of Object.entries(raw.blueprintME ?? {})) {
      const bpTypeId = Number(key);
      if (Number.isFinite(bpTypeId) && typeof level === "number" && level >= 0 && level <= 10) {
        map.set(bpTypeId, Math.round(level));
      }
    }
  } catch {
    // No config or unparsable — every blueprint at ME 0 (conservative)
  }
  cachedBlueprintMe = map;
  return map;
}

/** Test seam for the config cache. */
export function resetBlueprintMeCache(): void {
  cachedBlueprintMe = null;
}

interface SdeBlueprint {
  materials: BomMaterial[];
  productQtyPerRun: number;
}

const sdeBlueprintCache = new Map<number, SdeBlueprint | null>();

function loadSdeBlueprint(blueprintTypeId: number): SdeBlueprint | null {
  if (sdeBlueprintCache.has(blueprintTypeId)) return sdeBlueprintCache.get(blueprintTypeId) ?? null;
  const sde = getDatabase();
  const productRow = sde
    .prepare(
      `SELECT iap.productTypeID, iap.quantity
       FROM industryActivityProducts iap
       WHERE iap.typeID = ? AND iap.activityID = 1`
    )
    .get(blueprintTypeId) as { productTypeID: number; quantity: number } | undefined;
  if (!productRow) {
    sdeBlueprintCache.set(blueprintTypeId, null);
    return null;
  }
  const materialRows = sde
    .prepare(
      `SELECT iam.materialTypeID, t.typeName, iam.quantity
       FROM industryActivityMaterials iam
       JOIN invTypes t ON t.typeID = iam.materialTypeID
       WHERE iam.typeID = ? AND iam.activityID = 1`
    )
    .all(blueprintTypeId) as Array<{ materialTypeID: number; typeName: string; quantity: number }>;
  const bp: SdeBlueprint = {
    materials: materialRows.map((m) => ({ typeId: m.materialTypeID, name: m.typeName, qtyPerRun: m.quantity })),
    productQtyPerRun: productRow.quantity,
  };
  sdeBlueprintCache.set(blueprintTypeId, bp);
  return bp;
}

export interface BomApplyResult {
  jobsApplied: number;
  jobs: AppliedJob[];
  skipped: Array<{ jobId: number; reason: string }>;
}

/**
 * Apply every delivered-but-unprocessed manufacturing job: consume materials
 * from open lots, create the synthetic product lot, mark the job processed.
 * Idempotent per job (bom_applied). Called by the close before the pending
 * FIFO pass so same-day product sells match the just-created product lot.
 */
export function applyPendingBomJobs(characterId: number): BomApplyResult {
  const db = getLedgerDb();

  const jobRows = db
    .prepare(
      `SELECT job_id, blueprint_type_id, blueprint_id, product_type_id, runs, successful_runs, cost, completed_date
       FROM industry_jobs
       WHERE character_id = ? AND activity_id = 1 AND bom_applied = 0
         AND status = 'delivered' AND completed_date IS NOT NULL
       ORDER BY completed_date, job_id`
    )
    .all(characterId) as Array<{
    job_id: number;
    blueprint_type_id: number;
    blueprint_id: number | null;
    product_type_id: number | null;
    runs: number;
    successful_runs: number | null;
    cost: number | null;
    completed_date: string;
  }>;

  const result: BomApplyResult = { jobsApplied: 0, jobs: [], skipped: [] };

  for (const job of jobRows) {
    const bp = loadSdeBlueprint(job.blueprint_type_id);
    if (!bp || job.product_type_id === null) {
      result.skipped.push({ jobId: job.job_id, reason: "no manufacturing activity in the SDE or no product" });
      db.prepare(`UPDATE industry_jobs SET bom_applied = 1 WHERE job_id = ?`).run(job.job_id);
      continue;
    }

    const effectiveRuns = job.successful_runs ?? job.runs;
    const me = resolveJobMe(db, (job as { blueprint_id?: number | null }).blueprint_id ?? null, job.blueprint_type_id);
    const bom = buildJobBom(bp.materials, bp.productQtyPerRun, me.meLevel);

    // Load the character's open lots for this job's material types, oldest-first
    const materialTypeIds = [...new Set(bom.materials.map((m) => m.typeId))];
    const placeholders = materialTypeIds.map(() => "?").join(",");
    const lotRows = db
      .prepare(
        `SELECT buy_transaction_id, type_id, date, remaining_qty, unit_cost
         FROM lots
         WHERE character_id = ? AND remaining_qty > 0 AND type_id IN (${placeholders})
         ORDER BY type_id, date, buy_transaction_id`
      )
      .all(characterId, ...materialTypeIds) as Array<{
      buy_transaction_id: number;
      type_id: number;
      date: string;
      remaining_qty: number;
      unit_cost: number;
    }>;

    const applied = applyJobToLots({
      jobId: job.job_id,
      productTypeId: job.product_type_id,
      completedDate: job.completed_date,
      runs: effectiveRuns,
      bom,
      installationCost: job.cost ?? 0,
      materialLots: lotRows.map((l) => ({
        id: l.buy_transaction_id,
        typeId: l.type_id,
        date: l.date,
        remainingQty: l.remaining_qty,
        unitCost: l.unit_cost,
      })),
    });

    persistAppliedJob(db, characterId, job.job_id, applied);
    result.jobsApplied++;
    result.jobs.push(applied);
  }

  return result;
}

function persistAppliedJob(db: Database.Database, characterId: number, jobId: number, applied: AppliedJob): void {
  const updateLot = db.prepare(`UPDATE lots SET remaining_qty = ? WHERE buy_transaction_id = ? AND character_id = ?`);
  const insertConsumption = db.prepare(`
    INSERT INTO lot_consumptions
      (character_id, sell_transaction_id, buy_transaction_id, type_id, date, quantity, unit_cost, unit_sell_price, unmatched, is_production)
    VALUES (@characterId, @sellTransactionId, @buyTransactionId, @typeId, @date, @quantity, @unitCost, @unitSellPrice, @unmatched, 1)
  `);
  const insertProductLot = db.prepare(`
    INSERT OR REPLACE INTO lots
      (buy_transaction_id, character_id, type_id, date, original_qty, remaining_qty, unit_cost)
    VALUES (@id, @characterId, @typeId, @date, @originalQty, @remainingQty, @unitCost)
  `);

  const apply = db.transaction(() => {
    for (const lot of applied.updatedLots) {
      updateLot.run(lot.remainingQty, lot.id, characterId);
    }
    for (const c of applied.consumptions) {
      insertConsumption.run({
        characterId,
        // Production rows live in lot_consumptions for the audit trail, keyed
        // by the negated job id (never a real ESI transaction id).
        sellTransactionId: -jobId,
        buyTransactionId: null,
        typeId: c.materialTypeId,
        date: c.date,
        quantity: c.quantity,
        unitCost: c.unitCost,
        unitSellPrice: 0,
        unmatched: c.unmatched ? 1 : 0,
      });
    }
    insertProductLot.run({
      id: applied.productLot.id,
      characterId,
      typeId: applied.productLot.typeId,
      date: applied.productLot.date,
      originalQty: applied.productLot.remainingQty,
      remainingQty: applied.productLot.remainingQty,
      unitCost: applied.productLot.unitCost,
    });
    db.prepare(`UPDATE industry_jobs SET bom_applied = 1 WHERE job_id = ?`).run(jobId);
  });
  apply();
}

export interface ProductionDaySummary {
  jobsDelivered: Array<{
    jobId: number;
    productName: string;
    productTypeId: number;
    unitsProduced: number;
    materialsCostMatched: number;
    installationCost: number;
    unitBasis: number;
    meLevel: number;
    meSource: MeResolution["source"];
    missingBasis: Array<{ typeId: number; quantity: number }>;
  }>;
  totalUnitsProduced: number;
  totalMaterialsCost: number;
  totalInstallationCost: number;
  totalProductBasis: number;
  missingBasisUnits: number;
  notes: string[];
}

/**
 * Production section for a close: the BOM jobs delivered inside the day's
 * window, enriched from their synthetic product lots' basis. Requires
 * applyPendingBomJobs to have run (the close calls it first).
 */
export function productionSummaryForWindow(characterId: number, start: string, end: string): ProductionDaySummary {
  const db = getLedgerDb();
  const sde = getDatabase();
  const summary: ProductionDaySummary = {
    jobsDelivered: [],
    totalUnitsProduced: 0,
    totalMaterialsCost: 0,
    totalInstallationCost: 0,
    totalProductBasis: 0,
    missingBasisUnits: 0,
    notes: [],
  };

  const jobRows = db
    .prepare(
      `SELECT job_id, blueprint_type_id, blueprint_id, product_type_id, runs, successful_runs, cost, completed_date
       FROM industry_jobs
       WHERE character_id = ? AND activity_id = 1 AND bom_applied = 1
         AND status = 'delivered' AND completed_date >= ? AND completed_date < ?
       ORDER BY completed_date, job_id`
    )
    .all(characterId, start, end) as Array<{
    job_id: number;
    blueprint_type_id: number;
    blueprint_id: number | null;
    product_type_id: number;
    runs: number;
    successful_runs: number | null;
    cost: number | null;
    completed_date: string;
  }>;

  for (const job of jobRows) {
    const productLot = db
      .prepare(`SELECT original_qty, unit_cost FROM lots WHERE buy_transaction_id = ?`)
      .get(-job.job_id) as { original_qty: number; unit_cost: number } | undefined;
    if (!productLot) continue;

    const missingRows = db
      .prepare(
        `SELECT type_id, SUM(quantity) as qty FROM lot_consumptions
         WHERE character_id = ? AND sell_transaction_id = ? AND unmatched = 1 AND is_production = 1
         GROUP BY type_id`
      )
      .all(characterId, -job.job_id) as Array<{ type_id: number; qty: number }>;

    const materialsCost = db
      .prepare(
        `SELECT SUM(quantity * unit_cost) as cost FROM lot_consumptions
         WHERE character_id = ? AND sell_transaction_id = ? AND is_production = 1`
      )
      .get(characterId, -job.job_id) as { cost: number | null };

    const productNameRow = sde
      .prepare(`SELECT typeName FROM invTypes WHERE typeID = ?`)
      .get(job.product_type_id) as { typeName: string } | undefined;

    const units = productLot.original_qty;
    const basis = units * productLot.unit_cost;
    const me = resolveJobMe(db, job.blueprint_id, job.blueprint_type_id);
    summary.jobsDelivered.push({
      jobId: job.job_id,
      productName: productNameRow?.typeName ?? `type ${job.product_type_id}`,
      productTypeId: job.product_type_id,
      unitsProduced: units,
      materialsCostMatched: materialsCost.cost ?? 0,
      installationCost: job.cost ?? 0,
      unitBasis: productLot.unit_cost,
      meLevel: me.meLevel,
      meSource: me.source,
      missingBasis: missingRows.map((m) => ({ typeId: m.type_id, quantity: m.qty })),
    });
    summary.totalUnitsProduced += units;
    summary.totalMaterialsCost += materialsCost.cost ?? 0;
    summary.totalInstallationCost += job.cost ?? 0;
    summary.totalProductBasis += basis;
    summary.missingBasisUnits += missingRows.reduce((s, m) => s + m.qty, 0);
  }

  if (summary.missingBasisUnits > 0) {
    summary.notes.push(
      `${summary.missingBasisUnits} material units were consumed with no buy-lot basis (mined, refined, PI-sourced, or bought before the ledger began) — product basis is understated accordingly. Pin blueprintME in config.json if any of this is ME guesswork.`
    );
  }
  return summary;
}
