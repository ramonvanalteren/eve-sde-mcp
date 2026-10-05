import { describe, it, expect } from "vitest";
import { buildAssetRows, type RawAsset } from "../src/asset-rows.js";

const JITA = 60003760;
const CONTAINER = 1053962206747;

const asset = (over: Partial<RawAsset>): RawAsset => ({
  item_id: 1,
  type_id: 100,
  location_id: JITA,
  location_type: "station",
  quantity: 1,
  location_flag: "Hangar",
  is_singleton: false,
  ...over,
});

const names: Record<number, string> = { 100: "Hound", 200: "Station Container", 300: "Warp Disruptor II" };
const nameOf = (id: number) => names[id] ?? `Unknown(${id})`;

describe("buildAssetRows", () => {
  const assets = [
    asset({ item_id: 1, type_id: 100, quantity: 6 }),
    asset({ item_id: 2, type_id: 200, is_singleton: true }),
    asset({ item_id: 3, type_id: 300, location_id: CONTAINER, location_type: "item", location_flag: "Unlocked", quantity: 5 }),
  ];

  it("carries locationId on every row and no per-row location name", () => {
    const rows = buildAssetRows(assets, nameOf);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toHaveProperty("locationId");
      expect(row).not.toHaveProperty("locationName");
    }
  });

  it("maps fields and resolves the type name", () => {
    const [hound] = buildAssetRows(assets, nameOf);
    expect(hound).toEqual({
      itemId: 1,
      typeName: "Hound",
      typeId: 100,
      quantity: 6,
      locationId: JITA,
      locationType: "station",
      locationFlag: "Hangar",
      isSingleton: false,
    });
  });

  it("filters by type name, case-insensitively and by substring", () => {
    expect(buildAssetRows(assets, nameOf, { type_name: "warp disr" }).map((r) => r.itemId)).toEqual([3]);
  });

  it("filters by location", () => {
    expect(buildAssetRows(assets, nameOf, { location_id: JITA }).map((r) => r.itemId)).toEqual([1, 2]);
    expect(buildAssetRows(assets, nameOf, { location_id: CONTAINER }).map((r) => r.itemId)).toEqual([3]);
  });

  it("applies both filters together", () => {
    expect(buildAssetRows(assets, nameOf, { type_name: "hound", location_id: CONTAINER })).toEqual([]);
  });

  it("returns an empty list for no assets", () => {
    expect(buildAssetRows([], nameOf)).toEqual([]);
  });
});
