import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { resolveTypeNames } from "../src/type-resolve.js";
import { getDatabase, closeDatabase } from "../src/database.js";

describe("resolveTypeNames (stub table)", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE invTypes (typeID INTEGER PRIMARY KEY, typeName TEXT, published INTEGER)`);
    const insert = db.prepare("INSERT INTO invTypes VALUES (?, ?, ?)");
    insert.run(1, "Rodiva", 1);
    insert.run(2, "Pith X-Type Thermal Shield Hardener", 1);
    insert.run(3, "Twin Name", 1);
    insert.run(4, "Twin Name", 1);
    insert.run(5, "Retired Thing", 0);
    insert.run(6, "Retired Thing", 1);
    insert.run(7, "Only Unpublished", 0);
  });
  afterAll(() => db.close());

  it("resolves exact names, case-insensitively, reporting the canonical name", () => {
    const r = resolveTypeNames(db, ["rodiva", "PITH X-TYPE THERMAL SHIELD HARDENER"]);
    expect(r.resolved).toEqual([
      { name: "rodiva", typeId: 1, typeName: "Rodiva" },
      { name: "PITH X-TYPE THERMAL SHIELD HARDENER", typeId: 2, typeName: "Pith X-Type Thermal Shield Hardener" },
    ]);
    expect(r.missing).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it("does not guess: a partial name is missing", () => {
    const r = resolveTypeNames(db, ["Rodi", "Pith X-Type"]);
    expect(r.resolved).toEqual([]);
    expect(r.missing).toEqual(["Rodi", "Pith X-Type"]);
  });

  it("reports names with more than one match as ambiguous, with every candidate", () => {
    const r = resolveTypeNames(db, ["Twin Name"]);
    expect(r.resolved).toEqual([]);
    expect(r.ambiguous).toEqual([
      {
        name: "Twin Name",
        matches: [
          { typeId: 3, typeName: "Twin Name" },
          { typeId: 4, typeName: "Twin Name" },
        ],
      },
    ]);
  });

  it("matches published types only by default, which can disambiguate", () => {
    expect(resolveTypeNames(db, ["Retired Thing"]).resolved).toEqual([{ name: "Retired Thing", typeId: 6, typeName: "Retired Thing" }]);
    expect(resolveTypeNames(db, ["Only Unpublished"]).missing).toEqual(["Only Unpublished"]);
  });

  it("includes unpublished types when asked", () => {
    expect(resolveTypeNames(db, ["Only Unpublished"], { publishedOnly: false }).resolved[0].typeId).toBe(7);
    expect(resolveTypeNames(db, ["Retired Thing"], { publishedOnly: false }).ambiguous[0].matches).toHaveLength(2);
  });

  it("ignores blanks and duplicates, case-insensitively", () => {
    const r = resolveTypeNames(db, ["Rodiva", "  rodiva ", "", "   ", "RODIVA"]);
    expect(r.resolved).toHaveLength(1);
    expect(r.missing).toEqual([]);
  });

  it("returns empty groups for no names", () => {
    expect(resolveTypeNames(db, [])).toEqual({ resolved: [], ambiguous: [], missing: [] });
  });
});

describe("resolveTypeNames (real SDE)", () => {
  afterAll(() => closeDatabase());

  it("resolves real market items in one pass and reports the unknown ones", () => {
    const r = resolveTypeNames(getDatabase(), ["Tritanium", "Damage Control II", "Not A Real Item Name"]);
    expect(r.resolved.map((x) => x.typeName).sort()).toEqual(["Damage Control II", "Tritanium"]);
    expect(r.missing).toEqual(["Not A Real Item Name"]);
  });

  it("agrees with the type id the SDE stores", () => {
    const db = getDatabase();
    const direct = db.prepare("SELECT typeID FROM invTypes WHERE typeName = 'Tritanium' AND published = 1").get() as { typeID: number };
    expect(resolveTypeNames(db, ["Tritanium"]).resolved[0].typeId).toBe(direct.typeID);
  });
});
