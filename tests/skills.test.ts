import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";

afterAll(() => closeDatabase());

describe("skill requirement queries", () => {
  const SKILL_REQ_ATTRS = [
    { skillAttr: 182, levelAttr: 277 },
    { skillAttr: 183, levelAttr: 278 },
    { skillAttr: 184, levelAttr: 279 },
    { skillAttr: 1285, levelAttr: 1286 },
    { skillAttr: 1289, levelAttr: 1287 },
    { skillAttr: 1290, levelAttr: 1288 },
  ];

  it("extracts skill requirements for Rifter (T1 frigate)", () => {
    const db = getDatabase();
    const requirements: Array<{ skillId: number; skillName: string; level: number }> = [];

    for (const { skillAttr, levelAttr } of SKILL_REQ_ATTRS) {
      const skillRow = db
        .prepare(
          "SELECT COALESCE(valueFloat, valueInt) as value FROM dgmTypeAttributes WHERE typeID = 587 AND attributeID = ?"
        )
        .get(skillAttr) as { value: number } | undefined;

      if (!skillRow || skillRow.value === 0) continue;

      const levelRow = db
        .prepare(
          "SELECT COALESCE(valueFloat, valueInt) as value FROM dgmTypeAttributes WHERE typeID = 587 AND attributeID = ?"
        )
        .get(levelAttr) as { value: number } | undefined;

      const skillName = db
        .prepare("SELECT typeName FROM invTypes WHERE typeID = ?")
        .get(Math.round(skillRow.value)) as { typeName: string } | undefined;

      requirements.push({
        skillId: Math.round(skillRow.value),
        skillName: skillName?.typeName ?? "Unknown",
        level: levelRow ? Math.round(levelRow.value) : 1,
      });
    }

    expect(requirements.length).toBeGreaterThan(0);
    const names = requirements.map((r) => r.skillName);
    expect(names).toContain("Minmatar Frigate");
  });

  it("extracts skill requirements for a T2 ship (Vagabond)", () => {
    const db = getDatabase();
    // Find Vagabond typeID
    const vaga = db
      .prepare("SELECT typeID FROM invTypes WHERE typeName = 'Vagabond'")
      .get() as { typeID: number };
    expect(vaga).toBeDefined();

    const requirements: Array<{ skillId: number; skillName: string; level: number }> = [];

    for (const { skillAttr, levelAttr } of SKILL_REQ_ATTRS) {
      const skillRow = db
        .prepare(
          "SELECT COALESCE(valueFloat, valueInt) as value FROM dgmTypeAttributes WHERE typeID = ? AND attributeID = ?"
        )
        .get(vaga.typeID, skillAttr) as { value: number } | undefined;

      if (!skillRow || skillRow.value === 0) continue;

      const levelRow = db
        .prepare(
          "SELECT COALESCE(valueFloat, valueInt) as value FROM dgmTypeAttributes WHERE typeID = ? AND attributeID = ?"
        )
        .get(vaga.typeID, levelAttr) as { value: number } | undefined;

      const skillName = db
        .prepare("SELECT typeName FROM invTypes WHERE typeID = ?")
        .get(Math.round(skillRow.value)) as { typeName: string } | undefined;

      requirements.push({
        skillId: Math.round(skillRow.value),
        skillName: skillName?.typeName ?? "Unknown",
        level: levelRow ? Math.round(levelRow.value) : 1,
      });
    }

    // T2 ships require more skills than T1
    expect(requirements.length).toBeGreaterThan(1);
    const names = requirements.map((r) => r.skillName);
    expect(names).toContain("Minmatar Cruiser");
  });

  it("enriches skill IDs with SDE names and groups", () => {
    const db = getDatabase();
    // Simulate enriching ESI skill data with SDE
    const sampleSkillIds = [3300, 3301, 3302]; // Gunnery, Small Projectile Turret, etc.

    for (const id of sampleSkillIds) {
      const info = db
        .prepare(
          `SELECT t.typeName, g.groupName
           FROM invTypes t
           JOIN invGroups g ON t.groupID = g.groupID
           WHERE t.typeID = ?`
        )
        .get(id) as { typeName: string; groupName: string } | undefined;

      expect(info).toBeDefined();
      expect(info!.typeName).toBeTruthy();
      expect(info!.groupName).toBeTruthy();
    }
  });
});

describe("skill group queries", () => {
  it("finds all skill groups in the SDE", () => {
    const db = getDatabase();
    // Category 16 = Skill
    const groups = db
      .prepare(
        "SELECT groupID, groupName FROM invGroups WHERE categoryID = 16 AND published = 1 ORDER BY groupName"
      )
      .all() as { groupID: number; groupName: string }[];

    expect(groups.length).toBeGreaterThan(10);
    const names = groups.map((g) => g.groupName);
    expect(names).toContain("Gunnery");
    expect(names).toContain("Spaceship Command");
    expect(names).toContain("Engineering");
  });
});
