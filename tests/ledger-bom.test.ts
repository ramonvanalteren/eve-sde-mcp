import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

// The ledger singleton points at a throwaway file for this suite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bom-test-"));
process.env.EVE_SDE_LEDGER_PATH = path.join(TMP, "ledger.db");

import { getLedgerDb } from "../src/ledger/db.js";
import { applyPendingBomJobs, productionSummaryForWindow } from "../src/ledger/bom-close.js";
import { buildJobBom, applyJobToLots } from "../src/industry/bom.js";

const CHAR = 2118793551;

// Damage Control I Blueprint (2047): 1062 Trit, 2 Pyerite, 53 Mex per run —
// the founding audit's dead line. Her real Trit lot costs from 2026-09-11.
function seedMaterialLots(db: Database.Database) {
  const insert = db.prepare(`
    INSERT INTO lots (buy_transaction_id, character_id, type_id, date, original_qty, remaining_qty, unit_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Tritanium: two lots, 3.81 then 3.95 (oldest-first consumption)
  insert.run(6900000001, CHAR, 34, "2026-09-11T22:10:59Z", 200000, 200000, 3.81);
  insert.run(6900000002, CHAR, 34, "2026-09-11T22:13:12Z", 300000, 300000, 3.95);
  // Pyerite
  insert.run(6900000003, CHAR, 35, "2026-09-11T22:10:59Z", 50000, 50000, 17.96);
  // Mexallon: deliberately short (mined/refined gap) — 400 runs need 21,200
  insert.run(6900000004, CHAR, 36, "2026-09-11T22:10:59Z", 10000, 10000, 50.78);
}

function seedDeliveredJob(db: Database.Database, jobId: number, completedDate: string) {
  db.prepare(`
    INSERT INTO industry_jobs
      (job_id, character_id, activity_id, blueprint_type_id, product_type_id, runs, successful_runs, cost, start_date, end_date, completed_date, status, facility_id, bom_applied)
    VALUES (?, ?, 1, 2047, 2046, 400, 400, 182576, '2026-09-11T22:23:01Z', '2026-09-14T05:26:11Z', ?, 'delivered', 1051816770275, 0)`)
    .run(jobId, CHAR, completedDate);
}

describe("pure applyJobToLots — the founding audit's numbers", () => {
  const bom = buildJobBom(
    [
      { typeId: 34, name: "Tritanium", qtyPerRun: 1062 },
      { typeId: 35, name: "Pyerite", qtyPerRun: 2 },
      { typeId: 36, name: "Mexallon", qtyPerRun: 53 },
    ],
    1,
    0
  );

  it("consumes materials FIFO oldest-first and prices the product lot at all-in basis", () => {
    const applied = applyJobToLots({
      jobId: 671226812,
      productTypeId: 2046,
      completedDate: "2026-09-14T05:26:11Z",
      runs: 400,
      bom,
      installationCost: 182576,
      materialLots: [
        { id: 1, typeId: 34, date: "a", remainingQty: 200000, unitCost: 3.81 },
        { id: 2, typeId: 34, date: "b", remainingQty: 300000, unitCost: 3.95 },
        { id: 3, typeId: 35, date: "a", remainingQty: 50000, unitCost: 17.96 },
        { id: 4, typeId: 36, date: "a", remainingQty: 30000, unitCost: 50.78 },
      ],
    });
    // 424,800 Trit: 200k @ 3.81 + 224,800 @ 3.95
    const expectedTrit = 200000 * 3.81 + 224800 * 3.95;
    // 800 Pyerite @ 17.96; 21,200 Mex @ 50.78 (all matched here)
    const expected = expectedTrit + 800 * 17.96 + 21200 * 50.78;
    expect(applied.productQty).toBe(400);
    expect(applied.materialsCostMatched).toBeCloseTo(expected, 0);
    expect(applied.productLot.id).toBe(-671226812);
    expect(applied.productLot.unitCost).toBeCloseTo((expected + 182576) / 400, 0);
    // Selling at the audit's net (7,491) realizes ~+182/unit on these lots —
    // the dead line: healthy-looking sale price, near-zero margin
    expect(7491 - applied.productLot.unitCost).toBeGreaterThan(150);
    expect(7491 - applied.productLot.unitCost).toBeLessThan(210);
    // The first Trit lot is fully consumed, the second drawn down
    const lot1 = applied.updatedLots.find((l) => l.id === 1)!;
    const lot2 = applied.updatedLots.find((l) => l.id === 2)!;
    expect(lot1.remainingQty).toBe(0);
    expect(lot2.remainingQty).toBe(75200);
    expect(applied.materialsCostMissing).toEqual([]);
  });

  it("flags materials with no buy basis instead of guessing a cost", () => {
    const applied = applyJobToLots({
      jobId: 1,
      productTypeId: 2046,
      completedDate: "d",
      runs: 1,
      bom,
      installationCost: 0,
      materialLots: [{ id: 1, typeId: 34, date: "a", remainingQty: 10, unitCost: 4 }],
    });
    // 1062 Trit wanted, 10 available → 1052 missing; Pyerite and Mexallon have
    // no lots at all → fully missing
    expect(applied.materialsCostMissing).toEqual([
      { typeId: 34, quantity: 1052 },
      { typeId: 35, quantity: 2 },
      { typeId: 36, quantity: 53 },
    ]);
    expect(applied.consumptions.some((c) => c.unmatched)).toBe(true);
  });

  it("ME reduces consumed quantities", () => {
    const me0 = buildJobBom([{ typeId: 34, name: "Tritanium", qtyPerRun: 1000 }], 1, 0);
    const me10 = buildJobBom([{ typeId: 34, name: "Tritanium", qtyPerRun: 1000 }], 1, 10);
    expect(me10.materials[0].qtyPerRunAdjusted).toBe(900);
    expect(me0.materials[0].qtyPerRunAdjusted).toBe(1000);
  });
});

describe("ledger integration — applyPendingBomJobs + production section", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = getLedgerDb();
    seedMaterialLots(db);
    seedDeliveredJob(db, 671226812, "2026-09-14T05:26:11Z");
  });

  afterAll(() => {
    try { db.close(); } catch { /* already closed by other suites? */ }
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.EVE_SDE_LEDGER_PATH;
  });

  it("applies the delivered job once: material lots drawn down, product lot created, job marked", () => {
    const result = applyPendingBomJobs(CHAR);
    expect(result.jobsApplied).toBe(1);
    expect(result.skipped).toEqual([]);

    const trit1 = db.prepare(`SELECT remaining_qty FROM lots WHERE buy_transaction_id = ?`).get(6900000001) as { remaining_qty: number };
    expect(trit1.remaining_qty).toBe(0);
    const productLot = db.prepare(`SELECT * FROM lots WHERE buy_transaction_id = ?`).get(-671226812) as {
      type_id: number; remaining_qty: number; unit_cost: number;
    };
    expect(productLot.type_id).toBe(2046);
    expect(productLot.remaining_qty).toBe(400);
    // Trit+Pye fully matched, Mexallon only 10k of 21.2k → basis understated:
    // (2,172,128 matched materials + 182,576 install) / 400 = 5,886.76
    expect(productLot.unit_cost).toBeCloseTo(5886.76, 1);

    // Production consumption rows are marked is_production and excluded from sale pricing
    const prodRows = db.prepare(`SELECT * FROM lot_consumptions WHERE is_production = 1 AND sell_transaction_id = ?`).all(-671226812);
    expect(prodRows.length).toBe(5); // Trit×2 (two lots) + Pyerite + Mexallon matched + Mexallon missing
    expect(prodRows.every((r: any) => r.unit_sell_price === 0)).toBe(true);

    // Idempotent: re-running applies nothing
    const again = applyPendingBomJobs(CHAR);
    expect(again.jobsApplied).toBe(0);
  });

  it("reports the production section for the delivery window", () => {
    const summary = productionSummaryForWindow(CHAR, "2026-09-14T00:00:00.000Z", "2026-09-15T00:00:00.000Z");
    expect(summary.jobsDelivered.length).toBe(1);
    const job = summary.jobsDelivered[0];
    expect(job.productTypeId).toBe(2046);
    expect(job.unitsProduced).toBe(400);
    expect(job.installationCost).toBe(182576);
    expect(job.unitBasis).toBeCloseTo(5886.76, 1);
    // Mexallon was short (21,200 needed, 10,000 available) → 11,200 missing basis
    expect(job.missingBasis).toEqual([{ typeId: 36, quantity: 11200 }]);
    expect(summary.missingBasisUnits).toBe(11200);
    expect(summary.notes.length).toBeGreaterThan(0);
  });

  it("a product sell consumes the synthetic lot and realizes at real basis", async () => {
    // Simulate: 400 units sold at 7,877 gross through the pending-transaction path
    db.prepare(`
      INSERT INTO wallet_transactions
        (transaction_id, character_id, date, type_id, quantity, unit_price, is_buy, fifo_applied)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)`)
      .run(6900000999, CHAR, "2026-09-14T06:00:00Z", 2046, 400, 7877);
    const { applyPendingFifo } = await import("../src/ledger/close.js");
    applyPendingFifo(CHAR);

    const consumed = db.prepare(`
      SELECT buy_transaction_id, quantity, unit_cost, unit_sell_price, unmatched, is_production
      FROM lot_consumptions WHERE sell_transaction_id = 6900000999`).all() as any[];
    expect(consumed.length).toBe(1);
    expect(consumed[0].buy_transaction_id).toBe(-671226812);
    expect(consumed[0].is_production).toBe(0);
    expect(consumed[0].unmatched).toBe(0);
    // Revenue 400 × 7,877 minus COGS 400 × 5,886.76 — real basis realized
    const profit = 400 * consumed[0].unit_sell_price - 400 * consumed[0].unit_cost;
    expect(profit).toBeCloseTo(400 * (7877 - 5886.76), 0);
  });
});
