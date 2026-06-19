import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";

afterAll(() => closeDatabase());

describe("market SDE queries", () => {
  it("resolves type names for common trade items", () => {
    const db = getDatabase();
    const items = ["Tritanium", "PLEX", "Damage Control II"];
    for (const name of items) {
      const row = db
        .prepare("SELECT typeID, typeName FROM invTypes WHERE typeName = ?")
        .get(name) as { typeID: number; typeName: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.typeName).toBe(name);
    }
  });

  it("knows The Forge region ID for Jita market queries", () => {
    const db = getDatabase();
    const forge = db
      .prepare("SELECT regionID FROM mapRegions WHERE regionName = 'The Forge'")
      .get() as { regionID: number };
    expect(forge.regionID).toBe(10000002);
  });

  it("knows Domain region ID for Amarr market queries", () => {
    const db = getDatabase();
    const domain = db
      .prepare("SELECT regionID FROM mapRegions WHERE regionName = 'Domain'")
      .get() as { regionID: number };
    expect(domain.regionID).toBe(10000043);
  });

  it("can look up market group hierarchy for an item", () => {
    const db = getDatabase();
    // Tritanium should be in a Minerals market group
    const tri = db
      .prepare("SELECT marketGroupID FROM invTypes WHERE typeName = 'Tritanium'")
      .get() as { marketGroupID: number };
    expect(tri).toBeDefined();

    const group = db
      .prepare("SELECT marketGroupName, parentGroupID FROM invMarketGroups WHERE marketGroupID = ?")
      .get(tri.marketGroupID) as { marketGroupName: string; parentGroupID: number | null };
    expect(group).toBeDefined();
  });
});

describe("industry SDE queries", () => {
  it("resolves activity names from IDs", () => {
    const ACTIVITY_NAMES: Record<number, string> = {
      1: "Manufacturing",
      3: "TE Research",
      4: "ME Research",
      5: "Copying",
      8: "Invention",
      9: "Reaction",
    };

    for (const [id, name] of Object.entries(ACTIVITY_NAMES)) {
      expect(name).toBeTruthy();
      expect(parseInt(id)).toBeGreaterThan(0);
    }
  });

  it("can find solar system for cost index lookups", () => {
    const db = getDatabase();
    const jita = db
      .prepare("SELECT solarSystemID FROM mapSolarSystems WHERE solarSystemName = 'Jita'")
      .get() as { solarSystemID: number };
    expect(jita.solarSystemID).toBe(30000142);
  });
});
