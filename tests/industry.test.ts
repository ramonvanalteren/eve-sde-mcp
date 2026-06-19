import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";

afterAll(() => closeDatabase());

describe("industry queries", () => {
  it("finds Rifter blueprint", () => {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT iap.typeID as blueprintTypeID, bp.typeName as blueprintName,
                iap.productTypeID, p.typeName as productName
         FROM industryActivityProducts iap
         JOIN invTypes bp ON iap.typeID = bp.typeID
         JOIN invTypes p ON iap.productTypeID = p.typeID
         WHERE p.typeName = 'Rifter'`
      )
      .all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].blueprintName).toContain("Rifter");
  });

  it("gets blueprint activities", () => {
    const db = getDatabase();
    // Rifter Blueprint is typeID 691
    const activities = db
      .prepare("SELECT activityID, time FROM industryActivity WHERE typeID = 691")
      .all() as any[];
    expect(activities.length).toBeGreaterThan(0);
    const activityIds = activities.map((a) => a.activityID);
    expect(activityIds).toContain(1); // Manufacturing
  });

  it("gets blueprint materials", () => {
    const db = getDatabase();
    const materials = db
      .prepare(
        `SELECT iam.materialTypeID, t.typeName, iam.quantity
         FROM industryActivityMaterials iam
         JOIN invTypes t ON iam.materialTypeID = t.typeID
         WHERE iam.typeID = 688 AND iam.activityID = 1`
      )
      .all() as any[];
    expect(materials.length).toBeGreaterThan(0);
    const names = materials.map((m) => m.typeName);
    expect(names).toContain("Tritanium");
  });

  it("gets blueprint skills", () => {
    const db = getDatabase();
    const skills = db
      .prepare(
        `SELECT ias.skillID, t.typeName, ias.level
         FROM industryActivitySkills ias
         JOIN invTypes t ON ias.skillID = t.typeID
         WHERE ias.typeID = 688`
      )
      .all();
    expect(skills.length).toBeGreaterThan(0);
  });
});
