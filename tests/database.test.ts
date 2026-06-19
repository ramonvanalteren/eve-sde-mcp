import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase, sdeExists, getMetadata, listTables } from "../src/database.js";

afterAll(() => closeDatabase());

describe("database", () => {
  it("detects SDE exists", () => {
    expect(sdeExists()).toBe(true);
  });

  it("returns metadata", () => {
    const meta = getMetadata();
    expect(meta).not.toBeNull();
    expect(meta).toHaveProperty("downloadedAt");
    expect(meta).toHaveProperty("sourceUrl");
    expect(meta).toHaveProperty("fileSize");
  });

  it("opens the database", () => {
    const db = getDatabase();
    expect(db).toBeDefined();
  });

  it("lists tables", () => {
    const tables = listTables();
    expect(tables.length).toBeGreaterThan(50);
    expect(tables).toContain("invTypes");
    expect(tables).toContain("dgmTypeAttributes");
    expect(tables).toContain("mapSolarSystems");
    expect(tables).toContain("industryActivity");
  });
});
