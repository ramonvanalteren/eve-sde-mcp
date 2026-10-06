/**
 * Batch name -> type_id resolution for resolve_types. Takes the database as a
 * parameter (no module-level import) so tests can pass the real SDE or a
 * stub.
 *
 * Why it exists: a market scan yields item names, and one search_types call
 * per name (249 in one measured session) is slow and chatty. Matching is exact
 * and case-insensitive; a partial name resolves to nothing rather than to a
 * guess, because a wrong type_id silently produces a wrong margin.
 */

import type Database from "better-sqlite3";

export interface ResolvedType {
  name: string;
  typeId: number;
  typeName: string;
}

export interface AmbiguousName {
  name: string;
  matches: Array<{ typeId: number; typeName: string }>;
}

export interface ResolveResult {
  resolved: ResolvedType[];
  ambiguous: AmbiguousName[];
  missing: string[];
}

export function resolveTypeNames(
  db: Database.Database,
  names: string[],
  options: { publishedOnly?: boolean } = {}
): ResolveResult {
  const publishedOnly = options.publishedOnly ?? true;
  const stmt = db.prepare(
    `SELECT typeID, typeName FROM invTypes WHERE typeName = ? COLLATE NOCASE${publishedOnly ? " AND published = 1" : ""} ORDER BY typeID`
  );

  const result: ResolveResult = { resolved: [], ambiguous: [], missing: [] };
  const seen = new Set<string>();

  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);

    const rows = stmt.all(name) as Array<{ typeID: number; typeName: string }>;
    if (rows.length === 0) result.missing.push(name);
    else if (rows.length === 1) result.resolved.push({ name, typeId: rows[0].typeID, typeName: rows[0].typeName });
    else
      result.ambiguous.push({
        name,
        matches: rows.map((r) => ({ typeId: r.typeID, typeName: r.typeName })),
      });
  }
  return result;
}
