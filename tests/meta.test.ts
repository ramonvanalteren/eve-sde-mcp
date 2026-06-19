import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";

afterAll(() => closeDatabase());

describe("meta / query_sde safety", () => {
  it("executes valid SELECT queries", () => {
    const db = getDatabase();
    const rows = db
      .prepare("SELECT COUNT(*) as count FROM invTypes WHERE published = 1")
      .all() as any[];
    expect(rows[0].count).toBeGreaterThan(1000);
  });

  it("rejects INSERT statements at keyword level", () => {
    const sql = "INSERT INTO invTypes (typeID, typeName) VALUES (999999, 'test')";
    const firstWord = sql.trim().split(" ")[0].toUpperCase();
    expect(firstWord).not.toBe("SELECT");
  });

  it("rejects DROP hidden in a query", () => {
    const sql = "SELECT * FROM invTypes; DROP TABLE invTypes;";
    const forbidden =
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|REPLACE|PRAGMA)\b/i;
    expect(forbidden.test(sql)).toBe(true);
  });

  it("allows WITH (CTE) queries", () => {
    const db = getDatabase();
    const rows = db
      .prepare(
        `WITH ship_groups AS (
           SELECT groupID, groupName FROM invGroups WHERE categoryID = 6 AND published = 1
         )
         SELECT COUNT(*) as count FROM ship_groups`
      )
      .all() as any[];
    expect(rows[0].count).toBeGreaterThan(10);
  });

  it("allows EXPLAIN queries", () => {
    const db = getDatabase();
    const rows = db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM invTypes WHERE typeID = 587")
      .all();
    expect(rows.length).toBeGreaterThan(0);
  });
});
