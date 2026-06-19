import crypto from "crypto";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { getSdeDir } from "../database.js";
import type { OAuthTokens, CharacterInfo } from "./oauth.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;

export interface StoredCharacter {
  characterId: number;
  characterName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string;
}

let authDb: Database.Database | null = null;
let encryptionKey: Buffer | null = null;

function getAuthDb(): Database.Database {
  if (authDb) return authDb;

  const dbPath = path.join(getSdeDir(), "auth.db");
  authDb = new Database(dbPath);
  authDb.pragma("journal_mode = WAL");

  authDb.exec(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      character_id INTEGER PRIMARY KEY,
      character_name TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      scopes TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return authDb;
}

function getKey(): Buffer {
  if (encryptionKey) return encryptionKey;
  const passphrase = `${os.hostname()}-${os.platform()}-${os.arch()}`;
  const salt = crypto.createHash("sha256").update(os.hostname()).digest().subarray(0, SALT_LENGTH);
  encryptionKey = crypto.pbkdf2Sync(passphrase, salt, 100000, KEY_LENGTH, "sha256");
  return encryptionKey;
}

function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(ciphertext: string): string {
  const [ivB64, tagB64, encB64] = ciphertext.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function storeTokens(tokens: OAuthTokens, character: CharacterInfo): void {
  const db = getAuthDb();
  db.prepare(
    `INSERT OR REPLACE INTO auth_tokens
     (character_id, character_name, access_token, refresh_token, expires_at, scopes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    character.characterId,
    character.characterName,
    encrypt(tokens.accessToken),
    encrypt(tokens.refreshToken),
    tokens.expiresAt.toISOString(),
    character.scopes
  );
}

export function getTokens(characterId: number): StoredCharacter | null {
  const db = getAuthDb();
  const row = db
    .prepare("SELECT * FROM auth_tokens WHERE character_id = ?")
    .get(characterId) as any;
  if (!row) return null;
  return {
    characterId: row.character_id,
    characterName: row.character_name,
    accessToken: decrypt(row.access_token),
    refreshToken: decrypt(row.refresh_token),
    expiresAt: new Date(row.expires_at),
    scopes: row.scopes,
  };
}

export function updateTokens(characterId: number, tokens: OAuthTokens): void {
  const db = getAuthDb();
  db.prepare(
    `UPDATE auth_tokens
     SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now')
     WHERE character_id = ?`
  ).run(encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt.toISOString(), characterId);
}

export function removeTokens(characterId: number): void {
  getAuthDb().prepare("DELETE FROM auth_tokens WHERE character_id = ?").run(characterId);
}

export function listCharacters(): Array<{
  characterId: number;
  characterName: string;
  expiresAt: Date;
  scopes: string;
}> {
  const rows = getAuthDb()
    .prepare("SELECT character_id, character_name, expires_at, scopes FROM auth_tokens ORDER BY updated_at DESC")
    .all() as any[];
  return rows.map((r) => ({
    characterId: r.character_id,
    characterName: r.character_name,
    expiresAt: new Date(r.expires_at),
    scopes: r.scopes,
  }));
}

export function getCurrentCharacterId(): number | null {
  const row = getAuthDb()
    .prepare("SELECT value FROM config WHERE key = 'current_character_id'")
    .get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : null;
}

export function setCurrentCharacterId(characterId: number): void {
  getAuthDb()
    .prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('current_character_id', ?)")
    .run(characterId.toString());
}

export function getCurrentCharacter(): StoredCharacter | null {
  const currentId = getCurrentCharacterId();
  if (currentId) {
    const tokens = getTokens(currentId);
    if (tokens) return tokens;
  }
  // Fall back to most recently updated
  const row = getAuthDb()
    .prepare("SELECT character_id FROM auth_tokens ORDER BY updated_at DESC LIMIT 1")
    .get() as { character_id: number } | undefined;
  if (!row) return null;
  return getTokens(row.character_id);
}

export function closeAuthDb(): void {
  if (authDb) {
    authDb.close();
    authDb = null;
  }
}
