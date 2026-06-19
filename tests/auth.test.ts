import { describe, it, expect, afterAll } from "vitest";
import crypto from "crypto";
import os from "os";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;

function deriveKey(): Buffer {
  const passphrase = `${os.hostname()}-${os.platform()}-${os.arch()}`;
  const salt = crypto.createHash("sha256").update(os.hostname()).digest().subarray(0, SALT_LENGTH);
  return crypto.pbkdf2Sync(passphrase, salt, 100000, KEY_LENGTH, "sha256");
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(ciphertext: string, key: Buffer): string {
  const [ivB64, tagB64, encB64] = ciphertext.split(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

describe("token encryption", () => {
  it("round-trips a token through encrypt/decrypt", () => {
    const key = deriveKey();
    const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test-payload.signature";
    const encrypted = encrypt(token, key);
    expect(encrypted).not.toBe(token);
    expect(encrypted.split(":")).toHaveLength(3);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(token);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const key = deriveKey();
    const token = "same-token-value";
    const a = encrypt(token, key);
    const b = encrypt(token, key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe(token);
    expect(decrypt(b, key)).toBe(token);
  });

  it("fails to decrypt with wrong key", () => {
    const key = deriveKey();
    const wrongKey = crypto.randomBytes(KEY_LENGTH);
    const encrypted = encrypt("secret", key);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("fails on tampered ciphertext", () => {
    const key = deriveKey();
    const encrypted = encrypt("secret", key);
    const parts = encrypted.split(":");
    // Tamper with the encrypted data
    const tampered = parts[0] + ":" + parts[1] + ":AAAA" + parts[2].slice(4);
    expect(() => decrypt(tampered, key)).toThrow();
  });
});

describe("PKCE", () => {
  it("generates valid verifier and S256 challenge", () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest().toString("base64url");

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge.length).toBeGreaterThan(0);
    expect(challenge).not.toBe(verifier);
    // No padding characters
    expect(challenge).not.toContain("=");
    expect(verifier).not.toContain("=");
  });
});

describe("JWT character extraction", () => {
  it("extracts character ID and name from EVE SSO JWT payload", () => {
    const payload = {
      sub: "CHARACTER:EVE:2112625428",
      name: "CCP Bartender",
      owner: "some-hash",
    };
    const fakeJwt =
      "header." + Buffer.from(JSON.stringify(payload)).toString("base64") + ".signature";

    const decoded = JSON.parse(Buffer.from(fakeJwt.split(".")[1], "base64").toString("utf-8"));
    const match = (decoded.sub as string).match(/CHARACTER:EVE:(\d+)/);

    expect(match).not.toBeNull();
    expect(parseInt(match![1], 10)).toBe(2112625428);
    expect(decoded.name).toBe("CCP Bartender");
  });
});
