import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";

afterAll(() => closeDatabase());

describe("universe queries", () => {
  it("finds Jita by name", () => {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT s.solarSystemID, s.solarSystemName, s.security,
                c.constellationName, r.regionName
         FROM mapSolarSystems s
         JOIN mapConstellations c ON s.constellationID = c.constellationID
         JOIN mapRegions r ON s.regionID = r.regionID
         WHERE s.solarSystemName LIKE ?`
      )
      .all("%Jita%") as any[];
    expect(rows.length).toBeGreaterThan(0);
    const jita = rows.find((r) => r.solarSystemName === "Jita");
    expect(jita).toBeDefined();
    expect(jita.regionName).toBe("The Forge");
  });

  it("gets system jumps from Jita", () => {
    const db = getDatabase();
    const jita = db
      .prepare("SELECT solarSystemID FROM mapSolarSystems WHERE solarSystemName = 'Jita'")
      .get() as any;
    const jumps = db
      .prepare(
        `SELECT j.toSolarSystemID, s.solarSystemName
         FROM mapSolarSystemJumps j
         JOIN mapSolarSystems s ON j.toSolarSystemID = s.solarSystemID
         WHERE j.fromSolarSystemID = ?`
      )
      .all(jita.solarSystemID);
    expect(jumps.length).toBeGreaterThan(0);
  });

  it("gets stations in Jita", () => {
    const db = getDatabase();
    const jita = db
      .prepare("SELECT solarSystemID FROM mapSolarSystems WHERE solarSystemName = 'Jita'")
      .get() as any;
    const stations = db
      .prepare("SELECT stationID, stationName FROM staStations WHERE solarSystemID = ?")
      .all(jita.solarSystemID);
    expect(stations.length).toBeGreaterThan(0);
  });

  it("finds The Forge region", () => {
    const db = getDatabase();
    const region = db
      .prepare("SELECT * FROM mapRegions WHERE regionName = 'The Forge'")
      .get() as any;
    expect(region).toBeDefined();
    const constellations = db
      .prepare(
        "SELECT constellationID, constellationName FROM mapConstellations WHERE regionID = ?"
      )
      .all(region.regionID);
    expect(constellations.length).toBeGreaterThan(0);
  });
});
