import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

const SDE_DIR = path.join(os.homedir(), ".eve-sde");
const DB_PATH = path.join(SDE_DIR, "eve.db");
const METADATA_PATH = path.join(SDE_DIR, "metadata.json");

let db: Database.Database | null = null;

export function getSdeDir(): string {
  return SDE_DIR;
}

export function getDbPath(): string {
  return DB_PATH;
}

export function getMetadataPath(): string {
  return METADATA_PATH;
}

export function sdeExists(): boolean {
  return fs.existsSync(DB_PATH);
}

export function getMetadata(): Record<string, unknown> | null {
  if (!fs.existsSync(METADATA_PATH)) return null;
  return JSON.parse(fs.readFileSync(METADATA_PATH, "utf-8"));
}

export function getDatabase(): Database.Database {
  if (db) return db;
  if (!sdeExists()) {
    throw new Error(
      `SDE database not found at ${DB_PATH}. Use the refresh_sde tool to download it.`
    );
  }
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("NODE_MODULE_VERSION")) {
      throw new Error(
        `better-sqlite3 was compiled for a different Node.js version.\n` +
        `Run: npm rebuild better-sqlite3\n` +
        `If using nvm, make sure to run it with the same Node version you'll use to start the server.`
      );
    }
    throw err;
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function reopenDatabase(): void {
  closeDatabase();
  getDatabase();
}

export function listTables(): string[] {
  const rows = getDatabase()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}
