import { describe, it, expect } from "vitest";
import { isDeadRefreshToken, refreshFailureMessage } from "../src/auth/esi-client.js";

describe("dead-token auto-login messaging", () => {
  const invalidGrant = 'Token refresh failed (400): {"error":"invalid_grant","error_description":"Invalid refresh token. Token missing/expired."}';
  const serverDown = "Token refresh failed (503): gateway timeout";

  it("detects invalid_grant as a dead token (browser-worthy), not transient failures", () => {
    expect(isDeadRefreshToken(invalidGrant)).toBe(true);
    expect(isDeadRefreshToken(serverDown)).toBe(false);
    expect(isDeadRefreshToken("")).toBe(false);
  });

  it("the fallback error (login didn't complete) points at esi_login", () => {
    const msg = refreshFailureMessage("Mazarian", invalidGrant);
    expect(msg).toContain("Token refresh failed for Mazarian");
    expect(msg).toContain("Use the esi_login tool to re-authenticate.");
  });

  it("transient failures use the same message shape — they never open a browser", () => {
    const msg = refreshFailureMessage("Helga Syrobne", serverDown);
    expect(msg).toContain("Token refresh failed for Helga Syrobne");
    expect(msg).toContain("Use the esi_login tool to re-authenticate.");
  });
});
