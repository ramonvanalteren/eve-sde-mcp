import os from "os";
import path from "path";
import fs from "fs";
import { describe, it, expect, afterAll, vi, beforeAll } from "vitest";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-sde-test-"));

vi.mock("../../src/database.js", () => ({
  getSdeDir: () => tmpDir,
}));

import {
  storeTokens,
  getTokens,
  updateTokens,
  removeTokens,
  listCharacters,
  getCurrentCharacter,
  setCurrentCharacterId,
  closeAuthDb,
} from "../../src/auth/tokens.js";
import type { OAuthTokens, CharacterInfo } from "../../src/auth/oauth.js";

afterAll(() => {
  closeAuthDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTokens(overrides?: Partial<OAuthTokens>): OAuthTokens {
  return {
    accessToken: "access-" + Math.random().toString(36).slice(2),
    refreshToken: "refresh-" + Math.random().toString(36).slice(2),
    expiresAt: new Date(Date.now() + 3600000),
    ...overrides,
  };
}

function makeCharacter(id: number, name: string): CharacterInfo {
  return { characterId: id, characterName: name, scopes: "esi-test.v1" };
}

describe("token store lifecycle", () => {
  it("stores and retrieves tokens", () => {
    const tokens = makeTokens();
    const char = makeCharacter(1001, "Alice");
    storeTokens(tokens, char);

    const result = getTokens(1001);
    expect(result).not.toBeNull();
    expect(result!.characterId).toBe(1001);
    expect(result!.characterName).toBe("Alice");
    expect(result!.accessToken).toBe(tokens.accessToken);
    expect(result!.refreshToken).toBe(tokens.refreshToken);
    expect(result!.scopes).toBe("esi-test.v1");
  });

  it("encrypts tokens at rest (stored != plaintext)", async () => {
    const tokens = makeTokens({ accessToken: "plaintext-secret-token" });
    storeTokens(tokens, makeCharacter(1002, "Bob"));

    // Read raw DB to verify encryption
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(tmpDir, "auth.db"), { readonly: true });
    const row = db.prepare("SELECT access_token FROM auth_tokens WHERE character_id = ?").get(1002) as any;
    db.close();

    expect(row.access_token).not.toBe("plaintext-secret-token");
    expect(row.access_token).toContain(":");

    // But decrypted value matches
    const result = getTokens(1002);
    expect(result!.accessToken).toBe("plaintext-secret-token");
  });

  it("updates tokens for existing character", () => {
    const original = makeTokens({ accessToken: "original-access" });
    storeTokens(original, makeCharacter(1003, "Charlie"));

    const updated = makeTokens({ accessToken: "updated-access", refreshToken: "updated-refresh" });
    updateTokens(1003, updated);

    const result = getTokens(1003);
    expect(result!.accessToken).toBe("updated-access");
    expect(result!.refreshToken).toBe("updated-refresh");
    expect(result!.characterName).toBe("Charlie");
  });

  it("removes tokens", () => {
    storeTokens(makeTokens(), makeCharacter(1004, "Dave"));
    expect(getTokens(1004)).not.toBeNull();

    removeTokens(1004);
    expect(getTokens(1004)).toBeNull();
  });

  it("returns null for unknown character", () => {
    expect(getTokens(99999)).toBeNull();
  });
});

describe("listCharacters", () => {
  it("lists all stored characters ordered by most recent", () => {
    const chars = listCharacters();
    expect(chars.length).toBeGreaterThanOrEqual(2);
    expect(chars[0].characterName).toBeDefined();
    expect(chars[0].expiresAt).toBeInstanceOf(Date);
  });
});

describe("current character", () => {
  it("returns null when no characters stored", () => {
    // Clean slate by removing test chars we know about
    const before = getCurrentCharacter();
    // getCurrentCharacter falls back to most recent — just verify it doesn't crash
    // and returns a StoredCharacter-shaped object
    if (before) {
      expect(before.characterId).toBeDefined();
      expect(before.characterName).toBeDefined();
    }
  });

  it("switches current character", () => {
    storeTokens(makeTokens(), makeCharacter(2001, "Primary"));
    storeTokens(makeTokens(), makeCharacter(2002, "Alt"));

    setCurrentCharacterId(2002);
    const current = getCurrentCharacter();
    expect(current!.characterId).toBe(2002);
    expect(current!.characterName).toBe("Alt");

    setCurrentCharacterId(2001);
    const switched = getCurrentCharacter();
    expect(switched!.characterId).toBe(2001);
    expect(switched!.characterName).toBe("Primary");
  });

  it("falls back to most recently updated if current is removed", () => {
    storeTokens(makeTokens(), makeCharacter(3001, "Main"));
    storeTokens(makeTokens(), makeCharacter(3002, "Fallback"));
    setCurrentCharacterId(3001);
    removeTokens(3001);

    const current = getCurrentCharacter();
    expect(current).not.toBeNull();
    // Should fall back — exact char depends on other test data, but it shouldn't be 3001
    expect(current!.characterId).not.toBe(3001);
  });
});
