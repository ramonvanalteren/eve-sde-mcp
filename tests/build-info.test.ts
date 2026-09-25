import { describe, it, expect } from "vitest";
import { parseBuildInfo, getBuildInfo } from "../src/build-info.js";

describe("parseBuildInfo", () => {
  it("parses a well-formed build-info.json", () => {
    const info = parseBuildInfo(JSON.stringify({ gitCommit: "abc123", builtAt: "2026-09-25T00:00:00.000Z" }));
    expect(info).toEqual({ gitCommit: "abc123", builtAt: "2026-09-25T00:00:00.000Z" });
  });

  it("returns null for invalid JSON rather than throwing", () => {
    expect(parseBuildInfo("{not json")).toBeNull();
  });

  it("returns null for a JSON value that isn't an object", () => {
    expect(parseBuildInfo("42")).toBeNull();
    expect(parseBuildInfo("null")).toBeNull();
    expect(parseBuildInfo('"a string"')).toBeNull();
  });

  it("defaults missing or wrongly-typed fields to null instead of guessing", () => {
    expect(parseBuildInfo("{}")).toEqual({ gitCommit: null, builtAt: null });
    expect(parseBuildInfo(JSON.stringify({ gitCommit: 123, builtAt: true }))).toEqual({
      gitCommit: null,
      builtAt: null,
    });
  });
});

describe("getBuildInfo", () => {
  it("returns null under vitest/tsx (no dist/build-info.json next to src/build-info.ts — only deploy.mjs writes it)", () => {
    // This is the dev-mode case: never guess a build that doesn't exist.
    expect(getBuildInfo()).toBeNull();
  });
});
