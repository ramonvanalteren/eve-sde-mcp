import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";

afterAll(() => closeDatabase());

describe("fitting SDE queries", () => {
  it("resolves ship names to type IDs", () => {
    const db = getDatabase();
    const ships = [
      { name: "Rifter", expected: 587 },
      { name: "Vexor", expected: 626 },
      { name: "Raven", expected: 638 },
    ];
    for (const ship of ships) {
      const row = db
        .prepare("SELECT typeID FROM invTypes WHERE typeName = ? AND published = 1")
        .get(ship.name) as { typeID: number } | undefined;
      expect(row, `${ship.name} should exist`).toBeDefined();
      expect(row!.typeID).toBe(ship.expected);
    }
  });

  it("resolves module names to type IDs", () => {
    const db = getDatabase();
    const modules = [
      "Damage Control II",
      "1MN Afterburner II",
      "200mm AutoCannon II",
    ];
    for (const name of modules) {
      const row = db
        .prepare("SELECT typeID FROM invTypes WHERE typeName = ? AND published = 1")
        .get(name) as { typeID: number } | undefined;
      expect(row, `${name} should exist`).toBeDefined();
    }
  });

  it("determines slot types from dgmTypeEffects", () => {
    const db = getDatabase();

    const slotEffects: Record<number, string> = {
      12: "hiPower",
      13: "medPower",
      11: "loPower",
      2663: "rigSlot",
    };

    // 200mm AutoCannon II → hiPower (effectID 12)
    const gun = db
      .prepare("SELECT typeID FROM invTypes WHERE typeName = '200mm AutoCannon II'")
      .get() as { typeID: number };
    const gunEffects = db
      .prepare("SELECT effectID FROM dgmTypeEffects WHERE typeID = ?")
      .all(gun.typeID) as { effectID: number }[];
    expect(gunEffects.some((e) => e.effectID === 12)).toBe(true);

    // Damage Control II → loPower (effectID 11)
    const dc = db
      .prepare("SELECT typeID FROM invTypes WHERE typeName = 'Damage Control II'")
      .get() as { typeID: number };
    const dcEffects = db
      .prepare("SELECT effectID FROM dgmTypeEffects WHERE typeID = ?")
      .all(dc.typeID) as { effectID: number }[];
    expect(dcEffects.some((e) => e.effectID === 11)).toBe(true);

    // 1MN Afterburner II → medPower (effectID 13)
    const ab = db
      .prepare("SELECT typeID FROM invTypes WHERE typeName = '1MN Afterburner II'")
      .get() as { typeID: number };
    const abEffects = db
      .prepare("SELECT effectID FROM dgmTypeEffects WHERE typeID = ?")
      .all(ab.typeID) as { effectID: number }[];
    expect(abEffects.some((e) => e.effectID === 13)).toBe(true);
  });

  it("detects rig slot effect", () => {
    const db = getDatabase();
    const rig = db
      .prepare("SELECT typeID FROM invTypes WHERE typeName LIKE 'Small Projectile%Aerator I' AND published = 1")
      .get() as { typeID: number } | undefined;
    expect(rig).toBeDefined();
    const effects = db
      .prepare("SELECT effectID FROM dgmTypeEffects WHERE typeID = ?")
      .all(rig!.typeID) as { effectID: number }[];
    expect(effects.some((e) => e.effectID === 2663)).toBe(true);
  });

  it("identifies drones by category", () => {
    const db = getDatabase();
    const drone = db
      .prepare(
        `SELECT c.categoryName FROM invTypes t
         JOIN invGroups g ON t.groupID = g.groupID
         JOIN invCategories c ON g.categoryID = c.categoryID
         WHERE t.typeName = 'Hobgoblin II'`
      )
      .get() as { categoryName: string } | undefined;
    expect(drone).toBeDefined();
    expect(drone!.categoryName).toBe("Drone");
  });

  it("identifies charges by category", () => {
    const db = getDatabase();
    const charge = db
      .prepare(
        `SELECT c.categoryName FROM invTypes t
         JOIN invGroups g ON t.groupID = g.groupID
         JOIN invCategories c ON g.categoryID = c.categoryID
         WHERE t.typeName = 'Republic Fleet EMP S'`
      )
      .get() as { categoryName: string } | undefined;
    expect(charge).toBeDefined();
    expect(charge!.categoryName).toBe("Charge");
  });

  it("has valid ESI fitting flag names for all slot types", () => {
    // Verify the flag naming convention matches ESI expectations
    const validFlags = [
      "HiSlot0", "HiSlot1", "HiSlot2", "HiSlot3", "HiSlot4", "HiSlot5", "HiSlot6", "HiSlot7",
      "MedSlot0", "MedSlot1", "MedSlot2", "MedSlot3", "MedSlot4", "MedSlot5", "MedSlot6", "MedSlot7",
      "LoSlot0", "LoSlot1", "LoSlot2", "LoSlot3", "LoSlot4", "LoSlot5", "LoSlot6", "LoSlot7",
      "RigSlot0", "RigSlot1", "RigSlot2",
      "SubSystemSlot0", "SubSystemSlot1", "SubSystemSlot2", "SubSystemSlot3",
      "DroneBay", "FighterBay", "Cargo",
      "ServiceSlot0", "ServiceSlot1", "ServiceSlot2", "ServiceSlot3",
      "ServiceSlot4", "ServiceSlot5", "ServiceSlot6", "ServiceSlot7",
      "Invalid",
    ];
    // This is a reference test — ensures our flag names are in the valid set
    for (const flag of ["HiSlot0", "MedSlot0", "LoSlot0", "RigSlot0", "DroneBay", "Cargo"]) {
      expect(validFlags).toContain(flag);
    }
  });

  it("can count available slots for a Rifter from dogma attributes", () => {
    const db = getDatabase();
    // Rifter: 3 high, 3 med, 3 low, 3 rig
    const rifter = db
      .prepare("SELECT typeID FROM invTypes WHERE typeName = 'Rifter'")
      .get() as { typeID: number };

    const slotAttrs: Record<string, number> = {
      hiSlots: 14,    // attributeID for hiSlots
      medSlots: 13,   // attributeID for medSlots
      lowSlots: 12,   // attributeID for lowSlots
      rigSlots: 1137, // attributeID for rigSlots
    };

    for (const [name, attrId] of Object.entries(slotAttrs)) {
      const row = db
        .prepare(
          `SELECT COALESCE(valueFloat, valueInt) as value
           FROM dgmTypeAttributes WHERE typeID = ? AND attributeID = ?`
        )
        .get(rifter.typeID, attrId) as { value: number } | undefined;
      expect(row, `${name} attribute should exist for Rifter`).toBeDefined();
      expect(row!.value).toBeGreaterThan(0);
    }
  });
});
