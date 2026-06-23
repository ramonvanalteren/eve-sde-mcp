import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshAccessToken, waitForLogin } from "../../src/auth/oauth.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("refreshAccessToken", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("exchanges refresh token for new tokens", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 1200,
        }),
        { status: 200 }
      )
    );

    const result = await refreshAccessToken("old-refresh", "test-client");
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1200 * 1000 + 1000);
  });

  it("sends correct form body to token endpoint", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          expires_in: 600,
        }),
        { status: 200 }
      )
    );

    await refreshAccessToken("my-refresh-token", "my-client-id");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("login.eveonline.com");
    expect(url).toContain("/v2/oauth/token");
    expect(init.method).toBe("POST");

    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("my-refresh-token");
    expect(body.get("client_id")).toBe("my-client-id");
  });

  it("throws on failed refresh with status", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("invalid_grant", { status: 400 })
    );
    await expect(refreshAccessToken("bad-token", "client")).rejects.toThrow(
      /400.*invalid_grant/
    );
  });

  it("throws on server error", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("internal error", { status: 500 })
    );
    await expect(refreshAccessToken("token", "client")).rejects.toThrow(/500/);
  });
});

describe("waitForLogin", () => {
  it("throws when no login flow is pending", async () => {
    await expect(waitForLogin()).rejects.toThrow("No login flow in progress");
  });
});
