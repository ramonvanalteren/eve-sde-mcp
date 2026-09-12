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

  it("when auto-login started, the error says so and names the character", () => {
    const msg = refreshFailureMessage("Mazarian", invalidGrant, true);
    expect(msg).toContain("Token refresh failed for Mazarian");
    expect(msg).toContain("A login page has been opened in your browser");
    expect(msg).toContain("authenticate as Mazarian");
    expect(msg).not.toContain("Use the esi_login tool");
  });

  it("when auto-login could not start (cooldown/no client id), it falls back to the manual instruction", () => {
    const msg = refreshFailureMessage("Mazarian", invalidGrant, false);
    expect(msg).toContain("Use the esi_login tool to re-authenticate.");
    expect(msg).not.toContain("browser");
  });

  it("transient failures never mention a browser — only dead tokens trigger the flow", () => {
    const msg = refreshFailureMessage("Helga Syrobne", serverDown, false);
    expect(msg).toContain("Token refresh failed for Helga Syrobne");
    expect(msg).toContain("Use the esi_login tool to re-authenticate.");
  });
});
