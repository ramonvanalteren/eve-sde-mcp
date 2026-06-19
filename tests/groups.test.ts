import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";

afterAll(() => closeDatabase());

describe("group queries", () => {
  it("finds Frigate group by name", () => {
    const db = getDatabase();
    const group = db
      .prepare(
        `SELECT g.*, c.categoryName
         FROM invGroups g
         JOIN invCategories c ON g.categoryID = c.categoryID
         WHERE g.groupName LIKE ?`
      )
      .get("%Frigate%") as any;
    expect(group).toBeDefined();
    expect(group.categoryName).toBe("Ship");
  });

  it("lists types in a group", () => {
    const db = getDatabase();
    const types = db
      .prepare(
        `SELECT typeID, typeName FROM invTypes
         WHERE groupID = 25 AND published = 1
         ORDER BY typeName`
      )
      .all();
    expect(types.length).toBeGreaterThan(5);
  });

  it("finds Ship category", () => {
    const db = getDatabase();
    const cat = db
      .prepare("SELECT * FROM invCategories WHERE categoryName = ?")
      .get("Ship") as any;
    expect(cat).toBeDefined();
    expect(cat.categoryID).toBe(6);
  });

  it("lists groups in Ship category", () => {
    const db = getDatabase();
    const groups = db
      .prepare(
        "SELECT groupID, groupName FROM invGroups WHERE categoryID = 6 AND published = 1"
      )
      .all();
    expect(groups.length).toBeGreaterThan(10);
  });

  it("navigates top-level market groups", () => {
    const db = getDatabase();
    const topLevel = db
      .prepare(
        "SELECT marketGroupID, marketGroupName FROM invMarketGroups WHERE parentGroupID IS NULL"
      )
      .all();
    expect(topLevel.length).toBeGreaterThan(5);
  });

  it("navigates market group children", () => {
    const db = getDatabase();
    // Market group 4 is "Ships"
    const children = db
      .prepare(
        "SELECT marketGroupID, marketGroupName FROM invMarketGroups WHERE parentGroupID = 4"
      )
      .all();
    expect(children.length).toBeGreaterThan(0);
  });
});
