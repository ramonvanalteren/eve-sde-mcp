/**
 * Row shaping for get_character_assets, free of ESI and database imports so it
 * can be unit-tested directly.
 *
 * Rows carry locationId only. Location names live once in the `locations` list
 * of the tool result; repeating the name on every row (null for every item
 * inside a container) was most of the weight of a 130-asset listing.
 */

export interface RawAsset {
  item_id: number;
  type_id: number;
  location_id: number;
  location_type: string;
  quantity: number;
  location_flag: string;
  is_singleton: boolean;
}

export interface AssetRow {
  itemId: number;
  typeName: string;
  typeId: number;
  quantity: number;
  locationId: number;
  locationType: string;
  locationFlag: string;
  isSingleton: boolean;
}

export interface AssetFilters {
  type_name?: string;
  type_ids?: number[];
  location_id?: number;
  /** Drop assembled ships, containers, fitted modules and blueprints (singleton items). */
  skip_singletons?: boolean;
}

export interface GroupedAsset {
  typeId: number;
  typeName: string;
  quantity: number;
  locations: Array<{ locationId: number; quantity: number }>;
}

/**
 * One row per item type with the total quantity and where it is. Sorted by
 * type name. A 131-row listing is mostly stacks of the same type split across
 * containers, so grouping is the cheapest way to answer "how many of X do I
 * hold".
 */
export function groupAssetsByType(rows: AssetRow[]): GroupedAsset[] {
  const byType = new Map<number, GroupedAsset>();
  for (const r of rows) {
    let g = byType.get(r.typeId);
    if (!g) {
      g = { typeId: r.typeId, typeName: r.typeName, quantity: 0, locations: [] };
      byType.set(r.typeId, g);
    }
    g.quantity += r.quantity;
    const loc = g.locations.find((l) => l.locationId === r.locationId);
    if (loc) loc.quantity += r.quantity;
    else g.locations.push({ locationId: r.locationId, quantity: r.quantity });
  }
  return [...byType.values()].sort((a, b) => a.typeName.localeCompare(b.typeName));
}

export function buildAssetRows(
  assets: RawAsset[],
  typeName: (typeId: number) => string,
  filters: AssetFilters = {}
): AssetRow[] {
  let rows: AssetRow[] = assets.map((a) => ({
    itemId: a.item_id,
    typeName: typeName(a.type_id),
    typeId: a.type_id,
    quantity: a.quantity,
    locationId: a.location_id,
    locationType: a.location_type,
    locationFlag: a.location_flag,
    isSingleton: a.is_singleton,
  }));

  if (filters.type_name) {
    const needle = filters.type_name.toLowerCase();
    rows = rows.filter((r) => r.typeName.toLowerCase().includes(needle));
  }
  if (filters.type_ids && filters.type_ids.length > 0) {
    const wanted = new Set(filters.type_ids);
    rows = rows.filter((r) => wanted.has(r.typeId));
  }
  if (filters.location_id) {
    rows = rows.filter((r) => r.locationId === filters.location_id);
  }
  if (filters.skip_singletons) {
    rows = rows.filter((r) => !r.isSingleton);
  }
  return rows;
}
