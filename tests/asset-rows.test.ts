import { describe, it, expect } from "vitest";
import { buildAssetRows, groupAssetsByType, type RawAsset } from "../src/asset-rows.js";

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

  it("filters by a list of type ids", () => {
    expect(buildAssetRows(assets, nameOf, { type_ids: [100, 300] }).map((r) => r.itemId)).toEqual([1, 3]);
  });

  it("treats an empty type id list as no filter", () => {
    expect(buildAssetRows(assets, nameOf, { type_ids: [] })).toHaveLength(3);
  });

  it("skips singleton items on request and only then", () => {
    expect(buildAssetRows(assets, nameOf, { skip_singletons: true }).map((r) => r.itemId)).toEqual([1, 3]);
    expect(buildAssetRows(assets, nameOf, { skip_singletons: false })).toHaveLength(3);
  });

  it("combines type ids with the singleton and location filters", () => {
    const rows = buildAssetRows(assets, nameOf, { type_ids: [100, 200], skip_singletons: true, location_id: JITA });
    expect(rows.map((r) => r.itemId)).toEqual([1]);
  });
});

describe("groupAssetsByType", () => {
  const rows = buildAssetRows(
    [
      asset({ item_id: 1, type_id: 300, quantity: 5, location_id: CONTAINER }),
      asset({ item_id: 2, type_id: 100, quantity: 6 }),
      asset({ item_id: 3, type_id: 300, quantity: 2, location_id: JITA }),
      asset({ item_id: 4, type_id: 300, quantity: 3, location_id: CONTAINER }),
    ],
    nameOf
  );

  it("sums quantity per type and keeps one entry per type", () => {
    const grouped = groupAssetsByType(rows);
    expect(grouped).toHaveLength(2);
    expect(grouped.find((g) => g.typeId === 300)?.quantity).toBe(10);
    expect(grouped.find((g) => g.typeId === 100)?.quantity).toBe(6);
  });

  it("breaks the quantity down by location, merging stacks in the same place", () => {
    const warp = groupAssetsByType(rows).find((g) => g.typeId === 300)!;
    expect(warp.locations).toEqual([
      { locationId: CONTAINER, quantity: 8 },
      { locationId: JITA, quantity: 2 },
    ]);
  });

  it("sorts by type name", () => {
    expect(groupAssetsByType(rows).map((g) => g.typeName)).toEqual(["Hound", "Warp Disruptor II"]);
  });

  it("returns an empty list for no rows", () => {
    expect(groupAssetsByType([])).toEqual([]);
  });
});
