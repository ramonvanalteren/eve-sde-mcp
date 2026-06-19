import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";

afterAll(() => closeDatabase());

describe("type queries", () => {
  it("finds Rifter by name search", () => {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT t.typeID, t.typeName, g.groupName, c.categoryName
         FROM invTypes t
         JOIN invGroups g ON t.groupID = g.groupID
         JOIN invCategories c ON g.categoryID = c.categoryID
         WHERE t.typeName LIKE ? AND t.published = 1
         LIMIT 5`
      )
      .all("%Rifter%");
    expect(rows.length).toBeGreaterThan(0);
    const rifter = (rows as any[]).find((r) => r.typeName === "Rifter");
    expect(rifter).toBeDefined();
    expect(rifter.categoryName).toBe("Ship");
  });

  it("gets dogma attributes for Rifter", () => {
    const db = getDatabase();
    const attrs = db
      .prepare(
        `SELECT a.attributeName, COALESCE(ta.valueFloat, ta.valueInt) as value
         FROM dgmTypeAttributes ta
         JOIN dgmAttributeTypes a ON ta.attributeID = a.attributeID
         WHERE ta.typeID = 587`
      )
      .all() as { attributeName: string; value: number }[];
    expect(attrs.length).toBeGreaterThan(10);
    const names = attrs.map((a) => a.attributeName);
    expect(names).toContain("cpuOutput");
    expect(names).toContain("powerOutput");
  });

  it("gets effects for Rifter", () => {
    const db = getDatabase();
    const effects = db
      .prepare(
        `SELECT e.effectName
         FROM dgmTypeEffects te
         JOIN dgmEffects e ON te.effectID = e.effectID
         WHERE te.typeID = 587`
      )
      .all() as { effectName: string }[];
    expect(effects.length).toBeGreaterThan(0);
  });

  it("gets traits for Rifter", () => {
    const db = getDatabase();
    const traits = db
      .prepare("SELECT * FROM invTraits WHERE typeID = 587")
      .all();
    expect(traits.length).toBeGreaterThan(0);
  });

  it("searches modules by category", () => {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT t.typeID, t.typeName
         FROM invTypes t
         JOIN invGroups g ON t.groupID = g.groupID
         JOIN invCategories c ON g.categoryID = c.categoryID
         WHERE t.typeName LIKE ? AND c.categoryName LIKE ? AND t.published = 1
         LIMIT 5`
      )
      .all("%Damage Control%", "%Module%");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("compares two ships by attributes", () => {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT ta.typeID, a.attributeName, COALESCE(ta.valueFloat, ta.valueInt) as value
         FROM dgmTypeAttributes ta
         JOIN dgmAttributeTypes a ON ta.attributeID = a.attributeID
         WHERE ta.typeID IN (587, 603)
         AND a.attributeName IN ('cpuOutput', 'powerOutput', 'shieldCapacity')
         ORDER BY a.attributeName, ta.typeID`
      )
      .all() as { typeID: number; attributeName: string; value: number }[];
    // Rifter (587) and Merlin (603) should both have these attrs
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});
