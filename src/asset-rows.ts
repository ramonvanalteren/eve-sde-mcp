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
  location_id?: number;
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
  if (filters.location_id) {
    rows = rows.filter((r) => r.locationId === filters.location_id);
  }
  return rows;
}
