import type Database from "better-sqlite3";

export function enrichTypeName(db: Database.Database, typeId: number): string {
  const row = db.prepare("SELECT typeName FROM invTypes WHERE typeID = ?").get(typeId) as
    | { typeName: string }
    | undefined;
  return row?.typeName ?? `Unknown(${typeId})`;
}

export function enrichSystemName(db: Database.Database, systemId: number): string {
  const row = db
    .prepare("SELECT solarSystemName FROM mapSolarSystems WHERE solarSystemID = ?")
    .get(systemId) as { solarSystemName: string } | undefined;
  return row?.solarSystemName ?? `Unknown(${systemId})`;
}

export function escapeLike(input: string): string {
  return input.replace(/[%_\\]/g, "\\$&");
}

export function likeContains(input: string): string {
  return `%${escapeLike(input)}%`;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
