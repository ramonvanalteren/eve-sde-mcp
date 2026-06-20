import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";

afterAll(() => closeDatabase());

describe("killmail SDE queries", () => {
  it("resolves solar system names for killmail locations", () => {
    const db = getDatabase();
    const systems = [
      { name: "Jita", id: 30000142 },
      { name: "Rens", id: 30002510 },
      { name: "Amarr", id: 30002187 },
    ];
    for (const sys of systems) {
      const row = db
        .prepare("SELECT solarSystemName FROM mapSolarSystems WHERE solarSystemID = ?")
        .get(sys.id) as { solarSystemName: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.solarSystemName).toBe(sys.name);
    }
  });

  it("resolves ship type names for killmail victims", () => {
    const db = getDatabase();
    const ships = [
      { name: "Rifter", id: 587 },
      { name: "Capsule", id: 670 },
      { name: "Drake", id: 24698 },
    ];
    for (const ship of ships) {
      const row = db
        .prepare("SELECT typeName FROM invTypes WHERE typeID = ?")
        .get(ship.id) as { typeName: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.typeName).toBe(ship.name);
    }
  });

  it("resolves weapon type names for killmail attackers", () => {
    const db = getDatabase();
    const weapons = [
      "200mm AutoCannon II",
      "Hobgoblin II",
      "Scourge Heavy Missile",
    ];
    for (const name of weapons) {
      const row = db
        .prepare("SELECT typeID FROM invTypes WHERE typeName = ?")
        .get(name) as { typeID: number } | undefined;
      expect(row, `${name} should exist in SDE`).toBeDefined();
    }
  });

  it("maps ESI inventory flag IDs to slot names", () => {
    const FLAG_NAMES: Record<number, string> = {
      5: "Cargo",
      27: "HiSlot0", 28: "HiSlot1",
      19: "MedSlot0", 20: "MedSlot1",
      11: "LoSlot0", 12: "LoSlot1",
      92: "RigSlot0", 93: "RigSlot1",
      87: "DroneBay",
    };
    expect(FLAG_NAMES[27]).toBe("HiSlot0");
    expect(FLAG_NAMES[19]).toBe("MedSlot0");
    expect(FLAG_NAMES[11]).toBe("LoSlot0");
    expect(FLAG_NAMES[92]).toBe("RigSlot0");
    expect(FLAG_NAMES[87]).toBe("DroneBay");
    expect(FLAG_NAMES[5]).toBe("Cargo");
  });

  it("can distinguish between destroyed and dropped items by flag", () => {
    // Killmail items have quantity_destroyed and quantity_dropped
    // Both can be present for the same item type across slots
    const mockItems = [
      { item_type_id: 2456, flag: 27, quantity_destroyed: 1, quantity_dropped: 0, singleton: 0 },
      { item_type_id: 2456, flag: 28, quantity_destroyed: 0, quantity_dropped: 1, singleton: 0 },
    ];
    const destroyed = mockItems.filter((i) => (i.quantity_destroyed ?? 0) > 0);
    const dropped = mockItems.filter((i) => (i.quantity_dropped ?? 0) > 0);
    expect(destroyed).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });
});
